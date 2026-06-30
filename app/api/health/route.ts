import { NextResponse } from 'next/server';
import { systemHealth } from '@/lib/agents/otto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Otto's live substrate health — services, models, voice, queue, DB.
export async function GET() {
  const h = await systemHealth();
  const allUp =
    h.db.up && h.ollama.up &&
    h.services.every((s) => s.state !== 'inactive');
  return NextResponse.json({ ok: true, allUp, health: h });
}
