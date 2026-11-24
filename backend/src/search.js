// Hybrid search = hard filters  ->  two rankers (BM25 keywords + embeddings meaning)  ->  fused ranking.
import { catalog, specNumber } from './catalog.js';
import { getLogger } from './logger.js';
import { EMBEDDING_MODEL, initVectorStore, getVectorStore, vectorStatus } from './vectorstore/index.js';
import { searchConfig } from './configs/index.js';

const logger = getLogger('search');

/** @typedef {import('./catalog.js').Product} Product */

/**
 * Hard filters accepted by search. All optional; unset filters are ignored.
 * @typedef {object} SearchFilters
 * @property {string} [brand]          Exact brand, e.g. "Dremel"
 * @property {string} [category]       Exact category, e.g. "Power Tools"
 * @property {string} [subcategory]    Exact subcategory, e.g. "Drills & Drivers"
 * @property {string} [product_type]   Substring of product type, e.g. "Impact Driver"
 * @property {string|string[]} [status] One or more statuses, e.g. ["Active", "Coming Soon"]
 * @property {number} [min_price]      USD
 * @property {number} [max_price]      USD
 * @property {number} [voltage]        4 | 12 | 18 | 120
 * @property {'cordless'|'corded'|string} [power_source]
 * @property {'Brushless'|'Brushed'} [motor_type]
 * @property {'bare_tool'|'kit'} [kit] Bare tool (no battery) vs kit with battery
 * @property {number} [min_rating]
 * @property {boolean} [connected]     true = has Bluetooth/app connectivity
 * @property {{key: string, op: '>='|'<='|'='|'>'|'<', value: number|string}[]} [spec_filters]
 *   Conditions on technical_specs, e.g. {key: "max_torque_in_lbs", op: ">=", value: 1770}
 */

// ---------------------------------------------------------------------------
// Text we index per product. Name/model are repeated to weight them higher.
// ---------------------------------------------------------------------------
/**
 * Build the single text blob that represents a product for search (BM25) and for embeddings.
 * Name and model appear twice so they weigh more than description words.
 * @param {Product} p
 * @returns {string} e.g. "GSR12V-800N 12V Max ... . GSR12V-800N . Bosch . Power Tools . Drills & Drivers ..."
 */
export function productText(p) {
  return [
    p.name, p.name, p.model, p.model, p.brand, p.category, p.subcategory, p.productType,
    p.productLine, p.shortDescription, p.keyFeatures.join('. '), p.compatibleWith.join('. '),
    p.batteryPlatform, p.motorType, p.kitType,
  ].filter(Boolean).join(' . ');
}

const STOP = new Set('a an the and or for of to in on with is it this that i my me need want looking some any what which can do does you your best good tool tools'.split(' '));

/**
 * Split text into search tokens: lower-case, stop words removed, plus extra variants so partial
 * model numbers and plurals still match.
 * @param {string} text
 * @returns {string[]} tokens (may contain duplicates — BM25 counts them as term frequency)
 * @example tokenize('Bosch GSR18V-535 drills')
 * // -> ['bosch', 'gsr18v-535', 'gsr18v', '535', 'gsr18v535', 'drills', 'drill']
 */
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
const { k1: K1, b: B } = searchConfig.bm25;
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
/**
 * Inverse document frequency: how rare (= informative) a term is across the catalog.
 * A model number appearing in 1 product scores high; "18v" appearing in hundreds scores low.
 * @param {string} t  token
 * @returns {number} idf weight (>= 0)
 */
const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));

/**
 * Score candidate products against a query with BM25 (keyword relevance).
 * @param {string} query               User/agent query, e.g. "hammer drill masonry"
 * @param {number[]} candidateIdx      Indexes into catalog.products to score (already filtered)
 * @returns {Map<number, number>} product index -> BM25 score; only products with score > 0
 */
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
// Embeddings (optional). Product vectors live in a vector store — Qdrant Cloud or a local file —
// chosen by config (see src/vectorstore/). Built/synced by `npm run embed`.
// Captures meaning: "cut ceramic tile" finds tile blades even without exact words.
// ---------------------------------------------------------------------------
export { EMBEDDING_MODEL };
const indexBySku = new Map(catalog.products.map((p, i) => [p.sku, i]));
/**
 * Is semantic (vector) search currently available?
 * @returns {boolean} true once the vector store is initialized and holds vectors
 */
export const hasEmbeddings = () => vectorStatus().ready;

let openaiClient = null;

/**
 * Inject the OpenAI client used to embed queries (set by the agent on first use).
 * Without it, search runs on BM25 only.
 * @param {import('openai').default} c
 * @returns {void}
 */
export function setOpenAIClient(c) { openaiClient = c; }

/**
 * Turn the user's query into an embedding vector (one small OpenAI API call per search).
 * @param {string} query  e.g. "something to hang shelves straight"
 * @returns {Promise<number[]>} 1536-dimensional vector (text-embedding-3-small)
 * @throws when the OpenAI call fails (callers fall back to BM25)
 */
export async function embedQuery(query) {
  const res = await openaiClient.embeddings.create({ model: EMBEDDING_MODEL, input: query });
  return res.data[0].embedding;
}

/**
 * Vector ranking for the query, restricted to the filtered candidates.
 * - Qdrant: filters are pushed down to the DB (pre-filtering), then intersected with our JS candidates
 *   (which also applied filters Qdrant doesn't know about, like spec_filters / kit).
 * - Local: exact cosine over exactly the candidate set.
 * Returns scores + retrieval metadata for tracing. Any failure -> empty map -> BM25 carries the query.
 * @param {string} query              Search text to embed
 * @param {number[]} candidateIdx     Indexes of products that passed ALL hard filters
 * @param {SearchFilters} filters     Same filters, so Qdrant can pre-filter server-side
 * @returns {Promise<{
 *   scores: Map<number, number>,
 *   meta: {store: string|null, used: boolean, embed_ms?: number, search_ms?: number, hits?: number,
 *          kept_after_filters?: number, skipped?: string, error?: string}
 * }>} scores: product index -> cosine similarity; meta: which store answered and how fast (shown in the UI trace)
 */
async function vectorScores(query, candidateIdx, filters) {
  const meta = { store: vectorStatus().store, used: false };
  if (!query || !openaiClient) return { scores: new Map(), meta };
  await initVectorStore();
  const store = getVectorStore();
  if (!vectorStatus().ready || !store) return { scores: new Map(), meta: { ...meta, skipped: vectorStatus().reason } };
  try {
    const t0 = Date.now();
    const q = await embedQuery(query);
    const t1 = Date.now();
    const hits = await store.search(q, {
      filters,
      candidateSkus: candidateIdx.map((i) => catalog.products[i].sku),
      limit: searchConfig.vectorCandidates,
    });
    const allowed = new Set(candidateIdx);
    const scores = new Map();
    for (const { sku, score } of hits) {
      const i = indexBySku.get(sku);
      if (i !== undefined && allowed.has(i)) scores.set(i, score);
    }
    const meta2 = { store: store.name, used: true, embed_ms: t1 - t0, search_ms: Date.now() - t1, hits: hits.length, kept_after_filters: scores.size };
    // One line per vector query, so you can SEE in the console which store served it and how fast
    logger.info(`vector search via ${store.name.toUpperCase()}: "${query.slice(0, 60)}" -> ${meta2.hits} hits in ${meta2.search_ms}ms (embedding ${meta2.embed_ms}ms), ${meta2.kept_after_filters} kept after filters`);
    return { scores, meta: meta2 };
  } catch (e) {
    logger.warn(`Vector search via ${store.name} failed, falling back to BM25 only: ${e.message}`);
    return { scores: new Map(), meta: { ...meta, error: e.message } };
  }
}

// ---------------------------------------------------------------------------
// Filters. These are HARD constraints — an LLM shouldn't "approximately" respect a budget.
// ---------------------------------------------------------------------------
/**
 * Null-safe lower-case, for case-insensitive comparisons.
 * @param {*} s
 * @returns {string}
 */
const lc = (s) => String(s ?? '').toLowerCase();

/** Comparison operators allowed in spec_filters, e.g. OPS['>='](a, b). */
const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '=': (a, b) => a === b, '>': (a, b) => a > b, '<': (a, b) => a < b };

/**
 * One predicate per filter name: `(product, filterValue) => boolean`.
 * {@link applyFilters} keeps a product only if every set filter returns true.
 * @type {Record<keyof SearchFilters, (p: Product, v: any) => boolean>}
 */
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

/**
 * Apply hard filters to the whole catalog.
 * @param {SearchFilters} filters       Filters to apply (empty / null values are ignored)
 * @param {string|null} [skip=null]     Name of ONE filter to ignore — used to answer
 *                                      "how many results would there be without this filter?"
 * @returns {number[]} indexes into catalog.products of the products that pass
 * @example applyFilters({ voltage: 12, max_price: 100 }) // -> [12, 57, 301, ...]
 */
export function applyFilters(filters, skip = null) {
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
/**
 * Reciprocal Rank Fusion: merge several rankings using only each item's POSITION.
 * An item ranked high in either list (or decently in both) ends up on top.
 * @param {Map<number, number>[]} lists  Each map: product index -> score (higher = better)
 * @param {number} [k=60]                Damping constant; 60 is the standard value from the RRF paper
 * @returns {Map<number, number>} product index -> fused score
 */
function rrf(lists, k = searchConfig.rrfK) {
  const fused = new Map();
  for (const scores of lists) {
    [...scores.entries()].sort((a, b) => b[1] - a[1]).forEach(([i], rank) => {
      fused.set(i, (fused.get(i) || 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

/**
 * Main search entry point: hard filters -> BM25 + vector ranking -> RRF fusion -> optional sort.
 * When NOTHING passes the filters, returns `relaxations`: for each filter, how many query-relevant
 * products would match without it, plus the cheapest examples — so the agent can explain what blocks.
 * @param {object} params
 * @param {string} [params.query='']            Free-text query; empty = rank by filters only
 * @param {SearchFilters} [params.filters={}]   Hard constraints
 * @param {'relevance'|'price_asc'|'price_desc'|'rating'} [params.sort='relevance']
 * @param {number} [params.limit=8]             Max results returned
 * @param {boolean} [params.useVectors=true]    false = keyword (BM25) ranking only, no embedding/Qdrant call
 * @returns {Promise<{
 *   results: Product[],
 *   total: number,
 *   relaxations?: {dropped_filter: string, value: *, matches_without_it: number,
 *                  cheapest_examples?: {model: string, name: string, price_usd: number}[]}[],
 *   retrieval: {mode: 'hybrid'|'bm25_only'|'filters_only'|'no_candidates', bm25_hits?: number, vector?: object}
 * }>} `total` counts all matches; `retrieval` describes how the ranking was produced (for tracing)
 */
export async function searchProducts({ query = '', filters = {}, sort = 'relevance', limit = searchConfig.defaultLimit, useVectors = true }) {
  const candidates = applyFilters(filters);

  // Zero results: tell the agent WHICH constraint is blocking, so it can explain + offer alternatives
  if (!candidates.length) {
    // Count only products that ALSO match the text query, otherwise "34 circular saw kits" could really be
    // 34 unrelated 12V kits. Report the cheapest/closest matches so the agent can quote real numbers.
    const relaxations = Object.keys(filters)
      .filter((k) => filters[k] != null && filters[k] !== '' && k !== 'status')
      .map((k) => {
        const idx = applyFilters(filters, k);
        const relevant = query.trim() ? [...bm25Scores(query, idx).keys()] : idx;
        const sample = relevant.map((i) => catalog.products[i]).sort((a, b) => a.price - b.price).slice(0, 3);
        return {
          dropped_filter: k,
          value: filters[k],
          matches_without_it: relevant.length,
          ...(sample.length && { cheapest_examples: sample.map((p) => ({ model: p.model, name: p.name, price_usd: p.price })) }),
        };
      })
      .filter((r) => r.matches_without_it > 0);
    return { results: [], total: 0, relaxations, retrieval: { mode: 'no_candidates' } };
  }

  let ranked;
  let retrieval = { mode: 'filters_only' };
  if (query.trim()) {
    const lex = bm25Scores(query, candidates);
    // useVectors=false: keyword-only (cheap secondary lookups — no embedding call, no Qdrant query)
    const { scores: vec, meta } = useVectors ? await vectorScores(query, candidates, filters) : { scores: new Map(), meta: { used: false, skipped: 'keyword-only lookup' } };
    // Only keep semantically-close items from the vector side so it can't flood junk in
    const vecTop = new Map([...vec.entries()].sort((a, b) => b[1] - a[1]).slice(0, searchConfig.vectorKeep));
    const fused = rrf([lex, vecTop].filter((m) => m.size));
    ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
    // If the query matched nothing at all, filters alone still define a valid result set
    if (!ranked.length && Object.keys(filters).length) ranked = candidates;
    retrieval = { mode: vecTop.size ? 'hybrid' : 'bm25_only', bm25_hits: lex.size, vector: meta };
  } else {
    ranked = candidates;
  }

  let products = ranked.map((i) => catalog.products[i]);
  if (sort === 'price_asc') products.sort((a, b) => a.price - b.price);
  if (sort === 'price_desc') products.sort((a, b) => b.price - a.price);
  if (sort === 'rating') products.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount);

  return { results: products.slice(0, limit), total: products.length, retrieval };
}
