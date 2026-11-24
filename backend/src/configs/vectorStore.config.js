// Vector store selection and Qdrant connection.
import { cliFlag, num, str } from './env.js';

/**
 * Qdrant URL from QDRANT_URL or QDRANT_HOST; a bare hostname gets https:// (client adds port 6333).
 * @returns {string|null}
 */
function resolveQdrantUrl() {
  const v = str(['QDRANT_URL', 'QDRANT_HOST']);
  if (!v) return null;
  return /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : `https://${v}`;
}

const qdrantUrl = resolveQdrantUrl();

/**
 * @type {{kind: 'qdrant'|'local'|string, qdrant: {url: string|null, apiKey: string|null, collection: string, timeoutMs: number, upsertBatchSize: number}}}
 */
export const vectorStoreConfig = {
  /**
   * Which store serves vector search.
   * Priority: --vector-store=local|qdrant CLI flag > VECTOR_STORE env > "qdrant" if a Qdrant URL is set > "local".
   */
  kind: (cliFlag('vector-store') || str('VECTOR_STORE') || (qdrantUrl ? 'qdrant' : 'local')).toLowerCase(),
  qdrant: {
    /** Cluster URL. Env: QDRANT_URL or QDRANT_HOST */
    url: qdrantUrl,
    /** API key (not needed for a local Docker Qdrant). Env: QDRANT_API_KEY */
    apiKey: str('QDRANT_API_KEY'),
    /** Collection holding product vectors. Env: QDRANT_COLLECTION */
    collection: str('QDRANT_COLLECTION', 'bosch_products'),
    /** Give up on a vector query after this long and let BM25 answer. Env: QDRANT_TIMEOUT_MS */
    timeoutMs: num('QDRANT_TIMEOUT_MS', 2000),
    /** Points per upsert request in `npm run embed` */
    upsertBatchSize: 256,
  },
};
