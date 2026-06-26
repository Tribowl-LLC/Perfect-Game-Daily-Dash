/**
 * Items-by-category performance service (Task #188)
 *
 * Powers the Dashboard "Items" tab. Two responsibilities:
 *
 *   1. `getCategoryTree()` — return Square's category hierarchy as an
 *      arbitrarily-deep tree. The UI uses the top-level rollups (e.g.
 *      "Food", "Beverage") for the side-by-side panels and renders the
 *      sub-categories as the per-panel dropdown.
 *
 *   2. `getRankedItems({ categoryId, metric, dateRange })` — for the
 *      given category (rollup OR specific child), return a ranked list of
 *      the items that ACTUALLY SOLD in the window. Catalog rows are
 *      LEFT JOINed against windowed sales, the online/POS duplicate
 *      objects are merged by name + category + price, then `(KDS)` items
 *      and any row with revenue === 0 are dropped. (Zero-sales items are
 *      intentionally excluded here; they remain available for the planned
 *      per-category BI drill-down.)
 *
 * Design notes:
 *   - We don't hardcode "Food" / "Beverage". Any category that has at
 *     least one child becomes a rollup. That keeps the tab in sync with
 *     whatever Square is configured to do without code changes.
 *   - Aggregation joins `order_line_items` against `orders.created_at`
 *     using the same Eastern-time business window the rest of the
 *     dashboard uses, so numbers match the Overview tab.
 *   - Item-level joins use `product_id` → `square_catalog_object_id`
 *     because Square line items reference variation IDs and our catalog
 *     cache stores both items and their variations under the same key.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getEasternDateRange } from '../dateUtils';
import type {
  CategoryTreeNode,
  DateRange,
  ItemSourceBreakdown,
  ItemMetric,
  RankedItem,
} from '../../shared/schema';

function normalizeSource(source: string | null): string {
  const clean = (source ?? '').trim();
  if (!clean) return 'POS';

  const lower = clean.toLowerCase();
  if (
    lower.includes('online') ||
    lower.includes('web') ||
    lower.includes('pickup') ||
    lower.includes('delivery')
  ) {
    return 'Online';
  }
  if (
    lower.includes('point of sale') ||
    lower.includes('pos') ||
    lower.includes('register') ||
    lower.includes('terminal')
  ) {
    return 'POS';
  }
  return clean;
}

export class ItemsService {
  /**
   * Build the category hierarchy from `square_categories`. Returns the
   * forest of top-level (NULL parent) nodes, each with their full
   * descendant tree. Categories whose parent ID points to a row that
   * doesn't exist locally are promoted to top-level so they remain
   * reachable in the UI.
   */
  async getCategoryTree(): Promise<CategoryTreeNode[]> {
    const rows = await db.execute<{
      square_category_id: string;
      name: string;
      parent_category_id: string | null;
    }>(sql`
      SELECT square_category_id, name, parent_category_id
      FROM square_categories
      ORDER BY name ASC
    `);

    const byId = new Map<string, CategoryTreeNode>();
    for (const row of rows.rows) {
      byId.set(row.square_category_id, {
        squareCategoryId: row.square_category_id,
        name: row.name,
        children: [],
      });
    }

    const roots: CategoryTreeNode[] = [];
    for (const row of rows.rows) {
      const node = byId.get(row.square_category_id)!;
      const parentId = row.parent_category_id;
      if (parentId && byId.has(parentId)) {
        byId.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    // Stable alphabetical ordering at every level — operators expect
    // categories in a predictable order across loads.
    const sortRec = (nodes: CategoryTreeNode[]) => {
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      for (const n of nodes) sortRec(n.children);
    };
    sortRec(roots);
    return roots;
  }

  /**
   * Collect a category ID and all of its descendants into a flat list.
   * Used to expand a rollup selection into the set of leaf categories
   * whose items should be included.
   */
  private collectCategoryIds(
    rootId: string,
    nodes: CategoryTreeNode[],
  ): string[] {
    const out: string[] = [];
    const walk = (n: CategoryTreeNode) => {
      out.push(n.squareCategoryId);
      for (const c of n.children) walk(c);
    };
    const find = (list: CategoryTreeNode[]): CategoryTreeNode | null => {
      for (const n of list) {
        if (n.squareCategoryId === rootId) return n;
        const inner = find(n.children);
        if (inner) return inner;
      }
      return null;
    };
    const root = find(nodes);
    if (root) walk(root);
    return out;
  }

  /**
   * Return every non-archived item belonging to `categoryId` (or any of
   * its descendant categories) with revenue / units / transactions
   * aggregated over the requested business-date window. Items with zero
   * sales in the window still appear (metric values default to 0).
   *
   * `metric` only controls the ORDER BY direction, not the projection —
   * the response always carries all three numbers so the client can
   * switch metrics without an extra round-trip.
   */
  async getRankedItems(
    categoryId: string,
    metric: ItemMetric,
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
  ): Promise<RankedItem[]> {
    const tree = await this.getCategoryTree();
    const categoryIds = this.collectCategoryIds(categoryId, tree);
    if (categoryIds.length === 0) return [];

    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const totalsResult = await db.execute<{
      revenue: string | number | null;
      units: string | number | null;
      transactions: string | number | null;
    }>(sql`
      SELECT
        COALESCE(SUM(oli.total_money), 0) AS revenue,
        COALESCE(SUM(oli.quantity), 0) AS units,
        COUNT(DISTINCT oli.order_id) AS transactions
      FROM order_line_items oli
      INNER JOIN orders o ON o.id = oli.order_id
      WHERE oli.product_id IS NOT NULL
        AND o.created_at >= ${start}
        AND o.created_at <  ${end}
        AND NOT EXISTS (
          SELECT 1 FROM square_catalog_items sci
          WHERE sci.square_catalog_object_id = oli.product_id
            AND sci.item_name ILIKE '%(KDS)%'
        )
    `);
    const totalMetrics = {
      revenue: Number(totalsResult.rows[0]?.revenue ?? 0),
      units: Number(totalsResult.rows[0]?.units ?? 0),
      transactions: Number(totalsResult.rows[0]?.transactions ?? 0),
    };

    // LEFT JOIN catalog items against the windowed sales aggregation so a row
    // exists per catalog object even before merging (zero-sales rows are
    // filtered out later, after the duplicate merge, so a sold variation is
    // never dropped because a $0 duplicate copy shared its key). We keep
    // source-level sales rows separate so the UI can show Online vs POS mix.
    const result = await db.execute<{
      catalog_object_id: string;
      item_name: string | null;
      category_id: string | null;
      category_name: string | null;
      price_amount: string | number | null;
      source: string | null;
      revenue: string | number | null;
      units: string | number | null;
      transactions: string | number | null;
    }>(sql`
      WITH category_items AS (
        SELECT
          square_catalog_object_id,
          item_name,
          category_id,
          category_name,
          price_amount
        FROM square_catalog_items
        WHERE is_archived = false
          AND item_name NOT ILIKE '%(KDS)%'
          AND category_id IN (${sql.join(categoryIds.map(id => sql`${id}`), sql.raw(', '))})
      ),
      sales AS (
        SELECT
          oli.product_id AS catalog_object_id,
          o.source,
          COALESCE(SUM(oli.total_money), 0) AS revenue,
          COALESCE(SUM(oli.quantity), 0) AS units,
          COUNT(DISTINCT oli.order_id) AS transactions
        FROM order_line_items oli
        INNER JOIN orders o ON o.id = oli.order_id
        WHERE oli.product_id IS NOT NULL
          AND o.created_at >= ${start}
          AND o.created_at <  ${end}
        GROUP BY oli.product_id, o.source
      )
      SELECT
        ci.square_catalog_object_id AS catalog_object_id,
        ci.item_name,
        ci.category_id,
        ci.category_name,
        ci.price_amount,
        s.source,
        COALESCE(s.revenue, 0)       AS revenue,
        COALESCE(s.units, 0)         AS units,
        COALESCE(s.transactions, 0)  AS transactions
      FROM category_items ci
      LEFT JOIN sales s ON s.catalog_object_id = ci.square_catalog_object_id
    `);

    const byItem = new Map<string, RankedItem>();
    // Current catalog price (cents) per catalog object, used as a merge-key
    // component so only true online/POS duplicates (identical name + category
    // + price) collapse — a different item sharing a name but priced
    // differently stays its own row. Null prices fall back to name+category.
    const priceByCatalogObject = new Map<string, number | null>();
    for (const r of result.rows) {
      const catalogObjectId = r.catalog_object_id;
      if (!priceByCatalogObject.has(catalogObjectId)) {
        priceByCatalogObject.set(
          catalogObjectId,
          r.price_amount != null ? Number(r.price_amount) : null,
        );
      }
      let item = byItem.get(catalogObjectId);
      if (!item) {
        item = {
          catalogObjectId,
          itemName: r.item_name ?? 'Unnamed Item',
          categoryId: r.category_id,
          categoryName: r.category_name,
          revenue: 0,
          units: 0,
          transactions: 0,
          shareOfCategory: 0,
          shareOfTotal: 0,
          sourceBreakdown: [],
        };
        byItem.set(catalogObjectId, item);
      }

      const revenue = Number(r.revenue ?? 0);
      const units = Number(r.units ?? 0);
      const transactions = Number(r.transactions ?? 0);
      item.revenue += revenue;
      item.units += units;
      item.transactions += transactions;

      if (revenue !== 0 || units !== 0 || transactions !== 0) {
        const source = normalizeSource(r.source);
        let sourceRow = item.sourceBreakdown.find((s) => s.source === source);
        if (!sourceRow) {
          sourceRow = { source, revenue: 0, units: 0, transactions: 0 };
          item.sourceBreakdown.push(sourceRow);
        }
        sourceRow.revenue += revenue;
        sourceRow.units += units;
        sourceRow.transactions += transactions;
      }
    }

    const rawItems = Array.from(byItem.values());

    // Determine which base names genuinely have a different (non-Regular) sibling.
    // Two copies of "Boneless Wings - Regular" do NOT count — both are Regular.
    const basesWithNonRegularSibling = new Set<string>();
    for (const item of rawItems) {
      const base = item.itemName.replace(/ - Regular$/i, '');
      if (base === item.itemName) continue;
      const hasNonRegular = rawItems.some(
        other => other.catalogObjectId !== item.catalogObjectId &&
          other.itemName.startsWith(base + ' - ') &&
          !/- Regular$/i.test(other.itemName)
      );
      if (hasNonRegular) basesWithNonRegularSibling.add(base);
    }

    // Normalize display names (strip "- Regular" when no non-Regular sibling exists),
    // then merge any rows that share the same normalized name + category + price —
    // collapsing the intentional online/POS duplicate Square objects (identical in
    // every catalog attribute, no shared SKU) into one row, while keeping a
    // genuinely different item that merely shares a name but is priced differently.
    const mergedByKey = new Map<string, RankedItem>();
    for (const item of rawItems) {
      const base = item.itemName.replace(/ - Regular$/i, '');
      const displayName = basesWithNonRegularSibling.has(base) ? item.itemName : base;
      const price = priceByCatalogObject.get(item.catalogObjectId);
      const priceKey = price != null ? String(price) : '';
      const mergeKey = `${displayName}|||${item.categoryId ?? ''}|||${priceKey}`;
      const existing = mergedByKey.get(mergeKey);
      if (existing) {
        existing.revenue += item.revenue;
        existing.units += item.units;
        existing.transactions += item.transactions;
        for (const src of item.sourceBreakdown) {
          let row = existing.sourceBreakdown.find(s => s.source === src.source);
          if (!row) {
            row = { source: src.source, revenue: 0, units: 0, transactions: 0 };
            existing.sourceBreakdown.push(row);
          }
          row.revenue += src.revenue;
          row.units += src.units;
          row.transactions += src.transactions;
        }
      } else {
        mergedByKey.set(mergeKey, { ...item, itemName: displayName });
      }
    }

    // Main Items tab only lists items that actually sold — hide $0-revenue
    // rows. Filter after merging so a sold variation isn't dropped just
    // because a duplicate $0 copy existed. (Zero-sales items will still be
    // available for the future per-category BI drill-down.)
    const items = Array.from(mergedByKey.values()).filter((item) => item.revenue !== 0);

    const selectedMetricValue = (i: RankedItem | ItemSourceBreakdown | typeof totalMetrics) =>
      metric === 'revenue' ? i.revenue
      : metric === 'units' ? i.units
      : i.transactions;

    const categoryTotal = items.reduce((sum, item) => sum + selectedMetricValue(item), 0);
    const allItemsTotal = selectedMetricValue(totalMetrics);

    for (const item of items) {
      const value = selectedMetricValue(item);
      item.shareOfCategory = categoryTotal > 0 ? value / categoryTotal : 0;
      item.shareOfTotal = allItemsTotal > 0 ? value / allItemsTotal : 0;
      item.sourceBreakdown.sort((a, b) => selectedMetricValue(b) - selectedMetricValue(a));
    }

    // Sort in JS so the chosen metric is the primary key and the other
    // metrics break ties consistently. Item name is the final tiebreaker
    // so identical-zero rows render in a stable alphabetical order.
    const key = (i: RankedItem) =>
      metric === 'revenue' ? i.revenue
      : metric === 'units' ? i.units
      : i.transactions;
    items.sort((a, b) => {
      const diff = key(b) - key(a);
      if (diff !== 0) return diff;
      return a.itemName.localeCompare(b.itemName);
    });
    return items;
  }
}

export const itemsService = new ItemsService();
