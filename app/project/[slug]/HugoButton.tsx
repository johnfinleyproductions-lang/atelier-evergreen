'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export function HugoButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up any in-flight poll on unmount.
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  function fmtResult(j: Record<string, unknown>): string {
    const bytes = Number(j.htmlBytes ?? 0);
    const secs = (Number(j.latencyMs ?? 0) / 1000).toFixed(0);
    const pass = Boolean(j.proofPass);
    const de = j.paletteDeltaE;
    return `Hugo wrote ${bytes}b of HTML in ${secs}s · render-QC ${pass ? `passed ✓ (ΔE ${de})` : 'failed'} → see Latest Outputs`;
  }

  async function poll(jobId: string, startedAt: number) {
    try {
      const r = await fetch(`/api/job/${jobId}`, { cache: 'no-store' });
      const j = await r.json();
      const status: string = j?.job?.status ?? 'unknown';
      if (status === 'done') {
        const result = (j.job.result ?? {}) as Record<string, unknown>;
        setNote(result.ok ? fmtResult(result) : `Hugo couldn't build (${result.error ?? 'error'})`);
        setBusy(false);
        router.refresh();
        return;
      }
      if (status === 'error') {
        setNote(`Hugo's build failed (${j.job.error ?? 'error'})`);
        setBusy(false);
        return;
      }
      // still queued/running — keep waiting
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setNote(`Hugo is building — qwen2.5-coder on Framerstation… (${elapsed}s)`);
      if (elapsed > 240) { setNote('Still building — taking longer than usual. Check Latest Outputs shortly.'); setBusy(false); return; }
      pollRef.current = setTimeout(() => poll(jobId, startedAt), 2500);
    } catch {
      pollRef.current = setTimeout(() => poll(jobId, startedAt), 3500);
    }
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    setNote('Sending the build to Hugo…');
    try {
      const r = await fetch('/api/agent/hugo', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const j = await r.json();
      if (j.ok && j.jobId) {
        setNote('Hugo is building — qwen2.5-coder on Framerstation… (0s)');
        poll(j.jobId, Date.now());
      } else {
        setNote(`Couldn't start the build (${j.error ?? 'error'})`);
        setBusy(false);
      }
    } catch {
      setNote('Request failed');
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h4>{'</> '}Hugo · Build Engineer</h4>
      <div className="brief" style={{ marginBottom: 10 }}>
        A real coder model (qwen2.5-coder) writes on-brand HTML — proven by the Visual-QA gate before it advances. Runs in the background; you can keep working.
      </div>
      <button className="btn-primary" style={{ width: '100%', opacity: busy ? 0.6 : 1 }} onClick={run} disabled={busy}>
        {busy ? 'Building…' : 'Have Hugo build a landing card'}
      </button>
      {note ? <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>{note}</div> : null}
    </div>
  );
}
