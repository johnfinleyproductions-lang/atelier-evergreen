// lib/lanes.ts
//
// The GPU lane manager — Phase 1: registry + live state + zones + routing advice.
//
// It reads config/lanes.json (the lane + zone registry), collects LIVE GPU state
// per lane (nvidia-smi where local, Ollama /api/ps otherwise), works out the
// active zone from the clock, and — given a model request — recommends which lane
// should serve it. This phase is ADVISORY: it tells you the right lane and why;
// it does not yet load/evict models or gate requests (Phase 2). The policy
// encodes the rule: M90t pins services; Framerstation/vidbox kick on-demand.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { OLLAMA_URL } from './ollama';

const pexecFile = promisify(execFile);

// Approx VRAM each Atelier model needs to load (MB). Used by the room check.
export const MODEL_VRAM_MB: Record<string, number> = {
  'qwen3.5:9b': 7000,
  'qwen2.5-coder:14b': 9000,
};

export interface LaneCfg {
  id: string; name: string; lan: string; gpu: string; vramTotalMB: number;
  role: 'pinned' | 'on-demand'; ollama?: string | null; llamacpp?: string; local?: boolean; note?: string;
}
export interface ZoneCfg { id: string; days?: string[]; start?: string; end?: string; block?: string[]; allow?: string[]; note?: string }
export interface LanesConfig { lanes: LaneCfg[]; zones: ZoneCfg[]; defaultZone: { id: string; note?: string } }

export interface WarmModel { name: string; vramMB: number }
export interface LaneState {
  id: string; name: string; role: 'pinned' | 'on-demand'; lan: string; gpu: string;
  reachable: boolean; source: 'nvidia-smi' | 'ollama-ps' | 'unknown';
  vramTotalMB: number; vramUsedMB: number | null; vramFreeMB: number | null;
  warmModels: WarmModel[]; note?: string;
}

let cached: LanesConfig | null = null;
export function loadLanesConfig(): LanesConfig {
  if (cached) return cached;
  const raw = readFileSync(resolve(process.cwd(), 'config/lanes.json'), 'utf8');
  cached = JSON.parse(raw) as LanesConfig;
  return cached;
}

// ── Live collection ────────────────────────────────────────────────────────
async function nvidiaUsedTotal(): Promise<{ usedMB: number; totalMB: number } | null> {
  try {
    const { stdout } = await pexecFile(
      'nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    const [used, total] = stdout.trim().split('\n')[0].split(',').map((s) => parseInt(s.trim(), 10));
    return Number.isFinite(used) && Number.isFinite(total) ? { usedMB: used, totalMB: total } : null;
  } catch { return null; }
}

async function ollamaPs(url: string): Promise<WarmModel[] | null> {
  try {
    const res = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: { name: string; size_vram?: number }[] };
    return (j.models ?? []).map((m) => ({ name: m.name, vramMB: Math.round((m.size_vram ?? 0) / 1e6) }));
  } catch { return null; }
}

async function collectLane(c: LaneCfg): Promise<LaneState> {
  const base: LaneState = {
    id: c.id, name: c.name, role: c.role, lan: c.lan, gpu: c.gpu,
    reachable: false, source: 'unknown', vramTotalMB: c.vramTotalMB,
    vramUsedMB: null, vramFreeMB: null, warmModels: [], note: c.note,
  };
  // Warm models from Ollama (works local or remote).
  const warm = c.ollama ? await ollamaPs(c.ollama) : null;
  if (warm) { base.reachable = true; base.warmModels = warm; }

  // True card usage if we can run nvidia-smi here (only the local/M90t lane).
  if (c.local) {
    const nv = await nvidiaUsedTotal();
    if (nv) {
      base.reachable = true; base.source = 'nvidia-smi';
      base.vramTotalMB = nv.totalMB; base.vramUsedMB = nv.usedMB; base.vramFreeMB = nv.totalMB - nv.usedMB;
      return base;
    }
  }
  // Otherwise estimate used VRAM from Ollama's loaded models.
  if (warm) {
    base.source = 'ollama-ps';
    const used = warm.reduce((s, m) => s + m.vramMB, 0);
    base.vramUsedMB = used; base.vramFreeMB = Math.max(0, c.vramTotalMB - used);
  }
  return base;
}

export async function getLanesState(): Promise<LaneState[]> {
  const cfg = loadLanesConfig();
  return Promise.all(cfg.lanes.map(collectLane));
}

// ── Zones ──────────────────────────────────────────────────────────────────
const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function hm(s?: string): number | null { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; }

export interface ActiveZone { id: string; block: string[]; allow: string[]; note?: string }
/** Which zone is active now (server local time). Pass minutes-since-midnight + day index to override. */
export function currentZone(nowMin?: number, dayIdx?: number): ActiveZone {
  const cfg = loadLanesConfig();
  // Manual override: ATELIER_FORCE_ZONE=<zone id> pins a zone (e.g. force "work-hours"
  // to protect the lane). Only honored when not explicitly probing a time.
  if (nowMin == null && dayIdx == null && process.env.ATELIER_FORCE_ZONE) {
    const forced = cfg.zones.find((z) => z.id === process.env.ATELIER_FORCE_ZONE);
    if (forced) return { id: forced.id, block: forced.block ?? [], allow: forced.allow ?? [], note: `(forced) ${forced.note ?? ''}` };
  }
  const d = new Date();
  const mins = nowMin ?? d.getHours() * 60 + d.getMinutes();
  const day = DAY[dayIdx ?? d.getDay()];
  for (const z of cfg.zones) {
    if (z.days && !z.days.includes(day)) continue;
    const s = hm(z.start); const e = hm(z.end);
    if (s == null || e == null) continue;
    const inRange = s <= e ? (mins >= s && mins < e) : (mins >= s || mins < e); // wraps midnight
    if (inRange) return { id: z.id, block: z.block ?? [], allow: z.allow ?? [], note: z.note };
  }
  return { id: cfg.defaultZone.id, block: [], allow: [], note: cfg.defaultZone.note };
}

/** True when the active zone blocks this work kind. */
export function zoneBlocks(workKind: WorkKind, zone?: ActiveZone): boolean {
  const z = zone ?? currentZone();
  return z.block.includes(workKind) && !z.allow.includes(workKind);
}

/**
 * The next moment this work kind becomes allowed, scanning forward up to 24h at
 * 5-min resolution. Returns null if it's allowed right now. Uses the forced zone
 * if one is set (so a pinned block defers indefinitely → caller falls back to a
 * fixed delay).
 */
export function nextAllowedAt(workKind: WorkKind, from = new Date()): Date | null {
  if (!zoneBlocks(workKind)) return null;
  if (process.env.ATELIER_FORCE_ZONE) return null; // a forced pin has no predictable exit
  const baseDay = from.getDay();
  const baseMin = from.getHours() * 60 + from.getMinutes();
  for (let step = 5; step <= 24 * 60; step += 5) {
    const total = baseMin + step;
    const dayIdx = (baseDay + Math.floor(total / (24 * 60))) % 7;
    const mins = total % (24 * 60);
    const z = currentZone(mins, dayIdx);
    if (!(z.block.includes(workKind) && !z.allow.includes(workKind))) {
      const t = new Date(from.getTime() + step * 60_000);
      t.setSeconds(0, 0);
      return t;
    }
  }
  return null; // blocked for the whole horizon (e.g. a forced pin)
}

// ── Routing advisor ──────────────────────────────────────────────────────────
export type WorkKind = 'service' | 'interactive' | 'batch-heavy';
export interface RouteAdvice {
  laneId: string | null; laneName: string | null; reason: string;
  blockedByZone: boolean; zone: string; warm: boolean;
}

/** Recommend the lane to serve a model request right now. Advisory (Phase 1). */
export async function routeModel(opts: { kind: WorkKind; model?: string; sizeMB?: number }): Promise<RouteAdvice> {
  const { kind, model, sizeMB = 0 } = opts;
  const states = await getLanesState();
  const zone = currentZone();
  const byId = (id: string) => states.find((s) => s.id === id) ?? null;
  const isWarm = (s: LaneState) => !!model && s.warmModels.some((m) => m.name === model);
  const fits = (s: LaneState) => s.vramFreeMB == null || s.vramFreeMB >= sizeMB;

  // Pinned services belong on the pinned host.
  if (kind === 'service') {
    const m = byId('m90t');
    const ok = m && fits(m);
    return {
      laneId: 'm90t', laneName: m?.name ?? 'M90t', warm: !!m && isWarm(m), zone: zone.id, blockedByZone: false,
      reason: ok ? 'Pinned services run on M90t (the pinning host).'
        : `M90t is the pinning host but only ~${m?.vramFreeMB ?? 0}MB free — right-size the model or free VRAM.`,
    };
  }

  // Heavy/batch: biggest on-demand lane with room; honor zone blocks.
  if (kind === 'batch-heavy') {
    const blocked = zone.block.includes('batch-heavy') && !zone.allow.includes('batch-heavy');
    const candidates = states.filter((s) => s.role === 'on-demand' && s.reachable && fits(s))
      .sort((a, b) => (b.vramFreeMB ?? b.vramTotalMB) - (a.vramFreeMB ?? a.vramTotalMB));
    const pick = candidates[0] ?? byId('framerstation');
    return {
      laneId: pick?.id ?? null, laneName: pick?.name ?? null, warm: !!pick && isWarm(pick), zone: zone.id,
      blockedByZone: blocked,
      reason: blocked
        ? `Zone "${zone.id}" blocks batch-heavy work — defer to the overnight window, or override.`
        : `Heaviest on-demand lane with room: ${pick?.name ?? 'none reachable'}.`,
    };
  }

  // Interactive: prefer a lane already warm with the model; else on-demand lane with most room.
  const warmLane = states.find((s) => s.reachable && isWarm(s) && fits(s));
  if (warmLane) {
    return { laneId: warmLane.id, laneName: warmLane.name, warm: true, zone: zone.id, blockedByZone: false,
      reason: `${model} is already warm on ${warmLane.name} — lowest latency.` };
  }
  const onDemand = states.filter((s) => s.role === 'on-demand' && s.reachable && fits(s))
    .sort((a, b) => (b.vramFreeMB ?? b.vramTotalMB) - (a.vramFreeMB ?? a.vramTotalMB));
  const pick = onDemand[0] ?? byId('framerstation');
  return { laneId: pick?.id ?? null, laneName: pick?.name ?? null, warm: false, zone: zone.id, blockedByZone: false,
    reason: pick ? `No warm copy; ${pick.name} has the most free VRAM on an on-demand lane.` : 'No on-demand lane reachable.' };
}

// ── Eviction: "kick what's not being used" ───────────────────────────────────
const AUTOKICK = (process.env.ATELIER_LANE_AUTOKICK ?? 'on') !== 'off';

/** Unload a specific model on an Ollama lane (keep_alive:0 → immediate evict). */
export async function kickModel(ollamaUrl: string, model: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch { return false; }
}

/** Kick every loaded model on a lane except the ones to keep. Returns what was evicted. */
export async function kickIdle(laneId: string, keep: string[] = []): Promise<{ kicked: string[]; note: string }> {
  const lane = loadLanesConfig().lanes.find((l) => l.id === laneId);
  if (!lane?.ollama) return { kicked: [], note: `${laneId}: no Ollama lane to kick` };
  const warm = (await ollamaPs(lane.ollama)) ?? [];
  const kicked: string[] = [];
  for (const m of warm) {
    if (keep.includes(m.name)) continue;
    if (await kickModel(lane.ollama, m.name)) kicked.push(m.name);
  }
  return { kicked, note: kicked.length ? `kicked ${kicked.join(', ')} on ${lane.name}` : `${lane.name}: nothing idle to kick` };
}

function laneIdForOllama(url: string): string | null {
  return loadLanesConfig().lanes.find((l) => l.ollama && url.startsWith(l.ollama.replace(/\/$/, '')))?.id
    ?? loadLanesConfig().lanes.find((l) => l.ollama === url)?.id ?? null;
}

/**
 * Ensure Atelier's on-demand lane has room for `model` before a heavy job runs:
 * if free VRAM is short, kick whatever idle models are parked there (except the
 * one we're about to use). No-op if there's already room or autokick is off.
 * This is the "use Framerstation/vidbox + kick what's not being used" policy.
 */
export async function ensureAtelierLaneRoom(model: string): Promise<{ ok: boolean; kicked: string[]; note: string }> {
  if (!AUTOKICK) return { ok: true, kicked: [], note: 'autokick off' };
  const laneId = laneIdForOllama(OLLAMA_URL);
  if (!laneId) return { ok: true, kicked: [], note: 'unknown lane' };
  const needMB = MODEL_VRAM_MB[model] ?? 7000;
  const state = (await getLanesState()).find((s) => s.id === laneId);
  if (!state) return { ok: true, kicked: [], note: 'lane unreachable' };
  // Already room (or already warm)? Don't disturb the lane.
  if (state.warmModels.some((m) => m.name === model)) return { ok: true, kicked: [], note: `${model} already warm` };
  if (state.vramFreeMB != null && state.vramFreeMB >= needMB) return { ok: true, kicked: [], note: 'room available' };
  const r = await kickIdle(laneId, [model]);
  return { ok: true, kicked: r.kicked, note: r.note };
}

/** A glanceable lane map for chat / status. */
export function formatLanes(states: LaneState[], zone: ActiveZone): string {
  const gb = (mb: number | null) => mb == null ? '  ? ' : `${(mb / 1024).toFixed(1)}GB`;
  const lines = states.map((s) => {
    const dot = s.reachable ? '🟢' : '🔴';
    const usage = s.vramUsedMB == null ? 'usage unknown' : `${gb(s.vramUsedMB)}/${gb(s.vramTotalMB)} used · ${gb(s.vramFreeMB)} free`;
    const warm = s.warmModels.length ? ` · warm: ${s.warmModels.map((m) => m.name).join(', ')}` : '';
    const role = s.role === 'pinned' ? '[pinned]' : '[on-demand]';
    return `  ${dot} ${s.name} ${role} — ${usage}${warm} (${s.source})`;
  });
  return [`GPU lanes (zone: ${zone.id}${zone.block.length ? `, blocking ${zone.block.join(',')}` : ''}):`, ...lines].join('\n');
}
