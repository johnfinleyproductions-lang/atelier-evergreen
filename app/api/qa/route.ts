import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { attachProof, ATELIER_WS, type Task } from '@/lib/atelier';
import type { ProofStatus } from '@/lib/contracts';
import { renderAndScore } from '@/lib/visual-qa';

// postgres-js (and Playwright, under renderAndScore) need the Node runtime;
// never run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/qa  — THE VISUAL-QA GATE
 *
 * Body: { taskId, html? | url?, styleCardHandle?, assertions?, employeeSlug? }
 *
 * Renders the artifact (raw HTML or a URL) headless via Playwright, screenshots
 * it, and scores it against a style card's resolved spec:
 *   - palette ΔE  — deterministic, GATES the pass
 *   - DOM assertions — boolean checks against the rendered DOM
 *   - VL aesthetic — ADVISORY only (can fail, never passes alone)
 *
 * The scoring lives in lib/visual-qa's renderAndScore(...), which returns a
 * render_qc blob { proof_kind:'render_qc', pass, match_score,
 * breakdown:{ palette_deltaE, assertions{} }, screenshot_ref }. This route is
 * the thin HTTP edge: it validates, calls renderAndScore, then records the
 * verdict as an atelier_proof of kind 'render_qc' via attachProof (which
 * auto-advances active -> proofed on a pass and updates proof_status).
 *
 * The proof gate is sacred: this route never forces a pass — it trusts the
 * deterministic verdict in result.pass.
 *
 * Returns { proof, task }.
 */

/* ------------------------------------------------------------------ */
/* Request contract (local to this route — no shared QA contract yet). */
/* ------------------------------------------------------------------ */

const QaInputSchema = z
  .object({
    taskId: z.string().uuid(),
    html: z.string().min(1).optional(),
    url: z.string().url().optional(),
    styleCardHandle: z.string().min(1).optional(),
    // DOM assertions are passed through to renderAndScore untouched.
    assertions: z.array(z.string()).optional(),
    // Defaults to 'remy' — the render-QC checker — but may be overridden.
    employeeSlug: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.html) || Boolean(v.url), {
    message: 'Provide an artifact to render: either `html` or `url`.',
    path: ['html'],
  });

/* ------------------------------------------------------------------ */
/* Small helpers.                                                      */
/* ------------------------------------------------------------------ */

type Row = Record<string, any>;

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

// Mirrors lib/atelier's (unexported) mapTask so the JSON we return matches the
// camelCase Task shape the rest of the API speaks.
function mapTaskRow(r: Row): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    dossierId: r.dossier_id ?? null,
    assigneeSlug: r.assignee_employee_slug ?? null,
    title: r.title,
    intent: r.intent ?? null,
    state: r.state as Task['state'],
    station: r.station ?? null,
    kind: r.kind ?? null,
    spec: r.spec && typeof r.spec === 'object' ? (r.spec as Record<string, unknown>) : {},
    proofStatus: (r.proof_status ?? 'pending') as Task['proofStatus'],
    latestProofId: r.latest_proof_id ?? null,
    createdAt: r.created_at,
    shippedAt: r.shipped_at ?? null,
  };
}

async function getTaskById(taskId: string): Promise<Task | null> {
  const rows = (await sql`
    select * from atelier_task
     where id = ${taskId} and workspace_id = ${ATELIER_WS}
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapTaskRow(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* POST                                                                */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = QaInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { taskId, html, url, styleCardHandle, assertions, employeeSlug } =
    parsed.data;

  try {
    // (1) The proof must target a real task (and skip the render if not).
    const existing = await getTaskById(taskId);
    if (!existing) {
      return NextResponse.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
    }

    // (2) Render headless + score against the style card's resolved spec.
    //     renderAndScore owns Playwright, palette ΔE (the deterministic gate),
    //     the DOM assertions, and the advisory VL aesthetic pass.
    const result = await renderAndScore({
      html: html ?? undefined,
      url: url ?? undefined,
      styleCardHandle: styleCardHandle ?? undefined,
      assertions: assertions ?? [],
    });

    // (3) Read the verdict defensively (tolerate camel/snake field names).
    const blob = result as unknown as Record<string, any>;
    const pass = Boolean(blob.pass);
    const status: ProofStatus = pass ? 'pass' : 'fail';
    const score = num(blob.matchScore ?? blob.match_score);
    const threshold = num(blob.threshold);

    // (4) Record the render_qc proof. attachProof updates proof_status and, on
    //     a pass, auto-advances a still-active task to 'proofed'. The full
    //     render_qc blob (palette_deltaE, assertions{}, screenshot_ref, ...) is
    //     preserved verbatim as the proof detail.
    const proof = await attachProof({
      taskId,
      employeeSlug: employeeSlug ?? 'remy',
      kind: 'render_qc',
      status,
      score: score ?? undefined,
      threshold: threshold ?? undefined,
      detail: result as unknown as Record<string, unknown>,
    });

    // (5) Re-read the task so the response reflects any auto-advance + the new
    //     proof_status / latest_proof_id.
    const task = (await getTaskById(taskId)) ?? existing;

    return NextResponse.json({ proof, task }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const code =
      err instanceof Error
        ? ((err as Error & { code?: string }).code ?? err.message)
        : String(err);

    if (code === 'TASK_NOT_FOUND') {
      return NextResponse.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
    }
    if (code === 'STYLE_CARD_NOT_FOUND') {
      return NextResponse.json({ error: 'STYLE_CARD_NOT_FOUND' }, { status: 404 });
    }

    console.error('[POST /api/qa] renderAndScore/attachProof failed:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
