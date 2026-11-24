// Compatibility is deterministic code, not LLM guesswork: a wrong answer = customer buys a part that doesn't fit.
//
// The catalog encodes compatibility in three ways:
//   1. Battery platform    tools/batteries/chargers share "Bosch 18V (...)", "Bosch 12V Max", "Dremel 12V / Bosch 12V Max"
//   2. Free-text phrases   accessories say "SDS-plus rotary hammers", "Routers with 1/4 in. collet", "Dremel 4000"
//   3. Interfaces in specs bit_holder (SDS-plus/SDS-max/hex), collet_in, accessory_interface (Starlock...), pad_diameter_in
import { catalog, specNumber } from './catalog.js';

const lc = (s) => String(s ?? '').toLowerCase();
const isAccessory = (p) => /accessor|bits|blades|sanding|grinding|cutting|carving|cleaning|attachment|filament/i.test(p.category + ' ' + p.subcategory)
  && !['Power Tools', 'Rotary Tools'].includes(p.category);
const isTool = (p) => ['Power Tools', 'Rotary Tools', 'Digital Fabrication', 'Measuring Tools'].includes(p.category)
  && !/accessor|filament|tripod|grade rod/i.test(p.subcategory);

// --- 1. Battery platforms -------------------------------------------------------
// "Dremel 12V / Bosch 12V Max" and "Bosch 12V Max" are interchangeable 12V platforms.
function platformKey(s) {
  const t = lc(s);
  if (t.includes('18v')) return '18v';
  if (t.includes('12v')) return '12v';
  return null;
}

// --- 2. Labels a tool answers to, used to match accessory phrases ---------------
function toolLabels(t) {
  const type = lc(t.productType).replace(/^corded |^cordless /, '');
  const labels = new Set([type]);
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

/** Does an accessory's compatibility phrase apply to this tool? */
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

const summarize = (p) => ({
  model: p.model, name: p.name, brand: p.brand, subcategory: p.subcategory, price: p.price, status: p.status, url: p.url,
});

/**
 * Find what works with a given product.
 * Returns groups with an explicit `basis` so the agent can explain WHY something is compatible.
 */
export function findCompatible(p, { limit = 10, activeOnly = true } = {}) {
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
