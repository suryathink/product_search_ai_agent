// Pick the vector store from config. Everything else talks to this small interface:
//   init() -> {ready, count, reason?}     search(vector, opts) -> [{sku, score}]
//   listHashes() / upsert() / remove()     used by the sync script
// Swapping Qdrant for pgvector / OpenSearch later = one new file here.
import { catalog } from '../catalog.js';
import { getLogger } from '../logger.js';
import { QdrantStore } from './qdrant.js';
import { LocalStore } from './local.js';
import { openaiConfig, vectorStoreConfig } from '../configs/index.js';

const logger = getLogger('vectorstore');
 
/**
 * The interface every vector store implements (QdrantStore, LocalStore).
 * Search code depends only on this, so stores are interchangeable.
 * @typedef {object} VectorStore
 * @property {'qdrant'|'local'} name
 * @property {() => Promise<{ready: boolean, count: number, reason?: string}>} init
 *   Connect / load and report how many vectors are available
 * @property {(vector: number[], opts?: {filters?: object, candidateSkus?: string[], limit?: number}) => Promise<{sku: string, score: number}[]>} search
 *   Nearest neighbours of a query vector, best first (score = cosine similarity)
 * @property {() => Promise<Map<string, string|null>>} listHashes
 *   sku -> content hash of what is stored (used by the incremental sync)
 */

/** OpenAI embedding model used for products AND queries (must be the same for both). */
export const EMBEDDING_MODEL = openaiConfig.embeddingModel;
/** Vector length produced by EMBEDDING_MODEL. */
export const EMBEDDING_DIM = openaiConfig.embeddingDim;

/**
 * Which store? Priority: --vector-store=local|qdrant CLI flag > VECTOR_STORE env > qdrant if QDRANT_URL is set > local.
 * (CLI flag because `VAR=x node ...` in npm scripts doesn't work on Windows.)
 * @returns {string} "qdrant" or "local" (lower-cased)
 * @example // npm run dev:local  ->  node src/server.js --vector-store=local  ->  "local"
 */
export function selectedStoreKind() {
  return vectorStoreConfig.kind; // resolved in configs/vectorStore.config.js
}

/**
 * Accept QDRANT_URL or QDRANT_HOST; a bare hostname gets https:// (the client adds port 6333 by default).
 * @returns {string|null} normalized URL without trailing slash, or null when Qdrant is not configured
 * @example // QDRANT_HOST=abc.cloud.qdrant.io  ->  "https://abc.cloud.qdrant.io"
 */
export function qdrantUrl() {
  return vectorStoreConfig.qdrant.url; // resolved in configs/vectorStore.config.js
}

/**
 * Create (but don't connect) a vector store.
 * @param {string} [kind=selectedStoreKind()]  "qdrant" or "local"
 * @returns {VectorStore & (import('./qdrant.js').QdrantStore | import('./local.js').LocalStore)}
 * @throws {Error} when "qdrant" is requested but no Qdrant URL is configured
 */
export function createVectorStore(kind = selectedStoreKind()) {
  if (kind === 'qdrant') {
    if (!qdrantUrl()) throw new Error('Qdrant selected but QDRANT_URL / QDRANT_HOST is not set');
    return new QdrantStore({
      url: qdrantUrl(),
      apiKey: vectorStoreConfig.qdrant.apiKey,
      collection: vectorStoreConfig.qdrant.collection,
    });
  }
  return new LocalStore(catalog.products);
}

let store = null;
let status = { ready: false, count: 0, store: null, reason: 'not initialized' };
let initPromise = null;

/**
 * Lazy, memoized init: the server awaits it at startup; scripts trigger it on first search.
 * Never throws — on any failure, semantic search is disabled and search continues with BM25.
 * @returns {Promise<{ready: boolean, count: number, store: string|null, reason?: string}>}
 *   the same promise on every call (initializes only once)
 */
export function initVectorStore() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        store = createVectorStore();
        const r = await store.init();
        status = { ...r, store: store.name };
        if (r.ready) logger.info(`Semantic search enabled via ${store.name} (${r.count} vectors)`);
        else logger.warn(`Semantic search disabled (${store.name}): ${r.reason}. Using BM25 keyword search only.`);
      } catch (e) {
        status = { ready: false, count: 0, store: store?.name ?? null, reason: e.message };
        logger.warn(`Vector store unavailable (${e.message}). Using BM25 keyword search only.`);
      }
      return status;
    })();
  }
  return initPromise;
}

/**
 * Current vector-store status (shown in /api/health and the UI header).
 * @returns {{ready: boolean, count: number, store: string|null, reason?: string}}
 */
export const vectorStatus = () => status;

/**
 * The active vector store, or null before {@link initVectorStore} has run / if creation failed.
 * @returns {VectorStore|null}
 */
export const getVectorStore = () => store;
