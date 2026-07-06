import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { ATELIER_WS } from '@/lib/atelier';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// POST /api/voice/speak {slug, text} → audio/wav in the agent's own voice.
// The local Voice Pack: VoxStation XTTS on the LAN does the synthesis; each
// employee's voice comes from atelier_employee.voice_id. Proxied through the
// app so the browser stays same-origin (auth cookie included) and VoxStation
// never needs CORS. Nothing leaves the LAN.
const TTS_URL = process.env.ATELIER_TTS_URL ?? 'http://192.168.4.200:8020/synthesize';
const DEFAULT_VOICE = process.env.ATELIER_TTS_DEFAULT_VOICE ?? 'audiobook_narrator';

const Input = z.object({ slug: z.string().min(1), text: z.string().min(1).max(4000) });

/** Strip the things that sound terrible spoken: URLs, markdown furniture, job ids. */
function speakable(text: string, max = 700): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/[*_#>]+/g, ' ')
    .replace(/·\s*job\s+\w+/gi, '')
    .replace(/[│├└─═]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: 'INVALID_JSON' }, { status: 400 }); }
  const p = Input.safeParse(raw);
  if (!p.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 });

  const rows = (await sql`
    select voice_id from atelier_employee where workspace_id = ${ATELIER_WS} and slug = ${p.data.slug} limit 1
  `) as unknown as { voice_id: string | null }[];
  const voiceId = rows[0]?.voice_id || DEFAULT_VOICE;

  const text = speakable(p.data.text);
  if (!text) return NextResponse.json({ error: 'NOTHING_SPEAKABLE' }, { status: 422 });

  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice_id: voiceId }),
      signal: AbortSignal.timeout(110_000),
    });
    if (!res.ok) return NextResponse.json({ error: `TTS_HTTP_${res.status}` }, { status: 502 });
    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      status: 200,
      headers: { 'content-type': res.headers.get('content-type') ?? 'audio/wav', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'TTS_UNREACHABLE' }, { status: 502 });
  }
}
