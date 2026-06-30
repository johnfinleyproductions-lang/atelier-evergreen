import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveDecision } from '@/lib/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Input = z.object({ taskId: z.string().uuid(), optionKey: z.string().min(1) });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT', issues: p.error.flatten() }, { status: 400 });
  const r = await resolveDecision(p.data.taskId, p.data.optionKey);
  return NextResponse.json(r, { status: r.ok ? 200 : 404 });
}
