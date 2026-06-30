'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function HugoButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setNote('Hugo is building — qwen2.5-coder on Framerstation…');
    try {
      const r = await fetch('/api/agent/hugo', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const j = await r.json();
      if (j.ok) {
        setNote(`Hugo wrote ${j.htmlBytes}b of HTML in ${(j.latencyMs / 1000).toFixed(0)}s · render-QC ${j.proofPass ? 'passed ✓ (ΔE ' + j.paletteDeltaE + ')' : 'failed'} → see Latest Outputs`);
        router.refresh();
      } else {
        setNote(`Hugo couldn't build (${j.error ?? 'error'})`);
      }
    } catch { setNote('Request failed'); } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h4>{'</> '}Hugo · Build Engineer</h4>
      <div className="brief" style={{ marginBottom: 10 }}>
        A real coder model (qwen2.5-coder) writes on-brand HTML — proven by the Visual-QA gate before it advances.
      </div>
      <button className="btn-primary" style={{ width: '100%', opacity: busy ? 0.6 : 1 }} onClick={run} disabled={busy}>
        {busy ? 'Building…' : 'Have Hugo build a landing card'}
      </button>
      {note ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{note}</div> : null}
    </div>
  );
}
