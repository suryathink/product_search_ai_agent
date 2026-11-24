// Request validation with zod: a typed schema instead of hand-written checks.
// Rejects malformed or oversized chat bodies BEFORE any paid API is called.
import { z } from 'zod';
import { guardrailsConfig } from '../configs/index.js';

const { maxMessages, maxUserChars, maxAssistantChars } = guardrailsConfig.input;

/** One message in the conversation the widget sends. */
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().trim().min(1, 'empty message').max(maxUserChars, `message longer than ${maxUserChars} characters`) }),
  z.object({ role: z.literal('assistant'), content: z.string().max(maxAssistantChars) }),
]);

/** Body of POST /api/chat and /api/chat/stream. */
export const chatBodySchema = z.object({
  messages: z.array(messageSchema)
    .min(1, 'no messages')
    .max(maxMessages, `more than ${maxMessages} messages`)
    .refine((ms) => ms.at(-1)?.role === 'user', 'the last message must be from the user'),
});

/** Body of POST /api/feedback. */
export const feedbackBodySchema = z.object({
  requestId: z.string().min(8).max(100),
  rating: z.enum(['up', 'down']),
  comment: z.string().max(1000).optional(),
});

/**
 * Validate a body against a schema.
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} body
 * @returns {{ok: true, data: T} | {ok: false, error: string}} error = human-readable list of problems
 */
export function validate(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return { ok: true, data: r.data };
  const error = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return { ok: false, error };
}
