import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enqueueHugoBuild } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Input = z.object({ slug: z.string().min(1), brief: z.string().optional() });

// Enqueue a Hugo build and return immediately. The coder-model build + Visual-QA
// gate (~30–90s) runs in the background; the client polls /api/job/[id].
export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });
  const brief = p.data.brief?.trim() || 'Build Your AI Partner — a course on local-first personal AI';
  const jobId = await enqueueHugoBuild(p.data.slug, brief);
  return NextResponse.json({ ok: true, jobId }, { status: 202 });
}
