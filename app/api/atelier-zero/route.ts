import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { runAtelierZero } from '@/lib/atelier-zero';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InputSchema = z.object({
  styleHandle: z.string().min(1),
  brief: z.string().min(1),
  cta: z.string().optional(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const parsed = InputSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT', issues: parsed.error.flatten() }, { status: 400 });
  const result = await runAtelierZero(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
