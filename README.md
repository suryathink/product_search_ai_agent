# Product Assistant — AI agent over the power-tools catalog

A website chat agent that answers product questions (discovery, specs, comparisons, compatibility, status)
for Bosch, Dremel, RotoZip and CST/berger, grounded in `data/bosch_product_catalog_mock.csv` (2,261 products).

**Live:** https://bosch-agent.suryathink.com · API https://bosch-agent.api.suryathink.com ([health](https://bosch-agent.api.suryathink.com/api/health))

- **Backend:** Node.js + Express, OpenAI tool calling (Chat Completions) with streamed answers, in-memory catalog,
  hybrid search (BM25 + vectors in Qdrant Cloud), MongoDB Atlas persistence, layered guardrails
- **Frontend:** React (Vite) chat widget embedded on a stand-in storefront page
- **CLI** and a **20-scenario eval runner** that produces the example conversations
- **CI/CD:** GitHub Actions → Docker Hub → DigitalOcean droplet behind nginx + HTTPS

## Run it

```bash
# 1. backend
cd backend
npm install
cp .env.example .env          # OPENAI_API_KEY, and QDRANT_URL (or QDRANT_HOST) + QDRANT_API_KEY for Qdrant Cloud
npm run test:tools            # optional: exercise the tools without the LLM
npm run embed                 # incremental vector sync -> local file + Qdrant (only new/changed products are embedded)
npm run dev                   # API on http://localhost:3001 (Qdrant if configured, else local)
npm run dev:qdrant            # force Qdrant Cloud as the vector store
npm run dev:local             # force the local in-memory vector store
npm run vectors:compare       # same queries on both stores: latency + recall@10

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
React widget ──POST /api/chat/stream {messages}──► Express (stateless): helmet · zod validation · (rate limit)
                                                    │
                                                    ▼
                       guardrails/ — OpenAI Moderation on input → agent → leak filter + Moderation on output
                                                    │
                                                    ▼
                        agent.js — LLM tool-calling loop (≤6 rounds, temp 0.2, streamed over SSE)
                                             │ calls
                                             ▼
   tools.js: search_products · get_product_details · compare_products · find_compatible_products · get_catalog_overview
                                             │
                                             ▼
   catalog.js (normalized, in memory)   search.js (hard filters → BM25 + embeddings → RRF)   compatibility.js (rules)
                                                 │ vector search
                                                 ▼
                        vectorstore/ ── qdrant.js (Qdrant Cloud: HNSW, server-side filters)
                                     └─ local.js  (JSON file: exact brute force, offline / fallback)
```

| File | Responsibility |
|---|---|
| `backend/src/catalog.js` | Parse CSV once, normalize types (numbers, booleans, lists, specs JSON), indexes by model/SKU/UPC |
| `backend/src/search.js` | Hard filters, BM25 keyword ranking, optional embedding ranking, Reciprocal Rank Fusion, zero-result relaxation |
| `backend/src/vectorstore/` | Pluggable vector store: `qdrant.js` (Qdrant Cloud) and `local.js` (file), chosen by config |
| `backend/src/configs/` | All configuration in one place: loads `backend/.env`, typed values and documented defaults per area |
| `backend/src/mongo.js` | MongoDB Atlas persistence of interactions, conversations and feedback (non-blocking, TTL retention) |
| `backend/scripts/sync-vectors.js` | `npm run embed`: hash-based incremental embedding + sync to the local file and Qdrant |
| `backend/scripts/compare-stores.js` | `npm run vectors:compare`: latency and recall@10, local vs Qdrant |
| `backend/src/compatibility.js` | Deterministic compatibility: battery platform, bit holder / collet / Starlock interface, listed compatibility text |
| `backend/src/tools.js` | Tool schemas the model sees + implementations returning compact grounded JSON |
| `backend/src/agent.js` | System prompt (grounding, clarification, status, scope rules) + agent loop + product-card extraction |
| `backend/src/guardrails/` | `guardedChat()` (moderation around the agent), zod request schemas, rate limiters |
| `backend/src/server.js` | Routes (`/api/chat`, `/api/chat/stream`, `/api/feedback`, `/api/health`, `/api/metrics`), helmet, CORS, startup/shutdown |
| `backend/scripts/eval.js` | 20 scripted scenarios with automatic checks, run through `guardedChat()`; writes transcripts with tool traces |
| `frontend/src/ChatWidget.jsx` | Chat UI, streamed answers, live tool status, Stop button, product cards, status badges, "How I found this" trace |
| `.github/workflows/`, `deploy/` | CI/CD workflows, Dockerfile, deploy scripts (health check + rollback, atomic frontend release), nginx templates |

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

## Vector store: Qdrant Cloud + local, switchable

Product embeddings (`text-embedding-3-small`, 1536 dimensions) can be served from either store behind one interface
(`init`, `search`, `upsert`, `remove`, `listHashes`):

| | Local (`local.js`) | Qdrant Cloud (`qdrant.js`) |
|---|---|---|
| Storage | `data/embeddings.json`, loaded into RAM | Managed cluster (free tier), collection `bosch_products` |
| Search | Exact cosine, brute force | HNSW approximate nearest neighbours (exact scan below ~20k points) |
| Filters | Applied in JS before search | Pushed down to Qdrant (status, brand, category, subcategory, price range, voltage) with payload indexes |
| Updates | Rewrite the whole file | Upsert/delete single points |
| Multiple servers | Each holds its own copy | One shared source of truth |
| Best for | Offline dev, tests, fallback | Production, growth beyond ~100k vectors |

**Why Qdrant:** open source (can self-host later, no lock-in), fast filtering combined with vector search, simple REST API,
free managed tier. pgvector or OpenSearch would be equally valid if the catalog already lived in Postgres or Elasticsearch.

**Design details**
- **Incremental sync:** each product stores a SHA-1 of its indexed text, so `npm run embed` only embeds and upserts what changed, and deletes removed SKUs.
- **Stable IDs:** the Qdrant point ID is a UUID derived from the SKU, so re-running the sync is idempotent.
- **Hybrid filtering:** simple filters run inside Qdrant; complex ones (spec thresholds, kit type) are intersected in JS.
- **Resilience:** if Qdrant is unreachable at startup, or a query takes over 2 s, search degrades to BM25 and logs a warning. The chatbot never fails because of the vector DB.
- **Observability:** each search's trace shows which store answered, the hit count and the latency (visible in the UI under "How I found this").

**Measured (2,261 products, `npm run vectors:compare`):** identical top-10 on both stores (recall@10 = 100%).
Local takes about 10 ms; Qdrant Cloud takes about 160 ms, which is almost all network round-trip.
At this size local is faster. Qdrant pays off with scale, multiple instances and frequent updates.

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

## Deployment

- **Frontend:** https://bosch-agent.suryathink.com
- **Backend API:** https://bosch-agent.api.suryathink.com ([/api/health](https://bosch-agent.api.suryathink.com/api/health))

**CI/CD:** every push to `main` deploys the part that changed to a DigitalOcean droplet behind nginx with Let's Encrypt HTTPS:
- The **backend** is smoke-tested, built into a Docker image, pushed to Docker Hub, then swapped in on the server with a health check and automatic rollback.
- The **frontend** is built with the production API URL and released atomically, keeping the last 5 releases.

The workflows are in `.github/workflows/`. One-time setup, secrets and operations are in [deploy/DEPLOY.md](deploy/DEPLOY.md).
The backend runs on port **3001** both locally and in production (on `127.0.0.1` behind nginx); the frontend dev server uses **5173**.

## Guardrails

Layered, using established libraries, and enforced in code rather than only in the prompt. The eval showed the model sometimes ignores prompt-only rules.

| Layer | Guardrail | Library / mechanism |
|---|---|---|
| HTTP | Security headers (nosniff, frame denial, HSTS, no `X-Powered-By`) | `helmet` |
| HTTP | Per-IP rate limits: 15 chat requests/min and 300/day (protects the OpenAI bill). **Currently not mounted (demo period);** re-enable in `server.js` (lines marked `RATE LIMIT`) | `express-rate-limit` |
| Request | Schema validation: only `user`/`assistant` roles (blocks injected `system` messages), max 40 messages, 1,000 characters per user message, last message from the user | `zod` |
| Input | Harmful-content check on the user's message; flagged messages are refused **before** the agent runs (no tokens spent) | OpenAI Moderation API (`omni-moderation-latest`, free) |
| Agent | Scope rules, read-only tools, enum-restricted and validated tool arguments, max 6 tool rounds | system prompt + `tools.js` |
| Output | Internal-details filter: tool names, prompt and infrastructure never reach the user | `detectInternalLeak` in `agent.js` |
| Output | Harmful-content check on the final answer (streaming: the text is cleared and replaced) | OpenAI Moderation API |
| Output | Groundedness signals; product cards only for products a tool returned | `agent.js` |

- Blocked turns are logged, stored in MongoDB with `signals.guardrail_blocked`, and counted in `/api/metrics` (`guardrails.by_type`).
- The eval runs through the same `guardedChat()` as production, with scenarios for a harmful request (must be blocked), a violent-sounding but legitimate question (must **not** be blocked), internal-disclosure probes, and prompt injection.
- Settings are in `backend/src/configs/guardrails.config.js` and `.env`.

## Streaming responses

The widget uses `POST /api/chat/stream`, which streams the answer as Server-Sent Events (`text/event-stream`):
`meta` (request ID) → `tool_start` / `tool_end` (live status such as "Searching products") → `token` (answer text as it is
generated) → `done` (product cards, trace, usage). `error` ends the stream on failure.

- `fetch` + a stream reader is used instead of `EventSource`, because `EventSource` only supports GET and the chat history is POSTed.
- Tool calls also arrive in fragments while streaming; `callModel()` in `agent.js` reassembles them, so the agent loop is the same in both modes.
- **Stop** in the widget (or closing the tab) disconnects; the server notices and aborts the OpenAI request, so no tokens are paid for an unread answer.
- `POST /api/chat` (non-streaming) remains for the CLI, the eval and simple clients.

Measured: the first token arrives at ~1.8 s, compared with ~4 s for the complete answer.

The frontend calls the backend directly (no dev proxy) at `VITE_API_BASE_URL` (default `http://localhost:3001`, see
`frontend/.env.example`). The backend must allow the frontend's origin via CORS.

## Configuration

All settings live in `backend/src/configs/`. `env.js` loads `backend/.env` once, and nothing outside that folder reads
`process.env`. Each area has its own file with documented defaults (server, openai, agent, search, vectorStore, mongo,
logging, telemetry, paths), and `index.js` exposes them as one `config` object. On startup the server logs the effective
configuration, with secrets shown only as "set" / "not set". See `backend/.env.example` for the variables.

## Conversation persistence (MongoDB)

When `MONGO_URI` is set, every chat turn is also stored in MongoDB Atlas (database `MONGO_DB`, default `bosch_product_agent`):

| Collection | One document per | Notes |
|---|---|---|
| `interactions` | chat turn | Same record as `interactions.log`: question (redacted), answer, tool calls, tokens, cost, quality signals, feedback |
| `conversations` | session | Turns appended in order, turn count, total cost |
| `feedback` | 👍/👎 | Linked by `requestId`; the rated turn is marked in the other two collections |

- Writes are non-blocking: the user never waits for MongoDB, and an outage only disables persistence (logged), so the chat keeps working.
- Indexes: `requestId` (unique), `sessionId` + time, groundedness + time, and TTL indexes that delete data after `MONGO_TTL_DAYS` (default 90).
- `INTERACTION_FILE_LOGS=false` stops writing conversation content to local log files, which is recommended in production.

## Logging & monitoring

All backend logging goes through `log4js` (`backend/src/logger.js`). Files are written to `backend/logs/`, with a new file each
day and a new numbered file whenever one reaches `LOG_MAX_FILE_MB` (default 3 MB). **Storage is capped at `LOG_MAX_TOTAL_MB`
(default 30 MB) for the whole folder:** at startup and every 10 minutes, the oldest files are deleted until the folder fits,
so only the most recent logs are kept. Files currently being written are never deleted.

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

