// HTTP request logging middleware (based on the log4js reference pattern), extended with:
//   - a request ID (accepted from the X-Request-Id header or generated) returned to the client,
//     so a user complaint / thumbs-down can be traced to the exact log lines
//   - the response status and duration, logged when the response finishes
//   - body sanitizing: chat bodies contain the whole conversation every turn, so we log only the
//     newest message (redacted) + the message count instead of repeating the full history
import { randomUUID } from 'node:crypto';
import { getLogger, redact, truncate } from '../logger.js';

const logger = getLogger('api');

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body.messages)) {
    const last = body.messages.at(-1);
    return { message_count: body.messages.length, last_message: last && { role: last.role, content: truncate(redact(last.content), 300) } };
  }
  return JSON.parse(JSON.stringify(body, (_k, v) => (typeof v === 'string' ? truncate(redact(v), 300) : v)));
}

/**
 * Mount FIRST (before express.json): assigns the request ID and logs completion.
 * If it ran after the body parser, requests with malformed JSON would be rejected before
 * getting an ID and would never appear in requests.log.
 */
export function requestContext(req, res, next) {
  const start = process.hrtime.bigint();
  req.id = req.get('x-request-id') || randomUUID();
  req.sessionId = req.get('x-session-id') || null; // set by the chat widget, one per conversation
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const entry = { requestId: req.id, method: req.method, url: req.originalUrl, status: res.statusCode, durationMs: Math.round(durationMs) };
    if (res.statusCode >= 500) logger.error('Request failed', entry);
    else if (res.statusCode >= 400) logger.warn('Request rejected', entry);
    else logger.info('Request completed', entry);
  });
  next();
}

/** Mount AFTER express.json: logs the incoming request including its (sanitized) body. */
export function logRequests(req, res, next) {
  const { method, originalUrl, query } = req;
  logger.info('Incoming request', {
    requestId: req.id,
    sessionId: req.sessionId,
    method,
    url: originalUrl,
    query,
    body: sanitizeBody(req.body),
    ip: req.ip,
    userAgent: truncate(req.get('user-agent'), 120),
  });
  // Note: req.params is always {} in app-level middleware — Express fills it only inside the matched route.
  next();
}
