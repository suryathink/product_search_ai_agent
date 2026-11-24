// Tools = the ONLY way the LLM can see catalog data.
// Each tool has (1) a JSON schema the model reads to decide when/how to call it, and
// (2) an implementation that returns compact, grounded JSON.
import { catalog, findByIdentifier } from './catalog.js';
import { searchProducts } from './search.js';
import { findCompatible } from './compatibility.js';
import { getLogger } from './logger.js';

const logger = getLogger('tools');

const unique = (arr) => [...new Set(arr)].sort();
const FACETS = {
  brands: unique(catalog.products.map((p) => p.brand)),
  categories: unique(catalog.products.map((p) => p.category)),
  statuses: unique(catalog.products.map((p) => p.status)),
};

// Compact view for result lists — keeps token usage low and the model focused.
function summary(p) {
  return {
    model: p.model,
    name: p.name,
    brand: p.brand,
    category: `${p.category} > ${p.subcategory}`,
    price_usd: p.price,
    status: p.status,
    ...(p.replacementModel && { replaced_by: p.replacementModel }),
    ...(p.voltage && { voltage: p.voltage }),
    ...(p.kitType && { kit: p.kitType }),
    ...(p.motorType && { motor: p.motorType }),
    rating: p.rating == null ? 'no reviews yet' : `${p.rating} (${p.reviewCount} reviews)`,
    short_description: p.shortDescription,
    url: p.url,
  };
}

// Full view for a single product — everything the catalog knows, nothing more.
function details(p) {
  const out = {
    ...summary(p),
    sku: p.sku,
    upc: p.upc,
    product_type: p.productType,
    product_line: p.productLine,
    launch_date: p.launchDate,
    discontinued_date: p.discontinuedDate,
    long_description: p.longDescription,
    key_features: p.keyFeatures.length ? p.keyFeatures : 'not listed',
    whats_in_the_box: p.inTheBox,
    power_source: p.powerSource,
    battery_platform: p.batteryPlatform,
    battery_included: p.batteryIncluded,
    weight_lbs: p.weightLbs,
    dimensions_in: p.dimensionsIn ?? 'not listed',
    technical_specs: p.specs,
    compatible_with: p.compatibleWith.length ? p.compatibleWith : 'not listed',
    connectivity: p.connectivity,
    warranty: p.warranty,
    certifications: p.certifications ?? 'not listed',
    country_of_origin: p.countryOfOrigin,
    available_at: p.retailers,
    catalog_last_updated: p.lastUpdated,
  };
  // Follow the replacement link so the agent can immediately offer the successor.
  if (p.replacementModel) {
    const r = catalog.byModel.get(p.replacementModel.toUpperCase());
    if (r) out.replacement_product = summary(r);
  }
  return out;
}

function notFound(id) {
  // Suggest near-misses so the agent can ask "did you mean ...?" instead of guessing
  const key = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const near = catalog.products
    .filter((p) => key.length >= 3 && p.model.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(key.slice(0, Math.max(3, key.length - 2))))
    .slice(0, 5)
    .map((p) => ({ model: p.model, name: p.name }));
  return { error: `No product with model number, SKU or UPC "${id}" exists in the catalog.`, similar_models: near };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
const impl = {
  async search_products(args) {
    const { query = '', sort, limit = 8, include_discontinued = false, ...filters } = args;
    if (!filters.status && !include_discontinued) filters.status = ['Active', 'Temporarily Out of Stock', 'Coming Soon'];
    const { results, total, relaxations } = await searchProducts({ query, filters, sort, limit: Math.min(limit, 15) });
    if (!results.length) {
      return {
        total_matches: 0,
        message: 'No products match ALL of these constraints.',
        ...(relaxations?.length && { if_you_drop_one_filter: relaxations }),
        hint: 'Explain which constraint is blocking, offer the closest alternative (and ask whether to relax it). Do not invent products.',
      };
    }
    return { total_matches: total, showing: results.length, results: results.map(summary) };
  },

  async get_product_details({ identifier }) {
    const found = findByIdentifier(identifier);
    if (!found.length) return notFound(identifier);
    if (found.length > 1) {
      return {
        ambiguous: true,
        message: `"${identifier}" matches ${found.length} different products (duplicate UPC in catalog data). Ask the user which one they mean.`,
        candidates: found.map(summary),
      };
    }
    return details(found[0]);
  },

  async compare_products({ identifiers }) {
    const resolved = identifiers.map((id) => ({ id, found: findByIdentifier(id) }));
    const missing = resolved.filter((r) => r.found.length !== 1).map((r) => r.id);
    const products = resolved.filter((r) => r.found.length === 1).map((r) => r.found[0]);
    // Union of spec keys so differences line up side by side
    const specKeys = unique(products.flatMap((p) => Object.keys(p.specs)));
    return {
      ...(missing.length && { not_found_or_ambiguous: missing }),
      products: products.map((p) => ({
        ...summary(p),
        weight_lbs: p.weightLbs,
        battery_included: p.batteryIncluded,
        warranty: p.warranty,
        whats_in_the_box: p.inTheBox,
        specs: Object.fromEntries(specKeys.map((k) => [k, p.specs[k] ?? 'n/a'])),
      })),
      ...(products.length && new Set(products.map((p) => p.subcategory)).size > 1 && {
        warning: 'These products are in different subcategories — specs may not be directly comparable.',
      }),
    };
  },

  async find_compatible_products({ identifier }) {
    const found = findByIdentifier(identifier);
    if (found.length !== 1) return found.length ? { ambiguous: true, candidates: found.map(summary) } : notFound(identifier);
    return findCompatible(found[0]);
  },

  async get_catalog_overview({ category } = {}) {
    const ps = category ? catalog.products.filter((p) => p.category.toLowerCase() === category.toLowerCase()) : catalog.products;
    if (!ps.length) return { error: `Unknown category "${category}".`, categories: FACETS.categories };
    const count = (f) => ps.reduce((m, p) => ((m[f(p)] = (m[f(p)] || 0) + 1), m), {});
    const prices = ps.map((p) => p.price).filter((x) => x != null);
    return {
      total_products: ps.length,
      brands: count((p) => p.brand),
      ...(category ? { subcategories: count((p) => p.subcategory), product_types: count((p) => p.productType) } : { categories: count((p) => p.category) }),
      statuses: count((p) => p.status),
      price_range_usd: [Math.min(...prices), Math.max(...prices)],
      voltages: count((p) => p.voltage ?? 'n/a'),
      ...(category && {
        // Which technical spec keys exist here -> lets the model build spec_filters correctly
        spec_keys: unique(ps.flatMap((p) => Object.keys(p.specs))),
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// Schemas the model sees. Descriptions are prompt engineering: they teach WHEN to use each tool.
// ---------------------------------------------------------------------------
export const toolSchemas = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Search the product catalog with a free-text query plus optional hard filters. Use for any discovery/recommendation question. '
        + 'Excludes discontinued products unless include_discontinued=true or status is given. '
        + 'If 0 results, the response tells you which filter is blocking.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords / intent, e.g. "hammer drill masonry", "tile cutting blade", "GSR18V-535".' },
          brand: { type: 'string', enum: FACETS.brands },
          category: { type: 'string', enum: FACETS.categories },
          subcategory: { type: 'string', description: 'Exact subcategory, e.g. "Drills & Drivers", "Line Lasers", "Saw Blades". Use get_catalog_overview to see valid values.' },
          product_type: { type: 'string', description: 'Substring of product type, e.g. "Impact Driver", "Hammer Drill", "Jigsaw".' },
          status: { type: 'array', items: { type: 'string', enum: FACETS.statuses } },
          include_discontinued: { type: 'boolean' },
          min_price: { type: 'number' },
          max_price: { type: 'number' },
          voltage: { type: 'number', enum: [4, 12, 18, 120] },
          power_source: { type: 'string', enum: ['cordless', 'corded'] },
          motor_type: { type: 'string', enum: ['Brushless', 'Brushed'] },
          kit: { type: 'string', enum: ['bare_tool', 'kit'], description: 'bare_tool = no battery/charger; kit = includes battery.' },
          min_rating: { type: 'number' },
          connected: { type: 'boolean', description: 'true = has Bluetooth/app connectivity.' },
          spec_filters: {
            type: 'array',
            description: 'Numeric/text filters on technical_specs keys (imperial units as stored), e.g. {key:"max_torque_in_lbs", op:">=", value:500}. Get valid keys from get_catalog_overview(category).',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, op: { type: 'string', enum: ['>=', '<=', '=', '>', '<'] }, value: { type: ['number', 'string'] } },
              required: ['key', 'op', 'value'],
            },
          },
          sort: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'rating'] },
          limit: { type: 'integer', description: 'Max results, default 8, max 15.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product_details',
      description: 'Full record for ONE product by model number, SKU or UPC: specs, features, box contents, warranty, retailers, replacement. Use before answering any detailed question about a specific product.',
      parameters: { type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_products',
      description: 'Side-by-side comparison of 2-5 products by model number.',
      parameters: { type: 'object', properties: { identifiers: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 } }, required: ['identifiers'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_compatible_products',
      description: 'What works with a product: batteries/chargers for a tool, tools for a battery, accessories for a tool, or tools for an accessory. Based on catalog compatibility data only.',
      parameters: { type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_catalog_overview',
      description: 'Counts of brands, categories/subcategories, statuses, price range, and (with a category) the available technical spec keys. Use to learn valid filter values or to answer "what do you sell" questions.',
      parameters: { type: 'object', properties: { category: { type: 'string', enum: FACETS.categories } } },
    },
  },
];

export async function runTool(name, args) {
  const fn = impl[name];
  if (!fn) {
    logger.warn(`Model requested unknown tool "${name}"`);
    return { error: `Unknown tool ${name}` };
  }
  try {
    return await fn(args || {});
  } catch (e) {
    // The model gets a short error it can recover from; the full stack goes to the error log
    logger.error(`Tool ${name} threw`, { args }, e);
    return { error: `Tool failed: ${e.message}` };
  }
}
