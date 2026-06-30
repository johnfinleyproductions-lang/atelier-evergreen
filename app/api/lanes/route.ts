import { NextResponse, type NextRequest } from 'next/server';
import { getLanesState, currentZone, routeModel, type WorkKind } from '@/lib/lanes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/lanes            → live lane state + active zone
// GET /api/lanes?kind=batch-heavy&model=qwen3.5:27b&sizeMB=17000 → + routing advice
export async function GET(req: NextRequest) {
  const lanes = await getLanesState();
  const zone = currentZone();
  const kind = req.nextUrl.searchParams.get('kind') as WorkKind | null;
  let advice = null;
  if (kind) {
    const model = req.nextUrl.searchParams.get('model') ?? undefined;
    const sizeMB = Number(req.nextUrl.searchParams.get('sizeMB') ?? '0') || 0;
    advice = await routeModel({ kind, model, sizeMB });
  }
  return NextResponse.json({ ok: true, zone, lanes, advice });
}
