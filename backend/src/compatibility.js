// Compatibility is deterministic code, not LLM guesswork: a wrong answer = customer buys a part that doesn't fit.
//
// The catalog encodes compatibility in three ways:
//   1. Battery platform    tools/batteries/chargers share "Bosch 18V (...)", "Bosch 12V Max", "Dremel 12V / Bosch 12V Max"
//   2. Free-text phrases   accessories say "SDS-plus rotary hammers", "Routers with 1/4 in. collet", "Dremel 4000"
//   3. Interfaces in specs bit_holder (SDS-plus/SDS-max/hex), collet_in, accessory_interface (Starlock...), pad_diameter_in
import { catalog, specNumber } from './catalog.js';

/** @typedef {import('./catalog.js').Product} Product */

/**
 * Compact product view used inside compatibility results.
 * @typedef {{model: string, name: string, brand: string, subcategory: string, price: number|null, status: string, url: string}} ProductSummary
 */

/**
 * Null-safe lower-case, for case-insensitive comparisons.
 * @param {*} s
 * @returns {string}
 */
const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Is this product an accessory (bits, blades, sanding, attachments...) rather than a tool?
 * @param {Product} p
 * @returns {boolean}
 */
const isAccessory = (p) => /accessor|bits|blades|sanding|grinding|cutting|carving|cleaning|attachment|filament/i.test(p.category + ' ' + p.subcategory)
  && !['Power Tools', 'Rotary Tools'].includes(p.category);

/**
 * Is this product a tool that accessories/batteries can be compatible WITH
 * (power, rotary, measuring tools, 3D printers...), excluding accessory/consumable subcategories?
 * @param {Product} p
 * @returns {boolean}
 */
const isTool = (p) => ['Power Tools', 'Rotary Tools', 'Digital Fabrication', 'Measuring Tools'].includes(p.category)
  && !/accessor|filament|tripod|grade rod/i.test(p.subcategory);

// --- 1. Battery platforms -------------------------------------------------------
// "Dremel 12V / Bosch 12V Max" and "Bosch 12V Max" are interchangeable 12V platforms.
/**
 * Reduce a battery-platform text to a comparable key.
 * @param {string|null|undefined} s  e.g. "Bosch 18V (CORE18V / PROFACTOR compatible)", "Dremel 12V / Bosch 12V Max"
 * @returns {'18v'|'12v'|null} null when the text names no battery platform
 */
function platformKey(s) {
  const t = lc(s);
  if (t.includes('18v')) return '18v';
  if (t.includes('12v')) return '12v';
  return null;
}

// --- 2. Labels a tool answers to, used to match accessory phrases ---------------
/**
 * All the names an accessory's compatibility text might use for this tool.
 * @param {Product} t  A tool
 * @returns {string[]} lower-case labels
 * @example toolLabels(hammerDrillDriver) // -> ['hammer drill/driver', 'drill/driver', 'drill', 'hammer drill']
 * @example toolLabels(dremel4000Kit)     // -> ['rotary tool', 'dremel 4000']
 */
function toolLabels(t) {
  const type = lc(t.productType).replace(/^corded |^cordless /, '');
  const labels = new Set([type]);
  /**
   * Add one or more alias labels for this tool.
   * @param {...string} xs
   * @returns {void}
   */
  const add = (...xs) => xs.forEach((x) => labels.add(x));
  if (/drill\/driver/.test(type)) add('drill/driver', 'drill');
  if (/hammer drill/.test(type)) add('hammer drill', 'drill');
  if (/impact driver/.test(type)) add('impact driver');
  if (/sliding miter saw/.test(type)) add('miter saw');
  if (/table saw/.test(type)) add('table saw');
  if (/router/.test(type)) add('router');
  if (/oscillating/.test(type)) add('oscillating tool');
  if (/rotary hammer|demolition hammer|breaker hammer/.test(type)) add('hammer');
  if (t.brand === 'Dremel') add(`dremel ${lc(t.model.split('-')[0])}`);
  if (t.brand === 'RotoZip') add(`rotozip ${lc(t.model.split('-')[0])}`);
  return [...labels];
}

/**
 * Does one of an accessory's compatibility phrases apply to this tool?
 * Step 1: the tool's type must appear in the phrase as a whole word (see {@link toolLabels}).
 * Step 2: interface refinements — SDS-plus vs SDS-max bit holder, collet size, sander pad size,
 * Starlock interface, brand/voltage prefixes — must also agree.
 * @param {string} phrase  e.g. "SDS-plus rotary hammers", "Routers with 1/4 in. collet", "Dremel 4000"
 * @param {Product} t      The tool
 * @returns {boolean}
 * @example phraseMatchesTool('SDS-plus rotary hammers', sdsMaxHammer) // false (wrong bit holder)
 */
function phraseMatchesTool(phrase, t) {
  const ph = lc(phrase);
  const labels = toolLabels(t);
  // Each label must appear in the phrase as a whole word ("drill" must not match "drill presses" only partially)
  const typeHit = labels.some((l) => new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(e?s)?\\b`).test(ph));
  if (!typeHit) return false;

  // Interface refinements — the phrase is more specific than the tool type
  const bh = lc(t.specs.bit_holder);
  if (/sds-plus/.test(ph) && !bh.includes('sds-plus')) return false;
  if (/sds-max/.test(ph) && !bh.includes('sds-max')) return false;
  if (/1-1\/8 in\. hex/.test(ph) && !bh.includes('1-1/8')) return false;
  if (/3\/4 in\. hex/.test(ph) && !bh.includes('3/4')) return false;
  if (/core drill rig/.test(ph)) return false; // dedicated rigs — none are sold in this catalog
  if (/hammer drill/.test(ph) &&!/hammer drill/.test(lc(t.productType))) return false;
  if (/drill press|right-angle/.test(ph) && !/press|right-angle/.test(lc(t.productType))) return false;
  const collet = /(\d\/\d) in\. collet/.exec(ph);
  if (collet) {
    const tc = lc(JSON.stringify(t.specs.collet_in ?? t.specs.collets_in ?? ''));
    if (!tc.includes(collet[1])) return false;
  }
  const pad = /^(\d) in\. random orbit/.exec(ph);
  if (pad && specNumber(t.specs.pad_diameter_in) !== Number(pad[1])) return false;
  if (/starlock/.test(ph)) {
    const ai = lc(t.specs.accessory_interface);
    if (!ai.includes('starlock')) return false;
    if (/starlockmax oscillating tools only/.test(ph) && !ai.includes('starlockmax')) return false;
    if (/^starlockplus and starlockmax/.test(ph) && !/starlockplus|starlockmax/.test(ai)) return false;
  }
  if (/^bosch\b/.test(ph) && t.brand !== 'Bosch') return false;
  if (/^bosch 18v/.test(ph) && t.voltage !== 18) return false;
  return true;
}

/**
 * Shrink a product to the few fields a compatibility list needs (keeps LLM tokens low).
 * @param {Product} p
 * @returns {ProductSummary}
 */
const summarize = (p) => ({
  model: p.model, name: p.name, brand: p.brand, subcategory: p.subcategory, price: p.price, status: p.status, url: p.url,
});

/** Filler words ignored when reading a user's need ("what can I use for engraving glass"). */
const NEED_STOP = new Set('for the and with what can use using want need something into onto from that this my our a an to of in on it is'.split(' '));

/**
 * Extract the meaningful words from a need.
 * @param {string} need  e.g. "what can I use for engraving glass"
 * @returns {string[]} e.g. ["engraving", "glass"]
 */
const needTerms = (need) => [...new Set(String(need ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !NEED_STOP.has(w)))];

// Light stemming + WHOLE-WORD start match: "engraving" -> /\bengrav/ ; "glass" must not match "fiberglass"
/**
 * Light stemming: strip "-ing"/"-ed" from longer words so "engraving" also matches "engraver".
 * @param {string} w
 * @returns {string} e.g. "engraving" -> "engrav", "glass" -> "glass"
 */
const stem = (w) => (w.length > 5 ? w.replace(/(ing|ed)$/, '') : w);

/**
 * Regex matching a word at a word START, so "glass" matches "glass" but not "fiberglass".
 * @param {string} w
 * @returns {RegExp} e.g. /\bengrav/
 */
const wordRe = (w) => new RegExp(`\\b${stem(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/**
 * All searchable text of an accessory (name, type, descriptions, features), lower-cased.
 * @param {Product} a
 * @returns {string}
 */
const accText = (a) => `${a.name} ${a.subcategory} ${a.productType} ${a.shortDescription} ${a.keyFeatures.join(' ')} ${a.longDescription ?? ''}`.toLowerCase();

/**
 * Rank compatible accessories by the user's need ("engraving glass") and report which need terms
 * appear in NO compatible accessory. Stating the negative fact explicitly is what stops the model from
 * claiming "suitable for glass" — prompt rules alone did not.
 * @param {Product[]} acc   Accessories already known to be compatible with the tool
 * @param {string} need     What the user wants to do, e.g. "engraving glass"
 * @returns {null | {
 *   need: string,
 *   terms_found_in_compatible_accessories: string[],
 *   terms_not_found_anywhere: string[],
 *   best_matches: (ProductSummary & {matched_terms: string[]})[],
 *   warning?: string
 * }} null when the need has no meaningful words
 */
function matchNeed(acc, need) {
  const terms = needTerms(need);
  if (!terms.length) return null;
  const scored = acc.map((a) => {
    const t = accText(a);
    const hit = terms.filter((w) => wordRe(w).test(t));
    return { a, hit };
  });
  const covered = new Set(scored.flatMap((s) => s.hit));
  const best = scored.filter((s) => s.hit.length).sort((x, y) => y.hit.length - x.hit.length).slice(0, 8);
  const missing = terms.filter((w) => !covered.has(w));
  return {
    need,
    terms_found_in_compatible_accessories: [...covered],
    terms_not_found_anywhere: missing,
    best_matches: best.map(({ a, hit }) => ({ ...summarize(a), matched_terms: hit })),
    ...(missing.length && {
      warning: `No compatible accessory's catalog text mentions: ${missing.join(', ')}. Do NOT claim any accessory is made for or suitable for that; say the catalog doesn't specify it.`,
    }),
  };
}

/**
 * Find what works with a given product. Returns groups with an explicit `basis`
 * so the agent can explain WHY something is compatible:
 * - battery / charger -> tools and other batteries on the same platform
 * - tool              -> batteries/chargers on its platform + accessories whose compatibility text fits it
 * - accessory         -> tools its compatibility text describes
 * @param {Product} p
 * @param {object} [options]
 * @param {number} [options.limit=10]          Max items listed per group (totals are always complete)
 * @param {boolean} [options.activeOnly=true]  Only Active / Temporarily Out of Stock products
 * @param {string} [options.need]              Optional job/material, e.g. "engraving glass" — adds `for_your_need`
 * @returns {{
 *   product: ProductSummary,
 *   listed_compatibility: string[],
 *   battery_platform: string|null,
 *   groups: {group: string, basis: string, total: number, items: object[], subcategories?: Record<string, number>, for_your_need?: object}[],
 *   note: string
 * }}
 */
export function findCompatible(p, { limit = 10, activeOnly = true, need } = {}) {
  const pool = catalog.products.filter((x) => x !== p && (!activeOnly || x.status === 'Active' || x.status === 'Temporarily Out of Stock'));
  const groups = [];
  const platform = platformKey(p.batteryPlatform) || platformKey(p.compatibleWith.join(' '));

  if (p.subcategory === 'Batteries' || p.subcategory === 'Chargers' || p.subcategory === 'Starter Kits') {
    // Battery/charger -> tools on the same platform + other batteries/chargers
    if (platform) {
      const tools = pool.filter((x) => isTool(x) && platformKey(x.batteryPlatform) === platform);
      groups.push({ group: 'Tools on the same battery platform', basis: `battery platform ${p.batteryPlatform || p.compatibleWith[0]}`, total: tools.length, items: tools.slice(0, limit).map(summarize) });
      const power = pool.filter((x) => x.category === 'Batteries & Chargers' && platformKey(x.batteryPlatform || x.compatibleWith.join(' ')) === platform);
      groups.push({ group: 'Batteries & chargers on the same platform', basis: 'battery platform', total: power.length, items: power.slice(0, limit).map(summarize) });
    }
  } else if (isTool(p)) {
    if (platform) {
      const power = pool.filter((x) => x.category === 'Batteries & Chargers' && platformKey(x.batteryPlatform || x.compatibleWith.join(' ')) === platform);
      groups.push({ group: 'Batteries & chargers', basis: `battery platform ${p.batteryPlatform}`, total: power.length, items: power.slice(0, limit).map(summarize) });
    }
    const acc = pool.filter((x) => !isTool(x) && x.compatibleWith.some((ph) => phraseMatchesTool(ph, p)));
    // Diversify: show a spread of subcategories rather than 10 sizes of the same drill bit
    const bySub = new Map();
    for (const a of acc) { if (!bySub.has(a.subcategory)) bySub.set(a.subcategory, []); bySub.get(a.subcategory).push(a); }
    const diversified = [];
    for (let round = 0; diversified.length < limit && round < 10; round++) {
      for (const list of bySub.values()) if (list[round] && diversified.length < limit) diversified.push(list[round]);
    }
    groups.push({
      group: 'Accessories', basis: 'accessory compatibility text vs. this tool type/interface',
      total: acc.length, subcategories: Object.fromEntries([...bySub].map(([k, v]) => [k, v.length])),
      items: diversified.map((a) => ({ ...summarize(a), listed_compatibility: a.compatibleWith.join(' | ') })),
      ...(need && { for_your_need: matchNeed(acc, need) }),
    });
  } else {
    // Accessory (or apparel, storage...) -> which tools does it fit?
    const tools = pool.filter((x) => isTool(x) && p.compatibleWith.some((ph) => phraseMatchesTool(ph, x) || (platformKey(ph) && platformKey(ph) === platformKey(x.batteryPlatform))));
    groups.push({ group: 'Compatible tools in the catalog', basis: `listed compatibility: ${p.compatibleWith.join(' | ') || 'none listed'}`, total: tools.length, items: tools.slice(0, limit).map(summarize) });
  }

  return {
    product: summarize(p),
    listed_compatibility: p.compatibleWith,
    battery_platform: p.batteryPlatform,
    groups,
    note: 'Matches are derived from catalog compatibility fields. If a group is empty or listed_compatibility is empty, say compatibility is not documented rather than guessing.',
  };
}
