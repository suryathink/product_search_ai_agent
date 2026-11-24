// Backend address. The browser calls the API directly (no dev proxy), so this must be the backend's URL.
// Set VITE_API_BASE_URL in frontend/.env for other environments; the backend must allow this site in CORS_ORIGINS.
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

// Session ID = one per conversation. Sent as a header so the server can group log lines into conversations.
const SESSION_KEY = 'product-assistant-session';
export function getSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, id); }
    return id;
  } catch { return 'no-storage'; }
}
export function newSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

const headers = () => ({ 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() });
const toWire = (messages) => ({ messages: messages.map(({ role, content }) => ({ role, content })) });

// Non-streaming chat (kept for simple clients; the widget uses streamChat).
export async function sendChat(messages) {
  const res = await fetch(`${API_BASE_URL}/api/chat`, { method: 'POST', headers: headers(), body: JSON.stringify(toWire(messages)) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data; // { requestId, reply, products, trace, usage, ms }
}

/**
 * Streaming chat over Server-Sent Events.
 * EventSource only supports GET, so we POST with fetch and read the response body stream ourselves,
 * splitting it into SSE frames ("event: x\ndata: {...}\n\n").
 *
 * @param {{role: string, content: string}[]} messages
 * @param {object} handlers
 * @param {(e: {requestId: string}) => void} [handlers.onMeta]
 * @param {(delta: string) => void} [handlers.onToken]      next piece of the answer
 * @param {() => void} [handlers.onReset]                   discard text received so far
 * @param {(e: {tool: string, args: object}) => void} [handlers.onToolStart]
 * @param {(e: {tool: string, ms: number, result_preview: string}) => void} [handlers.onToolEnd]
 * @param {AbortSignal} [signal]  abort = Stop button; the server then cancels the LLM call
 * @returns {Promise<{requestId: string, reply: string, products: object[], trace: object[], usage: object, ms: number}>}
 *   resolves with the final 'done' payload; rejects on 'error' events or network failures
 */
export async function streamChat(messages, handlers = {}, signal) {
  const res = await fetch(`${API_BASE_URL}/api/chat/stream`, {
    method: 'POST',
    headers: { ...headers(), Accept: 'text/event-stream' },
    body: JSON.stringify(toWire(messages)),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    // A frame ends with a blank line; keep any incomplete tail in the buffer for the next chunk
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === 'meta') handlers.onMeta?.(payload);
      else if (event === 'token') handlers.onToken?.(payload.delta);
      else if (event === 'reset') handlers.onReset?.();
      else if (event === 'tool_start') handlers.onToolStart?.(payload);
      else if (event === 'tool_end') handlers.onToolEnd?.(payload);
      else if (event === 'done') done = payload;
      else if (event === 'error') throw new Error(payload.error || 'The assistant failed.');
    }
  }
  if (!done) throw new Error('The connection closed before the answer was complete.');
  return done;
}

export async function getHealth() {
  const res = await fetch(`${API_BASE_URL}/api/health`);
  return res.ok ? res.json() : null;
}

export async function sendFeedback(requestId, rating, comment) {
  await fetch(`${API_BASE_URL}/api/feedback`, { method: 'POST', headers: headers(), body: JSON.stringify({ requestId, rating, comment }) });
}
