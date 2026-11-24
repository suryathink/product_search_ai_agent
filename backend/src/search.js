// Hybrid search = hard filters  ->  two rankers (BM25 keywords + embeddings meaning)  ->  fused ranking.
import fs from 'node:fs';
import path from 'node:path';
import { catalog, DATA_DIR, specNumber } from './catalog.js';
import { getLogger } from './logger.js';

const logger = getLogger('search');

// ---------------------------------------------------------------------------
// Text we index per product. Name/model are repeated to weight them higher.
// ---------------------------------------------------------------------------
export function productText(p) {
  return [
    p.name, p.name, p.model, p.model, p.brand, p.category, p.subcategory, p.productType,
    p.productLine, p.shortDescription, p.keyFeatures.join('. '), p.compatibleWith.join('. '),
    p.batteryPlatform, p.motorType, p.kitType,
  ].filter(Boolean).join(' . ');
}

const STOP = new Set('a an the and or for of to in on with is it this that i my me need want looking some any what which can do does you your best good tool tools'.split(' '));

function tokenize(text) {
  const toks = String(text).toLowerCase().replace(/[^a-z0-9./-]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (const t of toks) {
    if (STOP.has(t)) continue;
    out.push(t);
    // "gsr18v-535" also indexed as "gsr18v" + "535" + "gsr18v535" so partial model numbers match
    if (/[-/.]/.test(t)) {
      for (const part of t.split(/[-/.]/)) if (part && !STOP.has(part)) out.push(part);
      out.push(t.replace(/[-/.]/g, ''));
    }
    // crude plural stemming: "drills" -> "drill", "batteries" -> "battery"
    if (t.length > 4 && t.endsWith('ies')) out.push(t.slice(0, -3) + 'y');
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) out.push(t.slice(0, -1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// BM25. score(doc) = Σ over query terms of  idf(term) * tf*(k1+1) / (tf + k1*(1 - b + b*len/avgLen))
//   idf: rare terms (a model number) matter much more than common ones ("18v")
//   k1:  term-frequency saturation (10 mentions isn't 10x better than 1)
//   b:   length normalization (long descriptions don't win just by being long)
// ---------------------------------------------------------------------------
const K1 = 1.2, B = 0.75;
const docs = catalog.products.map((p) => {
  const tf = new Map();
  const toks = tokenize(productText(p));
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  return { tf, len: toks.length };
});
const avgLen = docs.reduce((s, d) => s + d.len, 0) / docs.length;
const df = new Map();
for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
const N = docs.length;
const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

function bm25Scores(query, candidateIdx) {
  const qTerms = [...new Set(tokenize(query))];
  const scores = new Map();
  for (const i of candidateIdx) {
    const d = docs[i];
    let s = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen));
    }
    if (s > 0) scores.set(i, s);
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Embeddings (optional). Built once by `npm run embed`, cached to data/embeddings.json.
// Captures meaning: "cut ceramic tile" finds tile blades even without exact words.
// ---------------------------------------------------------------------------
export const EMBEDDINGS_PATH = path.join(DATA_DIR, 'embeddings.json');
export const EMBEDDING_MODEL = 'text-embedding-3-small';
let embeddings = null; // Float32Array[] aligned with catalog.products
try {
  const raw = JSON.parse(fs.readFileSync(EMBEDDINGS_PATH, 'utf8'));
  if (raw.model === EMBEDDING_MODEL && raw.vectors.length === N) {
    embeddings = raw.vectors.map((v) => Float32Array.from(v));
  }
} catch { /* not built yet -> BM25 only */ }
if (embeddings) logger.info(`Semantic search enabled (${N} product vectors loaded)`);
else logger.info('No embeddings file found or it is stale — using BM25 keyword search only (run `npm run embed`)');
export const hasEmbeddings = () => embeddings !== null;

let openaiClient = null;
export function setOpenAIClient(c) { openaiClient = c; }

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

async function vectorScores(query, candidateIdx) {
  if (!embeddings || !openaiClient || !query) return new Map();
  try {
    const res = await openaiClient.embeddings.create({ model: EMBEDDING_MODEL, input: query });
    const q = res.data[0].embedding;
    const scores = new Map();
    for (const i of candidateIdx) scores.set(i, cosine(q, embeddings[i]));
    return scores;
  } catch (e) {
    logger.warn(`Embedding query failed, falling back to BM25 only: ${e.message}`);
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Filters. These are HARD constraints — an LLM shouldn't "approximately" respect a budget.
// ---------------------------------------------------------------------------
const lc = (s) => String(s ?? '').toLowerCase();
const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '=': (a, b) => a === b, '>': (a, b) => a > b, '<': (a, b) => a < b };

export const FILTER_CHECKS = {
  brand: (p, v) => lc(p.brand) === lc(v),
  category: (p, v) => lc(p.category) === lc(v),
  subcategory: (p, v) => lc(p.subcategory) === lc(v),
  product_type: (p, v) => lc(p.productType).includes(lc(v)),
  status: (p, v) => (Array.isArray(v) ? v : [v]).some((s) => lc(s) === lc(p.status)),
  min_price: (p, v) => p.price != null && p.price >= v,
  max_price: (p, v) => p.price != null && p.price <= v,
  voltage: (p, v) => p.voltage === Number(v),
  power_source: (p, v) => {
    const ps = lc(p.powerSource);
    if (lc(v) === 'cordless') return ps === 'cordless' || ps === 'battery' || ps === 'integrated li-ion';
    if (lc(v) === 'corded') return ps.startsWith('corded');
    return ps.includes(lc(v));
  },
  motor_type: (p, v) => lc(p.motorType) === lc(v),
  kit: (p, v) => {
    if (!p.kitType) return false;
    const bare = lc(p.kitType).startsWith('bare tool');
    return lc(v) === 'bare_tool' ? bare : !bare;
  },
  min_rating: (p, v) => p.rating != null && p.rating >= v,
  connected: (p, v) => (v ? lc(p.connectivity) !== 'not connected' : lc(p.connectivity) === 'not connected'),
  spec_filters: (p, list) => list.every(({ key, op, value }) => {
    if (!(key in p.specs)) return false;
    const actual = p.specs[key];
    if (typeof value === 'string' && Number.isNaN(Number(value))) return lc(actual).includes(lc(value));
    const a = specNumber(actual);
    return a != null && (OPS[op] || OPS['='])(a, Number(value));
  }),
};

function applyFilters(filters, skip = null) {
  const idx = [];
  catalog.products.forEach((p, i) => {
    for (const [k, v] of Object.entries(filters)) {
      if (k === skip || v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const check = FILTER_CHECKS[k];
      if (check && !check(p, v)) return;
    }
    idx.push(i);
  });
  return idx;
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion: combine rankings by position, not raw score
// (BM25 scores and cosine similarities live on totally different scales).
// RRF(doc) = Σ 1 / (k + rank_in_list)
// ---------------------------------------------------------------------------
function rrf(lists, k = 60) {
  const fused = new Map();
  for (const scores of lists) {
    [...scores.entries()].sort((a, b) => b[1] - a[1]).forEach(([i], rank) => {
      fused.set(i, (fused.get(i) || 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

/**
 * Main search entry point.
 * @returns {{ results: object[], total: number, relaxations?: object[] }}
 */
export async function searchProducts({ query = '', filters = {}, sort = 'relevance', limit = 8 }) {
  const candidates = applyFilters(filters);

  // Zero results: tell the agent WHICH constraint is blocking, so it can explain + offer alternatives
  if (!candidates.length) {
    const relaxations = Object.keys(filters)
      .filter((k) => filters[k] != null && filters[k] !== '')
      .map((k) => ({ dropped_filter: k, value: filters[k], matches_without_it: applyFilters(filters, k).length }))
      .filter((r) => r.matches_without_it > 0);
    return { results: [], total: 0, relaxations };
  }

  let ranked;
  if (query.trim()) {
    const lex = bm25Scores(query, candidates);
    const vec = await vectorScores(query, candidates);
    // Only keep semantically-close items from the vector side so it can't flood junk in
    const vecTop = new Map([...vec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50));
    const fused = rrf([lex, vecTop].filter((m) => m.size));
    ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
    // If the query matched nothing at all, filters alone still define a valid result set
    if (!ranked.length && Object.keys(filters).length) ranked = candidates;
  } else {
    ranked = candidates;
  }

  let products = ranked.map((i) => catalog.products[i]);
  if (sort === 'price_asc') products.sort((a, b) => a.price - b.price);
  if (sort === 'price_desc') products.sort((a, b) => b.price - a.price);
  if (sort === 'rating') products.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount);

  return { results: products.slice(0, limit), total: products.length };
}
