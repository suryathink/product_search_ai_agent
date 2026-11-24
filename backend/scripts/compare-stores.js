// Side-by-side: local brute-force vs Qdrant on the same queries.   npm run vectors:compare
//   - latency (median of 5 runs, after warm-up)
//   - recall@10: how many of the EXACT top-10 (local brute force) Qdrant's approximate (HNSW) search also returns
//   - a filtered query to show Qdrant's server-side filtering ("pre-filtering")
// Uses OpenAI to embed text queries if OPENAI_API_KEY is set; otherwise uses product vectors as queries ("more like this").
import { openaiConfig } from '../src/configs/index.js'; // also loads backend/.env
import OpenAI from 'openai';
import { shutdownLogger } from '../src/logger.js';
import { catalog } from '../src/catalog.js';
import { applyFilters } from '../src/search.js';
import { EMBEDDING_MODEL, createVectorStore } from '../src/vectorstore/index.js';

const K = 10;
const RUNS = 5;
/**
 * Median of a list of numbers (robust to one slow outlier run).
 * @param {number[]} xs
 * @returns {number}
 */
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Product name for a SKU (for readable output).
 * @param {string} sku
 * @returns {string} the name, or the SKU itself if unknown
 */
const name = (sku) => catalog.bySku.get(sku)?.name ?? sku;

/**
 * Fit text into a fixed-width table column (cut with "…" or pad with spaces).
 * @param {string} s
 * @param {number} n  column width
 * @returns {string} exactly n characters
 */
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/**
 * Benchmark an async function: one warm-up call (connection setup, JIT), then RUNS timed calls.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{out: T, ms: number}>} result of the last call + median duration in ms
 */
async function timed(fn) {
  await fn(); // warm-up (connection setup, JIT)
  const times = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    out = await fn();
    times.push(performance.now() - t0);
  }
  return { out, ms: median(times) };
}

const local = createVectorStore('local');
const qdrant = createVectorStore('qdrant');
const [ls, qs] = await Promise.all([local.init(), qdrant.init()]);
console.log(`local : ${ls.ready ? `${ls.count} vectors (in-memory, exact brute force)` : ls.reason}`);
console.log(`qdrant: ${qs.ready ? `${qs.count} vectors at ${qdrant.url} (HNSW, approximate)` : qs.reason}`);
if (!ls.ready || !qs.ready) { console.log('\nBoth stores must be populated: run `npm run embed` first.'); await shutdownLogger(); process.exit(1); }

let queries;
if (openaiConfig.hasApiKey) {
  const texts = [
    { q: 'something to hang shelves straight' },
    { q: 'cut ceramic tile' },
    { q: 'remove old bathroom grout' },
    { q: 'gift for a woodworking hobbyist' },
    { q: 'drill holes in a concrete wall', filters: { status: ['Active'], max_price: 250, voltage: 18 } },
  ];
  const openai = new OpenAI();
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts.map((t) => t.q) });
  queries = texts.map((t, i) => ({ ...t, vector: res.data[i].embedding }));
} else {
  console.log('\n(OPENAI_API_KEY not set — using product vectors as "more like this" queries)');
  const picks = ['GSR12V-800N', 'GLL3-330CG', 'T109C6', '4000-2/30'].map((m) => catalog.byModel.get(m.toUpperCase())).filter(Boolean);
  queries = picks.map((p) => ({ q: `more like ${p.model}`, vector: [...local.vectors.get(p.sku)] }));
  queries.push({ ...queries[0], q: `${queries[0].q} (Active, <=$250, 18V)`, filters: { status: ['Active'], max_price: 250, voltage: 18 } });
}

console.log(`\n${'query'.padEnd(46)} ${'local ms'.padStart(9)} ${'qdrant ms'.padStart(10)}  recall@${K}`);
console.log('-'.repeat(80));
const recalls = [];
for (const { q, vector, filters } of queries) {
  // Local: filters applied in JS first, then exact search over the candidates
  const candidateSkus = filters ? applyFilters(filters).map((i) => catalog.products[i].sku) : undefined;
  const L = await timed(() => local.search(vector, { candidateSkus, limit: K }));
  // Qdrant: filters pushed down into the vector DB query
  const Q = await timed(() => qdrant.search(vector, { filters, limit: K }));
  const exact = new Set(L.out.map((h) => h.sku));
  const recall = Q.out.filter((h) => exact.has(h.sku)).length / Math.max(1, exact.size);
  recalls.push(recall);
  console.log(`${short(q, 46)} ${L.ms.toFixed(1).padStart(9)} ${Q.ms.toFixed(1).padStart(10)}  ${(recall * 100).toFixed(0).padStart(5)}%`);
  console.log(`   local  top3: ${L.out.slice(0, 3).map((h) => short(name(h.sku), 24)).join(' | ')}`);
  console.log(`   qdrant top3: ${Q.out.slice(0, 3).map((h) => short(name(h.sku), 24)).join(' | ')}`);
}
console.log('-'.repeat(80));
console.log(`average recall@${K}: ${((recalls.reduce((a, b) => a + b, 0) / recalls.length) * 100).toFixed(1)}%`);
console.log(`
How to read this:
- Local is exact and has no network hop, so at ${ls.count} vectors it is faster. That is expected.
- Qdrant's latency is almost all network round-trip to the cloud region, not search time.
- Below its indexing threshold (~20k vectors by default) Qdrant does not build HNSW yet: it scans exactly,
  so recall is 100% here. At scale it switches to HNSW: milliseconds for millions of vectors, while
  local brute force grows linearly (~900x slower at 2M vectors) and must fit in every server's RAM.
- Recall below 100% would mean approximate search missed exact neighbours; raising hnsw_ef trades speed for recall.`);
await shutdownLogger();
