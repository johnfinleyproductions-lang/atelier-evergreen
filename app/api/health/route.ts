import { NextResponse, type NextRequest } from 'next/server';
import { systemHealth } from '@/lib/agents/otto';
import { isAuthorized, GATE_SECRET, AUTH_DISABLED } from '@/lib/gate-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Otto's live substrate health. The route is public (deploy probes + uptime
// checks need it), but the detailed service/model/queue breakdown is only
// returned to authorized callers — anonymous LAN traffic gets booleans.
export async function GET(req: NextRequest) {
  const h = await systemHealth();
  const allUp =
    h.db.up && h.ollama.up &&
    h.services.every((s) => s.state !== 'inactive');
  if (isAuthorized(req)) {
    return NextResponse.json({ ok: true, allUp, health: h });
  }
  return NextResponse.json({ ok: true, allUp, authConfigured: !!GATE_SECRET && !AUTH_DISABLED });
}
