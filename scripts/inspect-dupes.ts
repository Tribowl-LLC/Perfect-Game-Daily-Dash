import { SquareClient, SquareEnvironment } from 'square';

const client = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN!,
  environment: SquareEnvironment.Production,
});

function topLevelKeys(obj: any): string[] {
  return obj ? Object.keys(obj) : [];
}

async function main() {
  const items: any[] = [];
  const page: any = await client.catalog.list({ types: 'ITEM' });
  for await (const obj of page) items.push(obj);

  console.log('TOTAL ITEMS fetched (all pages):', items.length);

  // Group by lowercased name
  const byName = new Map<string, any[]>();
  for (const it of items) {
    const name = (it.itemData?.name || '').trim().toLowerCase();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(it);
  }

  const dupGroups = [...byName.entries()].filter(([, arr]) => arr.length > 1);
  console.log('DUPLICATE NAME GROUPS:', dupGroups.length);

  // ---- Catalog-wide identifier census ----
  let varCount = 0, withSku = 0, withUpc = 0, withGtin = 0;
  for (const it of items) {
    for (const v of (it.itemData?.variations || [])) {
      varCount++;
      const vd = v.itemVariationData || {};
      if (vd.sku) withSku++;
      if (vd.upc) withUpc++;
      if ((vd as any).gtin) withGtin++;
    }
  }
  console.log(`\nIDENTIFIER CENSUS: ${varCount} variations | sku:${withSku} upc:${withUpc} gtin:${withGtin}`);

  // ---- For each dup group: does exactly one twin carry the ecom signature? ----
  const isEcom = (it: any) => Boolean(it.itemData?.ecomUri) || it.itemData?.ecom_available === true || it.itemData?.ecomAvailable === true;
  const priceSig = (it: any) => (it.itemData?.variations || []).map((v: any) => `${v.itemVariationData?.name || ''}=${v.itemVariationData?.priceMoney?.amount ?? '∅'}`).sort().join(',');
  let cleanSplit = 0, sameName2 = 0, dupWithSku = 0, samePrice = 0;
  for (const [, arr] of dupGroups) {
    if (arr.length === 2) {
      sameName2++;
      const ecomCount = arr.filter(isEcom).length;
      if (ecomCount === 1) cleanSplit++;
      if (priceSig(arr[0]) === priceSig(arr[1])) samePrice++;
    }
    for (const it of arr) for (const v of (it.itemData?.variations || [])) if (v.itemVariationData?.sku) dupWithSku++;
  }
  console.log(`DUP GROUPS (exactly 2): ${sameName2} | same price-sig: ${samePrice} | exactly-one-ecom-twin: ${cleanSplit} | any dup variation w/ sku: ${dupWithSku}`);


  // Examine up to 3 duplicate groups in full
  for (const [name, arr] of dupGroups.slice(0, 3)) {
    console.log('\n==================================================');
    console.log('DUP GROUP NAME:', JSON.stringify(name), 'count=', arr.length);
    for (const it of arr) {
      console.log('\n  --- ITEM object id:', it.id);
      console.log('  top-level keys:', topLevelKeys(it).join(', '));
      console.log('  itemData keys:', topLevelKeys(it.itemData).join(', '));
      const d = it.itemData || {};
      console.log('  ecomUri:', d.ecomUri);
      console.log('  ecomImageUris:', JSON.stringify(d.ecomImageUris));
      console.log('  imageIds:', JSON.stringify(d.imageIds));
      console.log('  channels:', JSON.stringify(d.channels));
      console.log('  productType:', d.productType);
      console.log('  presentAtAllLocations:', it.presentAtAllLocations);
      console.log('  presentAtLocationIds:', JSON.stringify(it.presentAtLocationIds));
      console.log('  customAttributeValues:', JSON.stringify(it.customAttributeValues, null, 2));
      console.log('  catalogV1Ids:', JSON.stringify(it.catalogV1Ids));
      const vars = d.variations || [];
      for (const v of vars) {
        const vd = v.itemVariationData || {};
        console.log('    VAR id:', v.id, '| sku:', vd.sku, '| upc:', vd.upc, '| gtin:', (vd as any).gtin, '| name:', vd.name, '| price:', vd.priceMoney?.amount, '| customAttr:', JSON.stringify(v.customAttributeValues));
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
