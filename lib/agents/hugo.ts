// lib/agents/hugo.ts
//
// Hugo — the Build Engineer. The second REAL agent: he calls a local CODER model
// (qwen2.5-coder:14b on Framerstation) to ACTUALLY WRITE the code for a task,
// then the Visual-QA gate proves the result is on-brand before it can advance.
// A real coding model writes the code; the deterministic proof is what gates it.
//
// (The OpenCode → qwen3-coder-next path is also wired and proven for *editing*
// existing files — the re-skin — but a from-scratch build is faster and more
// reliable through a direct coder-model call that fits fully in VRAM.)

import { sql } from '../db';
import { ATELIER_WS, createTask, attachProof, moveTask } from '../atelier';
import { getStyleCard, getDefaultBrandRubric } from '../style-repo';
import { resolveSpec } from '../merge-ledger';
import { renderAndScore } from '../visual-qa';

const OLLAMA_URL = process.env.ATELIER_OLLAMA_URL ?? 'http://192.168.4.176:11434';
const HUGO_MODEL = process.env.ATELIER_HUGO_MODEL ?? 'qwen2.5-coder:14b';

// Heavy tier: the vidbox 80B coder (qwen3-coder-next) behind the M90t auto-swap
// proxy (OpenAI-compatible, NOT Ollama). It evicts ComfyUI + cold-loads ~27GB on
// first request, so it's slow to start and reserved for builds bigger than a card.
const HUGO_HEAVY_URL = process.env.ATELIER_HUGO_HEAVY_URL ?? 'http://127.0.0.1:8092/v1';
const HUGO_HEAVY_MODEL = process.env.ATELIER_HUGO_HEAVY_MODEL ?? 'qwen3-coder-next-UD-Q2_K_XL';

/** Call the coder model. Light tier = Ollama on Framerstation; heavy = vidbox OpenAI-compat. */
async function callCoder(heavy: boolean, system: string, user: string): Promise<{ ok: boolean; content: string; status: number }> {
  if (heavy) {
    const res = await fetch(`${HUGO_HEAVY_URL}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: HUGO_HEAVY_MODEL, stream: false, temperature: 0.3,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(300_000), // cold start (ComfyUI swap + 27GB load) + slow gen
    });
    if (!res.ok) return { ok: false, content: '', status: res.status };
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return { ok: true, content: j.choices?.[0]?.message?.content ?? '', status: 200 };
  }
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: HUGO_MODEL, stream: false, options: { temperature: 0.3 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { ok: false, content: '', status: res.status };
  const j = (await res.json()) as { message?: { content?: string } };
  return { ok: true, content: j.message?.content ?? '', status: 200 };
}

export interface HugoBuildResult {
  ok: boolean;
  taskId: string | null;
  proofPass: boolean;
  matchScore: number;
  paletteDeltaE: number | null;
  screenshotRef: string | null;
  htmlBytes: number;
  model: string;
  latencyMs: number;
  reachedReview: boolean;
  error?: string;
}

function extractHtml(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/<!doctype|<html/i);
  if (start > 0) s = s.slice(start);
  return s.trim();
}

/**
 * Hugo writes a real on-brand landing card with a local coder model, then the
 * Visual-QA gate proves it (render + palette ΔE). On pass it advances through
 * the proof gate to review. Returns a typed result; never throws.
 */
export async function hugoBuild(slug: string, brief: string, styleHandle = '@warm-editorial', heavy = false): Promise<HugoBuildResult> {
  const t0 = Date.now();
  const model = heavy ? HUGO_HEAVY_MODEL : HUGO_MODEL;
  const base: HugoBuildResult = {
    ok: false, taskId: null, proofPass: false, matchScore: 0, paletteDeltaE: null,
    screenshotRef: null, htmlBytes: 0, model, latencyMs: 0, reachedReview: false,
  };
  try {
    // Resolve the brand-locked colors (so we can prove on-brand afterward).
    const card = await getStyleCard(styleHandle);
    const rubric = await getDefaultBrandRubric();
    let colors = { teal: '#0d9488', gold: '#c79320', page: '#f5f3ec', ink: '#15201c' };
    if (card) {
      const c = (resolveSpec(card as never, rubric as never).resolvedSpec.colors ?? {}) as Record<string, string>;
      colors = { teal: c.teal ?? colors.teal, gold: c.gold ?? colors.gold, page: c.page ?? colors.page, ink: c.ink ?? colors.ink };
    }

    // Hugo writes the code (a real coder model).
    const system =
      `You are Hugo, a senior front-end engineer. You write clean, semantic, single-file HTML with inline styles only — no external resources, no JavaScript, no frameworks, no markdown commentary. You follow brand specs EXACTLY.`;
    const user =
      `Build a complete single-file HTML landing card for: "${brief}".\n` +
      `Use ONLY these exact colors:\n` +
      `- headline + links: teal ${colors.teal}\n- accent rule + CTA button background: gold ${colors.gold}\n` +
      `- page background: ${colors.page}\n- body text: ink ${colors.ink}\n` +
      `Include: a short <h1>, one paragraph, and one <a> CTA button. Generous spacing, a serif headline.\n` +
      `Output ONLY the HTML document, starting with <!doctype html>.`;

    const call = await callCoder(heavy, system, user);
    if (!call.ok) return { ...base, latencyMs: Date.now() - t0, error: `CODER_HTTP_${call.status}` };
    const html = extractHtml(call.content);
    if (!/<html|<!doctype|<body/i.test(html)) return { ...base, latencyMs: Date.now() - t0, error: 'NO_VALID_HTML' };

    // Prove it: render + palette ΔE vs the brand colors.
    const qc = await renderAndScore({ html, resolvedSpec: { colors } as never, assertions: ['h1', 'a'] });

    // Open Hugo's task, attach the proof, advance through the gate.
    const task = await createTask({ title: `Build: ${brief}`.slice(0, 80), intent: brief, kind: 'build', assigneeSlug: 'hugo' });
    await moveTask(task.id, 'scoped');
    await moveTask(task.id, 'active');
    await attachProof({
      taskId: task.id,
      employeeSlug: 'hugo',
      kind: 'render_qc',
      status: qc.pass ? 'pass' : 'fail',
      score: qc.matchScore,
      threshold: 0.6,
      detail: { agent: 'hugo', model, paletteDeltaE: qc.breakdown.paletteDeltaE?.max ?? null, screenshotRef: qc.screenshotRef, htmlBytes: html.length },
    });

    let reachedReview = false;
    if (qc.pass) {
      const ft = await moveTask(task.id, 'review');
      reachedReview = ft.state === 'review';
    }

    const dRows = (await sql`select id from atelier_dossier where workspace_id=${ATELIER_WS} and slug=${slug} limit 1`) as unknown as Record<string, unknown>[];
    if (dRows[0]) {
      await sql`
        insert into atelier_dossier_entry (workspace_id, dossier_id, task_id, employee_slug, entry_type, body, payload)
        values (${ATELIER_WS}, ${dRows[0].id as string}, ${task.id}, 'hugo', 'asset',
                ${`Wrote ${html.length}b of HTML with ${model} — render-QC ${qc.pass ? 'passed' : 'failed'} (${qc.matchScore})`},
                ${sql.json({ agent: 'hugo', screenshotRef: qc.screenshotRef } as never)})`;
    }

    return {
      ok: true, taskId: task.id, proofPass: qc.pass, matchScore: qc.matchScore,
      paletteDeltaE: qc.breakdown.paletteDeltaE?.max ?? null, screenshotRef: qc.screenshotRef,
      htmlBytes: html.length, model, latencyMs: Date.now() - t0, reachedReview,
    };
  } catch (err) {
    return { ...base, latencyMs: Date.now() - t0, error: err instanceof Error ? err.message : 'HUGO_BUILD_FAILED' };
  }
}
