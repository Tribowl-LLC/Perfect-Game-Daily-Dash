---
name: Square online/POS catalog duplicates
description: How to identify the intentional online-menu vs POS duplicate items in this Square catalog (no shared SKU exists)
---

# Square online/POS catalog duplicates

For (nearly) every food item, this merchant intentionally maintains **two
separate Square catalog ITEM objects** — one wired to the online-ordering menu,
one to the in-store POS. They are NOT linked by any shared identifier.

**Confirmed from the live catalog (June 2026):** within a duplicate pair the
name, category, and price are identical; `sku` and `upc` are `null` (only ~5
items in the whole catalog have a SKU, none on duplicates). The ONLY field that
differs is the internal Square object ID. There is no product code, GTIN, or
relationship that ties the two copies together.

**Consequence / rule:** the only reliable key to collapse a true duplicate is
**normalized name + category + price**. Matching on name alone is wrong (it
would merge two genuinely different items that happen to share a name); there is
no finer-grained "same item" key available because Square stores none.

**Why price works as the discriminator:** across all 35 duplicate groups, every
pair shares an identical price, so adding price never splits a real duplicate;
and zero same-name+category groups have differing prices, so it changes nothing
today while guarding against a future name collision between different items.

**How to apply:** `itemsService.getRankedItems` merges by name+category+price.
The price lives in `square_catalog_items.price_amount` (cents, nullable for
variable-price/parent rows), populated by `catalogService.syncCatalog()`. The
two copies are distinguishable only by *where they sell* — the order `source`
(Online vs POS) — which is why the merged row shows a combined source mix.

**Drizzle upsert gotcha hit here:** adding a new column to the schema is not
enough — `catalogService` upserts catalog rows with `onConflictDoUpdate`, and
the new column MUST be added to its `set:` clause or existing rows (the common
case, since the catalog already exists) never receive the value on re-sync.
