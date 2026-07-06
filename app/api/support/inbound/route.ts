import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { enqueueSupportDraft } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Inbound lane for the support desk. Anything can feed it — a Gmail poller, a
// webhook, a cron, or a manual curl — and Piper drafts a gated reply into her
// thread. Auth: the global middleware (cookie or x-atelier-secret) covers this
// route like every other /api path.
const Input = z.object({
  from: z.string().min(3),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20_000),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT', detail: p.error.issues[0]?.message }, { status: 400 });
  const jobId = await enqueueSupportDraft(p.data.from, p.data.subject, p.data.body);
  return NextResponse.json({ ok: true, jobId, note: 'draft will land in Piper\'s thread with the send gate attached' }, { status: 202 });
}
