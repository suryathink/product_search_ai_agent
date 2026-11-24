// One-off: embed every product's text and cache it. ~2.3k products ≈ a few cents with text-embedding-3-small.
// Re-run whenever the catalog changes.
import 'dotenv/config';
import fs from 'node:fs';
import OpenAI from 'openai';
import { getLogger, shutdownLogger } from '../src/logger.js';
import { catalog } from '../src/catalog.js';
import { productText, EMBEDDINGS_PATH, EMBEDDING_MODEL } from '../src/search.js';

const logger = getLogger('embed');
const openai = new OpenAI();
const texts = catalog.products.map((p) => productText(p).slice(0, 6000));
const BATCH = 200;
const vectors = [];
const t0 = Date.now();
let tokens = 0;

try {
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts.slice(i, i + BATCH) });
    tokens += res.usage?.total_tokens ?? 0;
    // Round to 5 decimals: halves file size, no measurable effect on ranking
    vectors.push(...res.data.map((d) => d.embedding.map((x) => Math.round(x * 1e5) / 1e5)));
    logger.info(`Embedded ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify({ model: EMBEDDING_MODEL, createdAt: new Date().toISOString(), vectors }));
  logger.info(`Saved ${vectors.length} vectors to ${EMBEDDINGS_PATH} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${tokens} tokens)`);
} catch (e) {
  logger.error('Embedding build failed', e);
  process.exitCode = 1;
} finally {
  await shutdownLogger();
}
