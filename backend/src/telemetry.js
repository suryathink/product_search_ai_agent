// AI-agent monitoring: one structured record per chat turn (logs/interactions.*.log) + live in-memory metrics.
// Ops metrics (latency, errors) tell you the service is UP; these tell you the agent is GOOD.
import { getLogger, redact, truncate } from './logger.js';
import { MODEL } from './agent.js';

const interactionLog = getLogger('interaction');
const feedbackLog = getLogger('feedback');
const logger = getLogger('telemetry');

// USD per 1M tokens. Defaults are an ESTIMATE for gpt-4.1-mini; set real prices for your model in .env.
const PRICE_IN = Number(process.env.PRICE_INPUT_PER_1M ?? 0.4);
const PRICE_OUT = Number(process.env.PRICE_OUTPUT_PER_1M ?? 1.6);
export const estimateCost = (u) => +(((u.prompt_tokens * PRICE_IN) + (u.completion_tokens * PRICE_OUT)) / 1e6).toFixed(6);

// ---------------------------------------------------------------------------
// In-memory metrics since process start (reset on restart; the log files are the durable record)
// ---------------------------------------------------------------------------
const startedAt = new Date().toISOString();
const latencies = []; // ring buffer of the last 1000 turn latencies
const m = {
  turns: 0, errors: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, tool_calls: 0,
  tool_usage: {}, zero_result_turns: 0, not_found_turns: 0, clarifying_turns: 0,
  ungrounded_turns: 0, step_cap_hits: 0, tool_error_turns: 0, no_product_turns: 0,
  feedback_up: 0, feedback_down: 0, sessions: new Set(),
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const rate = (n) => (m.turns ? +(n / m.turns).toFixed(3) : 0);

/** Called once per successful chat turn. */
export function recordInteraction({ requestId, sessionId, history, result, ms }) {
  const { reply, trace, usage, signals, products } = result;
  const cost = estimateCost(usage);
  const userMessage = history.at(-1).content;

  interactionLog.info({
    requestId,
    sessionId,
    model: MODEL,
    turn_index: history.filter((x) => x.role === 'user').length,
    user_message: truncate(redact(userMessage), 2000),
    reply: truncate(reply, 4000),
    products: products.map((p) => p.model),
    tool_calls: trace.map((t) => ({ step: t.step, tool: t.tool, args: t.args, ms: t.ms, result: t.result_preview, flags: t.flags })),
    latency_ms: ms,
    llm_ms: usage.llm_ms,
    llm_calls: usage.llm_calls,
    tokens: { prompt: usage.prompt_tokens, completion: usage.completion_tokens },
    cost_usd: cost,
    signals,
  });

  m.turns++;
  if (sessionId) m.sessions.add(sessionId);
  latencies.push(ms); if (latencies.length > 1000) latencies.shift();
  m.tokens_in += usage.prompt_tokens;
  m.tokens_out += usage.completion_tokens;
  m.cost_usd += cost;
  m.tool_calls += trace.length;
  for (const t of trace) m.tool_usage[t.tool] = (m.tool_usage[t.tool] || 0) + 1;
  if (signals.zero_result_searches) m.zero_result_turns++;
  if (signals.not_found_lookups) m.not_found_turns++;
  if (signals.clarifying_question) m.clarifying_turns++;
  if (!signals.grounded) m.ungrounded_turns++;
  if (signals.step_cap_hit) m.step_cap_hits++;
  if (signals.tool_errors) m.tool_error_turns++;
  if (trace.length && !products.length) m.no_product_turns++;
}

export function recordError({ requestId, sessionId, error }) {
  m.errors++;
  interactionLog.info({ requestId, sessionId, model: MODEL, error: error.message, status: 'error' });
}

/** Thumbs up/down from the widget, linked to the turn by requestId. */
export function recordFeedback({ requestId, sessionId, rating, comment }) {
  if (rating === 'up') m.feedback_up++; else m.feedback_down++;
  feedbackLog.info('User feedback', { requestId, sessionId, rating, comment: truncate(redact(comment), 1000) });
  if (rating === 'down') logger.warn(`Thumbs down on request ${requestId}${comment ? `: ${truncate(comment, 120)}` : ''}`);
}

export function metricsSnapshot() {
  const fb = m.feedback_up + m.feedback_down;
  return {
    since: startedAt,
    model: MODEL,
    traffic: { turns: m.turns, sessions: m.sessions.size, errors: m.errors, error_rate: m.turns + m.errors ? +(m.errors / (m.turns + m.errors)).toFixed(3) : 0 },
    latency_ms: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    cost: {
      tokens_in: m.tokens_in, tokens_out: m.tokens_out,
      estimated_usd: +m.cost_usd.toFixed(4),
      avg_usd_per_turn: m.turns ? +(m.cost_usd / m.turns).toFixed(5) : 0,
    },
    agent_behaviour: {
      avg_tool_calls_per_turn: m.turns ? +(m.tool_calls / m.turns).toFixed(2) : 0,
      tool_usage: m.tool_usage,
      clarifying_question_rate: rate(m.clarifying_turns),
      step_cap_hit_rate: rate(m.step_cap_hits),
    },
    quality: {
      ungrounded_rate: rate(m.ungrounded_turns), // possible hallucinated price/model — investigate every one
      zero_result_rate: rate(m.zero_result_turns), // catalog gaps or search misses
      not_found_rate: rate(m.not_found_turns),
      tool_error_rate: rate(m.tool_error_turns),
      searched_but_no_product_rate: rate(m.no_product_turns),
    },
    user_feedback: { up: m.feedback_up, down: m.feedback_down, satisfaction: fb ? +(m.feedback_up / fb).toFixed(3) : null },
  };
}
