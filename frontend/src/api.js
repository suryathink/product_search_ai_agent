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

// The server is stateless: we send the visible conversation (user + assistant text) every turn.
export async function sendChat(messages) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ messages: messages.map(({ role, content }) => ({ role, content })) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data; // { requestId, reply, products, trace, usage, ms }
}

export async function sendFeedback(requestId, rating, comment) {
  await fetch('/api/feedback', { method: 'POST', headers: headers(), body: JSON.stringify({ requestId, rating, comment }) });
}
