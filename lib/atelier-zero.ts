// lib/atelier-zero.ts
//
// Atelier Zero — the v1 differentiator, the whole loop in one orchestration:
//
//   reference + "build in @style"  →  Iris resolves the merge ledger (brand-lock
//   wins colors, style wins layout)  →  Hugo builds an on-brand HTML landing card
//   from the resolved spec  →  the Visual-QA gate renders + scores it against the
//   brand colors  →  on PASS the card carries a real render_qc proof through the
//   proof gate to REVIEW. No card reaches Tyler unproven.
//
// Hugo's "build" here is a deterministic spec→HTML assembly (honest: he composes
// per the resolved spec, he doesn't invent). The proof is what matters — the
// gate verifies the output is genuinely on-brand, not that an agent claimed so.

import { createTask, attachProof, moveTask, type Task } from './atelier';
import { getStyleCard, getDefaultBrandRubric, recordInjection } from './style-repo';
import { resolveSpec, type ResolvedSpec } from './merge-ledger';
import { renderAndScore } from './visual-qa';

export interface AtelierZeroInput {
  /** The @handle of the style card to build in (e.g. "@warm-editorial"). */
  styleHandle: string;
  /** What the card is for (headline/subject). */
  brief: string;
  /** Optional CTA label. */
  cta?: string;
}

export interface AtelierZeroResult {
  ok: boolean;
  task: Task | null;
  styleHandle: string;
  resolvedColors: Record<string, string>;
  proof: {
    kind: 'render_qc';
    pass: boolean;
    matchScore: number;
    paletteDeltaE: number | null;
    screenshotRef: string | null;
  } | null;
  html: string | null;
  reachedReview: boolean;
  error?: string;
}

function colorsOf(spec: ResolvedSpec): Record<string, string> {
  const c = (spec.colors ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Hugo: assemble an on-brand landing card from the resolved spec. */
function buildLandingCard(brief: string, cta: string, colors: Record<string, string>): string {
  const teal = colors.teal ?? '#0d9488';
  const gold = colors.gold ?? '#c79320';
  const page = colors.page ?? '#f5f3ec';
  const ink = colors.ink ?? '#15201c';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:${page};color:${ink};font-family:Georgia,'Times New Roman',serif">
  <main style="max-width:760px;margin:0 auto;padding:80px 48px">
    <div style="height:3px;width:64px;background:${gold};margin-bottom:28px"></div>
    <h1 style="color:${teal};font-size:52px;line-height:1.1;margin:0 0 18px;letter-spacing:-0.5px">${brief}</h1>
    <p style="font-size:20px;line-height:1.6;color:${ink};max-width:48ch;margin:0 0 40px">
      A focused, on-brand landing built and brand-checked by your studio — proof attached, no card ships unverified.</p>
    <a href="#" style="display:inline-block;background:${gold};color:#fff;text-decoration:none;font-size:19px;font-weight:600;padding:18px 40px;border-radius:10px">${cta}</a>
  </main>
</body></html>`;
}

/** Run the full Atelier Zero loop. Never throws — returns a typed result. */
export async function runAtelierZero(input: AtelierZeroInput): Promise<AtelierZeroResult> {
  const styleHandle = input.styleHandle.startsWith('@') ? input.styleHandle : `@${input.styleHandle}`;
  const base: AtelierZeroResult = {
    ok: false, task: null, styleHandle, resolvedColors: {}, proof: null, html: null, reachedReview: false,
  };
  try {
    // 1. Iris resolves the merge ledger (brand-lock colors + style layout).
    const card = await getStyleCard(styleHandle);
    if (!card) return { ...base, error: 'STYLE_CARD_NOT_FOUND' };
    const rubric = await getDefaultBrandRubric();
    const { ledger, resolvedSpec, conflicts } = resolveSpec(card as never, rubric as never);
    const colors = colorsOf(resolvedSpec);

    // 2. Open the task (Hugo builds it) + record the style injection (audit).
    const task = await createTask({
      title: input.brief,
      intent: `Build a landing card in ${styleHandle}`,
      kind: 'build',
      assigneeSlug: 'hugo',
    });
    await recordInjection({
      taskId: task.id,
      styleCardId: (card as { id: string }).id,
      brandRubricId: (rubric as { id?: string } | null)?.id ?? null,
      ledger,
      resolvedSpec: resolvedSpec as unknown as Record<string, unknown>,
      conflicts,
    });

    // 3. Walk Hugo's task captured -> scoped -> active.
    await moveTask(task.id, 'scoped');
    await moveTask(task.id, 'active');

    // 4. Hugo assembles the on-brand HTML from the resolved spec.
    const html = buildLandingCard(input.brief, input.cta ?? 'Enroll Now', colors);

    // 5. The Visual-QA gate proves it: render + palette ΔE vs the brand-lock colors.
    const qc = await renderAndScore({ html, resolvedSpec, assertions: ['h1', 'a'] });
    const proofStatus = qc.pass ? 'pass' : 'fail';
    await attachProof({
      taskId: task.id,
      employeeSlug: 'remy', // the eyes
      kind: 'render_qc',
      status: proofStatus,
      score: qc.matchScore,
      threshold: 0.6,
      detail: {
        gate: 'atelier-zero',
        styleHandle,
        paletteDeltaE: qc.breakdown.paletteDeltaE?.max ?? null,
        screenshotRef: qc.screenshotRef,
        conflicts,
      },
    });

    // 6. The proof gate: only a passing proof lets the card reach review.
    let reachedReview = false;
    let finalTask = task;
    if (qc.pass) {
      finalTask = await moveTask(task.id, 'review'); // gate verifies the pass proof exists
      reachedReview = finalTask.state === 'review';
    }

    return {
      ok: true,
      task: finalTask,
      styleHandle,
      resolvedColors: colors,
      proof: {
        kind: 'render_qc',
        pass: qc.pass,
        matchScore: qc.matchScore,
        paletteDeltaE: qc.breakdown.paletteDeltaE?.max ?? null,
        screenshotRef: qc.screenshotRef,
      },
      html,
      reachedReview,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : 'ATELIER_ZERO_FAILED' };
  }
}
