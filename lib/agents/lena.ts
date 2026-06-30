// lib/agents/lena.ts
//
// Lena — Curriculum & distribution lead. Turns a course/launch brief into a
// concrete distribution plan: who it's for, which channels, the angle + format
// per channel, and a launch sequence. Outcome-focused, grounded in THIS
// project's dossier via the local model. Runs as a background job (the shared
// GPU can cold-load the model), acks instantly in chat, and logs the plan to
// the project so it shows in the log and Dewey can recall it.

import { projectContext, logToProject } from './context';

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const LENA_MODEL = process.env.ATELIER_LENA_MODEL ?? 'qwen3.5:9b';

export interface Channel { name: string; angle: string; format: string }
export interface DistributionPlan {
  brief: string;
  audience: string;
  channels: Channel[];
  sequence: string[];
  cta: string;
  model: string;
  latencyMs: number;
  error?: string;
}

function parsePlan(raw: string): { audience: string; channels: Channel[]; sequence: string[]; cta: string } {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const out = { audience: '', channels: [] as Channel[], sequence: [] as string[], cta: '' };
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    out.audience = String(j.audience ?? '').trim();
    out.cta = String(j.cta ?? '').trim();
    out.sequence = Array.isArray(j.sequence) ? (j.sequence as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [];
    out.channels = Array.isArray(j.channels) ? (j.channels as Record<string, unknown>[]).map((c) => ({
      name: String(c.name ?? c.channel ?? '').trim(),
      angle: String(c.angle ?? c.hook ?? '').trim(),
      format: String(c.format ?? '').trim(),
    })).filter((c) => c.name).slice(0, 6) : [];
  } catch { /* leave empty */ }
  return out;
}

/** Build a distribution plan for a brief. Real model + project grounding; never throws. */
export async function distributionPlan(brief: string): Promise<DistributionPlan> {
  const t0 = Date.now();
  const base: DistributionPlan = { brief, audience: '', channels: [], sequence: [], cta: '', model: LENA_MODEL, latencyMs: 0 };
  try {
    const ctx = await projectContext();
    const system =
      `You are Lena, a curriculum & distribution lead. Given a brief and project context, return ONLY a JSON ` +
      `object: {"audience":"who this is for, specific","channels":[{"name":"channel","angle":"the hook for that ` +
      `channel","format":"the asset type"}],"sequence":["ordered launch steps"],"cta":"the single primary call to action"}. ` +
      `3-5 channels, each with a DIFFERENT angle suited to that channel. Be concrete and outcome-focused — no generic ` +
      `"post on social media". No prose, just the JSON object.`;
    const user = `Brief: ${brief}\n\n${ctx}\n\nReturn the JSON object.`;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LENA_MODEL, stream: false, keep_alive: '10m', options: { temperature: 0.6 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(140_000),
    });
    if (!res.ok) return { ...base, latencyMs: Date.now() - t0, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const plan = parsePlan(j.message?.content ?? '');
    return { ...base, ...plan, latencyMs: Date.now() - t0, error: plan.channels.length ? undefined : 'NO_PLAN_PARSED' };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : 'LENA_FAILED' };
  }
}

export async function planAndLog(brief: string): Promise<DistributionPlan & { logged: boolean }> {
  const p = await distributionPlan(brief);
  let logged = false;
  if (p.channels.length) {
    logged = await logToProject('lena', `Distribution plan — ${brief}: ${p.channels.map((c) => c.name).join(', ')}`,
      { agent: 'lena', audience: p.audience, channels: p.channels, sequence: p.sequence, cta: p.cta });
  }
  return { ...p, logged };
}

export function formatPlan(p: DistributionPlan): string {
  if (!p.channels.length) return `I couldn't put a distribution plan together for that (${p.error ?? 'no output'}). Try a sharper brief?`;
  const out: string[] = [`Distribution plan — ${p.brief}`];
  if (p.audience) out.push(`Audience: ${p.audience}`);
  out.push('Channels:');
  p.channels.forEach((c) => out.push(`  • ${c.name}${c.format ? ` (${c.format})` : ''} — ${c.angle}`));
  if (p.sequence.length) { out.push('Sequence:'); p.sequence.forEach((s, i) => out.push(`  ${i + 1}. ${s}`)); }
  if (p.cta) out.push(`Primary CTA: ${p.cta}`);
  return out.join('\n');
}
