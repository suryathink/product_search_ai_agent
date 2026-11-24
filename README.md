# Product Assistant — AI agent over the power-tools catalog

A website chat agent that answers product questions (discovery, specs, comparisons, compatibility, status)
for Bosch, Dremel, RotoZip and CST/berger, grounded in `data/bosch_product_catalog_mock.csv` (2,261 products).

- **Backend:** Node.js + Express, OpenAI tool calling (Chat Completions), in-memory catalog, hybrid search
- **Frontend:** React (Vite) chat widget embedded on a stand-in storefront page
- **CLI** and a **scenario eval runner** that produces the example conversations

## Run it

```bash
# 1. backend
cd backend
npm install
cp .env.example .env          # put your OPENAI_API_KEY in .env
npm run test:tools            # optional: exercise the tools without the LLM
npm run embed                 # optional (recommended): build semantic-search vectors once, ~cents
npm run dev                   # API on http://localhost:3001

# 2. frontend (second terminal)
cd frontend
npm install
npm run dev                   # open http://localhost:5173

# other entry points (from backend/)
npm run cli                   # chat in the terminal, shows tool calls
npm run eval                  # run all scenarios -> examples/conversations.md
```

## Architecture

```
React widget ──POST /api/chat {messages}──► Express (stateless)
                                             │
                                             ▼
                        agent.js — LLM tool-calling loop (≤6 rounds, temp 0.2)
                                             │ calls
                                             ▼
   tools.js: search_products · get_product_details · compare_products · find_compatible_products · get_catalog_overview
                                             │
                                             ▼
   catalog.js (normalized, in memory)   search.js (hard filters → BM25 + embeddings → RRF)   compatibility.js (rules)
```

| File | Responsibility |
|---|---|
| `backend/src/catalog.js` | Parse CSV once, normalize types (numbers, booleans, lists, specs JSON), indexes by model/SKU/UPC |
| `backend/src/search.js` | Hard filters, BM25 keyword ranking, optional embedding ranking, Reciprocal Rank Fusion, zero-result relaxation |
| `backend/src/compatibility.js` | Deterministic compatibility: battery platform, bit holder / collet / Starlock interface, listed compatibility text |
| `backend/src/tools.js` | Tool schemas the model sees + implementations returning compact grounded JSON |
| `backend/src/agent.js` | System prompt (grounding, clarification, status, scope rules) + agent loop + product-card extraction |
| `backend/scripts/eval.js` | 17 scripted scenarios with automatic checks; writes transcripts with tool traces |
| `frontend/src/ChatWidget.jsx` | Chat UI, product cards, status badges, "How I found this" tool trace |

## Key design decisions

1. **Tools instead of stuffing the catalog into the prompt.** 2,261 products won't fit usefully in context.
   The model only sees what tools return, so every fact is traceable to a tool call (visible in the UI).
2. **Hybrid search.** Budgets, voltage, status and spec thresholds are *hard filters* in code — an LLM shouldn't
   "approximately" respect a budget. Ranking combines **BM25** (exact model numbers like `GSR18V-535CN`)
   and **embeddings** (meaning: "cut ceramic tile"), fused with **Reciprocal Rank Fusion** because their scores
   aren't on comparable scales. Without embeddings it degrades gracefully to BM25.
3. **Zero results are a feature.** When nothing matches, `search_products` reports which single filter is
   blocking and how many products exist without it, so the agent can say *"nothing under $40 — the cheapest is $79,
   want to see it?"* instead of a dead end or a silently dropped constraint.
4. **Compatibility is code, not LLM reasoning.** A wrong "yes it fits" costs a customer money. Rules match
   battery platform (12V/18V), bit holder (SDS-plus/SDS-max/hex), collet size, Starlock interface, pad size and
   Dremel/RotoZip model families, and always return the *basis* of the match.
5. **In-memory, stateless server.** ~2 MB of data; filtering is milliseconds. The client sends the visible
   conversation each turn, so the server scales horizontally with no session store.
6. **Bounded loop.** Max 6 tool rounds, last round forces a text answer; tool results are truncated; history is
   capped. Predictable latency and cost.

## Data findings that shaped the agent

| Finding | Handling |
|---|---|
| 4 statuses incl. *Temporarily Out of Stock* | Status wording rules; status badge on every card |
| All 33 *Coming Soon* items have launch dates in the past | Trust `status`, never promise a date |
| 156 discontinued items, each with an active `replacement_model` | `get_product_details` follows the link and returns the replacement |
| Duplicate UPCs on unrelated products | Identifier lookup returns `ambiguous` + candidates → agent asks |
| 12 near-identical variants per tool (bare tool vs battery kits) | `kit` filter; prompt treats "do you own batteries?" as a key clarifying question |
| 175 spec keys, imperial units only | `spec_filters` + `get_catalog_overview(category)` exposes valid keys; prompt converts Nm/mm |
| Empty rating only when 0 reviews | Shown as "no reviews yet", never 0 stars |
| Missing features/dimensions on many rows | Reported as "not listed"; prompt forbids guessing |

## Scenario handling

| Scenario | Behaviour |
|---|---|
| Vague request ("I need a saw") | One clarifying question with concrete options (material/job, battery platform) |
| Borderline-specific request | Show 2-3 options, then one refining question (don't interrogate) |
| Unknown model / competitor model | "Not in our catalog" + similar model suggestions, no invention |
| Spec not in data (e.g. noise dB) | "Not listed" — no guessing |
| Impossible constraints | Explains the blocking constraint, offers the closest alternatives |
| Discontinued / coming soon / out of stock | Clearly flagged; replacement recommended |
| Order status, returns, warranty claims | Out of scope → points to customer support (no invented contacts) |
| Competitor comparison | Declines to compare; can report catalog compatibility statements naming other brands |
| Prompt injection / fake discounts | Ignored; prices only from catalog |
| Follow-ups ("which of those is lighter?") | Conversation history carries model numbers forward |

## Logging & monitoring

All backend logging goes through `log4js` (`backend/src/logger.js`). Files rotate daily and are kept 14 days in `backend/logs/`:

| File | Format | Contents |
|---|---|---|
| `app.YYYY-MM-DD.log` | readable | Startup, per-chat summary, warnings (also printed to the console) |
| `errors.YYYY-MM-DD.log` | readable | ERROR and above only: what to check first when something breaks |
| `requests.YYYY-MM-DD.log` | JSON lines | Every HTTP request: incoming (method, url, sanitized body, session) + completed (status, duration) |
| `interactions.YYYY-MM-DD.log` | JSON lines | Every chat turn: question, answer, tool calls with args/latency/flags, tokens, cost, quality signals |
| `feedback.YYYY-MM-DD.log` | JSON lines | 👍/👎 from the widget, with an optional comment, linked to the answer by `requestId` |

- **Request ID** on every request (returned as the `X-Request-Id` header and in the chat response) links one answer across all files.
  **Session ID** (sent by the widget) groups a conversation.
- **Privacy:** emails, card-like and phone-like numbers are redacted before logging. Chat bodies log only the newest message, not the whole history.
- `LOG_LEVEL=debug` additionally logs every LLM step and tool call.

**Agent-quality signals** (computed per turn in `agent.js`, aggregated in `telemetry.js`):

| Signal | Why it matters |
|---|---|
| `ungrounded_prices` / `ungrounded_models` / `unknown_models` | A `$` amount or model number in the reply that no tool returned → possible hallucination |
| `zero_result_searches`, `not_found_lookups` | Demand the catalog/search can't meet (product gaps or retrieval misses) |
| `clarifying_question` rate | Too low → guessing; too high → interrogating users |
| `step_cap_hit`, `tool_errors`, tool calls per turn | Agent loops, broken tools, cost creep |
| latency p50/p95, tokens, estimated cost | Service health and spend |
| 👍/👎 satisfaction | The ground truth the automatic signals approximate |

- `GET /api/metrics`: live aggregates since server start
- `npm run report [-- YYYY-MM-DD]`: offline report from the log files: 👎 answers, possibly ungrounded answers,
  zero-result queries, unknown identifiers, slowest turns, errors

**Production next steps:** ship the JSON logs to a log platform (ELK / Datadog / CloudWatch), put alerts on
error rate, p95 latency and ungrounded rate, use an LLM-tracing tool (Langfuse, LangSmith, Helicone or OpenTelemetry GenAI spans)
for per-step traces, run an LLM-as-judge on a daily sample of interactions, and turn 👎 turns into new eval scenarios.

## Limitations & next steps

- **Evaluation:** checks in `eval.js` are regex-level; next step is an LLM-as-judge for groundedness
  (every number in the reply appears in a tool result) plus a larger labeled query set for retrieval recall@k.
- **Streaming** responses (SSE) for perceived latency; **caching** frequent queries.
- **Data freshness:** re-ingest on catalog change; the embedding cache is keyed by model and row count only.
- **Compatibility rules** are heuristic over free text; a structured compatibility table in the source data would be better.
- **Production hardening:** rate limiting, PII scrubbing in logs, observability (trace IDs per tool call), A/B on prompts.
- **Handoff:** escalate to human support when the user is frustrated or the question is out of scope.
