import { db } from '../db';
import { eq, sql } from 'drizzle-orm';
import { SquareClient, SquareEnvironment } from 'square';
import {
  squareCategories,
  squareCatalogItems,
  type InsertSquareCategory,
  type InsertSquareCatalogItem,
  type SquareCatalogItem,
} from '../../shared/schema';
import { logger, errorContext } from '../logger';

const squareClient = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN || '',
  environment: SquareEnvironment.Production,
});

const catalogItemCache = new Map<string, string | null>();
let cacheLoadedAt: number = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function ensureCacheLoaded(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && catalogItemCache.size > 0) {
    return;
  }
  const rows = await db.select().from(squareCatalogItems);
  catalogItemCache.clear();
  for (const row of rows) {
    catalogItemCache.set(row.squareCatalogObjectId, row.categoryName || null);
  }
  cacheLoadedAt = Date.now();
}

export function lookupCategorySync(catalogObjectId: string | null | undefined): string | null {
  if (!catalogObjectId) return null;
  const cached = catalogItemCache.get(catalogObjectId);
  return cached !== undefined ? cached : null;
}

export async function preloadCatalogCache(): Promise<void> {
  cacheLoadedAt = 0;
  await ensureCacheLoaded();
  logger.info('catalog.cache.preloaded', { count: catalogItemCache.size });
}

export async function lookupCategoryByCatalogObjectId(
  catalogObjectId: string | null | undefined
): Promise<string | null> {
  if (!catalogObjectId) return null;
  await ensureCacheLoaded();
  const cached = catalogItemCache.get(catalogObjectId);
  if (cached !== undefined) return cached;
  const rows = await db
    .select()
    .from(squareCatalogItems)
    .where(eq(squareCatalogItems.squareCatalogObjectId, catalogObjectId))
    .limit(1);
  if (rows.length > 0) {
    const name = rows[0].categoryName || null;
    catalogItemCache.set(catalogObjectId, name);
    return name;
  }
  catalogItemCache.set(catalogObjectId, null);
  return null;
}

export async function syncCatalog(): Promise<{
  categories: number;
  items: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let categoryCount = 0;
  let itemCount = 0;

  try {
    logger.info('catalog.sync.start');

    const categoryMap = new Map<string, string>();

    try {
      let catPage = await squareClient.catalog.list({ types: 'CATEGORY' });
      while (true) {
        const objects = catPage.data ?? [];
        const pageCategories: InsertSquareCategory[] = [];
        for (const obj of objects) {
          if (obj.type !== 'CATEGORY' || !obj.categoryData) continue;
          const catId = obj.id as string;
          if (!catId) continue;
          const catName = obj.categoryData.name || 'Unnamed Category';
          // Square's CategoryData exposes the parent rollup either as
          // `parentCategory.id` (current SDK) or the legacy `parentCategoryId`
          // field. Read both so we don't silently drop the hierarchy if
          // Square ever flips one off — the items dashboard depends on
          // this to drive its rollup dropdowns.
          const catData = obj.categoryData as Record<string, unknown>;
          const parentCategoryObj = catData.parentCategory as { id?: unknown } | undefined;
          const parentCategoryId =
            (typeof parentCategoryObj?.id === 'string' && parentCategoryObj.id) ||
            (typeof catData.parentCategoryId === 'string' && catData.parentCategoryId) ||
            null;
          categoryMap.set(catId, catName);
          pageCategories.push({ squareCategoryId: catId, name: catName, parentCategoryId, updatedAt: new Date() });
        }
        if (pageCategories.length > 0) {
          await db
            .insert(squareCategories)
            .values(pageCategories)
            .onConflictDoUpdate({
              target: squareCategories.squareCategoryId,
              set: {
                name: sql`excluded.name`,
                parentCategoryId: sql`excluded.parent_category_id`,
                updatedAt: sql`excluded.updated_at`,
              },
            });
          categoryCount += pageCategories.length;
        }
        if (!catPage.hasNextPage() || objects.length === 0) break;
        catPage = await catPage.getNextPage();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Error fetching categories: ${msg}`);
      logger.error('catalog.sync.categories_failed', errorContext(e));
    }

    logger.info('catalog.sync.categories_done', { count: categoryCount });

    try {
      let itemPage = await squareClient.catalog.list({ types: 'ITEM' });
      while (true) {
        const itemObjects = itemPage.data ?? [];
        const pageItems: InsertSquareCatalogItem[] = [];
        for (const obj of itemObjects) {
          if (obj.type !== 'ITEM' || !obj.itemData) continue;

          const itemData = obj.itemData;
          const catalogObjectId = obj.id;
          const itemName = itemData.name || 'Unnamed Item';
          // Square uses `is_deleted` on the catalog object for archived
          // SKUs. Capture it so the items dashboard can hide retired items
          // without losing their historical sales data.
          const objAny = obj as unknown as Record<string, unknown>;
          const isArchived = objAny.isDeleted === true || objAny.is_deleted === true;

          let categoryId: string | null = null;
          let categoryName: string | null = null;

          if (itemData.categories && itemData.categories.length > 0) {
            const firstCat = itemData.categories[0];
            categoryId = firstCat.id || null;
            if (categoryId && categoryMap.has(categoryId)) {
              categoryName = categoryMap.get(categoryId)!;
            }
          }

          if (!categoryId && itemData.reportingCategory?.id) {
            categoryId = itemData.reportingCategory.id;
            if (categoryId && categoryMap.has(categoryId)) {
              categoryName = categoryMap.get(categoryId)!;
            }
          }

          if (!categoryId && itemData.categoryId) {
            categoryId = itemData.categoryId;
            if (categoryId && categoryMap.has(categoryId)) {
              categoryName = categoryMap.get(categoryId)!;
            }
          }

          if (!categoryName && categoryId) {
            const catRows = await db
              .select()
              .from(squareCategories)
              .where(eq(squareCategories.squareCategoryId, categoryId))
              .limit(1);
            if (catRows.length > 0) {
              categoryName = catRows[0].name;
            }
          }

          pageItems.push({
            squareCatalogObjectId: catalogObjectId,
            categoryId,
            categoryName,
            itemName,
            isArchived,
            updatedAt: new Date(),
          } satisfies InsertSquareCatalogItem);

          if (itemData.variations && Array.isArray(itemData.variations)) {
            for (const variation of itemData.variations) {
              if (!variation.id) continue;
              const varName = 'itemVariationData' in variation && variation.itemVariationData
                && typeof variation.itemVariationData === 'object'
                && 'name' in variation.itemVariationData
                && typeof variation.itemVariationData.name === 'string'
                ? `${itemName} - ${variation.itemVariationData.name}`
                : itemName;
              // A variation inherits its parent item's archived state unless Square
              // marked the variation itself as deleted; either is enough to retire it.
              const varAny = variation as unknown as Record<string, unknown>;
              const varArchived = isArchived
                || varAny.isDeleted === true
                || varAny.is_deleted === true;

              pageItems.push({
                squareCatalogObjectId: variation.id,
                categoryId,
                categoryName,
                itemName: varName,
                isArchived: varArchived,
                updatedAt: new Date(),
              } satisfies InsertSquareCatalogItem);
            }
          }
        }

        if (pageItems.length > 0) {
          await db
            .insert(squareCatalogItems)
            .values(pageItems)
            .onConflictDoUpdate({
              target: squareCatalogItems.squareCatalogObjectId,
              set: {
                categoryId: sql`excluded.category_id`,
                categoryName: sql`excluded.category_name`,
                itemName: sql`excluded.item_name`,
                isArchived: sql`excluded.is_archived`,
                updatedAt: sql`excluded.updated_at`,
              },
            });
          itemCount += pageItems.length;
        }
        if (!itemPage.hasNextPage() || itemObjects.length === 0) break;
        itemPage = await itemPage.getNextPage();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Error fetching items: ${msg}`);
      logger.error('catalog.sync.items_failed', errorContext(e));
    }

    logger.info('catalog.sync.items_done', { count: itemCount });

    catalogItemCache.clear();
    cacheLoadedAt = 0;

    return { categories: categoryCount, items: itemCount, errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Catalog sync failed: ${msg}`);
    logger.error('catalog.sync.fatal', errorContext(e));
    return { categories: categoryCount, items: itemCount, errors };
  }
}

export async function backfillCategories(): Promise<{
  updatedLineItems: number;
  updatedTransactions: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let updatedLineItems = 0;
  let updatedTransactions = 0;

  try {
    logger.info('catalog.backfill.start');

    await ensureCacheLoaded();

    const lineItemResult = await db.execute<{
      id: number;
      product_id: string;
      category: string | null;
    }>(sql`
      SELECT id, product_id, category
      FROM order_line_items
      WHERE product_id IS NOT NULL
    `);

    for (const row of lineItemResult.rows) {
      const productId = row.product_id;
      if (!productId) continue;

      const newCategory = catalogItemCache.get(productId);
      if (newCategory && newCategory !== row.category) {
        await db.execute(sql`
          UPDATE order_line_items
          SET category = ${newCategory}
          WHERE id = ${row.id}
        `);
        updatedLineItems++;
      }
    }

    logger.info('catalog.backfill.lineItems_done', { count: updatedLineItems });

    const txResult = await db.execute<{
      id: number;
      category_id: string;
      square_data: Record<string, unknown> | null;
    }>(sql`
      SELECT id, category_id, square_data
      FROM transactions
    `);

    for (const row of txResult.rows) {
      const squareData =
        typeof row.square_data === 'object' && row.square_data !== null
          ? (row.square_data as Record<string, unknown>)
          : {};
      const orderId = squareData.orderId as string | undefined;
      if (!orderId) continue;

      const orderLineItemsResult = await db.execute<{
        product_id: string | null;
      }>(sql`
        SELECT oli.product_id
        FROM order_line_items oli
        INNER JOIN orders o ON oli.order_id = o.id
        WHERE o.square_id = ${orderId}
        AND oli.product_id IS NOT NULL
        LIMIT 1
      `);

      if (orderLineItemsResult.rows.length > 0) {
        const pid = orderLineItemsResult.rows[0].product_id;
        if (pid) {
          const newCat = catalogItemCache.get(pid);
          if (newCat && newCat !== row.category_id) {
            await db.execute(sql`
              UPDATE transactions
              SET category_id = ${newCat}
              WHERE id = ${row.id}
            `);
            updatedTransactions++;
          }
        }
      }
    }

    logger.info('catalog.backfill.transactions_done', { count: updatedTransactions });

    return { updatedLineItems, updatedTransactions, errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Backfill failed: ${msg}`);
    logger.error('catalog.backfill.fatal', errorContext(e));
    return { updatedLineItems, updatedTransactions, errors };
  }
}
