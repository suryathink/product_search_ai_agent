// configs/ must be imported first: it loads backend/.env before any other module reads settings
import { serverConfig, openaiConfig, describeConfig } from './configs/index.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getLogger, shutdownLogger, LOG_DIR } from './logger.js';
import { requestContext, logRequests } from './middleware/requestLogger.js';
import { MODEL } from './agent.js';
import { guardedChat, chatBodySchema, feedbackBodySchema, validate } from './guardrails/index.js';
// Rate limiting temporarily disabled for the demo. To re-enable: restore this import and the 3 route lines marked "RATE LIMIT".
// import { chatRateLimits, feedbackRateLimit } from './guardrails/index.js';
import { catalog } from './catalog.js';
import { initVectorStore, vectorStatus } from './vectorstore/index.js';
import { recordInteraction, recordError, recordFeedback, metricsSnapshot } from './telemetry.js';
import { initMongo, mongoStatus, closeMongo } from './mongo.js';

const logger = getLogger('server');
const app = express();
// Behind nginx: trust X-Forwarded-For so req.ip (logged per request) is the visitor's real IP
if (serverConfig.trustProxy) app.set('trust proxy', 1);
app.use(requestContext); // first: every request gets an ID + completion log, even if body parsing fails
// helmet: standard security headers (nosniff, no framing, no referrer leaks, hides "X-Powered-By: Express")
app.use(helmet());
// CORS: the frontend calls the API directly from another origin (e.g. :5173 -> :3001).
// Default CORS_ORIGINS=* -> any website may call the API. Set a comma-separated list to restrict it.
app.use(cors({
  origin: serverConfig.corsOrigins.includes('*') ? '*' : serverConfig.corsOrigins,
  exposedHeaders: ['X-Request-Id'], // let browser code read the request ID header
}));
app.use(express.json({ limit: serverConfig.jsonBodyLimit }));
app.use(logRequests); // after json(), so the body is parsed and can be logged

/**
 * GET /api/health — is the service up, and which vector store is serving?
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @returns {void} 200 {ok, model, products, semantic_search, vector_store: {type, vectors, note?}, persistence: {mongodb, db?, note?}}
 */
app.get('/api/health', (_req, res) => {
  const v = vectorStatus();
  const mg = mongoStatus();
  res.json({
    ok: true,
    model: MODEL,
    products: catalog.products.length,
    semantic_search: v.ready,
    vector_store: { type: v.store, vectors: v.count, ...(v.reason && { note: v.reason }) },
    persistence: { mongodb: mg.connected, ...(mg.db && { db: mg.db }), ...(mg.reason && { note: mg.reason }) },
  });
});

// Live agent metrics since server start. In production protect this (auth / internal network only).
/**
 * GET /api/metrics — live agent metrics since server start (latency, cost, quality rates, feedback).
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @returns {void} 200 — see metricsSnapshot() in telemetry.js
 */
app.get('/api/metrics', (_req, res) => res.json(metricsSnapshot()));

/**
 * Validate a chat body with the zod schema (guardrails/validation.js).
 * @param {unknown} body
 * @returns {{messages?: {role: 'user'|'assistant', content: string}[], error?: string}}
 */
function parseChatBody(body) {
  const v = validate(chatBodySchema, body);
  return v.ok ? { messages: v.data.messages } : { error: `Invalid request: ${v.error}` };
}

// Stateless: the client sends the visible conversation each time.
/**
 * POST /api/chat/stream — one chat turn, STREAMED as Server-Sent Events.
 * Same body as /api/chat. Response is `text/event-stream`; each event is `event: <type>\ndata: <json>\n\n`:
 *   meta       {requestId}                      first event
 *   tool_start {tool, args}                     a tool started (UI shows "Searching products…")
 *   tool_end   {tool, ms, result_preview}       it finished
 *   token      {delta}                          next piece of the answer text
 *   reset      {}                               discard text streamed so far (model switched to tools)
 *   done       {requestId, reply, products, trace, usage, ms}   final result (same fields as /api/chat)
 *   error      {requestId, error}               something failed; stream ends
 * If the client disconnects (Stop button / tab closed), the OpenAI request is aborted to save tokens.
 * @param {import('express').Request & {id: string, sessionId: string|null}} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
// RATE LIMIT (disabled for demo): app.post('/api/chat/stream', ...chatRateLimits, async (req, res) => {
app.post('/api/chat/stream', async (req, res) => {
  const { messages, error } = parseChatBody(req.body);
  if (error) return res.status(400).json({ requestId: req.id, error });

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', // no caching / no compression buffering
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // tell nginx-style proxies not to buffer the stream
  });
  res.flushHeaders();

  /**
   * Write one SSE event (no-op once the client is gone).
   * @param {string} event
   * @param {object} data
   * @returns {void}
   */
  const send = (event, data) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 'close' on the RESPONSE before we ended it = the client went away -> abort the LLM call
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });

  const t0 = Date.now();
  send('meta', { requestId: req.id });
  try {
    const result = await guardedChat(messages, { requestId: req.id, signal: abort.signal, onEvent: send });
    const ms = Date.now() - t0;
    recordInteraction({ requestId: req.id, sessionId: req.sessionId, history: messages, result, ms });
    logger.info(`[${req.id.slice(0, 8)}] chat (stream) ${ms}ms tools=${result.trace.map((t) => t.tool).join(',') || '-'} grounded=${result.signals.grounded}${result.signals.guardrail_blocked ? ` blocked=${result.signals.guardrail_blocked}` : ''}`);
    const { reply, products, trace, usage } = result;
    send('done', { requestId: req.id, reply, products, trace, usage, ms });
  } catch (e) {
    if (abort.signal.aborted) {
      logger.info(`[${req.id.slice(0, 8)}] stream cancelled by client after ${Date.now() - t0}ms`);
    } else {
      logger.error(`[${req.id.slice(0, 8)}] chat (stream) failed`, e);
      recordError({ requestId: req.id, sessionId: req.sessionId, error: e });
      send('error', { requestId: req.id, error: 'The assistant is temporarily unavailable. Please try again.' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/chat — one chat turn.
 * Body: {messages: [{role: 'user'|'assistant', content: string}, ...]} — must end with a user message.
 * Runs the agent, records the interaction (logs + metrics) and returns the answer.
 * @param {import('express').Request & {id: string, sessionId: string|null}} req
 * @param {import('express').Response} res
 * @returns {Promise<void>} 200 {requestId, reply, products, trace, usage, ms}
 *   | 400 invalid body | 500 {requestId, error} when the agent fails (e.g. OpenAI down)
 */
// RATE LIMIT (disabled for demo): app.post('/api/chat', ...chatRateLimits, async (req, res) => {
app.post('/api/chat', async (req, res) => {
  const { messages, error } = parseChatBody(req.body);
  if (error) return res.status(400).json({ requestId: req.id, error });

  const t0 = Date.now();
  try {
    const result = await guardedChat(messages, { requestId: req.id });
    const ms = Date.now() - t0;
    recordInteraction({ requestId: req.id, sessionId: req.sessionId, history: messages, result, ms });
    logger.info(`[${req.id.slice(0, 8)}] chat ${ms}ms tools=${result.trace.map((t) => t.tool).join(',') || '-'} grounded=${result.signals.grounded}${result.signals.guardrail_blocked ? ` blocked=${result.signals.guardrail_blocked}` : ''}`);
    const { reply, products, trace, usage } = result;
    res.json({ requestId: req.id, reply, products, trace, usage, ms });
  } catch (e) {
    logger.error(`[${req.id.slice(0, 8)}] chat failed`, e);
    recordError({ requestId: req.id, sessionId: req.sessionId, error: e });
    res.status(500).json({ requestId: req.id, error: 'The assistant is temporarily unavailable. Please try again.' });
  }
});

// Thumbs up/down from the widget -> logs/feedback.*.log, linked to the answer by requestId
/**
 * POST /api/feedback — 👍/👎 on an answer.
 * Body: {requestId: string, rating: 'up'|'down', comment?: string}
 * @param {import('express').Request & {sessionId: string|null}} req
 * @param {import('express').Response} res
 * @returns {void} 200 {ok: true} | 400 invalid body
 */
// RATE LIMIT (disabled for demo): app.post('/api/feedback', feedbackRateLimit, (req, res) => {
app.post('/api/feedback', (req, res) => {
  const v = validate(feedbackBodySchema, req.body);
  if (!v.ok) return res.status(400).json({ requestId: req.id, error: `Invalid request: ${v.error}` });
  const { requestId, rating, comment } = v.data;
  recordFeedback({ requestId, sessionId: req.sessionId, rating, comment });
  res.json({ ok: true });
});

// Last-resort error handler (e.g. malformed JSON body)
/**
 * Express error handler (4 arguments = error middleware). Logs 5xx as ERROR and 4xx as WARN,
 * and never leaks internal error details to the client for 5xx.
 * @param {Error & {status?: number, statusCode?: number}} err
 * @param {import('express').Request & {id?: string}} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next  Required in the signature so Express treats this as an error handler
 * @returns {void} {requestId, error}
 */
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logger.error(`[${req.id?.slice(0, 8)}] unhandled error`, err);
  else logger.warn(`[${req.id?.slice(0, 8)}] bad request: ${err.message}`);
  res.status(status).json({ requestId: req.id, error: status >= 500 ? 'Internal error' : err.message });
});

const PORT = serverConfig.port;
logger.info('Configuration', describeConfig()); // safe view: secrets shown only as "set"/"not set"
// Connect dependencies in parallel before taking traffic. Neither can crash startup:
// vector store falls back to BM25, MongoDB falls back to log files only.
await Promise.all([initVectorStore(), initMongo()]);
const server = app.listen(PORT, serverConfig.host, () => {
  const v = vectorStatus();
  logger.info(`Product agent API on http://localhost:${PORT} (model=${MODEL}, products=${catalog.products.length}, vector_store=${v.store}, semantic_search=${v.ready}, mongodb=${mongoStatus().connected}, logs=${LOG_DIR})`);
  if (!openaiConfig.hasApiKey) logger.warn('OPENAI_API_KEY is not set — /api/chat will fail until it is (see .env.example)');
}); 

/**
 * Log promise rejections nobody handled (the process keeps running).
 * @param {unknown} e
 * @returns {void}
 */
process.on('unhandledRejection', (e) => logger.error('Unhandled promise rejection', e));
/**
 * Log a crash, flush the log files, then exit with code 1 (a process manager should restart it).
 * @param {Error} e
 * @returns {void}
 */
process.on('uncaughtException', (e) => { logger.fatal('Uncaught exception', e); shutdownLogger().then(() => process.exit(1)); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  /**
   * Graceful shutdown on Ctrl+C / container stop: stop accepting requests, flush logs, exit 0.
   * @returns {void}
   */
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    server.close(() => closeMongo().then(shutdownLogger).then(() => process.exit(0)));
  });
}
