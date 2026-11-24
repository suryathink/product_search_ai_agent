// MongoDB persistence for conversations (in ADDITION to the log files).
//
// Why: log files live on one server's disk — they're lost when a container is replaced, can't be
// queried, and aren't shared between instances. MongoDB (Atlas) gives durable, queryable,
// centrally-retained conversation history.
//
// Collections
//   interactions   one document per chat turn (question, answer, tool calls, tokens, cost, quality signals)
//   conversations  one document per session, turns appended -> a whole conversation in one read
//   feedback       one document per thumbs up/down, linked to the turn by requestId
//
// Design rules
//   - Writes never block or break the chat: fire-and-forget, errors are logged, the log files still have everything.
//   - If MONGO_URI is not set or Atlas is unreachable, persistence is simply disabled.
//   - Retention: documents expire after MONGO_TTL_DAYS (default 90) via TTL indexes (data protection).
import { MongoClient } from 'mongodb';
import { getLogger } from './logger.js';
import { mongoConfig } from './configs/index.js';

const logger = getLogger('mongo');
const TTL_DAYS = mongoConfig.ttlDays;

let client = null;
let db = null;
let status = { enabled: false, connected: false, reason: 'not initialized' };
let initPromise = null;

/**
 * Connect to MongoDB once (memoized) and make sure indexes exist.
 * Never throws: on failure persistence is disabled and the app continues with log files only.
 * @returns {Promise<{enabled: boolean, connected: boolean, db?: string, reason?: string}>}
 */
export function initMongo() {
  if (!initPromise) {
    initPromise = (async () => {
      const { uri } = mongoConfig;
      if (!uri) {
        status = { enabled: false, connected: false, reason: 'MONGO_URI not set' };
        logger.info('MongoDB persistence disabled (MONGO_URI not set) — conversations go to log files only');
        return status;
      }
      try {
        // Short timeouts: a slow/unreachable cluster must not delay server startup for long
        client = new MongoClient(uri, {
          serverSelectionTimeoutMS: mongoConfig.serverSelectionTimeoutMs,
          connectTimeoutMS: mongoConfig.connectTimeoutMs,
          appName: mongoConfig.appName,
        });
        await client.connect();
        db = client.db(mongoConfig.dbName);
        await ensureIndexes();
        status = { enabled: true, connected: true, db: db.databaseName };
        logger.info(`MongoDB connected (db="${db.databaseName}", retention ${TTL_DAYS} days)`);
      } catch (e) {
        status = { enabled: true, connected: false, reason: e.message };
        logger.warn(`MongoDB unavailable (${e.message}) — conversations go to log files only`);
        db = null;
      }
      return status;
    })();
  }
  return initPromise;
}

/**
 * Create the indexes the app relies on. Idempotent (MongoDB ignores existing identical indexes).
 * - requestId unique: one document per turn, safe to retry
 * - sessionId + createdAt: "show me this conversation" queries
 * - createdAt TTL: automatic deletion after TTL_DAYS
 * @returns {Promise<void>}
 */
async function ensureIndexes() {
  const ttl = TTL_DAYS * 24 * 3600;
  await Promise.all([
    db.collection('interactions').createIndexes([
      { key: { requestId: 1 }, name: 'requestId_unique', unique: true },
      { key: { sessionId: 1, createdAt: 1 }, name: 'session_time' },
      { key: { createdAt: 1 }, name: 'ttl_createdAt', expireAfterSeconds: ttl },
      { key: { 'signals.grounded': 1, createdAt: -1 }, name: 'grounded_time' },
    ]),
    db.collection('conversations').createIndexes([
      { key: { sessionId: 1 }, name: 'sessionId_unique', unique: true },
      { key: { updatedAt: 1 }, name: 'ttl_updatedAt', expireAfterSeconds: ttl },
    ]),
    db.collection('feedback').createIndexes([
      { key: { requestId: 1 }, name: 'requestId' },
      { key: { createdAt: 1 }, name: 'ttl_createdAt', expireAfterSeconds: ttl },
    ]),
  ]);
}

/**
 * Run a write in the background. The caller never waits and never sees an error;
 * failures are logged so they show up in errors.log.
 * @param {string} what            Description for the log, e.g. "interaction 1a2b3c4d"
 * @param {() => Promise<unknown>} fn  The write
 * @returns {void}
 */
function background(what, fn) {
  if (!db) return; // persistence disabled or not connected: log files are the record
  fn().catch((e) => logger.error(`MongoDB write failed (${what}): ${e.message}`));
}

/**
 * Persist one chat turn: insert into `interactions` and append the turn to the session's `conversations` doc.
 * @param {object} record  The same structured record written to logs/interactions.*.log (user text already redacted)
 * @param {string} record.requestId
 * @param {string|null} record.sessionId
 * @returns {void}
 */
export function saveInteraction(record) {
  const now = new Date();
  background(`interaction ${record.requestId?.slice(0, 8)}`, async () => {
    await db.collection('interactions').insertOne({ ...record, createdAt: now });
    if (!record.sessionId || record.status === 'error') return;
    // Upsert: first turn creates the conversation, later turns are appended in order
    await db.collection('conversations').updateOne(
      { sessionId: record.sessionId },
      {
        $setOnInsert: { sessionId: record.sessionId, createdAt: now, model: record.model },
        $set: { updatedAt: now },
        $inc: { turnCount: 1, totalCostUsd: record.cost_usd ?? 0 },
        $push: {
          turns: {
            requestId: record.requestId,
            at: now,
            user: record.user_message,
            assistant: record.reply,
            products: record.products,
            tools: (record.tool_calls ?? []).map((t) => t.tool),
            grounded: record.signals?.grounded,
            latencyMs: record.latency_ms,
          },
        },
      },
      { upsert: true },
    );
  });
}

/**
 * Persist a thumbs up/down, and mark it on the conversation turn it rates.
 * @param {{requestId: string, sessionId: string|null, rating: 'up'|'down', comment?: string}} fb  comment already redacted
 * @returns {void}
 */
export function saveFeedback(fb) {
  const now = new Date();
  background(`feedback ${fb.requestId?.slice(0, 8)}`, async () => {
    await db.collection('feedback').insertOne({ ...fb, createdAt: now });
    await db.collection('interactions').updateOne({ requestId: fb.requestId }, { $set: { feedback: { rating: fb.rating, comment: fb.comment, at: now } } });
    if (fb.sessionId) {
      await db.collection('conversations').updateOne(
        { sessionId: fb.sessionId, 'turns.requestId': fb.requestId },
        { $set: { 'turns.$.feedback': fb.rating } }, // positional $: the matched turn
      );
    }
  });
}

/**
 * Current persistence status (shown in /api/health).
 * @returns {{enabled: boolean, connected: boolean, db?: string, reason?: string}}
 */
export const mongoStatus = () => status;

/**
 * The connected database handle, or null (used by scripts such as the report).
 * @returns {import('mongodb').Db|null}
 */
export const getDb = () => db;

/**
 * Close the connection on shutdown (lets in-flight writes finish).
 * @returns {Promise<void>}
 */
export async function closeMongo() {
  if (client) await client.close().catch(() => {});
}
