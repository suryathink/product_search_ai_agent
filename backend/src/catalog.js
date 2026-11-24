// Data layer: load the CSV once, normalize every row into a clean, typed product object,
// and build lookup indexes. Nothing else in the app touches raw CSV strings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { getLogger } from './logger.js';

const logger = getLogger('catalog');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../../data');
const CSV_PATH = path.join(DATA_DIR, 'bosch_product_catalog_mock.csv');

const splitList = (s) => (s ? s.split('|').map((x) => x.trim()).filter(Boolean) : []);
const num = (s) => (s === '' || s == null || Number.isNaN(Number(s)) ? null : Number(s));
const yesNo = (s) => (s === 'Yes' ? true : s === 'No' ? false : null);

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

/** Resolve any identifier a user might type: model number, SKU, or UPC. Returns an array (UPCs can collide). */
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

/** Parse a spec value into a comparable number. "0-450/0-1750" -> 1750, "3/8" -> 0.375, true -> 1. */
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
