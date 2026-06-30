// lib/agents/marlowe.ts
//
// Marlowe — Editor & brand critic. The QC pass that red-teams copy BEFORE it
// reaches Tyler. He critiques against two real standards:
//   1. the documented Evergreen voice (the same bar Wren writes to), and
//   2. Tyler's learned taste — what he has actually favored / vetoed.
// He names 2-3 specific fixes and a ship/revise verdict — never vague praise.
//
// Two surfaces: critique() red-teams any text (chat), and reviewLatestWren()
// auto-reviews Wren's freshly written option set and logs the read to the
// project (wired as a background job off the Wren flow, so it never blocks).

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';
import { recallTasteForPrompt } from '../taste-memory';

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const MARLOWE_MODEL = process.env.ATELIER_MARLOWE_MODEL ?? 'qwen3.5:9b';

// The Evergreen voice standard Marlowe holds work to (mirrors Wren's brief).
const VOICE = `Evergreen voice: clear, confident, benefit-led. Substance over hype. ` +
  `No clichés, no buzzwords, no emoji, no exclamation spam. Specific over generic. ` +
  `Talks to a creator who values craft. A headline earns attention with a real idea, not a trick.`;

export interface CritiqueIssue { problem: string; fix: string }
export interface Critique {
  verdict: 'ship' | 'revise';
  onBrand: boolean;
  score: number;            // 0..1, the model's on-voice read
  issues: CritiqueIssue[];
  note: string;
  model: string;
  latencyMs: number;
  error?: string;
}

function parseCritique(raw: string): Omit<Critique, 'model' | 'latencyMs'> {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const issues = Array.isArray(j.issues)
      ? (j.issues as Record<string, unknown>[]).map((x) => ({
          problem: String(x.problem ?? x.issue ?? '').trim(),
          fix: String(x.fix ?? x.suggestion ?? '').trim(),
        })).filter((x) => x.problem).slice(0, 4)
      : [];
    const score = typeof j.score === 'number' ? Math.max(0, Math.min(1, j.score as number)) : (j.onBrand ? 0.7 : 0.4);
    const verdict = (j.verdict === 'ship' || j.verdict === 'revise') ? j.verdict
      : (issues.length === 0 ? 'ship' : 'revise');
    return {
      verdict: verdict as 'ship' | 'revise',
      onBrand: typeof j.onBrand === 'boolean' ? j.onBrand : verdict === 'ship',
      score, issues, note: String(j.note ?? '').trim(),
    };
  } catch {
    return { verdict: 'revise', onBrand: false, score: 0, issues: [], note: '' };
  }
}

/** Red-team a piece of copy. Grounded in Evergreen voice + Tyler's taste. Never throws. */
export async function critique(content: string, label = 'this copy'): Promise<Critique> {
  const t0 = Date.now();
  const base: Critique = { verdict: 'revise', onBrand: false, score: 0, issues: [], note: '', model: MARLOWE_MODEL, latencyMs: 0 };
  try {
    const taste = await recallTasteForPrompt('wren_option');
    const system =
      `You are Marlowe, an exacting brand editor. Critique the supplied copy against the brand voice. ` +
      `Be honest and specific — name concrete problems and concrete fixes, never vague praise. ` +
      `${VOICE}${taste}\n\n` +
      `Return ONLY a JSON object: {"verdict":"ship"|"revise","onBrand":true|false,"score":0..1,` +
      `"issues":[{"problem":"...","fix":"..."}],"note":"one-line overall read"}. ` +
      `"ship" only if it is genuinely on-voice with no material issues. 2-3 issues max, the ones that matter.`;
    const user = `Critique ${label}:\n\n${content}\n\nReturn the JSON object only.`;
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MARLOWE_MODEL, stream: false, keep_alive: '10m',
        options: { temperature: 0.4 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) return { ...base, latencyMs: Date.now() - t0, error: `OLLAMA_HTTP_${res.status}` };
    const j = (await res.json()) as { message?: { content?: string } };
    const parsed = parseCritique(j.message?.content ?? '');
    return { ...parsed, model: MARLOWE_MODEL, latencyMs: Date.now() - t0,
      error: parsed.note || parsed.issues.length ? undefined : 'NO_CRITIQUE_PARSED' };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : 'MARLOWE_FAILED' };
  }
}

export interface ReviewResult { ok: boolean; subject: string; decisionTaskId: string | null; critique: Critique | null; error?: string }

/** Auto-review Wren's most recent option set (or a specific decision task). Logs the read. */
export async function reviewLatestWren(decisionTaskId?: string): Promise<ReviewResult> {
  const rows = (await sql`
    select id, spec, dossier_id from atelier_task
     where workspace_id = ${ATELIER_WS} and kind = 'decision'
       and ${decisionTaskId ? sql`id = ${decisionTaskId}` : sql`spec->>'agent' = 'wren'`}
     order by created_at desc limit 1
  `) as unknown as { id: string; spec: Record<string, unknown>; dossier_id: string | null }[];
  if (!rows[0]) return { ok: false, subject: '', decisionTaskId: null, critique: null, error: 'NO_WREN_DECISION' };

  const spec = rows[0].spec ?? {};
  const question = (spec.question as string) ?? 'the options';
  const options = (spec.options as { key: string; label: string }[]) ?? [];
  if (!options.length) return { ok: false, subject: question, decisionTaskId: rows[0].id, critique: null, error: 'NO_OPTIONS' };

  const content = `Question: ${question}\nOptions:\n` + options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  const c = await critique(content, `these ${options.length} headline options`);

  // Log Marlowe's read to the project so it shows in the log and Dewey can recall it.
  if (rows[0].dossier_id) {
    const body = `Marlowe's read (${c.verdict}): ${c.note || (c.issues[0]?.problem ?? 'reviewed')}`;
    await sql`
      insert into atelier_dossier_entry (workspace_id, dossier_id, task_id, employee_slug, entry_type, body, payload)
      values (${ATELIER_WS}, ${rows[0].dossier_id}, ${rows[0].id}, 'marlowe', 'note',
              ${body}, ${sql.json({ agent: 'marlowe', verdict: c.verdict, score: c.score, issues: c.issues } as never)})`;
  }
  return { ok: true, subject: question, decisionTaskId: rows[0].id, critique: c };
}

export function formatCritique(c: Critique, subject = 'this'): string {
  if (c.error && !c.issues.length && !c.note) return `I couldn't get a clean read on ${subject} (${c.error}).`;
  const head = `${c.verdict === 'ship' ? '✅ Ship' : '✏️ Revise'} — ${subject}${c.note ? `: ${c.note}` : ''} (on-voice ${(c.score * 100).toFixed(0)}%)`;
  const lines = c.issues.map((it) => `  • ${it.problem}\n    → ${it.fix}`);
  return c.issues.length ? [head, ...lines].join('\n') : head;
}
