// Qdrant vector store (works with Qdrant Cloud free tier or a local Docker container — same API).
//
// Why Qdrant: open source (no lock-in, can self-host later), HNSW index, fast payload filtering
// combined with vector search, simple REST API, free managed cloud tier.
import crypto from 'node:crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { getLogger } from '../logger.js';
import { vectorStoreConfig } from '../configs/index.js';

const logger = getLogger('qdrant');
const QUERY_TIMEOUT_MS = vectorStoreConfig.qdrant.timeoutMs;

/**
 * Qdrant point IDs must be an unsigned int or UUID. Derive a stable UUID from the SKU so upserts are idempotent.
 * (Same SKU -> same ID, so re-running the sync overwrites instead of duplicating.)
 * @param {string} sku  e.g. "0664622522"
 * @returns {string} UUID-formatted MD5 of the SKU, e.g. "00378a84-ff7b-e4b9-440d-2df22572d033"
 */
export function pointId(sku) {
  const h = crypto.createHash('md5').update(String(sku)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Lower-case, keeping null as null (so missing fields stay missing in the payload).
 * @param {*} s
 * @returns {string|null}
 */
const lc = (s) => (s == null ? null : String(s).toLowerCase());

/**
 * Payload stored next to each vector. *_lc fields make keyword filters case-insensitive.
 * @param {import('../catalog.js').Product} p
 * @param {string} contentHash     SHA-1 of the embedded text (lets the sync detect changes)
 * @param {string} embeddingModel  e.g. "text-embedding-3-small"
 * @returns {{sku: string, model: string, name: string, brand_lc: string|null, category_lc: string|null,
 *   subcategory_lc: string|null, status_lc: string|null, price: number|null, voltage: number|null,
 *   content_hash: string, embedding_model: string}}
 */
export function payloadFor(p, contentHash, embeddingModel) {
  return {
    sku: p.sku,
    model: p.model,
    name: p.name,
    brand_lc: lc(p.brand),
    category_lc: lc(p.category),
    subcategory_lc: lc(p.subcategory),
    status_lc: lc(p.status),
    price: p.price,
    voltage: p.voltage,
    content_hash: contentHash,
    embedding_model: embeddingModel,
  };
}

// Fields we filter on server-side get a payload index (like a DB index) so filtering stays fast at scale.
const PAYLOAD_INDEXES = {
  brand_lc: 'keyword', category_lc: 'keyword', subcategory_lc: 'keyword', status_lc: 'keyword',
  price: 'float', voltage: 'integer', content_hash: 'keyword',
};

/**
 * Translate our search filters into a Qdrant filter ("pre-filtering": the ANN search only
 * considers matching points). Only simple fields are pushed down; complex ones (spec_filters, kit,
 * product_type substring) are still applied in JS on the results.
 * @param {import('../search.js').SearchFilters} [filters={}]
 * @returns {{must: object[]} | undefined} Qdrant filter object, or undefined when nothing can be pushed down
 * @example toQdrantFilter({ voltage: 18, max_price: 250 })
 * // -> { must: [ {key:'price', range:{lte:250}}, {key:'voltage', match:{value:18}} ] }
 */
export function toQdrantFilter(filters = {}) {
  const must = [];
  if (filters.brand) must.push({ key: 'brand_lc', match: { value: lc(filters.brand) } });
  if (filters.category) must.push({ key: 'category_lc', match: { value: lc(filters.category) } });
  if (filters.subcategory) must.push({ key: 'subcategory_lc', match: { value: lc(filters.subcategory) } });
  if (filters.status) {
    const statuses = (Array.isArray(filters.status) ? filters.status : [filters.status]).map(lc);
    must.push({ key: 'status_lc', match: { any: statuses } });
  }
  if (filters.min_price != null || filters.max_price != null) {
    must.push({ key: 'price', range: { ...(filters.min_price != null && { gte: filters.min_price }), ...(filters.max_price != null && { lte: filters.max_price }) } });
  }
  if (filters.voltage != null) must.push({ key: 'voltage', match: { value: Number(filters.voltage) } });
  return must.length ? { must } : undefined;
}

/**
 * Vector store backed by Qdrant (Cloud or self-hosted). Implements the VectorStore interface (see ./index.js)
 * plus write methods used by the sync script.
 */
export class QdrantStore {
  /**
   * @param {object} config
   * @param {string} config.url         Cluster URL, e.g. "https://xxxx.cloud.qdrant.io"
   * @param {string} [config.apiKey]    API key (not needed for a local Docker instance)
   * @param {string} config.collection  Collection name, e.g. "bosch_products"
   */
  constructor({ url, apiKey, collection }) {
    this.name = 'qdrant';
    this.collection = collection;
    this.client = new QdrantClient({ url, apiKey, checkCompatibility: false });
    this.url = url;
  }

  /**
   * Called at startup: is the collection there and how many vectors does it hold?
   * @returns {Promise<{ready: boolean, count: number, reason?: string}>}
   * @throws when the cluster is unreachable (caught by initVectorStore -> BM25 fallback)
   */
  async init() {
    const exists = (await this.client.collectionExists(this.collection)).exists;
    if (!exists) return { ready: false, count: 0, reason: `collection "${this.collection}" does not exist — run \`npm run embed\`` };
    const { count } = await this.client.count(this.collection, { exact: true });
    return { ready: count > 0, count, reason: count ? undefined : 'collection is empty — run `npm run embed`' };
  }

  /**
   * Create the collection if missing (Cosine distance) and make sure all payload indexes exist.
   * Safe to call repeatedly.
   * @param {number} vectorSize  Embedding length, 1536 for text-embedding-3-small
   * @returns {Promise<void>}
   */
  async ensureCollection(vectorSize) {
    const exists = (await this.client.collectionExists(this.collection)).exists;
    if (!exists) {
      // Cosine distance: same similarity measure as the local brute-force store
      await this.client.createCollection(this.collection, { vectors: { size: vectorSize, distance: 'Cosine' } });
      logger.info(`Created collection "${this.collection}" (size=${vectorSize}, distance=Cosine)`);
    }
    for (const [field, schema] of Object.entries(PAYLOAD_INDEXES)) {
      await this.client.createPayloadIndex(this.collection, { field_name: field, field_schema: schema, wait: true });
    }
  }

  /**
   * sku -> content_hash for everything currently stored (used for incremental sync).
   * Pages through the collection 1000 points at a time without downloading vectors.
   * @returns {Promise<Map<string, string>>}
   */
  async listHashes() {
    const out = new Map();
    let offset;
    do {
      const page = await this.client.scroll(this.collection, { limit: 1000, offset, with_payload: ['sku', 'content_hash'], with_vector: false });
      for (const pt of page.points) out.set(pt.payload.sku, pt.payload.content_hash);
      offset = page.next_page_offset ?? undefined;
    } while (offset);
    return out;
  }

  /**
   * Insert or overwrite points (one per product) and wait until Qdrant has applied them.
   * @param {{product: import('../catalog.js').Product, hash: string, vector: number[], model: string}[]} items
   * @returns {Promise<void>}
   */
  async upsert(items) { // items: [{ product, hash, vector, model }]
    await this.client.upsert(this.collection, {
      wait: true,
      points: items.map(({ product, hash, vector, model }) => ({ id: pointId(product.sku), vector, payload: payloadFor(product, hash, model) })),
    });
  }

  /**
   * Delete points for products that left the catalog.
   * @param {string[]} skus
   * @returns {Promise<void>}
   */
  async remove(skus) {
    if (skus.length) await this.client.delete(this.collection, { wait: true, points: skus.map(pointId) });
  }

  /**
   * Nearest neighbours of `vector`, pre-filtered by the pushable filters.
   * Gives up after QDRANT_TIMEOUT_MS (default 2 s) so a slow DB can't make the chatbot slow.
   * @param {number[]} vector  Query embedding
   * @param {object} [opts]
   * @param {import('../search.js').SearchFilters} [opts.filters]  Pushed down via {@link toQdrantFilter}
   * @param {number} [opts.limit=100]
   * @returns {Promise<{sku:string, score:number}[]>} best first; score = cosine similarity
   * @throws on timeout or network error (caller falls back to BM25)
   */
  async search(vector, { filters, limit = 100 } = {}) {
    const request = this.client.query(this.collection, {
      query: vector,
      filter: toQdrantFilter(filters),
      limit,
      with_payload: ['sku'],
    });
    // A slow vector DB must not make the chatbot slow: give up and let BM25 carry the query
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Qdrant query timed out after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS); });
    try {
      const res = await Promise.race([request, timeout]);
      return res.points.map((p) => ({ sku: p.payload.sku, score: p.score }));
    } finally {
      clearTimeout(timer);
    }
  }
}
