// Single entry point for ALL configuration.
//   import { config } from './configs/index.js';
//   config.openai.chatModel, config.mongo.uri, config.search.bm25.k1, ...
// Importing this module also loads backend/.env (via env.js) — so import it first in entry points.
import { paths } from './paths.js';
import { serverConfig } from './server.config.js';
import { openaiConfig } from './openai.config.js';
import { agentConfig } from './agent.config.js';
import { searchConfig } from './search.config.js';
import { vectorStoreConfig } from './vectorStore.config.js';
import { mongoConfig } from './mongo.config.js';
import { loggingConfig } from './logging.config.js';
import { telemetryConfig } from './telemetry.config.js';

export { paths, serverConfig, openaiConfig, agentConfig, searchConfig, vectorStoreConfig, mongoConfig, loggingConfig, telemetryConfig };
export { ENV_FILE, cliFlag } from './env.js';

/**
 * Everything, grouped by area.
 */
export const config = {
  paths,
  server: serverConfig,
  openai: openaiConfig,
  agent: agentConfig,
  search: searchConfig,
  vectorStore: vectorStoreConfig,
  mongo: mongoConfig,
  logging: loggingConfig,
  telemetry: telemetryConfig,
};

/**
 * A safe-to-print view of the configuration (secrets reduced to "set"/"not set"), for startup logs and debugging.
 * @returns {object}
 */
export function describeConfig() {
  return {
    port: serverConfig.port,
    chatModel: openaiConfig.chatModel,
    openaiApiKey: openaiConfig.hasApiKey ? 'set' : 'not set',
    embeddingModel: openaiConfig.embeddingModel,
    vectorStore: vectorStoreConfig.kind,
    qdrant: { url: vectorStoreConfig.qdrant.url ? 'set' : 'not set', apiKey: vectorStoreConfig.qdrant.apiKey ? 'set' : 'not set', collection: vectorStoreConfig.qdrant.collection },
    mongo: { uri: mongoConfig.uri ? 'set' : 'not set', db: mongoConfig.dbName, ttlDays: mongoConfig.ttlDays },
    logging: { level: loggingConfig.level, dir: loggingConfig.dir, interactionFileLogs: loggingConfig.interactionFileLogs },
    agent: agentConfig,
  };
}
