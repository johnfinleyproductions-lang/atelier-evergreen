// lib/agents/wren.ts
//
// Wren — the Copywriter. The first REAL agent in Atelier: she calls a local
// model (qwen3.5:9b on Framerstation Ollama) with a copywriter system prompt
// and returns headline options. This is the model doing the thinking; the
// Hermes "employee shell" (Slack/voice/memory) is a later wrapper around this.
//
// No data leaves the LAN. Override the endpoint/model via env.

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const WREN_MODEL = process.env.ATELIER_WREN_MODEL ?? 'qwen3.5:9b';

const SYSTEM = `You are Wren, a senior direct-response copywriter for Evergreen.
Voice: clear, confident, benefit-led, no hype, no clichés, no emoji. You write
for a creator's audience who values substance. Given a brief, produce sharp,
varied headline options — each a different angle (outcome, curiosity, contrarian,
specificity, identity). Keep each under 9 words. Return ONLY a JSON array of
strings, nothing else.`;

export interface WrenResult {
  ok: boolean;
  headlines: string[];
  model: string;
  latencyMs: number;
  error?: string;
}

/** Strip code fences / prose and parse a JSON array of strings. */
function parseHeadlines(raw: string, want: number): string[] {
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).replace(/^["'\d.\s-]+/, '').trim()).filter(Boolean).slice(0, want);
    }
  } catch {
    /* fall through to line parsing */
  }
  // Fallback: split lines, strip bullets/numbers/quotes.
  return raw
    .split('\n')
    .map((l) => l.replace(/^[\s\-*\d.)"']+/, '').replace(/["']\s*,?\s*$/, '').trim())
    .filter((l) => l.length > 3 && l.length < 80)
    .slice(0, want);
}

/** Generate N headline options for a brief. Real model call; never throws. */
export async function generateHeadlines(brief: string, count = 6): Promise<WrenResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: WREN_MODEL,
        stream: false,
        options: { temperature: 0.8 },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Brief: ${brief}\n\nWrite ${count} headline options. JSON array of strings only.` },
        ],
      }),
    });
    if (!res.ok) {
      return { ok: false, headlines: [], model: WREN_MODEL, latencyMs: Date.now() - t0, error: `OLLAMA_HTTP_${res.status}` };
    }
    const j = (await res.json()) as { message?: { content?: string } };
    const headlines = parseHeadlines(j.message?.content ?? '', count);
    return {
      ok: headlines.length > 0,
      headlines,
      model: WREN_MODEL,
      latencyMs: Date.now() - t0,
      error: headlines.length ? undefined : 'NO_HEADLINES_PARSED',
    };
  } catch (err) {
    return {
      ok: false,
      headlines: [],
      model: WREN_MODEL,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : 'OLLAMA_UNREACHABLE',
    };
  }
}

// ── Wren in the flow: generate headlines → a Decision + an activity entry ──
import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

export interface WrenRunResult {
  ok: boolean;
  headlines: string[];
  decisionTaskId: string | null;
  latencyMs: number;
  error?: string;
}

/**
 * Have Wren write headlines for a project, then turn them into a Decision Needed
 * (pick your headline) and log it to the Dossier. The full loop: a real local
 * model produces options; the human decides. Idempotent-ish (replaces a prior
 * open Wren decision for the same dossier).
 */
export async function wrenWriteHeadlines(slug: string): Promise<WrenRunResult> {
  const dRows = (await sql`
    select id, title, objective from atelier_dossier where workspace_id = ${ATELIER_WS} and slug = ${slug} limit 1
  `) as unknown as Record<string, unknown>[];
  if (!dRows[0]) return { ok: false, headlines: [], decisionTaskId: null, latencyMs: 0, error: 'PROJECT_NOT_FOUND' };
  const did = dRows[0].id as string;
  const brief = `${dRows[0].title}${dRows[0].objective ? ' — ' + dRows[0].objective : ''}`;

  const gen = await generateHeadlines(brief, 6);
  if (!gen.ok) return { ok: false, headlines: [], decisionTaskId: null, latencyMs: gen.latencyMs, error: gen.error };

  // Clear any prior open Wren headline decision for this project.
  await sql`
    delete from atelier_task where workspace_id = ${ATELIER_WS} and dossier_id = ${did}
      and kind = 'decision' and state <> 'shipped' and spec->>'agent' = 'wren'
  `;

  const options = gen.headlines.map((h, i) => ({ key: `h${i + 1}`, label: h, detail: `Option ${i + 1} · ${gen.model}` }));
  const spec = { agent: 'wren', model: gen.model, question: 'Which headline should we lead with?', options };
  const tRows = (await sql`
    insert into atelier_task (workspace_id, dossier_id, assignee_employee_slug, title, kind, state, spec, proof_status)
    values (${ATELIER_WS}, ${did}, 'wren', 'Which headline should we lead with?', 'decision', 'review',
            ${sql.json(spec as never)}, 'pending')
    returning id
  `) as unknown as Record<string, unknown>[];

  await sql`
    insert into atelier_dossier_entry (workspace_id, dossier_id, task_id, employee_slug, entry_type, body, payload)
    values (${ATELIER_WS}, ${did}, ${tRows[0].id as string}, 'wren', 'asset',
            ${`Generated ${gen.headlines.length} headline options (${gen.model})`},
            ${sql.json({ agent: 'wren', latencyMs: gen.latencyMs } as never)})
  `;

  return { ok: true, headlines: gen.headlines, decisionTaskId: tRows[0].id as string, latencyMs: gen.latencyMs };
}
