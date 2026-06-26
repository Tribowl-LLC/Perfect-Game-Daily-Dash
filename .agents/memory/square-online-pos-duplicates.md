---
name: Square online/POS catalog duplicates & variation rollup
description: How the Items-by-Category tab groups item sales — keep online/POS twins separate, roll variations up by parent ITEM
---

# Square online/POS duplicates & variation rollup

For (nearly) every food item, this merchant intentionally maintains **two
separate Square catalog ITEM objects** — one wired to the online-ordering menu,
one to the in-store POS. They are NOT linked by any shared identifier (within a
twin pair name/category/price are identical; `sku`/`upc` are null — only ~5
items catalog-wide have a SKU, none on twins; the only differing field is the
Square object ID).

## The owner's rule (decided June 2026)
- **DO NOT merge the online vs POS twins.** They must stay as SEPARATE rows so
  each channel's sales are tracked independently.
- **DO merge all variations of the SAME item into one row** (e.g. "Absolut" +
  "Absolut - Regular"; or a beer's Pint/Tall/Pitcher/Beer Tube), displayed
  under the bare item name.

**Why:** an earlier "merge by name+category+price" approach was explicitly
rejected — it collapsed the two intentional twins (they share name+category+
price) into one, destroying the per-channel split the owner needs.

## How it works now
Square's own hierarchy is the key, no heuristics:
- Order line items reference a **variation** id (`order_line_items.product_id`).
- Each variation maps to its parent **ITEM** via
  `square_catalog_items.parent_item_id` (= the ITEM object id; for a
  no-variation item, its own id). `item_base_name` holds the bare item name.
- `itemsService.getRankedItems` groups sales by
  `COALESCE(parent_item_id, square_catalog_object_id)` and displays
  `item_base_name`. Variations roll up; the two twins stay separate because they
  are different ITEM objects → different `parent_item_id`.
- `item_name` is left in the suffixed "Item - Variation" form because
  `catalogService`'s parent-prune `LIKE parent||' - %'` depends on it.

**`transactions` correctness:** computed as COUNT(DISTINCT order_id) per
(item, source) in SQL, then summed across sources in JS. Each order has exactly
one source, so summing per-source distinct counts equals the item's true
distinct-order total (and one order buying two variations of the same item now
counts once, since variations are grouped before the distinct count).

## Drizzle upsert gotcha (re-learned)
Adding a column to the schema is not enough — `catalogService` upserts with
`onConflictDoUpdate`, and any new column MUST be added to its `set:` clause or
existing rows (the common case) never get the value on re-sync. After a schema
change, re-run `syncCatalog()` to backfill the new columns before relying on
them; `getRankedItems` uses `COALESCE(...)` fallbacks so it degrades safely
until the backfill lands.
