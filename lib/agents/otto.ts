// lib/agents/otto.ts
//
// Otto — Ops / SRE. The first REAL ops tool in Atelier: instead of *talking* about
// health, he reports it. Everything here is a live signal the Atelier server can
// actually reach, so the snapshot is honest (no fabrication):
//   - systemd --user services on the host (atelier, whisper, opencode)
//   - Framerstation Ollama: reachable? which models are warm in VRAM?
//   - Whisper STT endpoint: listening?
//   - the Atelier job queue + recent proof pass-rate (from the DB)
//   - DB round-trip latency
//
// When Atelier runs on M90t (the deployed service) all of these are real; on a
// Mac dev box the systemd checks degrade gracefully to "unknown".

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

const pexecFile = promisify(execFile);

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const WHISPER_URL = process.env.ATELIER_WHISPER_URL ?? 'http://127.0.0.1:8025';
const SERVICES = (process.env.ATELIER_HEALTH_SERVICES ?? 'atelier,atelier-whisper,opencode-serve')
  .split(',').map((s) => s.trim()).filter(Boolean);

export interface ServiceHealth { name: string; state: 'active' | 'inactive' | 'unknown'; detail: string }
export interface ProbeHealth { name: string; up: boolean; ms: number | null; detail: string }
export interface QueueHealth {
  queued: number; running: number; done: number; error: number;
  lastBuild: { status: string; proofPass: boolean | null; paletteDeltaE: number | null; ageMin: number | null } | null;
}
export interface SystemHealth {
  services: ServiceHealth[];
  ollama: ProbeHealth & { models: string[] };
  whisper: ProbeHealth;
  queue: QueueHealth;
  db: { up: boolean; ms: number | null };
  takenAt: string;
}

// systemctl --user needs XDG_RUNTIME_DIR; set it defensively for the child.
function userEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}` };
}

async function checkService(name: string): Promise<ServiceHealth> {
  try {
    const { stdout } = await pexecFile('systemctl', ['--user', 'is-active', name], {
      env: userEnv(), timeout: 5000,
    });
    const s = stdout.trim();
    return { name, state: s === 'active' ? 'active' : 'inactive', detail: s };
  } catch (err: unknown) {
    // is-active exits non-zero when inactive; the word is still on stdout.
    const e = err as { stdout?: string; code?: string };
    const s = (e.stdout ?? '').trim();
    if (s === 'inactive' || s === 'failed') return { name, state: 'inactive', detail: s };
    return { name, state: 'unknown', detail: 'systemd unavailable' };
  }
}

async function probe(name: string, url: string): Promise<ProbeHealth> {
  const t0 = Date.now();
  try {
    const ctrl = AbortSignal.timeout(5000);
    const res = await fetch(url, { signal: ctrl });
    // Any HTTP response (even 404) means the listener is up.
    return { name, up: true, ms: Date.now() - t0, detail: `HTTP ${res.status}` };
  } catch {
    return { name, up: false, ms: null, detail: 'no response' };
  }
}

async function ollamaHealth(): Promise<ProbeHealth & { models: string[] }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { name: 'ollama', up: false, ms: Date.now() - t0, detail: `HTTP ${res.status}`, models: [] };
    const j = (await res.json()) as { models?: { name: string }[] };
    const models = (j.models ?? []).map((m) => m.name);
    return { name: 'ollama', up: true, ms: Date.now() - t0, detail: models.length ? `${models.length} warm` : 'idle', models };
  } catch {
    return { name: 'ollama', up: false, ms: null, detail: 'unreachable', models: [] };
  }
}

async function queueHealth(): Promise<QueueHealth> {
  const counts = (await sql`
    select status, count(*)::int as n from atelier_job where workspace_id = ${ATELIER_WS} group by status
  `) as unknown as { status: string; n: number }[];
  const by = Object.fromEntries(counts.map((c) => [c.status, c.n])) as Record<string, number>;
  const last = (await sql`
    select status, result, finished_at,
           extract(epoch from (now() - finished_at)) as age_s
      from atelier_job
     where workspace_id = ${ATELIER_WS} and kind = 'hugo_build' and finished_at is not null
     order by finished_at desc limit 1
  `) as unknown as { status: string; result: Record<string, unknown> | null; age_s: number | null }[];
  let lastBuild: QueueHealth['lastBuild'] = null;
  if (last[0]) {
    const r = last[0].result ?? {};
    lastBuild = {
      status: last[0].status,
      proofPass: typeof r.proofPass === 'boolean' ? r.proofPass : null,
      paletteDeltaE: typeof r.paletteDeltaE === 'number' ? r.paletteDeltaE : null,
      ageMin: last[0].age_s != null ? Math.round(Number(last[0].age_s) / 60) : null,
    };
  }
  return {
    queued: by.queued ?? 0, running: by.running ?? 0, done: by.done ?? 0, error: by.error ?? 0, lastBuild,
  };
}

async function dbPing(): Promise<{ up: boolean; ms: number | null }> {
  const t0 = Date.now();
  try { await sql`select 1`; return { up: true, ms: Date.now() - t0 }; }
  catch { return { up: false, ms: null }; }
}

/** Gather a full live health snapshot. Parallel; never throws. */
export async function systemHealth(): Promise<SystemHealth> {
  const [services, ollama, whisper, queue, db] = await Promise.all([
    Promise.all(SERVICES.map(checkService)),
    ollamaHealth(),
    probe('whisper', WHISPER_URL),
    queueHealth(),
    dbPing(),
  ]);
  return { services, ollama, whisper, queue, db, takenAt: new Date().toISOString() };
}

/** A concise, glanceable health line for chat. */
export function formatHealth(h: SystemHealth): string {
  const dot = (ok: boolean) => (ok ? '🟢' : '🔴');
  const svc = h.services.map((s) => `${dot(s.state === 'active')} ${s.name}`).join('  ');
  const ol = `${dot(h.ollama.up)} Framerstation Ollama${h.ollama.up ? ` (${h.ollama.models.join(', ') || 'idle'})` : ''}`;
  const wh = `${dot(h.whisper.up)} Whisper STT${h.whisper.up ? ` (${h.whisper.ms}ms)` : ''}`;
  const q = h.queue;
  const lb = q.lastBuild
    ? `last build ${q.lastBuild.status}${q.lastBuild.proofPass != null ? ` (${q.lastBuild.proofPass ? 'proof ✓' : 'proof ✗'}${q.lastBuild.paletteDeltaE != null ? ` ΔE ${q.lastBuild.paletteDeltaE}` : ''})` : ''}${q.lastBuild.ageMin != null ? `, ${q.lastBuild.ageMin}m ago` : ''}`
    : 'no builds yet';
  const qline = `Jobs: ${q.running} running · ${q.queued} queued · ${q.done} done · ${q.error} errored — ${lb}`;
  const dbline = `${dot(h.db.up)} DB${h.db.up ? ` (${h.db.ms}ms)` : ''}`;
  return [
    'Substrate health:',
    `  Services: ${svc}`,
    `  Models:   ${ol}`,
    `  Voice:    ${wh}`,
    `  Data:     ${dbline}`,
    `  ${qline}`,
  ].join('\n');
}
