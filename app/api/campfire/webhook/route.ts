import { NextResponse, type NextRequest } from 'next/server';
import { agentChat } from '@/lib/agents/chat';
import { campfirePost, agentForRoom } from '@/lib/campfire';
import { safeEqual } from '@/lib/gate-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Campfire → Atelier. When the bot is @mentioned in a room, Campfire POSTs
// {user, room, message} here (7s delivery timeout, text response = instant
// reply). Routing matches the Slack bridge: "wren: ..." addresses an agent,
// anything else goes to Cleo.
//
// The global middleware allowlists this path; auth is the per-route token
// (?token=CAMPFIRE_WEBHOOK_TOKEN, constant-time compared) — Campfire can't
// send custom headers.
//
// Fast tool replies return inline (instant in the room). Slow model replies
// would trip Campfire's 7s timeout, so past ~5.5s we return 200 empty and the
// reply posts via the bot API when it lands — same async pattern as the jobs.

const WEBHOOK_TOKEN = process.env.CAMPFIRE_WEBHOOK_TOKEN ?? '';
const AGENTS = ['cleo', 'wren', 'hugo', 'iris', 'vera', 'lena', 'remy', 'marlowe', 'dewey', 'otto', 'piper'];

interface CampfirePayload {
  user?: { id?: number; name?: string };
  room?: { id?: number; name?: string };
  message?: { body?: { plain?: string } };
}

// Addressing, in priority order: an explicit "wren: ..." prefix wins anywhere;
// otherwise an agent's own room addresses that agent (no prefix to remember —
// the room IS the agent); otherwise Cleo routes.
function resolveAgent(text: string, roomId: string): { slug: string; msg: string } {
  const m = text.trim().toLowerCase().match(/^@?([a-z]+)\s*[,:]\s*/);
  if (m && AGENTS.includes(m[1])) return { slug: m[1], msg: text.trim().slice(m[0].length).trim() };
  const roomAgent = agentForRoom(roomId);
  if (roomAgent) return { slug: roomAgent, msg: text.trim() };
  return { slug: 'cleo', msg: text.trim() };
}

export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (!WEBHOOK_TOKEN || !token || !safeEqual(token, WEBHOOK_TOKEN)) {
    return new NextResponse('unauthorized', { status: 401 });
  }

  let payload: CampfirePayload;
  try { payload = (await req.json()) as CampfirePayload; } catch { return new NextResponse('bad payload', { status: 400 }); }
  const text = payload.message?.body?.plain ?? '';
  const roomId = String(payload.room?.id ?? '');
  if (!text.trim()) return new NextResponse(null, { status: 204 });

  const { slug, msg } = resolveAgent(text, roomId);
  if (!msg) return new NextResponse(`Who do you need? ("wren: 6 headlines for course 19")`, { status: 200 });

  // The Campfire thread is its own conversation lane — one thread per room, so
  // handoff yes/no state in a room doesn't collide with the in-app thread.
  const chat = agentChat(slug, msg, `campfire-${roomId || 'dm'}`);

  const timer = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 5500));
  const first = await Promise.race([chat, timer]);

  if (first !== 'timeout') {
    const r = first;
    const reply = r.ok ? r.reply : `(${slug} couldn't reply: ${r.error ?? 'error'})`;
    return new NextResponse(`[${slug.charAt(0).toUpperCase() + slug.slice(1)}] ${reply}`.slice(0, 8000), {
      status: 200, headers: { 'content-type': 'text/plain' },
    });
  }

  // Too slow for the webhook window — finish in the background and post via
  // the bot API (the persistent server keeps the floating promise alive).
  void chat.then(async (r) => {
    const reply = r.ok ? r.reply : `(${slug} couldn't reply: ${r.error ?? 'error'})`;
    if (roomId) await campfirePost(roomId, `[${slug.charAt(0).toUpperCase() + slug.slice(1)}] ${reply}`);
  }).catch(() => { /* best-effort */ });
  return new NextResponse(null, { status: 204 });
}
