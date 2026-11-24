// Exercise the tools WITHOUT the LLM. If retrieval is wrong here, no prompt will fix it.
import { runTool } from '../src/tools.js';

const cases = [
  ['search_products', { query: 'hammer drill for concrete', voltage: 18, max_price: 200 }],
  ['search_products', { query: 'GSR18V-535' }],
  ['search_products', { query: 'drill', voltage: 12, max_price: 20, category: 'Power Tools' }], // impossible -> relaxations
  ['search_products', { subcategory: 'Drills & Drivers', spec_filters: [{ key: 'max_torque_in_lbs', op: '>=', value: 1000 }], sort: 'price_asc', limit: 3 }],
  ['search_products', { query: 'tile cutting' }],
  ['get_product_details', { identifier: 'GBA18V20' }], // discontinued -> replacement
  ['get_product_details', { identifier: '000346313673' }], // duplicate UPC -> ambiguous
  ['get_product_details', { identifier: 'DCD771' }], // competitor model -> not found
  ['compare_products', { identifiers: ['GSR12V-800N', 'GBA18V40'] }],
  ['find_compatible_products', { identifier: 'GSR12V-800N' }],
  ['find_compatible_products', { identifier: 'GBA18V40' }],
  ['get_catalog_overview', { category: 'Measuring Tools' }],
];

const short = (o) => JSON.stringify(o, (k, v) => (k === 'short_description' || k === 'url' ? undefined : v), 1).slice(0, 1400);
for (const [name, args] of cases) {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  console.log(short(await runTool(name, args)));
}
