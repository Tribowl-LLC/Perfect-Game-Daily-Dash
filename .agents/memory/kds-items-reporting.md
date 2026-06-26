---
name: KDS items in Square catalog
description: Why "(KDS)" items must be excluded from BOTH item rows and totals denominators in Items-by-Category reporting
---

# KDS (kitchen display system) items

Square catalog items whose name contains `(KDS)` are internal kitchen-display
duplicates of real menu items. They always record **$0 revenue** but they DO
carry non-zero **quantity (units) and order counts (transactions)** in
`order_line_items`.

**Rule:** any item-level report that computes a `% Total` or share must exclude
KDS items from *both* the visible rows AND the all-items denominator
(`totalsResult`), or units/transactions percentages will be wrong even though
revenue looks fine.

**Why:** a $0-revenue filter alone is not enough — KDS lines have phantom
units/transactions. Confirmed via DB: ~40 KDS catalog items, 0 revenue but
thousands of units and hundreds of transactions.

**How to apply:** filter `item_name NOT ILIKE '%(KDS)%'` on the
`square_catalog_items` rows and add a matching `NOT EXISTS` against the catalog
on any `order_line_items` aggregation used as a denominator
(`itemsService.getRankedItems`).
