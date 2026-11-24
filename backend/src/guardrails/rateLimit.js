// Rate limiting with express-rate-limit: every chat request costs OpenAI tokens, so a public URL
// must not let one client send unlimited requests ("denial of wallet").
// Keyed by client IP (req.ip — correct behind nginx because TRUST_PROXY sets 'trust proxy').
import rateLimit from 'express-rate-limit';
import { guardrailsConfig } from '../configs/index.js';
import { getLogger } from '../logger.js';

const logger = getLogger('guardrails');
const cfg = guardrailsConfig.rateLimit;

/**
 * Build a limiter that answers 429 with a JSON error the widget can show, and logs each block.
 * @param {string} name        For logs, e.g. "chat-minute"
 * @param {number} windowMs
 * @param {number} limit       Requests allowed per window per IP
 * @param {string} message     Shown to the user
 * @returns {import('express').RequestHandler}
 */
function limiter(name, windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8', // RateLimit-* headers tell well-behaved clients when to retry
    legacyHeaders: false,
    handler: (req, res, _next, options) => {
      logger.warn(`[${req.id?.slice(0, 8)}] rate limit "${name}" hit by ${req.ip} (${limit} per ${Math.round(windowMs / 1000)}s)`);
      res.status(options.statusCode).json({ requestId: req.id, error: message });
    },
  });
}

/** Pass-through used when rate limiting is disabled. */
const off = (_req, _res, next) => next();

/** Chat endpoints: short burst limit + daily cost cap, both per IP. */
export const chatRateLimits = cfg.enabled
  ? [
    limiter('chat-minute', 60 * 1000, cfg.perMinute, 'You are sending messages too quickly. Please wait a minute and try again.'),
    limiter('chat-day', 24 * 60 * 60 * 1000, cfg.perDay, 'Daily message limit reached. Please come back tomorrow.'),
  ]
  : [off];

/** Feedback endpoint (cheap, but still shouldn't be floodable). */
export const feedbackRateLimit = cfg.enabled
  ? limiter('feedback', 60 * 1000, cfg.feedbackPerMinute, 'Too many feedback requests. Please slow down.')
  : off;
