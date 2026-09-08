// lib/campfire.ts
//
// The Campfire half of the bridge layer (the Slack bridge stays — both run).
// Campfire is the self-hosted chat on M90t :3050; agents post report-backs into
// rooms through its bot API, and @mentions come back via the webhook route
// (app/api/campfire/webhook). Everything here is BEST-EFFORT and env-gated:
// until CAMPFIRE_BOT_KEY + room ids are set, every call is a silent no-op, so
// the bridge ships before the bot exists and lights up when the env lands.
//
// Bot API (from basecamp/once-campfire source):
//   POST {CAMPFIRE_URL}/rooms/{roomId}/{botKey}/messages  body = plain text

const CAMPFIRE_URL = (process.env.CAMPFIRE_URL ?? '').replace(/\/$/, '');
const BOT_KEY = process.env.CAMPFIRE_BOT_KEY ?? '';

// Room map: which room each agent's report-backs land in — and, inverted,
// which agent a room "belongs to" (their room auto-addresses them, no prefix).
// CAMPFIRE_ROOM_MAP is a JSON object {"wren":"5",...}; the three legacy vars
// cover cleo/piper/otto's original rooms and act as fallbacks.
const ROOM_FLOOR = process.env.CAMPFIRE_ROOM_FLOOR ?? '';
const ROOM_SUPPORT = process.env.CAMPFIRE_ROOM_SUPPORT_DESK ?? '';
const ROOM_SUBSTRATE = process.env.CAMPFIRE_ROOM_SUBSTRATE ?? '';

function parseRoomMap(): Record<string, string> {
  try {
    const j = JSON.parse(process.env.CAMPFIRE_ROOM_MAP ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}
const ROOM_MAP: Record<string, string> = {
  ...(ROOM_FLOOR ? { cleo: ROOM_FLOOR } : {}),
  ...(ROOM_SUPPORT ? { piper: ROOM_SUPPORT } : {}),
  ...(ROOM_SUBSTRATE ? { otto: ROOM_SUBSTRATE } : {}),
  ...parseRoomMap(),
};

export function campfireConfigured(): boolean {
  return Boolean(CAMPFIRE_URL && BOT_KEY);
}

/** The room an agent's messages belong in (falls back to #floor). */
export function roomFor(slug: string): string {
  return ROOM_MAP[slug] || ROOM_FLOOR;
}

/** The agent a room belongs to, if it's an agent room (cleo's = the floor, so
 *  it stays general routing rather than forcing every floor message to her). */
export function agentForRoom(roomId: string): string | null {
  for (const [slug, id] of Object.entries(ROOM_MAP)) {
    if (id === roomId && slug !== 'cleo') return slug;
  }
  return null;
}

/** Post as the bot into a room. Best-effort: failures are swallowed (the
 *  atelier thread remains the source of truth; Campfire is a mirror). */
export async function campfirePost(roomId: string, text: string): Promise<boolean> {
  if (!campfireConfigured() || !roomId || !text.trim()) return false;
  try {
    const res = await fetch(`${CAMPFIRE_URL}/rooms/${roomId}/${BOT_KEY}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: text.slice(0, 8000),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Mirror an agent's thread message into their Campfire room, prefixed so a
 *  multi-agent room reads like a floor, not a single anonymous bot. */
export async function campfireMirror(slug: string, text: string): Promise<void> {
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);
  await campfirePost(roomFor(slug), `[${name}] ${text}`);
}
