// lib/agents/remy.ts
//
// Remy — Media producer. Turns a topic/brief into a short-form video script:
// a hook, ordered beats (each with what's on screen + the voiceover line), and
// a CTA. Concrete and shoot-ready, grounded in THIS project's dossier via the
// local model. Background job (shared-GPU cold loads), acks instantly in chat,
// logs the script to the project. Pairs with the Resolve/Showrunner pipeline.

import { projectContext, logToProject } from './context';

import { OLLAMA_KEEPALIVE } from '../ollama';
const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const REMY_MODEL = process.env.ATELIER_REMY_MODEL ?? 'qwen3.5:9b';

export interface Beat { onScreen: string; vo: string }
export interface VideoScript {
  brief: string;
  hook: string;
  beats: Beat[];
  cta: string;
  model: string;
  latencyMs: number;
  error?: string;
}

function parseScript(raw: string): { hook: string; beats: Beat[]; cta: string } {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const out = { hook: '', beats: [] as Beat[], cta: '' };
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    out.hook = String(j.hook ?? '').trim();
    out.cta = String(j.cta ?? '').trim();
    out.beats = Array.isArray(j.beats) ? (j.beats as Record<string, unknown>[]).map((bt) => ({
      onScreen: String(bt.onScreen ?? bt.on_screen ?? bt.shot ?? bt.visual ?? '').trim(),
      vo: String(bt.vo ?? bt.voiceover ?? bt.line ?? bt.script ?? '').trim(),
    })).filter((bt) => bt.vo || bt.onScreen).slice(0, 8) : [];
  } catch { /* leave empty */ }
  return out;
}

/** Build a short-form video script for a brief. Real model + grounding; never throws. */
export async function videoScript(brief: string): Promise<VideoScript> {
  const t0 = Date.now();
  const base: VideoScript = { brief, hook: '', beats: [], cta: '', model: REMY_MODEL, latencyMs: 0 };
  try {
    const ctx = await projectContext();
    const system =
      `You are Remy, a media producer. Given a brief and project context, return ONLY a JSON object for a tight ` +
      `30-60s short-form video: {"hook":"the first-3-seconds line that stops the scroll","beats":[{"onScreen":"what ` +
      `the viewer sees","vo":"the voiceover line"}],"cta":"closing call to action"}. 3-5 beats, concrete and ` +
      `shoot-ready (real shots, not "show footage"). Energetic, no fluff. No prose, just the JSON object.`;
    const user = `Brief: ${brief}\n\n${ctx}\n\nReturn the JSON object.`;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: REMY_MODEL, stream: false, keep_alive: OLLAMA_KEEPALIVE, options: { temperature: 0.7 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(140_000),
    });
    if (!res.ok) return { ...base, latencyMs: Date.now() - t0, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const sc = parseScript(j.message?.content ?? '');
    return { ...base, ...sc, latencyMs: Date.now() - t0, error: sc.beats.length ? undefined : 'NO_SCRIPT_PARSED' };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : 'REMY_FAILED' };
  }
}

export async function scriptAndLog(brief: string): Promise<VideoScript & { logged: boolean }> {
  const sc = await videoScript(brief);
  let logged = false;
  if (sc.beats.length) {
    logged = await logToProject('remy', `Video script — ${brief}: "${sc.hook}"`,
      { agent: 'remy', hook: sc.hook, beats: sc.beats, cta: sc.cta });
  }
  return { ...sc, logged };
}

export function formatScript(s: VideoScript): string {
  if (!s.beats.length) return `I couldn't draft a script for that (${s.error ?? 'no output'}). Try a sharper brief?`;
  const out: string[] = [`Video script — ${s.brief}`];
  if (s.hook) out.push(`Hook (0-3s): ${s.hook}`);
  out.push('Beats:');
  s.beats.forEach((b, i) => out.push(`  ${i + 1}. [${b.onScreen || 'shot'}] ${b.vo}`));
  if (s.cta) out.push(`CTA: ${s.cta}`);
  return out.join('\n');
}
