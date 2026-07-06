'use client';
import { useState, useRef, useEffect } from 'react';

interface Msg { role: 'user' | 'assistant'; content: string; createdAt?: string }

const msgKey = (m: Msg) => `${m.role}|${m.content}`;

export function TalkChat({ slug, name, initial }: { slug: string; name: string; initial: Msg[] }) {
  const [msgs, setMsgs] = useState<Msg[]>(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Voice Pack (local): 🔊 speaks replies in the agent's VoxStation voice;
  // 🎙 records, transcribes via the on-LAN Whisper, and (when 🔊 is on) sends.
  const [voiceOn, setVoiceOn] = useState(false);
  const [rec, setRec] = useState<'idle' | 'rec' | 'stt'>('idle');
  const endRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<string | null>(initial.length ? initial[initial.length - 1].createdAt ?? null : null);
  const busyRef = useRef(false);
  const voiceOnRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  async function speak(content: string) {
    try {
      const r = await fetch('/api/voice/speak', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, text: content }),
      });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      audioRef.current?.pause();
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => URL.revokeObjectURL(url);
      void a.play();
    } catch { /* voice is a garnish — never break the chat over it */ }
  }

  // Background jobs post report-backs into this thread server-side; poll so
  // they appear (and, in voice mode, get spoken) without a reload.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive || busyRef.current) return;
      try {
        const q = cursorRef.current ? `?after=${encodeURIComponent(cursorRef.current)}` : '';
        const r = await fetch(`/api/chat/${slug}${q}`);
        if (!r.ok) return;
        const j = (await r.json()) as { messages?: Msg[] };
        const fresh = j.messages ?? [];
        if (!alive || !fresh.length) return;
        const last = fresh[fresh.length - 1].createdAt;
        if (last) cursorRef.current = last;
        setMsgs((p) => {
          const seen = new Set(p.map(msgKey));
          const add = fresh.filter((m) => !seen.has(msgKey(m)));
          if (add.length && voiceOnRef.current) {
            const spokenLast = [...add].reverse().find((m) => m.role === 'assistant');
            if (spokenLast) void speak(spokenLast.content);
          }
          return add.length ? [...p, ...add] : p;
        });
      } catch { /* offline tick — try again next interval */ }
    };
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  async function send(overrideText?: string) {
    const m = (overrideText ?? text).trim(); if (!m || busy) return;
    setText(''); setMsgs((p) => [...p, { role: 'user', content: m }]); setBusy(true); busyRef.current = true;
    try {
      const r = await fetch(`/api/chat/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: m }) });
      const j = await r.json();
      const reply = j.ok ? j.reply : `(couldn't reach the model: ${j.error ?? 'error'})`;
      setMsgs((p) => [...p, { role: 'assistant', content: reply }]);
      if (j.ok && voiceOnRef.current) void speak(reply);
    } catch { setMsgs((p) => [...p, { role: 'assistant', content: '(request failed)' }]); } finally { setBusy(false); busyRef.current = false; }
  }

  async function toggleMic() {
    if (rec === 'rec') { mediaRef.current?.stop(); return; }
    if (rec !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRec('stt');
        try {
          const fd = new FormData();
          fd.append('audio', new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' }), 'clip.webm');
          const r = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
          const j = (await r.json()) as { text?: string };
          if (j.text) {
            if (voiceOnRef.current) void send(j.text);       // voice conversation: straight through
            else setText((t) => (t ? t + ' ' : '') + j.text); // otherwise: fill the box for review
          }
        } catch { /* stt failure = nothing typed */ }
        setRec('idle');
      };
      mr.start();
      mediaRef.current = mr;
      setRec('rec');
    } catch { setRec('idle'); /* mic denied — needs a secure context (see talk page note) */ }
  }

  const iconBtn: React.CSSProperties = {
    border: '1px solid var(--line)', background: 'var(--panel-2)', borderRadius: 10,
    padding: '10px 12px', cursor: 'pointer', fontSize: 15, lineHeight: 1,
  };

  return (
    <div className="card" style={{ marginTop: 18, padding: 0, overflow: 'hidden' }}>
      <div style={{ maxHeight: 'min(540px, calc(100dvh - 280px))', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {msgs.length === 0 ? <div style={{ color: 'var(--faint)', fontSize: 13 }}>Say hi to {name}.</div> : null}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', padding: '10px 13px', borderRadius: 12,
              background: m.role === 'user' ? 'var(--purple)' : 'var(--panel-2)', color: m.role === 'user' ? '#fff' : 'var(--ink)',
              border: m.role === 'user' ? 'none' : '1px solid var(--line)' }}>{m.content}</div>
          </div>
        ))}
        {busy ? <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 12 }}>{name} is thinking…</div> : null}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--line)', alignItems: 'center' }}>
        <button onClick={toggleMic} title={rec === 'rec' ? 'Stop recording' : 'Speak to ' + name}
          style={{ ...iconBtn, background: rec === 'rec' ? '#c0392b' : 'var(--panel-2)', opacity: rec === 'stt' ? 0.5 : 1 }}>
          {rec === 'rec' ? '⏹' : rec === 'stt' ? '…' : '🎙'}
        </button>
        <button onClick={() => setVoiceOn((v) => !v)} title={voiceOn ? `${name} speaks replies — click to mute` : `Hear ${name}'s voice`}
          style={{ ...iconBtn, background: voiceOn ? 'var(--teal, #0d9488)' : 'var(--panel-2)' }}>
          {voiceOn ? '🔊' : '🔇'}
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={`Message ${name}…`} style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '11px 13px', color: 'var(--ink)', fontSize: 14 }} />
        <button className="btn-primary" onClick={() => send()} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>Send</button>
      </div>
    </div>
  );
}
