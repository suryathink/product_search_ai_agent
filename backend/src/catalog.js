// Data layer: load the CSV once, normalize every row into a clean, typed product object,
// and build lookup indexes. Nothing else in the app touches raw CSV strings.
import fs from 'node:fs';
import { parse } from 'csv-parse/sync';
import { getLogger } from './logger.js';
import { paths } from './configs/index.js';

const logger = getLogger('catalog');

/** data/ folder (configs/paths.js). */
export const DATA_DIR = paths.dataDir;
const CSV_PATH = paths.catalogCsv;

/**
 * A cleaned-up catalog product. Every other module works with this shape, never with raw CSV rows.
 * @typedef {object} Product
 * @property {string} sku                  Unique SKU (string — keeps leading zeros)
 * @property {string} model                Model number, e.g. "GSR18V-535CN"
 * @property {string} upc                  Barcode (NOT unique in this data set)
 * @property {string} brand                Bosch | Dremel | RotoZip | CST/berger
 * @property {string} name                 Product name as shown on the website
 * @property {string} category             Top-level category, e.g. "Power Tools"
 * @property {string} subcategory          e.g. "Drills & Drivers"
 * @property {string} productType          e.g. "Impact Driver"
 * @property {string|null} productLine     e.g. "18V System", "PROFACTOR"
 * @property {string} status               Active | Discontinued | Temporarily Out of Stock | Coming Soon
 * @property {string|null} launchDate
 * @property {string|null} discontinuedDate
 * @property {string|null} replacementModel Model number of the successor (discontinued items)
 * @property {number|null} price           MSRP in USD
 * @property {string} shortDescription
 * @property {string|null} longDescription
 * @property {string[]} keyFeatures
 * @property {string[]} inTheBox
 * @property {string} powerSource
 * @property {number|null} voltage          4 | 12 | 18 | 120
 * @property {string|null} batteryPlatform  e.g. "Bosch 18V (CORE18V / PROFACTOR compatible)"
 * @property {boolean|null} batteryIncluded
 * @property {string|null} motorType       Brushless | Brushed
 * @property {number|null} weightLbs
 * @property {string|null} dimensionsIn
 * @property {string[]} compatibleWith      Free-text compatibility phrases, e.g. ["SDS-plus rotary hammers"]
 * @property {Record<string, any>} specs    Category-specific technical specs (parsed JSON, imperial units)
 * @property {string|null} kitType          "Bare tool" or "Kit with (2) 4.0 Ah batteries" etc.
 * @property {string} connectivity
 * @property {string} warranty
 * @property {string|null} certifications
 * @property {string} countryOfOrigin
 * @property {number|null} rating           null when there are no reviews (never 0 stars)
 * @property {number} reviewCount
 * @property {string[]} retailers
 * @property {string} url                   Product page (mock URL)
 * @property {string|null} imageUrl
 * @property {string} lastUpdated
 */

/**
 * Split a pipe-separated CSV cell into a clean list.
 * @param {string} s  e.g. "Fits all 18V tools | 2 Ah capacity"
 * @returns {string[]} e.g. ["Fits all 18V tools", "2 Ah capacity"]; [] for an empty cell
 */
const splitList = (s) => (s ? s.split('|').map((x) => x.trim()).filter(Boolean) : []);

/**
 * Parse a CSV cell as a number.
 * @param {string} s
 * @returns {number|null} the number, or null for empty / non-numeric cells (so "missing" never becomes 0)
 */
const num = (s) => (s === '' || s == null || Number.isNaN(Number(s)) ? null : Number(s));

/**
 * Parse a "Yes"/"No" CSV cell.
 * @param {string} s
 * @returns {boolean|null} true, false, or null when the cell is empty / unknown
 */
const yesNo = (s) => (s === 'Yes' ? true : s === 'No' ? false : null);

/**
 * Turn one raw CSV row into a typed {@link Product}: numbers parsed, lists split, specs JSON parsed,
 * a unified `kitType` derived, and the rating nulled when there are no reviews.
 * @param {Record<string, string>} r  Raw CSV row (column name -> string value)
 * @returns {Product}
 */
function normalize(r) {
  const specs = JSON.parse(r.technical_specs || '{}');
  const reviewCount = num(r.review_count) ?? 0;

  // Kit vs bare tool is one of the most important buying decisions, but it lives in
  // different places depending on category. Derive one field for it.
  let kitType = specs.kit_type ?? null;
  if (!kitType && /tool only|bare tool/i.test(r.product_name)) kitType = 'Bare tool';

  return {
    sku: r.sku,
    model: r.model_number,
    upc: r.upc,
    brand: r.brand,
    name: r.product_name,
    category: r.category,
    subcategory: r.subcategory,
    productType: r.product_type,
    productLine: r.product_line || null,
    status: r.status, // Active | Discontinued | Temporarily Out of Stock | Coming Soon
    launchDate: r.launch_date || null,
    discontinuedDate: r.discontinued_date || null,
    replacementModel: r.replacement_model || null,
    price: num(r.msrp_usd),
    shortDescription: r.short_description,
    longDescription: r.long_description || null,
    keyFeatures: splitList(r.key_features),
    inTheBox: splitList(r.whats_in_the_box),
    powerSource: r.power_source,
    voltage: num(r.voltage_v),
    batteryPlatform: r.battery_platform || null,
    batteryIncluded: yesNo(r.battery_included),
    motorType: r.motor_type || null,
    weightLbs: num(r.weight_lbs),
    dimensionsIn: r.dimensions_in || null,
    compatibleWith: splitList(r.compatible_with),
    specs,
    kitType,
    connectivity: r.connectivity,
    warranty: r.warranty,
    certifications: r.certifications || null,
    countryOfOrigin: r.country_of_origin,
    // An empty rating only happens when there are 0 reviews -> "no reviews yet", not "0 stars".
    rating: reviewCount > 0 ? num(r.avg_rating) : null,
    reviewCount,
    retailers: splitList(r.available_at),
    url: r.product_url,
    imageUrl: r.image_url || null,
    lastUpdated: r.last_updated,
  };
}

/**
 * Read the CSV once and build the in-memory catalog with lookup indexes.
 * Runs at import time; 2,261 rows take ~200 ms.
 * @returns {{
 *   products: Product[],
 *   byModel: Map<string, Product>,
 *   bySku: Map<string, Product>,
 *   byUpc: Map<string, Product[]>
 * }} byModel keys are upper-cased; byUpc holds arrays because UPCs collide in this data
 */
function load() {
  const rows = parse(fs.readFileSync(CSV_PATH), { columns: true, skip_empty_lines: true });
  const products = rows.map(normalize);

  const byModel = new Map();
  const bySku = new Map();
  const byUpc = new Map(); // UPC -> [products]; the data has duplicate UPCs across unrelated items
  for (const p of products) {
    byModel.set(p.model.toUpperCase(), p);
    bySku.set(p.sku, p);
    if (!byUpc.has(p.upc)) byUpc.set(p.upc, []);
    byUpc.get(p.upc).push(p);
  }
  return { products, byModel, bySku, byUpc };
}

const t0 = Date.now();
export const catalog = load();
logger.info(`Catalog loaded: ${catalog.products.length} products in ${Date.now() - t0}ms`);

/**
 * Resolve any identifier a user might type — model number, SKU or UPC — to products.
 * Tries exact model (case-insensitive), SKU, UPC, then a loose model match ignoring spaces/dashes.
 * @param {string} id  e.g. "GSR12V-800N", "gsr12v 800n", "0645494808" (SKU) or "000346313673" (UPC)
 * @returns {Product[]} 0 = not found, 1 = found, 2+ = ambiguous (duplicate UPCs exist in the data)
 * @example findByIdentifier('gsr12v 800n') // -> [GSR12V-800N]
 */
export function findByIdentifier(id) {
  if (!id) return [];
  const raw = String(id).trim();
  const key = raw.toUpperCase();
  if (catalog.byModel.has(key)) return [catalog.byModel.get(key)];
  if (catalog.bySku.has(raw)) return [catalog.bySku.get(raw)];
  if (catalog.byUpc.has(raw)) return catalog.byUpc.get(raw);
  // Forgiving match: "gsr18v 535" vs "GSR18V-535"
  const loose = key.replace(/[^A-Z0-9]/g, '');
  return catalog.products.filter((p) => p.model.toUpperCase().replace(/[^A-Z0-9]/g, '') === loose);
}

/**
 * Convert a technical-spec value into ONE comparable number, so filters like "torque >= 500" work
 * on messy values. Ranges return their maximum; imperial fractions become decimals.
 * @param {number|string|boolean|null|undefined} v  Raw spec value
 * @returns {number|null} null when nothing numeric can be extracted
 * @example
 * specNumber(275)            // 275
 * specNumber('0-450/0-1750') // 1750  (speed range -> max)
 * specNumber('3/8')          // 0.375
 * specNumber('1-1/8')        // 1.125
 * specNumber(true)           // 1
 */
export function specNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  // Only treat "a/b" as a fraction when it looks like an imperial size (small numerator < denominator),
  // so speed ranges like "0-450/0-1750" are read as numbers 0, 450, 0, 1750.
  const nums = [];
  const re = /(?:(\d+)-)?(\d{1,2})\/(\d{1,2})(?!\d)|(\d+(?:\.\d+)?)/g;
  for (const m of v.matchAll(re)) {
    if (m[2] && Number(m[2]) < Number(m[3])) {
      nums.push((m[1] ? Number(m[1]) : 0) + Number(m[2]) / Number(m[3])); // 1-1/8, 3/8
    } else if (m[2]) {
      nums.push(...m[0].split(/[-/]/).map(Number)); // not a real fraction: keep the raw numbers
    } else {
      nums.push(Number(m[4]));
    }
  }
  return nums.length ? Math.max(...nums) : null;
}
