import { NextResponse, type NextRequest } from 'next/server';
import { getLanesState, currentZone, routeModel, type WorkKind } from '@/lib/lanes';
import { runDueDeferredJobs, listRecentJobs } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/lanes            → live lane state + active zone + deferred jobs
// GET /api/lanes?kind=batch-heavy&model=...&sizeMB=...  → + routing advice
// GET /api/lanes?tick=1     → also run any due deferred jobs now (manual ticker)
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.get('tick') === '1') {
    const r = await runDueDeferredJobs();
    return NextResponse.json({ ok: true, ticked: r });
  }
  const lanes = await getLanesState();
  const zone = currentZone();
  const recent = await listRecentJobs(40);
  const deferred = recent.filter((j) => j.status === 'deferred')
    .map((j) => ({ id: j.id, kind: j.kind, runAfter: j.runAfter }));
  const kind = sp.get('kind') as WorkKind | null;
  let advice = null;
  if (kind) {
    advice = await routeModel({ kind, model: sp.get('model') ?? undefined, sizeMB: Number(sp.get('sizeMB') ?? '0') || 0 });
  }
  return NextResponse.json({ ok: true, zone, lanes, deferred, advice });
}
