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
 *      the items that ACTUALLY SOLD in the window. Sales are grouped by the
 *      parent Square ITEM (`parent_item_id`), so every variation of an item
 *      (Pint/Tall/Pitcher, "- Regular", …) rolls up into ONE row shown under
 *      the bare item name. The two intentional online vs POS duplicate ITEMs
 *      stay SEPARATE rows — they are distinct Square objects with distinct
 *      parent_item_id values, so each channel can be tracked on its own.
 *      `(KDS)` items and any row with revenue === 0 are dropped. (Zero-sales
 *      items are intentionally excluded here; they remain available for the
 *      planned per-category BI drill-down.)
 *
 * Design notes:
 *   - We don't hardcode "Food" / "Beverage". Any category that has at
 *     least one child becomes a rollup. That keeps the tab in sync with
 *     whatever Square is configured to do without code changes.
 *   - Aggregation joins `order_line_items` against `orders.created_at`
 *     using the same Eastern-time business window the rest of the
 *     dashboard uses, so numbers match the Overview tab.
 *   - Square line items reference variation IDs (`product_id`); we map each
 *     to its parent ITEM via `square_catalog_items.parent_item_id` to roll a
 *     multi-variation item's sales together under one display name.
 */
import { db } from '../db';
import { sql } from 'drizzle-orm';
import { getEasternDateRange } from '../dateUtils';
import type {
  CategoryTreeNode,
  CategoryRevenueTotal,
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

    // Group sales by the parent Square ITEM. Each line item references a
    // variation ID (`oli.product_id`); joining to the catalog maps it to its
    // parent ITEM (`parent_item_id`) and bare display name, so all variations
    // of one item sum into a single row. The intentional online vs POS twins
    // are DIFFERENT Square ITEM objects (different parent_item_id), so they
    // remain separate rows and each channel stays independently trackable.
    // INNER JOIN to sales returns only items that actually sold in the window.
    const result = await db.execute<{
      item_key: string;
      display_name: string | null;
      category_id: string | null;
      category_name: string | null;
      source: string | null;
      revenue: string | number | null;
      units: string | number | null;
      transactions: string | number | null;
    }>(sql`
      WITH catalog AS (
        SELECT
          square_catalog_object_id,
          COALESCE(parent_item_id, square_catalog_object_id) AS item_key,
          COALESCE(item_base_name, item_name)                AS display_name,
          category_id,
          category_name
        FROM square_catalog_items
        WHERE is_archived = false
          AND item_name NOT ILIKE '%(KDS)%'
          AND category_id IN (${sql.join(categoryIds.map(id => sql`${id}`), sql.raw(', '))})
      ),
      sales AS (
        SELECT
          c.item_key,
          c.display_name,
          c.category_id,
          c.category_name,
          o.source,
          COALESCE(SUM(oli.total_money), 0) AS revenue,
          COALESCE(SUM(oli.quantity), 0)    AS units,
          COUNT(DISTINCT oli.order_id)      AS transactions
        FROM order_line_items oli
        INNER JOIN orders o   ON o.id = oli.order_id
        INNER JOIN catalog c  ON c.square_catalog_object_id = oli.product_id
        WHERE oli.product_id IS NOT NULL
          AND o.created_at >= ${start}
          AND o.created_at <  ${end}
        GROUP BY c.item_key, c.display_name, c.category_id, c.category_name, o.source
      )
      SELECT item_key, display_name, category_id, category_name, source,
             revenue, units, transactions
      FROM sales
    `);

    // Roll the per-(item, source) rows up into one RankedItem per parent ITEM.
    // Each order belongs to exactly one source, so summing per-source distinct
    // order counts yields the item's true distinct-order (transactions) total.
    const byItem = new Map<string, RankedItem>();
    for (const r of result.rows) {
      const itemKey = r.item_key;
      const revenue = Number(r.revenue ?? 0);
      const units = Number(r.units ?? 0);
      const transactions = Number(r.transactions ?? 0);

      let item = byItem.get(itemKey);
      if (!item) {
        item = {
          catalogObjectId: itemKey,
          itemName: r.display_name ?? 'Unnamed Item',
          categoryId: r.category_id,
          categoryName: r.category_name,
          revenue: 0,
          units: 0,
          transactions: 0,
          shareOfCategory: 0,
          shareOfTotal: 0,
          sourceBreakdown: [],
        };
        byItem.set(itemKey, item);
      }

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

    // Main Items tab only lists items that actually sold — hide $0-revenue rows.
    // (Zero-sales items remain available for the future per-category BI drill-down.)
    const items = Array.from(byItem.values()).filter((item) => item.revenue !== 0);

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

  /**
   * Return total revenue per top-level rollup category for the given date
   * window. Uses a two-level join (category → parent category) to map every
   * leaf category up to its rollup, then aggregates in a single query.
   * Only non-archived, non-KDS items with a matching order line item are
   * counted, consistent with getRankedItems.
   */
  async getCategoryRevenueTotals(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
  ): Promise<CategoryRevenueTotal[]> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);

    const result = await db.execute<{
      rollup_id: string;
      rollup_name: string;
      revenue: string | number | null;
    }>(sql`
      WITH RECURSIVE cat_ancestry AS (
        -- Anchor: top-level categories roll up to themselves
        SELECT
          square_category_id AS leaf_id,
          square_category_id AS rollup_id,
          name               AS rollup_name
        FROM square_categories
        WHERE parent_category_id IS NULL

        UNION ALL

        -- Recursive: each child inherits its parent's rollup
        SELECT
          c.square_category_id AS leaf_id,
          ca.rollup_id,
          ca.rollup_name
        FROM square_categories c
        INNER JOIN cat_ancestry ca
          ON ca.leaf_id = c.parent_category_id
      )
      SELECT
        ca.rollup_id,
        ca.rollup_name,
        COALESCE(SUM(oli.total_money), 0) AS revenue
      FROM order_line_items oli
      INNER JOIN orders o
        ON o.id = oli.order_id
      INNER JOIN square_catalog_items sci
        ON sci.square_catalog_object_id = oli.product_id
      INNER JOIN cat_ancestry ca
        ON ca.leaf_id = sci.category_id
      WHERE o.created_at  >= ${start}
        AND o.created_at  <  ${end}
        AND oli.product_id IS NOT NULL
        AND sci.is_archived = false
        AND sci.item_name NOT ILIKE '%(KDS)%'
      GROUP BY ca.rollup_id, ca.rollup_name
      ORDER BY revenue DESC
    `);

    return result.rows.map((r) => ({
      categoryId: r.rollup_id,
      categoryName: r.rollup_name,
      revenue: Number(r.revenue ?? 0),
    }));
  }
}

export const itemsService = new ItemsService();
