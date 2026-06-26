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
    // Track every Square category ID seen in this sync so we can prune
    // stale rows that were deleted or reorganised away in Square.
    const seenCategoryIds = new Set<string>();

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
          seenCategoryIds.add(catId);
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

      // Delete any categories in the DB that Square no longer returns —
      // these are categories that were deleted or reorganised away. Keeping
      // them causes phantom children to appear in the tree and pollutes the
      // Items tab dropdown.
      if (seenCategoryIds.size > 0) {
        const seenArray = Array.from(seenCategoryIds);
        const deleted = await db.execute<{ count: string }>(sql`
          WITH removed AS (
            DELETE FROM square_categories
            WHERE square_category_id != ALL(${seenArray})
            RETURNING 1
          )
          SELECT COUNT(*)::text AS count FROM removed
        `);
        const deletedCount = parseInt(deleted.rows[0]?.count ?? '0', 10);
        if (deletedCount > 0) {
          logger.info('catalog.sync.stale_categories_pruned', { count: deletedCount });
        }
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

          if (itemData.reportingCategory?.id) {
            categoryId = itemData.reportingCategory.id;
            if (categoryId && categoryMap.has(categoryId)) {
              categoryName = categoryMap.get(categoryId)!;
            }
          }

          if (!categoryId && itemData.categories && itemData.categories.length > 0) {
            const firstCat = itemData.categories[0];
            categoryId = firstCat.id || null;
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

          // Only store the parent ITEM row when it has no variations.
          // Square order line items always reference a specific variation ID
          // (never the parent ITEM ID itself), so a parent row with variations
          // would always show zero sales and — after the UI strips " - Regular" —
          // create a duplicate display name with no revenue.
          if (!itemData.variations || itemData.variations.length === 0) {
            pageItems.push({
              squareCatalogObjectId: catalogObjectId,
              categoryId,
              categoryName,
              itemName,
              isArchived,
              updatedAt: new Date(),
            } satisfies InsertSquareCatalogItem);
          }

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

    // Purge any lingering parent ITEM rows that have a "- <variant>" sibling
    // in the same category and no sales. These accumulate when Square re-syncs
    // an item that has variations — the parent ITEM ID never appears in order
    // line items (Square sells the variation, not the parent), so these rows
    // only create zero-revenue duplicates in the Items tab.
    try {
      const pruneResult = await db.execute<{ count: string }>(sql`
        WITH deleted AS (
          DELETE FROM square_catalog_items parent
          WHERE NOT EXISTS (
            SELECT 1 FROM order_line_items oli
            WHERE oli.product_id = parent.square_catalog_object_id
          )
          AND EXISTS (
            SELECT 1 FROM square_catalog_items sibling
            WHERE sibling.category_id = parent.category_id
              AND sibling.item_name LIKE parent.item_name || ' - %'
              AND sibling.square_catalog_object_id != parent.square_catalog_object_id
          )
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `);
      const pruned = parseInt(pruneResult.rows[0]?.count ?? '0', 10);
      if (pruned > 0) {
        logger.info('catalog.sync.parent_items_pruned', { count: pruned });
      }
    } catch (e) {
      logger.warn('catalog.sync.parent_prune_failed', errorContext(e));
    }

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

    // Bulk-update order_line_items: join directly against square_catalog_items
    // rather than fetching every row into JS and updating one at a time.
    const lineItemRes = await db.execute<{ count: string }>(sql`
      WITH updated AS (
        UPDATE order_line_items oli
        SET category = sci.category_name
        FROM square_catalog_items sci
        WHERE oli.product_id = sci.square_catalog_object_id
          AND sci.category_name IS NOT NULL
          AND oli.category IS DISTINCT FROM sci.category_name
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM updated
    `);
    updatedLineItems = parseInt(lineItemRes.rows[0]?.count ?? '0', 10);
    logger.info('catalog.backfill.lineItems_done', { count: updatedLineItems });

    // Bulk-update transactions: resolve orderId from square_data JSONB,
    // join to the order's first categorised line item.
    const txRes = await db.execute<{ count: string }>(sql`
      WITH first_cat AS (
        SELECT DISTINCT ON (o.square_id)
          o.square_id,
          sci.category_name
        FROM orders o
        JOIN order_line_items oli ON oli.order_id = o.id AND oli.product_id IS NOT NULL
        JOIN square_catalog_items sci ON sci.square_catalog_object_id = oli.product_id
        WHERE sci.category_name IS NOT NULL
        ORDER BY o.square_id, oli.id
      ),
      updated AS (
        UPDATE transactions t
        SET category_id = fc.category_name
        FROM first_cat fc
        WHERE (t.square_data->>'orderId') = fc.square_id
          AND t.category_id IS DISTINCT FROM fc.category_name
        RETURNING 1
      )
      SELECT COUNT(*)::text AS count FROM updated
    `);
    updatedTransactions = parseInt(txRes.rows[0]?.count ?? '0', 10);
    logger.info('catalog.backfill.transactions_done', { count: updatedTransactions });

    return { updatedLineItems, updatedTransactions, errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Backfill failed: ${msg}`);
    logger.error('catalog.backfill.fatal', errorContext(e));
    return { updatedLineItems, updatedTransactions, errors };
  }
}
