// Guardrails around the agent. Layers:
//   HTTP     helmet (security headers), express-rate-limit (per-IP limits)      -> server.js
//   Request  zod schema validation (shape, counts, lengths)                    -> server.js
//   Input    OpenAI Moderation API on the user's message                       -> guardedChat (here)
//   Agent    system-prompt scope rules, validated read-only tools, step cap    -> agent.js / tools.js
//   Output   internal-details leak filter (agent.js) + OpenAI Moderation on the final answer (here)
import { chat } from '../agent.js';
import { moderate } from './moderation.js';
import { guardrailsConfig } from '../configs/index.js';
import { getLogger } from '../logger.js';

export { chatRateLimits, feedbackRateLimit } from './rateLimit.js';
export { chatBodySchema, feedbackBodySchema, validate } from './validation.js';
export { moderate } from './moderation.js';

const logger = getLogger('guardrails');

/** Polite refusal shown when moderation blocks a message or an answer (no details about why, by design). */
export const REFUSAL_REPLY = "Sorry, I can't help with that. I'm here to help with Bosch, Dremel, RotoZip and CST/berger products "
  + '— finding the right tool, specs, compatibility and availability. What are you looking for?';

/**
 * Result shape for a turn that never reached the agent (same fields as chat()), so logging/metrics/Mongo work unchanged.
 * @param {string} reason  e.g. "moderation_input:violence"
 * @returns {Awaited<ReturnType<typeof chat>>}
 */
function blockedResult(reason) {
  return {
    reply: REFUSAL_REPLY,
    products: [],
    trace: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, llm_calls: 0, llm_ms: 0 },
    signals: {
      tool_calls: 0, tools_used: [], rounds: 0, step_cap_hit: false, zero_result_searches: 0, not_found_lookups: 0,
      ambiguous_lookups: 0, tool_errors: 0, clarifying_question: false, products_shown: 0, ungrounded_prices: [],
      ungrounded_models: [], unknown_models: [], grounded: true, guardrail_blocked: reason,
    },
  };
}

/**
 * The agent wrapped in input and output guardrails. Use this instead of chat() at the edges (HTTP, eval).
 * 1. Moderate the newest user message -> if flagged, refuse WITHOUT calling the agent (no tokens spent).
 * 2. Run the agent (streaming events pass straight through).
 * 3. Moderate the final answer -> if flagged, replace it (streaming: 'reset' + refusal).
 * @param {{role: 'user'|'assistant', content: string}[]} messages
 * @param {Parameters<typeof chat>[1]} [ctx]  requestId, onEvent (streaming), signal (abort)
 * @returns {ReturnType<typeof chat>} same shape as chat(); signals.guardrail_blocked says what was blocked
 */
export async function guardedChat(messages, ctx = {}) {
  const rid = ctx.requestId ? `[${ctx.requestId.slice(0, 8)}] ` : '';
  const emit = (type, data) => { try { ctx.onEvent?.(type, data); } catch { /* client gone */ } };

  // 1. Input moderation (only the newest message: earlier ones were checked when they were sent)
  const input = await moderate(messages.at(-1).content);
  if (input.flagged) {
    logger.warn(`${rid}Input blocked by moderation: ${input.categories.join(', ')}`);
    emit('token', { delta: REFUSAL_REPLY });
    return blockedResult(`moderation_input:${input.categories.join(',')}`);
  }

  // 2. The agent
  const result = await chat(messages, ctx);

  // 3. Output moderation (skip if the agent's own leak filter already replaced the answer)
  if (guardrailsConfig.moderation.checkOutput && !result.signals.guardrail_blocked) {
    const output = await moderate(result.reply);
    if (output.flagged) {
      logger.warn(`${rid}Answer blocked by moderation: ${output.categories.join(', ')}`);
      emit('reset', {});
      emit('token', { delta: REFUSAL_REPLY });
      return { ...result, reply: REFUSAL_REPLY, products: [], signals: { ...result.signals, guardrail_blocked: `moderation_output:${output.categories.join(',')}` } };
    }
  }
  return result;
}
