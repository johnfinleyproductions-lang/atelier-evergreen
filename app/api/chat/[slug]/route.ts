import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { agentChat, getThread, getThreadAfter } from '@/lib/agents/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const Input = z.object({ message: z.string().min(1), thread: z.string().optional() });

// The polling feed: messages newer than ?after=<ISO> (or the latest 40 without
// it). This is what makes background-job report-backs appear live in the UI.
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const thread = req.nextUrl.searchParams.get('thread') ?? 'default';
  const after = req.nextUrl.searchParams.get('after');
  if (after && Number.isNaN(Date.parse(after))) {
    return NextResponse.json({ error: 'INVALID_AFTER' }, { status: 400 });
  }
  const messages = after ? await getThreadAfter(slug, thread, after) : await getThread(slug, thread, 40);
  return NextResponse.json({ messages });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const r = await agentChat(slug, p.data.message, p.data.thread ?? 'default');
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
