// Local vector store: a JSON file + exact brute-force cosine search in memory.
// Good for offline development / tests and as a zero-infrastructure fallback.
import fs from 'node:fs';
import { paths } from '../configs/index.js';

/** Where the local vectors live (also the embedding cache used by `npm run embed`). From configs/paths.js. */
export const LOCAL_PATH = paths.embeddingsFile;

/**
 * One stored vector.
 * @typedef {{sku: string, hash: string|null, vector: number[]}} VectorItem
 *   hash = SHA-1 of the product text it was embedded from (null in the old file format)
 */

/**
 * Cosine similarity: how closely two vectors point in the same direction.
 * 1 = same meaning, ~0 = unrelated. Computed exactly over every dimension.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b  same length as a
 * @returns {number} in [-1, 1]
 */
const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

/**
 * File format: { model, items: [{ sku, hash, vector }] }.
 * Also reads the older format { model, vectors: [...] } (aligned with catalog row order, no hashes).
 * @param {import('../catalog.js').Product[]} catalogProducts  Needed to map the old format's row order to SKUs
 * @returns {{model: string, items: VectorItem[]} | null} null if the file is missing, unreadable or doesn't match the catalog
 */
export function readLocalFile(catalogProducts) {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
    if (Array.isArray(raw.items)) return { model: raw.model, items: raw.items };
    if (Array.isArray(raw.vectors) && raw.vectors.length === catalogProducts.length) {
      return { model: raw.model, items: raw.vectors.map((v, i) => ({ sku: catalogProducts[i].sku, hash: null, vector: v })) };
    }
  } catch { /* missing or unreadable */ }
  return null;
}

/**
 * Vector store backed by a local JSON file, searched by exact brute force in memory.
 * Implements the VectorStore interface (see ./index.js).
 */
export class LocalStore {
  /**
   * @param {import('../catalog.js').Product[]} catalogProducts
   */
  constructor(catalogProducts) {
    this.name = 'local';
    this.products = catalogProducts;
    this.vectors = new Map(); // sku -> Float32Array
  }

  /**
   * Load all vectors from the file into memory (Float32Array halves RAM vs. plain arrays).
   * @returns {Promise<{ready: boolean, count: number, reason?: string}>}
   */
  async init() {
    const file = readLocalFile(this.products);
    if (!file) return { ready: false, count: 0, reason: `${LOCAL_PATH} not found — run \`npm run embed\`` };
    for (const it of file.items) this.vectors.set(it.sku, Float32Array.from(it.vector));
    return { ready: this.vectors.size > 0, count: this.vectors.size };
  }

  /**
   * What is stored, for the incremental sync.
   * @returns {Promise<Map<string, string|null>>} sku -> content hash
   */
  async listHashes() {
    const file = readLocalFile(this.products);
    return new Map((file?.items ?? []).map((it) => [it.sku, it.hash]));
  }

  /**
   * Write the whole file (local store has no partial updates — one of the reasons to use a real vector DB).
   * @param {VectorItem[]} items  All vectors to keep
   * @param {string} model        Embedding model name, stored so a model change invalidates the cache
   * @returns {void}
   */
  writeAll(items, model) {
    fs.writeFileSync(LOCAL_PATH, JSON.stringify({ model, createdAt: new Date().toISOString(), items }));
  }

  /**
   * Exact search over the given candidate SKUs (filters were already applied in JS).
   * @param {number[]} vector                      Query embedding
   * @param {object} [opts]
   * @param {Iterable<string>} [opts.candidateSkus] Only score these SKUs (default: all)
   * @param {number} [opts.limit=100]              How many nearest neighbours to return
   * @returns {Promise<{sku: string, score: number}[]>} best first; score = cosine similarity
   */
  async search(vector, { candidateSkus, limit = 100 } = {}) {
    const scored = [];
    for (const sku of candidateSkus ?? this.vectors.keys()) {
      const v = this.vectors.get(sku);
      if (v) scored.push({ sku, score: cosine(vector, v) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
