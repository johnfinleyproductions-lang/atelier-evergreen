import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { wrenChat } from '@/lib/agents/wren-chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const Input = z.object({ message: z.string().min(1), thread: z.string().optional() });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const r = await wrenChat(p.data.message, p.data.thread ?? 'default');
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
