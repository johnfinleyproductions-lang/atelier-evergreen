import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { wrenWriteHeadlines } from '@/lib/agents/wren';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // Wren's model call can take ~20s

const Input = z.object({ slug: z.string().min(1) });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const r = await wrenWriteHeadlines(p.data.slug);
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
