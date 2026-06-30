import { NextResponse, type NextRequest } from 'next/server';
import { getJob } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Poll a background job's status. Returns { ok, job } or 404 if unknown.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ ok: false, error: 'JOB_NOT_FOUND' }, { status: 404 });
  return NextResponse.json({ ok: true, job });
}
