// Incremental vector sync:  npm run embed  [-- --target=local|qdrant|both] [--dry-run]
//
// 1. Hash every product's indexed text (sha1 of model name + text).
// 2. Embed ONLY products that are new or whose text changed (vs. the local cache) -> you pay once per change.
// 3. Write the local cache (data/embeddings.json) = the "local" vector store.
// 4. If Qdrant is configured, upsert changed points and delete removed products there too.
// Default target: both if QDRANT_URL is set, otherwise local.
import { openaiConfig, vectorStoreConfig } from '../src/configs/index.js'; // also loads backend/.env
import crypto from 'node:crypto';
import OpenAI from 'openai';
import { getLogger, shutdownLogger } from '../src/logger.js';
import { catalog } from '../src/catalog.js';
import { productText } from '../src/search.js';
import { EMBEDDING_MODEL, createVectorStore, qdrantUrl } from '../src/vectorstore/index.js';
import { LocalStore, readLocalFile, LOCAL_PATH } from '../src/vectorstore/local.js';

const logger = getLogger('sync');
/**
 * Read a `--name=value` command-line argument.
 * @param {string} name  e.g. "target"
 * @returns {string|undefined} e.g. "qdrant" for `--target=qdrant`
 */
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const DRY = process.argv.includes('--dry-run');
const target = arg('target') || (qdrantUrl() ? 'both' : 'local');
const BATCH = openaiConfig.embeddingBatchSize; // texts per embeddings call
const UPSERT_BATCH = vectorStoreConfig.qdrant.upsertBatchSize; // points per Qdrant upsert

/**
 * Fingerprint of what gets embedded for a product. Changes when the product text OR the
 * embedding model changes -> that product is re-embedded; otherwise its cached vector is reused.
 * @param {import('../src/catalog.js').Product} p
 * @returns {string} 40-char SHA-1 hex
 */
const hashOf = (p) => crypto.createHash('sha1').update(`${EMBEDDING_MODEL}\n${productText(p)}`).digest('hex');

/**
 * The sync: compare hashes with the local cache, embed only new/changed products (OpenAI),
 * rewrite the local store, then upsert changed / delete removed points in Qdrant (if targeted).
 * @returns {Promise<void>}
 * @throws on OpenAI or Qdrant errors (logged; process exits with code 1)
 */
async function main() {
  const t0 = Date.now();
  const products = catalog.products;
  const hashes = new Map(products.map((p) => [p.sku, hashOf(p)]));

  // ---- 1. local cache: what do we already have embedded? ----
  const file = readLocalFile(products);
  const cache = new Map();
  if (file && file.model === EMBEDDING_MODEL) {
    for (const it of file.items) cache.set(it.sku, it);
    if (file.items.some((it) => it.hash == null)) {
      logger.info('Local cache is in the old format (no hashes) — trusting its vectors and adding hashes now');
      for (const it of cache.values()) if (it.hash == null) it.hash = hashes.get(it.sku);
    }
  }
  const toEmbed = products.filter((p) => cache.get(p.sku)?.hash !== hashes.get(p.sku));
  logger.info(`Catalog: ${products.length} products | cached vectors: ${cache.size} | need embedding: ${toEmbed.length} | target: ${target}`);

  if (DRY) { logger.info('Dry run — nothing written'); return; }

  // ---- 2. embed only what's new/changed ----
  if (toEmbed.length) {
    const openai = new OpenAI();
    let tokens = 0;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch = toEmbed.slice(i, i + BATCH);
      const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: batch.map((p) => productText(p).slice(0, 6000)) });
      tokens += res.usage?.total_tokens ?? 0;
      res.data.forEach((d, j) => {
        const p = batch[j];
        // Round to 5 decimals: halves file size, no measurable effect on ranking
        cache.set(p.sku, { sku: p.sku, hash: hashes.get(p.sku), vector: d.embedding.map((x) => Math.round(x * 1e5) / 1e5) });
      });
      logger.info(`Embedded ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`);
    }
    logger.info(`Embedding done: ${tokens} tokens`);
  }

  // ---- 3. local store = cache restricted to current catalog (drops removed products) ----
  const items = products.map((p) => cache.get(p.sku)).filter(Boolean);
  new LocalStore(products).writeAll(items, EMBEDDING_MODEL);
  logger.info(`Local store: wrote ${items.length} vectors to ${LOCAL_PATH}`);

  // ---- 4. Qdrant: upsert changed points, delete removed ----
  if (target === 'qdrant' || target === 'both') {
    const qdrant = createVectorStore('qdrant');
    await qdrant.ensureCollection(items[0].vector.length);
    const remote = await qdrant.listHashes();
    const bySku = new Map(products.map((p) => [p.sku, p]));
    const changed = items.filter((it) => remote.get(it.sku) !== it.hash);
    const removed = [...remote.keys()].filter((sku) => !bySku.has(sku));
    logger.info(`Qdrant "${qdrant.collection}": ${remote.size} points | to upsert: ${changed.length} | to delete: ${removed.length}`);
    for (let i = 0; i < changed.length; i += UPSERT_BATCH) {
      const batch = changed.slice(i, i + UPSERT_BATCH);
      await qdrant.upsert(batch.map((it) => ({ product: bySku.get(it.sku), hash: it.hash, vector: it.vector, model: EMBEDDING_MODEL })));
      logger.info(`Qdrant upserted ${Math.min(i + UPSERT_BATCH, changed.length)}/${changed.length}`);
    }
    await qdrant.remove(removed);
    const status = await qdrant.init();
    logger.info(`Qdrant now holds ${status.count} vectors`);
  }
  logger.info(`Sync finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

try {
  await main();
} catch (e) {
  logger.error('Vector sync failed', e);
  process.exitCode = 1;
} finally {
  await shutdownLogger();
}
