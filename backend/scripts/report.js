// Offline quality report from the JSON-lines logs.
//   npm run report               -> all days in logs/
//   npm run report -- 2026-11-24 -> one day
// This is the "read your logs" habit: what fails, what users want that we don't have, what got a thumbs-down.
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, shutdownLogger } from '../src/logger.js';

const day = process.argv[2];
const read = (prefix) => fs.readdirSync(LOG_DIR)
  .filter((f) => f.startsWith(`${prefix}.`) && f.endsWith('.log') && (!day || f.includes(day)))
  .flatMap((f) => fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n').filter(Boolean))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

const turns = read('interactions');
const ok = turns.filter((t) => t.status !== 'error');
const errors = turns.filter((t) => t.status === 'error');
const feedback = read('feedback');
const byId = new Map(ok.map((t) => [t.requestId, t]));

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : '-'; };
const share = (n) => (ok.length ? `${((n / ok.length) * 100).toFixed(1)}%` : '-');
const count = (xs) => Object.entries(xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
const short = (s, n = 90) => (s && s.length > n ? `${s.slice(0, n)}…` : s);
const h = (t) => console.log(`\n=== ${t} ${'='.repeat(Math.max(0, 60 - t.length))}`);

console.log(`Agent report ${day ? `for ${day}` : '(all logs)'} — ${LOG_DIR}`);
if (!turns.length) { console.log('No interactions logged yet. Chat with the agent first.'); await shutdownLogger(); process.exit(0); }

h('Traffic & cost');
console.log(`turns: ${ok.length}   errors: ${errors.length}   sessions: ${new Set(ok.map((t) => t.sessionId).filter(Boolean)).size}`);
console.log(`latency p50/p95: ${pct(ok.map((t) => t.latency_ms), 50)} / ${pct(ok.map((t) => t.latency_ms), 95)} ms`);
const cost = ok.reduce((s, t) => s + (t.cost_usd || 0), 0);
console.log(`estimated cost: $${cost.toFixed(4)}  (avg $${(cost / ok.length).toFixed(5)}/turn)`);
console.log(`avg tool calls/turn: ${(ok.reduce((s, t) => s + t.tool_calls.length, 0) / ok.length).toFixed(2)}   tool usage: ${count(ok.flatMap((t) => t.tool_calls.map((c) => c.tool))).map(([k, v]) => `${k}=${v}`).join(', ')}`);

h('Quality signals');
const q = (f) => ok.filter((t) => f(t.signals || {}));
console.log(`possibly ungrounded answers: ${q((s) => s.grounded === false).length} (${share(q((s) => s.grounded === false).length)})`);
console.log(`turns with zero-result searches: ${q((s) => s.zero_result_searches).length} (${share(q((s) => s.zero_result_searches).length)})`);
console.log(`turns with not-found lookups: ${q((s) => s.not_found_lookups).length}`);
console.log(`clarifying questions asked: ${q((s) => s.clarifying_question).length} (${share(q((s) => s.clarifying_question).length)})`);
console.log(`step cap hit: ${q((s) => s.step_cap_hit).length}   tool errors: ${q((s) => s.tool_errors).length}`);

const up = feedback.filter((f) => f.rating === 'up').length;
const down = feedback.filter((f) => f.rating === 'down');
h('User feedback');
console.log(`👍 ${up}   👎 ${down.length}   satisfaction: ${up + down.length ? `${((up / (up + down.length)) * 100).toFixed(0)}%` : '-'}`);
for (const f of down.slice(-10)) {
  const t = byId.get(f.requestId);
  console.log(`- [${f.requestId?.slice(0, 8)}] Q: ${short(t?.user_message) ?? '(turn not in these logs)'}${f.comment ? `\n    comment: ${short(f.comment)}` : ''}\n    A: ${short(t?.reply?.replace(/\s+/g, ' '))}`);
}

h('Review these: possibly ungrounded');
for (const t of q((s) => s.grounded === false).slice(-10)) {
  const s = t.signals;
  console.log(`- [${t.requestId?.slice(0, 8)}] ${short(t.user_message)}\n    prices=${JSON.stringify(s.ungrounded_prices)} models=${JSON.stringify(s.ungrounded_models)} unknown=${JSON.stringify(s.unknown_models)}`);
}

h('Demand we could not meet (zero-result searches)');
const zero = ok.flatMap((t) => t.tool_calls.filter((c) => c.flags?.zero_results).map((c) => JSON.stringify(c.args)));
for (const [args, n] of count(zero).slice(0, 10)) console.log(`${n}x ${short(args, 140)}`);

h('Identifiers users asked for that are not in the catalog');
const nf = ok.flatMap((t) => t.tool_calls.filter((c) => c.flags?.not_found).map((c) => c.args.identifier ?? JSON.stringify(c.args)));
for (const [id, n] of count(nf).slice(0, 10)) console.log(`${n}x ${id}`);

h('Slowest turns');
for (const t of [...ok].sort((a, b) => b.latency_ms - a.latency_ms).slice(0, 5)) {
  console.log(`${t.latency_ms}ms  llm_calls=${t.llm_calls} tools=${t.tool_calls.length}  ${short(t.user_message, 70)}`);
}

if (errors.length) {
  h('Errors');
  for (const [msg, n] of count(errors.map((e) => e.error)).slice(0, 10)) console.log(`${n}x ${msg}`);
}
await shutdownLogger();
