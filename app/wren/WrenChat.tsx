'use client';
import { useState, useRef, useEffect } from 'react';

interface Msg { role: 'user' | 'assistant'; content: string; createdAt?: string }

export function WrenChat({ initial }: { initial: Msg[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function send() {
    const m = text.trim();
    if (!m || busy) return;
    setText(''); setMsgs((p) => [...p, { role: 'user', content: m }]); setBusy(true);
    try {
      const r = await fetch('/api/wren/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: m }) });
      const j = await r.json();
      setMsgs((p) => [...p, { role: 'assistant', content: j.ok ? j.reply : `(couldn't reach the model: ${j.error ?? 'error'})` }]);
    } catch { setMsgs((p) => [...p, { role: 'assistant', content: '(request failed)' }]); } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
      <div style={{ maxHeight: 540, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.length === 0 ? <div style={{ color: 'var(--faint)', fontSize: 13 }}>Say hi, or ask Wren for headlines.</div> : null}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', padding: '10px 13px', borderRadius: 12,
              background: m.role === 'user' ? 'var(--purple)' : 'var(--panel-2)',
              color: m.role === 'user' ? '#fff' : 'var(--ink)',
              border: m.role === 'user' ? 'none' : '1px solid var(--line)' }}>{m.content}</div>
          </div>
        ))}
        {busy ? <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 12 }}>Wren is thinking…</div> : null}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--line)' }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message Wren…" style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px', color: 'var(--ink)', fontSize: 14 }} />
        <button className="btn-primary" onClick={send} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>Send</button>
      </div>
    </div>
  );
}
