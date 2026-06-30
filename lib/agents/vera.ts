// lib/agents/vera.ts
//
// Vera — Researcher. Turns a fuzzy brief into a sharp research plan: distinct
// angles to investigate, the key questions, and what to verify before using it.
// Honest grounding, two layers:
//   1. ALWAYS: the project's own dossier (objective + recent log) so the plan is
//      about THIS project, plus the local model for the angles/questions.
//   2. OPTIONAL: real cited passages from the Evergreen knowledge service — only
//      when KNOWLEDGE_API_KEY is set in Atelier's env. Without it, Vera degrades
//      to the local plan and clearly says sources aren't wired, rather than
//      inventing citations.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const VERA_MODEL = process.env.ATELIER_VERA_MODEL ?? 'qwen3.5:9b';
const KNOWLEDGE_URL = process.env.ATELIER_KNOWLEDGE_URL ?? 'http://127.0.0.1:8001';
const KNOWLEDGE_API_KEY = process.env.ATELIER_KNOWLEDGE_API_KEY ?? '';

export interface Source { text: string; source: string | null; course: string | null; score: number | null }
export interface ResearchPlan {
  brief: string;
  angles: string[];
  questions: string[];
  verify: string[];
  sources: Source[];
  grounded: boolean;       // true when real knowledge sources were attached
  sourcesEnabled: boolean; // true when a knowledge key is configured
  model: string;
  latencyMs: number;
  error?: string;
}

/** Real cited passages from the knowledge service. [] if no key / unreachable. */
export async function knowledgeSearch(query: string, limit = 4): Promise<Source[]> {
  if (!KNOWLEDGE_API_KEY) return [];
  try {
    const res = await fetch(`${KNOWLEDGE_URL}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': KNOWLEDGE_API_KEY },
      body: JSON.stringify({ query, limit, rerank: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as unknown;
    const rows: Record<string, unknown>[] =
      Array.isArray(j) ? (j as Record<string, unknown>[])
        : Array.isArray((j as { results?: unknown[] }).results) ? (j as { results: Record<string, unknown>[] }).results
        : Array.isArray((j as { hits?: unknown[] }).hits) ? (j as { hits: Record<string, unknown>[] }).hits
        : [];
    return rows.slice(0, limit).map((r) => {
      const payload = (r.payload as Record<string, unknown>) ?? r;
      const text = String(r.text ?? r.content ?? r.chunk ?? payload.text ?? '').trim().slice(0, 280);
      return {
        text,
        source: (payload.source as string) ?? (payload.source_type as string) ?? (r.source as string) ?? null,
        course: (payload.course as string) ?? null,
        score: typeof r.score === 'number' ? Math.round((r.score as number) * 100) / 100 : null,
      };
    }).filter((s) => s.text);
  } catch {
    return [];
  }
}

/** The project's own context, so the plan is about THIS project. */
async function projectContext(): Promise<string> {
  const d = (await sql`
    select title, objective from atelier_dossier
     where workspace_id = ${ATELIER_WS} order by created_at desc limit 1
  `) as unknown as { title: string | null; objective: string | null }[];
  if (!d[0]) return '';
  const entries = (await sql`
    select body from atelier_dossier_entry
     where workspace_id = ${ATELIER_WS} and body is not null
     order by created_at desc limit 4
  `) as unknown as { body: string }[];
  const log = entries.map((e) => `- ${e.body.slice(0, 120)}`).join('\n');
  return `Current project: ${d[0].title ?? ''}${d[0].objective ? ` — ${d[0].objective}` : ''}.\nRecent log:\n${log}`;
}

function parsePlan(raw: string): { angles: string[]; questions: string[]; verify: string[] } {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const out = { angles: [] as string[], questions: [] as string[], verify: [] as string[] };
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const arr = (k: string) => Array.isArray(j[k]) ? (j[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [];
    out.angles = arr('angles'); out.questions = arr('questions'); out.verify = arr('verify');
  } catch { /* leave empty; caller handles */ }
  return out;
}

/** Produce a research plan for a brief. Real model + grounding; never throws. */
export async function research(brief: string): Promise<ResearchPlan> {
  const t0 = Date.now();
  const base: ResearchPlan = {
    brief, angles: [], questions: [], verify: [], sources: [],
    grounded: false, sourcesEnabled: !!KNOWLEDGE_API_KEY, model: VERA_MODEL, latencyMs: 0,
  };
  try {
    const [ctx, sources] = await Promise.all([projectContext(), knowledgeSearch(brief, 4)]);
    const srcBlock = sources.length
      ? `\nIndexed sources you may lean on (cite by source):\n${sources.map((s, i) => `[${i + 1}] ${s.text}`).join('\n')}`
      : '';
    const system =
      `You are Vera, a sharp researcher. Given a brief and project context, return ONLY a JSON object ` +
      `with three string arrays: "angles" (3-5 distinct angles worth investigating, each a short phrase), ` +
      `"questions" (3-5 specific questions to answer), and "verify" (2-4 things to fact-check before relying on them). ` +
      `Be concrete and non-generic. No prose, no markdown — just the JSON object.`;
    const user = `Brief: ${brief}\n\n${ctx}${srcBlock}\n\nReturn the JSON object.`;

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // keep_alive pins the model so back-to-back Atelier calls don't pay a cold
      // reload (Framerstation's GPU is shared with OpenCode's 27b). The long
      // timeout tolerates a one-off cold load; research runs as a background job,
      // so this never blocks an HTTP request.
      body: JSON.stringify({ model: VERA_MODEL, stream: false, keep_alive: '10m', options: { temperature: 0.6 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(140_000),
    });
    if (!res.ok) return { ...base, sources, latencyMs: Date.now() - t0, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const plan = parsePlan(j.message?.content ?? '');
    return {
      ...base, ...plan, sources, grounded: sources.length > 0, latencyMs: Date.now() - t0,
      error: plan.angles.length ? undefined : 'NO_PLAN_PARSED',
    };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : 'VERA_FAILED' };
  }
}

/**
 * Run research and log the plan to the active project's dossier as a note, so it
 * shows in the project log and Dewey can recall it later. Used by the background
 * job runner (model cold-loads make this too slow to await in a request).
 */
export async function researchAndLog(brief: string): Promise<ResearchPlan & { logged: boolean }> {
  const p = await research(brief);
  let logged = false;
  if (p.angles.length || p.questions.length) {
    const d = (await sql`
      select id from atelier_dossier where workspace_id = ${ATELIER_WS} order by created_at desc limit 1
    `) as unknown as { id: string }[];
    if (d[0]) {
      await sql`
        insert into atelier_dossier_entry (workspace_id, dossier_id, employee_slug, entry_type, body, payload)
        values (${ATELIER_WS}, ${d[0].id}, 'vera', 'note',
                ${`Research plan — ${brief}: ${p.angles.slice(0, 3).join('; ')}`},
                ${sql.json({ agent: 'vera', angles: p.angles, questions: p.questions, verify: p.verify, grounded: p.grounded } as never)})`;
      logged = true;
    }
  }
  return { ...p, logged };
}

export function formatResearch(p: ResearchPlan): string {
  if (!p.angles.length && !p.questions.length) {
    return `I couldn't put a plan together for that (${p.error ?? 'no output'}). Try a sharper brief?`;
  }
  const sec = (title: string, items: string[]) => items.length ? [`${title}:`, ...items.map((x) => `  • ${x}`)] : [];
  const out: string[] = [`Research plan — ${p.brief}`];
  out.push(...sec('Angles to investigate', p.angles));
  out.push(...sec('Key questions', p.questions));
  out.push(...sec('Verify before using', p.verify));
  if (p.sources.length) {
    out.push('Grounded in indexed sources:');
    p.sources.forEach((s, i) => out.push(`  [${i + 1}] ${s.text}${s.course ? ` (${s.course})` : ''}${s.source ? ` — ${s.source}` : ''}`));
  } else if (!p.sourcesEnabled) {
    out.push('(These are angles to investigate, not verified facts. Live knowledge-base citations aren\'t wired yet — set ATELIER_KNOWLEDGE_API_KEY to ground them in the indexed corpus.)');
  } else {
    out.push('(No indexed sources matched — treat these as angles to investigate, not verified facts.)');
  }
  return out.join('\n');
}
