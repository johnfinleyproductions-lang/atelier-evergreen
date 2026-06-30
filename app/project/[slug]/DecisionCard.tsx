'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Opt { key: string; label: string; detail: string }

export function DecisionCard({ taskId, question, options }: { taskId: string; question: string; options: Opt[] }) {
  const router = useRouter();
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function make() {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await fetch('/api/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, optionKey: picked }),
      });
      router.refresh(); // server re-renders; decision drops out of the queue, angle is recorded
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card decision">
      <h4>⚡ Decision Needed <span className="badge" style={{ background: '#3a2f12', color: 'var(--gold)', marginLeft: 'auto' }}>Important</span></h4>
      <div className="q">{question}</div>
      {options.map((o) => (
        <button
          key={o.key}
          className="opt"
          onClick={() => setPicked(o.key)}
          style={picked === o.key ? { borderColor: 'var(--purple)', background: 'var(--purple-soft)' } : undefined}
        >
          <div className="ol">{o.label}{picked === o.key ? '  ✓' : ''}</div>
          <div className="od">{o.detail}</div>
        </button>
      ))}
      <button className="btn-primary" style={{ width: '100%', marginTop: 6, opacity: picked && !busy ? 1 : 0.55 }} onClick={make} disabled={!picked || busy}>
        {busy ? 'Recording…' : 'Make Decision'}
      </button>
    </div>
  );
}
