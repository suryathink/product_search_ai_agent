import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sendChat, sendFeedback, newSession } from './api.js';

const GREETING = {
  role: 'assistant',
  isGreeting: true, // UI-only message, never sent to the model
  content: "Hi! I can help you find Bosch, Dremel, RotoZip and CST/berger products — specs, compatibility, kits and more. What are you working on?",
};

const SUGGESTIONS = [
  'Cordless hammer drill for brick under $200',
  'Which batteries fit the GSR12V-800N?',
  'I need a saw',
  'Can I still buy the GBA18V20?',
];

const STORAGE_KEY = 'product-assistant-chat';
const loadSaved = () => {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || [GREETING]; } catch { return [GREETING]; }
};

export default function ChatWidget() {
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState(loadSaved);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showTrace, setShowTrace] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  useEffect(() => { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages)); } catch { /* ignore */ } }, [messages]);

  async function send(text) {
    const content = text.trim();
    if (!content || loading) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setError(null);
    setLoading(true);
    try {
      const { requestId, reply, products, trace, ms } = await sendChat(next.filter((m) => !m.isGreeting));
      setMessages([...next, { role: 'assistant', content: reply, products, trace, ms, requestId }]);
    } catch (e) {
      setError(e.message);
      setMessages(messages); // roll back so the user can retry
      setInput(content);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    newSession(); // a new conversation gets a new session ID in the logs
    setMessages([GREETING]);
    setError(null);
  }

  function rate(index, rating, comment) {
    const m = messages[index];
    if (!m?.requestId || m.feedback) return;
    sendFeedback(m.requestId, rating, comment).catch(() => { /* feedback is best-effort */ });
    setMessages((ms) => ms.map((x, i) => (i === index ? { ...x, feedback: rating } : x)));
  }

  if (!open) {
    return <button className="chat-launcher" onClick={() => setOpen(true)} aria-label="Open product assistant">💬 Ask about products</button>;
  }

  const onlyGreeting = messages.length === 1;

  return (
    <section className="chat" aria-label="Product assistant">
      <header className="chat-header">
        <div>
          <div className="chat-title">Product Assistant</div>
          <div className="chat-sub">Answers come from the product catalog</div>
        </div>
        <div className="chat-actions">
          <label className="trace-toggle" title="Show the tool calls behind each answer">
            <input type="checkbox" checked={showTrace} onChange={(e) => setShowTrace(e.target.checked)} /> How I found this
          </label>
          <button onClick={reset} title="New conversation">↺</button>
          <button onClick={() => setOpen(false)} title="Minimize">–</button>
        </div>
      </header>

      <div className="chat-body">
        {messages.map((m, i) => <Message key={i} m={m} showTrace={showTrace} onRate={(r, c) => rate(i, r, c)} />)}

        {onlyGreeting && (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
          </div>
        )}
        {loading && <div className="msg assistant"><div className="bubble typing">Searching the catalog<span>.</span><span>.</span><span>.</span></div></div>}
        {error && <div className="chat-error">⚠️ {error} <button onClick={() => send(input)}>Retry</button></div>}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about a product, spec or compatibility…"
          maxLength={1000}
          disabled={loading}
          autoFocus
        />
        <button type="submit" disabled={loading || !input.trim()}>Send</button>
      </form>
      <div className="chat-disclaimer">AI assistant · prices are MSRP and may vary by retailer</div>
    </section>
  );
}

function Feedback({ m, onRate }) {
  const [askWhy, setAskWhy] = useState(false);
  const [why, setWhy] = useState('');
  if (!m.requestId) return null;
  if (m.feedback) return <div className="feedback done">Thanks for the feedback!</div>;
  if (askWhy) {
    return (
      <form className="feedback why" onSubmit={(e) => { e.preventDefault(); onRate('down', why.trim() || undefined); }}>
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What was wrong? (optional)" maxLength={500} autoFocus />
        <button type="submit">Send</button>
      </form>
    );
  }
  return (
    <div className="feedback">
      <span>Helpful?</span>
      <button onClick={() => onRate('up')} aria-label="Helpful">👍</button>
      <button onClick={() => setAskWhy(true)} aria-label="Not helpful">👎</button>
    </div>
  );
}

function Message({ m, showTrace, onRate }) {
  return (
    <div className={`msg ${m.role}`}>
      <div className="bubble">
        {m.role === 'assistant'
          ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>{m.content}</ReactMarkdown>
          : m.content}
      </div>
      {m.products?.length > 0 && (
        <div className="cards">{m.products.map((p) => <ProductCard key={p.model} p={p} />)}</div>
      )}
      {m.role === 'assistant' && <Feedback m={m} onRate={onRate} />}
      {showTrace && m.trace && (
        <div className="trace">
          <div className="trace-head">{m.trace.length ? `${m.trace.length} tool call(s)` : 'No tools used'} · {m.ms} ms</div>
          {m.trace.map((t, i) => (
            <details key={i}>
              <summary><code>{t.tool}</code> → {t.result_preview}</summary>
              <pre>{JSON.stringify(t.args, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_CLASS = { Active: 'ok', 'Temporarily Out of Stock': 'warn', 'Coming Soon': 'info', Discontinued: 'bad' };

function ProductCard({ p }) {
  return (
    <a className="card" href={p.url} target="_blank" rel="noreferrer" title="Product page (mock URL)">
      <div className="card-top">
        <span className="card-model">{p.model}</span>
        <span className={`badge ${STATUS_CLASS[p.status] || ''}`}>{p.status}</span>
      </div>
      <div className="card-name">{p.name}</div>
      <div className="card-meta">
        <strong>{p.price != null ? `$${p.price.toFixed(2)}` : '—'}</strong>
        <span>{p.rating != null ? `★ ${p.rating} (${p.reviewCount})` : 'No reviews yet'}</span>
      </div>
      {p.replacementModel && <div className="card-note">Replaced by {p.replacementModel}</div>}
    </a>
  );
}
