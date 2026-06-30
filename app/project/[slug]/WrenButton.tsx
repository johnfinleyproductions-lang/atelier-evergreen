'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function WrenButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setNote('Wren is writing — qwen3.5 on Framerstation…');
    try {
      const r = await fetch('/api/agent/wren', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const j = await r.json();
      if (j.ok) {
        setNote(`Wren wrote ${j.headlines.length} options in ${(j.latencyMs / 1000).toFixed(0)}s → pick one in Decision Needed`);
        router.refresh();
      } else {
        setNote(`Wren couldn't reach the model (${j.error ?? 'error'})`);
      }
    } catch {
      setNote('Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h4>✍️ Wren · Copywriter</h4>
      <div className="brief" style={{ marginBottom: 10 }}>
        A real local model (qwen3.5 on Framerstation) — nothing leaves the LAN.
      </div>
      <button className="btn-primary" style={{ width: '100%', opacity: busy ? 0.6 : 1 }} onClick={run} disabled={busy}>
        {busy ? 'Writing…' : 'Have Wren write 6 headlines'}
      </button>
      {note ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{note}</div> : null}
    </div>
  );
}
