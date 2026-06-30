import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { hugoBuild } from '@/lib/agents/hugo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180; // coder model build can take ~90s cold

const Input = z.object({ slug: z.string().min(1), brief: z.string().optional() });

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const brief = p.data.brief?.trim() || 'Build Your AI Partner — a course on local-first personal AI';
  const r = await hugoBuild(p.data.slug, brief);
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
