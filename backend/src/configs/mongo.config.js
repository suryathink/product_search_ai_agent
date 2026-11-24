// MongoDB (Atlas) persistence for interactions, conversations and feedback.
import { num, str } from './env.js';

/**
 * @type {{uri: string|null, dbName: string, ttlDays: number, serverSelectionTimeoutMs: number, connectTimeoutMs: number, appName: string}}
 */
export const mongoConfig = {
  /** Connection string; unset = persistence disabled (log files only). Env: MONGO_URI (or MONGODB_URI) */
  uri: str(['MONGO_URI', 'MONGODB_URI']),
  /** Database name. Env: MONGO_DB */
  dbName: str('MONGO_DB', 'bosch_product_agent'),
  /** Conversation data auto-deletes after this many days (TTL index). Env: MONGO_TTL_DAYS */
  ttlDays: num('MONGO_TTL_DAYS', 90),
  /** Fail fast when Atlas is unreachable so startup isn't held up for long */
  serverSelectionTimeoutMs: 5000,
  connectTimeoutMs: 5000,
  /** Shown in Atlas monitoring, identifies this app's connections */
  appName: 'product-agent',
};
