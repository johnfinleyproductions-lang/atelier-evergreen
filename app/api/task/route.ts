import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { CreateTaskInputSchema, MoveTaskInputSchema } from '@/lib/contracts';
import { createTask, moveTask } from '@/lib/atelier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/task -> createTask(body)
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const parsed = CreateTaskInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const task = await createTask(parsed.data);
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error('[POST /api/task] createTask failed:', err);
    return NextResponse.json({ error: 'CREATE_FAILED' }, { status: 500 });
  }
}

// PATCH /api/task -> moveTask(taskId, toState)
// THE PROOF GATE: moving to 'review' without a passing proof is rejected 422.
export async function PATCH(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 });
  }

  const parsed = MoveTaskInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_INPUT', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { taskId, toState } = parsed.data;

  try {
    const task = await moveTask(taskId, toState);
    return NextResponse.json({ task }, { status: 200 });
  } catch (err) {
    // The proof gate surfaces as an error whose code/message is 'PROOF_REQUIRED'.
    const code =
      err instanceof Error
        ? (err as Error & { code?: string }).code ?? err.message
        : String(err);

    if (code === 'PROOF_REQUIRED') {
      return NextResponse.json({ error: 'PROOF_REQUIRED' }, { status: 422 });
    }
    if (code === 'TASK_NOT_FOUND') {
      return NextResponse.json({ error: 'TASK_NOT_FOUND' }, { status: 404 });
    }
    if (code === 'ILLEGAL_TRANSITION') {
      return NextResponse.json({ error: 'ILLEGAL_TRANSITION' }, { status: 409 });
    }

    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', issues: err.flatten() },
        { status: 400 },
      );
    }

    console.error('[PATCH /api/task] moveTask failed:', err);
    return NextResponse.json({ error: 'MOVE_FAILED' }, { status: 500 });
  }
}
