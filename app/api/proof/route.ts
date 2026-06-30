import { NextResponse, type NextRequest } from 'next/server';
import { AttachProofInputSchema } from '@/lib/contracts';
import { attachProof } from '@/lib/atelier';

// postgres-js needs the Node runtime; never run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/proof
 * Body: AttachProofInput { taskId, employeeSlug, kind, status, score?, threshold?, detail? }
 *
 * Inserts an append-only atelier_proof row, updates the task's
 * proof_status + latest_proof_id, and (when status='pass') auto-advances
 * a task from 'active' -> 'proofed'. Returns the new proof + updated task.
 */
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

  const parsed = AttachProofInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await attachProof(parsed.data);
    // result = { proof, task }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message === 'TASK_NOT_FOUND') {
      return NextResponse.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
    }
    console.error('[POST /api/proof] attachProof failed:', err);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message },
      { status: 500 },
    );
  }
}
