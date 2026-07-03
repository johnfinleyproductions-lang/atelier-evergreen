'use client';
import { useState } from 'react';

// Minimal single-user gate: enter the Atelier secret once → httpOnly cookie →
// the whole UI's /api calls are authorized.
export default function GatePage() {
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
      if (r.ok) { window.location.href = '/'; }
      else { setErr('Wrong secret.'); }
    } catch { setErr('Request failed.'); }
    finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f5f3ec', color: '#15201c' }}>
      <form onSubmit={submit} style={{ width: 340, padding: 28, borderRadius: 14, background: 'white', boxShadow: '0 8px 30px rgba(0,0,0,.08)' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 20 }}>Atelier</h1>
        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#5b6b63' }}>Enter the studio secret to continue.</p>
        <input
          type="password" value={secret} autoFocus onChange={(e) => setSecret(e.target.value)}
          placeholder="secret"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d8d4c8', marginBottom: 10, fontSize: 14 }}
        />
        <button type="submit" disabled={busy || !secret}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', background: '#0d9488', color: 'white', fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
        {err ? <div style={{ marginTop: 10, fontSize: 12, color: '#b00020' }}>{err}</div> : null}
      </form>
    </main>
  );
}
