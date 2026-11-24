// Tools = the ONLY way the LLM can see catalog data.
// Each tool has (1) a JSON schema the model reads to decide when/how to call it, and
// (2) an implementation that returns compact, grounded JSON.
import { catalog, findByIdentifier } from './catalog.js';
import { searchProducts, applyFilters } from './search.js';
import { findCompatible } from './compatibility.js';
import { getLogger } from './logger.js';
import { searchConfig } from './configs/index.js';

const logger = getLogger('tools');

/** @typedef {import('./catalog.js').Product} Product */

/**
 * De-duplicate and sort a list.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
const unique = (arr) => [...new Set(arr)].sort();

/** Real values from the data, used as `enum`s in the tool schemas so the model can't invent a brand/category. */
const FACETS = {
  brands: unique(catalog.products.map((p) => p.brand)),
  categories: unique(catalog.products.map((p) => p.category)),
  statuses: unique(catalog.products.map((p) => p.status)),
};

// Compact view for result lists — keeps token usage low and the model focused.
/**
 * Compact product view for result lists, in the shape the LLM reads. Keeps tokens low:
 * only fields needed to recommend a product (no specs, no long description).
 * @param {Product} p
 * @returns {{model: string, name: string, brand: string, category: string, price_usd: number|null,
 *   status: string, replaced_by?: string, voltage?: number, kit?: string, motor?: string,
 *   rating: string, short_description: string, url: string}}
 *   `rating` is a human string, e.g. "4.5 (333 reviews)" or "no reviews yet"
 */
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
/**
 * Full product view for one product: everything the catalog knows, nothing more.
 * Missing fields are spelled out as "not listed" so the model says so instead of guessing.
 * If the product is discontinued and has a successor, `replacement_product` is included.
 * @param {Product} p
 * @returns {object} summary fields + sku, upc, specs, features, box contents, warranty, retailers, ...
 */
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

/**
 * Build the "not found" tool result, with near-miss model numbers so the agent can ask
 * "did you mean ...?" instead of guessing.
 * @param {string} id  The identifier the model looked up
 * @returns {{error: string, similar_models: {model: string, name: string}[]}}
 */
function notFound(id) {
  // Suggest near-misses so the agent can ask "did you mean ...?" instead of guessing
  const key = String(id).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const near = catalog.products
    .filter((p) => key.length >= 3 && p.model.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(key.slice(0, Math.max(3, key.length - 2))))
    .slice(0, 5)
    .map((p) => ({ model: p.model, name: p.name }));
  return { error: `No product with model number, SKU or UPC "${id}" exists in the catalog.`, similar_models: near };
}

/**
 * Users name product FAMILIES ("Dremel 4000", "GSR18V-535"), but model numbers are per variant
 * ("4000-2/30", "GSR18V-535CN"). If there's no exact match, find variants whose name contains the text.
 * @param {string} id  e.g. "Dremel 4000"
 * @returns {Product[]} all variants; [] if the text is shorter than 4 characters or matches nothing
 * @example findFamily('Dremel 4000') // -> [4000-N/10, 4000-1/26, 4000-2/30, 4000-5/50, 4000-6/60]
 */
function findFamily(id) {
  const q = String(id ?? '').trim().toLowerCase();
  if (q.length < 4) return [];
  return catalog.products.filter((p) => p.name.toLowerCase().includes(q) || p.model.toLowerCase().startsWith(q));
}

/**
 * Validate spec_filters against the products the search would actually look at.
 * The same concept has different keys per product type (impact DRIVERS: max_torque_in_lbs,
 * impact WRENCHES: max_fastening_torque_ft_lbs), so a key that exists somewhere in the catalog can
 * still be wrong for these products — which silently returns 0 results and reads as "no product has this".
 * @param {{key: string, op: string, value: number|string}[]} [specFilters=[]]  spec_filters from the model
 * @param {import('./search.js').SearchFilters} [otherFilters={}]  The search's other filters (define "these products")
 * @returns {null | {error: string, did_you_mean: string[], hint: string}}
 *   null when every key is valid; otherwise an error the model can correct, with suggestions like
 *   "max_torque_in_lbs (used by: Impact Driver, Drill/Driver)"
 */
function invalidSpecKeys(specFilters = [], otherFilters = {}) {
  if (!specFilters?.length) return null;
  const base = applyFilters({ ...otherFilters, spec_filters: undefined }).map((i) => catalog.products[i]);
  const keysHere = new Set(base.flatMap((p) => Object.keys(p.specs)));
  const bad = specFilters.filter((f) => !keysHere.has(f.key));
  if (!bad.length) return null;
  const words = bad.flatMap((f) => String(f.key).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2 && !['max', 'min', 'the', 'lbs', 'nm'].includes(w)));
  const related = [...keysHere].filter((k) => words.some((w) => k.includes(w)));
  // Say WHICH product types use each key: "max_torque_in_lbs (used by: Impact Driver, Drill/Driver...)" vs
  // "max_fastening_torque_ft_lbs (used by: Impact Wrench)". Without this the model picked the wrench key for drivers.
  /**
   * Which product types (most common first) have this spec key, among the searched products.
   * @param {string} key
   * @returns {string} e.g. "Impact Driver, Drill/Driver, Hammer Drill/Driver"
   */
  const usedBy = (key) => {
    const counts = {};
    for (const p of base) if (key in p.specs) counts[p.productType] = (counts[p.productType] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t).join(', ');
  };
  return {
    error: `Unknown spec key(s) for the products matching your other filters: ${bad.map((f) => f.key).join(', ')}. Specs are stored in imperial units under fixed, product-type-specific key names.`,
    did_you_mean: (related.length ? related : [...keysHere].slice(0, 25)).map((k) => `${k} (used by: ${usedBy(k)})`),
    hint: 'Pick the key whose "used by" matches the product type the user asked for, and add product_type to the search. Convert units first: 1 Nm = 8.85 in-lbs = 0.7376 ft-lbs.',
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
/**
 * Tool implementations, keyed by tool name. Each receives the arguments the model sent
 * (already JSON-parsed) and returns plain JSON the model will read.
 */
const impl = {
  /**
   * Tool: search the catalog with free text + hard filters.
   * Hides discontinued products unless asked; validates spec keys first; on zero results returns
   * which filter is blocking (`if_you_drop_one_filter`). Attaches non-enumerable `_meta.retrieval`
   * (which vector store answered) — visible to the trace/UI, invisible to the LLM.
   * @param {import('./search.js').SearchFilters & {query?: string, sort?: string, limit?: number, include_discontinued?: boolean}} args
   * @returns {Promise<object>} {total_matches, showing, results[]} | {total_matches: 0, if_you_drop_one_filter[], hint} | spec-key error
   */
  async search_products(args) {
    const { query = '', sort, limit = searchConfig.defaultLimit, include_discontinued = false, ...filters } = args;
    if (!filters.status && !include_discontinued) filters.status = [...searchConfig.defaultStatuses];
    const specError = invalidSpecKeys(filters.spec_filters, filters);
    if (specError) return specError;
    const { results, total, relaxations, retrieval } = await searchProducts({ query, filters, sort, limit: Math.min(limit, searchConfig.maxLimit) });
    // Non-enumerable = invisible to JSON.stringify -> the LLM never sees it (no tokens), but the trace/UI can
    /**
     * Attach retrieval info as a NON-enumerable property: JSON.stringify skips it, so it costs no LLM tokens.
     * @param {object} obj
     * @returns {object} the same object
     */
    const withMeta = (obj) => Object.defineProperty(obj, '_meta', { value: { retrieval }, enumerable: false });
    if (!results.length) {
      return withMeta({
        total_matches: 0,
        message: 'No products match ALL of these constraints.',
        ...(relaxations?.length && { if_you_drop_one_filter: relaxations }),
        hint: 'Explain which constraint is blocking, offer the closest alternative (and ask whether to relax it). Check cheapest_examples: they may be a DIFFERENT product type than requested — if so, say the requested type does not exist with the other constraints. Do not invent products.',
      });
    }
    return withMeta({ total_matches: total, showing: results.length, results: results.map(summary) });
  },

  /**
   * Tool: full details of ONE product.
   * @param {{identifier: string}} args  Model number, SKU, UPC — or a family name like "Dremel 4000"
   * @returns {Promise<object>} details | {family_match, variants[]} | {ambiguous, candidates[]} (duplicate UPC)
   *   | {error, similar_models[]} (not found)
   */
  async get_product_details({ identifier }) {
    const found = findByIdentifier(identifier);
    if (!found.length) {
      const family = findFamily(identifier);
      if (family.length) {
        return {
          family_match: true,
          message: `"${identifier}" is not a single model number but matches ${family.length} product variant(s). Pick the relevant one(s) or ask the user (e.g. which kit).`,
          variants: family.slice(0, 12).map(summary),
        };
      }
      return notFound(identifier);
    }
    if (found.length > 1) {
      return {
        ambiguous: true,
        message: `"${identifier}" matches ${found.length} different products (duplicate UPC in catalog data). Ask the user which one they mean.`,
        candidates: found.map(summary),
      };
    }
    return details(found[0]);
  },

  /**
   * Tool: side-by-side comparison. Specs are aligned on the union of keys ("n/a" where a product
   * lacks one); warns when products are from different subcategories.
   * @param {{identifiers: string[]}} args  2-5 model numbers
   * @returns {Promise<{products: object[], not_found_or_ambiguous?: string[], warning?: string}>}
   */
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

  /**
   * Tool: what works with a product (batteries, chargers, accessories, or tools for an accessory).
   * Family names resolve to a representative variant (variants of one tool share compatibility).
   * @param {{identifier: string, need?: string}} args  need: optional job/material, e.g. "engraving glass"
   * @returns {Promise<object>} see {@link findCompatible}; plus `family_note` when a family was resolved
   */
  async find_compatible_products({ identifier, need }) {
    const found = findByIdentifier(identifier);
    if (found.length > 1) return { ambiguous: true, candidates: found.map(summary) };
    if (found.length === 1) return findCompatible(found[0], { need });
    // Family name ("Dremel 4000"): variants of one tool share compatibility, so use a representative variant
    const family = findFamily(identifier);
    if (family.length && new Set(family.map((p) => p.productType)).size === 1) {
      const rep = family.find((p) => p.status === 'Active') ?? family[0];
      return {
        ...findCompatible(rep, { need }),
        family_note: `"${identifier}" matches ${family.length} variants (${family.slice(0, 5).map((p) => p.model).join(', ')}${family.length > 5 ? ', ...' : ''}); compatibility shown for ${rep.model}, which applies to the family.`,
      };
    }
    if (family.length) return { family_match: true, message: `"${identifier}" matches different product types; ask which one.`, variants: family.slice(0, 12).map(summary) };
    return notFound(identifier);
  },

  /**
   * Tool: catalog facts — counts by brand/category/status, price range, voltages and (per category)
   * the valid technical spec keys. Used for "what do you sell?" and to learn valid filter values.
   * @param {{category?: string}} [args]
   * @returns {Promise<object>} {total_products, brands, categories|subcategories, statuses, price_range_usd, voltages, spec_keys?}
   */
  async get_catalog_overview({ category } = {}) {
    const ps = category ? catalog.products.filter((p) => p.category.toLowerCase() === category.toLowerCase()) : catalog.products;
    if (!ps.length) return { error: `Unknown category "${category}".`, categories: FACETS.categories };
    /**
     * Count products per value of a field.
     * @param {(p: Product) => *} f  field picker
     * @returns {Record<string, number>}
     */
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
/**
 * OpenAI function-calling schemas, sent with every model request. The model reads the names,
 * descriptions and parameter schemas to decide which tool to call and with what arguments.
 * @type {object[]}
 */
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
      parameters: { type: 'object', properties: { identifier: { type: 'string' }, need: { type: 'string', description: 'Optional: what the user wants to do or the material, e.g. "engraving glass", "cutting tile". Ranks accessories by it and reports need terms no compatible accessory mentions.' } }, required: ['identifier'] },
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

/**
 * Execute a tool call requested by the model. Never throws: unknown tools and exceptions become
 * `{error}` results the model can read and recover from (full stack goes to the error log).
 * @param {string} name   Tool name, e.g. "search_products"
 * @param {object} args   Parsed JSON arguments from the model
 * @returns {Promise<object>} the tool's JSON result
 * @example await runTool('get_product_details', { identifier: 'GBA18V20' })
 */
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
