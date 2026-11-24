// Guardrail settings: rate limiting, content moderation, request validation.
import { bool, num, str } from './env.js';

/**
 * @type {{
 *   rateLimit: {enabled: boolean, perMinute: number, perDay: number, feedbackPerMinute: number},
 *   moderation: {enabled: boolean, model: string, checkOutput: boolean, failOpen: boolean},
 *   input: {maxMessages: number, maxUserChars: number, maxAssistantChars: number}
 * }}
 */
export const guardrailsConfig = {
  rateLimit: {
    /** Turn rate limiting on/off. Env: RATE_LIMIT_ENABLED */
    enabled: bool('RATE_LIMIT_ENABLED', true),
    /** Chat requests per IP per minute (burst protection). Env: RATE_LIMIT_PER_MINUTE */
    perMinute: num('RATE_LIMIT_PER_MINUTE', 15),
    /** Chat requests per IP per day (cost protection: every chat request costs OpenAI tokens). Env: RATE_LIMIT_PER_DAY */
    perDay: num('RATE_LIMIT_PER_DAY', 300),
    /** Feedback (thumbs) requests per IP per minute */
    feedbackPerMinute: num('RATE_LIMIT_FEEDBACK_PER_MINUTE', 30),
  },
  moderation: {
    /** Check messages with the OpenAI Moderation API (free). Env: MODERATION_ENABLED */
    enabled: bool('MODERATION_ENABLED', true),
    /** Moderation model (multimodal, covers hate, harassment, violence, self-harm, sexual, illicit...). Env: MODERATION_MODEL */
    model: str('MODERATION_MODEL', 'omni-moderation-latest'),
    /** Also check the assistant's final answer before it is shown. Env: MODERATION_CHECK_OUTPUT */
    checkOutput: bool('MODERATION_CHECK_OUTPUT', true),
    /**
     * If the moderation API itself fails (timeout/outage): true = let the message through (availability first,
     * logged as a warning), false = refuse it (safety first). Env: MODERATION_FAIL_OPEN
     */
    failOpen: bool('MODERATION_FAIL_OPEN', true),
  },
  input: {
    /** Max messages in one request (the conversation history sent by the widget). Env: MAX_MESSAGES */
    maxMessages: num('MAX_MESSAGES', 40),
    /** Max characters in one user message (matches the widget's input limit). Env: MAX_USER_CHARS */
    maxUserChars: num('MAX_USER_CHARS', 1000),
    /** Max characters in one assistant message echoed back in history */
    maxAssistantChars: num('MAX_ASSISTANT_CHARS', 8000),
  },
};
