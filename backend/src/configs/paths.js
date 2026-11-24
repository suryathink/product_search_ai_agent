// File-system locations used by the app and scripts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { str } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root (the folder that contains backend/, frontend/, data/). */
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

/** Backend root (backend/). */
export const BACKEND_ROOT = path.resolve(__dirname, '../..');

/**
 * All paths in one object.
 * @type {{dataDir: string, catalogCsv: string, embeddingsFile: string, logDir: string, examplesDir: string}}
 */
export const paths = {
  /** data/ — catalog CSV and local vectors */
  dataDir: path.join(PROJECT_ROOT, 'data'),
  /** The product catalog (source of truth) */
  catalogCsv: str('CATALOG_CSV') ?? path.join(PROJECT_ROOT, 'data', 'bosch_product_catalog_mock.csv'),
  /** Local vector store + embedding cache written by `npm run embed` */
  embeddingsFile: str('EMBEDDINGS_FILE') ?? path.join(PROJECT_ROOT, 'data', 'embeddings.json'),
  /** Where log4js writes its daily files */
  logDir: str('LOG_DIR') ?? path.join(BACKEND_ROOT, 'logs'),
  /** Eval transcripts (examples/conversations.md) */
  examplesDir: path.join(PROJECT_ROOT, 'examples'),
};
