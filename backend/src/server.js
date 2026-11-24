import 'dotenv/config'; // must be first: agent.js reads env vars at import time
import express from 'express';
import cors from 'cors';
import { getLogger, shutdownLogger, LOG_DIR } from './logger.js';
import { requestContext, logRequests } from './middleware/requestLogger.js';
import { chat, MODEL } from './agent.js';
import { catalog } from './catalog.js';
import { hasEmbeddings } from './search.js';
import { recordInteraction, recordError, recordFeedback, metricsSnapshot } from './telemetry.js';

const logger = getLogger('server');
const app = express();
app.use(requestContext); // first: every request gets an ID + completion log, even if body parsing fails
app.use(cors({ exposedHeaders: ['X-Request-Id'] }));
app.use(express.json({ limit: '200kb' }));
app.use(logRequests); // after json(), so the body is parsed and can be logged

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, products: catalog.products.length, semantic_search: hasEmbeddings() });
});

// Live agent metrics since server start. In production protect this (auth / internal network only).
app.get('/api/metrics', (_req, res) => res.json(metricsSnapshot()));

// Stateless: the client sends the visible conversation each time.
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body ?? {};
  const valid = Array.isArray(messages) && messages.length > 0
    && messages.every((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    && messages.at(-1).role === 'user';
  if (!valid) return res.status(400).json({ error: 'Body must be { messages: [{role, content}...] } ending with a user message.' });

  const t0 = Date.now();
  try {
    const result = await chat(messages, { requestId: req.id });
    const ms = Date.now() - t0;
    recordInteraction({ requestId: req.id, sessionId: req.sessionId, history: messages, result, ms });
    logger.info(`[${req.id.slice(0, 8)}] chat ${ms}ms tools=${result.trace.map((t) => t.tool).join(',') || '-'} grounded=${result.signals.grounded}`);
    const { reply, products, trace, usage } = result;
    res.json({ requestId: req.id, reply, products, trace, usage, ms });
  } catch (e) {
    logger.error(`[${req.id.slice(0, 8)}] chat failed`, e);
    recordError({ requestId: req.id, sessionId: req.sessionId, error: e });
    res.status(500).json({ requestId: req.id, error: 'The assistant is temporarily unavailable. Please try again.' });
  }
});

// Thumbs up/down from the widget -> logs/feedback.*.log, linked to the answer by requestId
app.post('/api/feedback', (req, res) => {
  const { requestId, rating, comment } = req.body ?? {};
  if (typeof requestId !== 'string' || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'Body must be { requestId, rating: "up"|"down", comment? }' });
  }
  recordFeedback({ requestId, sessionId: req.sessionId, rating, comment: typeof comment === 'string' ? comment : undefined });
  res.json({ ok: true });
});

// Last-resort error handler (e.g. malformed JSON body)
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) logger.error(`[${req.id?.slice(0, 8)}] unhandled error`, err);
  else logger.warn(`[${req.id?.slice(0, 8)}] bad request: ${err.message}`);
  res.status(status).json({ requestId: req.id, error: status >= 500 ? 'Internal error' : err.message });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info(`Product agent API on http://localhost:${PORT} (model=${MODEL}, products=${catalog.products.length}, semantic_search=${hasEmbeddings()}, logs=${LOG_DIR})`);
  if (!process.env.OPENAI_API_KEY) logger.warn('OPENAI_API_KEY is not set — /api/chat will fail until it is (see .env.example)');
});

process.on('unhandledRejection', (e) => logger.error('Unhandled promise rejection', e));
process.on('uncaughtException', (e) => { logger.fatal('Uncaught exception', e); shutdownLogger().then(() => process.exit(1)); });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logger.info(`${sig} received, shutting down`);
    server.close(() => shutdownLogger().then(() => process.exit(0)));
  });
}
