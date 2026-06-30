import { NextResponse } from 'next/server';
import { getFloor, getEmployee } from '@/lib/atelier';
import type { Floor, NeedsYouItem } from '@/lib/atelier';
import { speak } from '@/lib/whisper-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET  /api/brief            -> { text, counts, standout }
// GET  /api/brief?speak=1    -> { text, counts, standout, audioUrl }
// POST /api/brief            -> { text, counts, standout, audioUrl }
//
// Cleo's morning brief. We read the whole Floor (getFloor) and turn it into a
// single spoken-style paragraph: N tasks need you, M in flight, K shipped, plus
// "the standout" — the one thing Cleo would have you clear first. When asked to
// speak (POST, or GET ?speak), we synthesize it through VoxStation via
// whisper-client.speak and hand back an audioUrl. TTS is best-effort: if the
// voice box is down the text still comes back, audioUrl just stays null.
// ---------------------------------------------------------------------------

const CLEO_SLUG = 'cleo';

export interface BriefCounts {
  needsYou: number;
  inFlight: number;
  shipped: number;
  blocked: number;
}

export interface BriefStandout {
  taskId: string;
  title: string;
  assigneeSlug: string | null;
  reason: string;
}

export interface Brief {
  text: string;
  counts: BriefCounts;
  standout: BriefStandout | null;
}

// whisper-client.speak is owned by a sibling file; reference it through a
// tolerant local signature so this route stays decoupled from its exact return
// shape (string url, { audioUrl }, { url }, data-url, …) and arg list.
type Speak = (
  text: string,
  opts?: { voiceId?: string | null },
) => Promise<unknown>;

function pluralCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The one item Cleo would have you clear first, with a human reason. */
function pickStandout(floor: Floor): BriefStandout | null {
  // 1) Highest-scored review item — proof's in, it's just waiting on you.
  const scored = floor.needsYou
    .filter((n): n is NeedsYouItem & { proof: NonNullable<NeedsYouItem['proof']> } =>
      n.proof !== null && typeof n.proof.score === 'number',
    )
    .sort((a, b) => (b.proof.score ?? 0) - (a.proof.score ?? 0));

  if (scored.length > 0) {
    const top = scored[0];
    const who = top.task.assigneeSlug ?? 'Someone';
    const score = Math.round((top.proof.score ?? 0) * (top.proof.score! <= 1 ? 100 : 1));
    return {
      taskId: top.task.id,
      title: top.task.title,
      assigneeSlug: top.task.assigneeSlug,
      reason: `${who} cleared a ${top.proof.kind} proof at ${score} on "${top.task.title}" — that's the one I'd sign off first.`,
    };
  }

  // 2) Otherwise the longest-waiting review item (needsYou is created_at asc).
  if (floor.needsYou.length > 0) {
    const oldest = floor.needsYou[0];
    return {
      taskId: oldest.task.id,
      title: oldest.task.title,
      assigneeSlug: oldest.task.assigneeSlug,
      reason: `"${oldest.task.title}" has been waiting on your review the longest — start there.`,
    };
  }

  // 3) Nothing waiting on you — celebrate the most recent ship.
  if (floor.shipped.length > 0) {
    const latest = floor.shipped[0];
    return {
      taskId: latest.id,
      title: latest.title,
      assigneeSlug: latest.assigneeSlug,
      reason: `"${latest.title}" just shipped — nothing needs you right now.`,
    };
  }

  // 4) Or the next thing moving through the shop.
  if (floor.inFlight.length > 0) {
    const next = floor.inFlight[0];
    return {
      taskId: next.id,
      title: next.title,
      assigneeSlug: next.assigneeSlug,
      reason: `"${next.title}" is moving through the shop — nothing's blocked.`,
    };
  }

  return null;
}

function buildBrief(floor: Floor, now: Date): Brief {
  const counts: BriefCounts = {
    needsYou: floor.needsYou.length,
    inFlight: floor.inFlight.length,
    shipped: floor.shipped.length,
    blocked: floor.blocked.length,
  };

  const standout = pickStandout(floor);

  const parts: string[] = [];
  parts.push(`${greeting(now)}. Here's your floor.`);

  if (counts.needsYou === 0 && counts.inFlight === 0) {
    parts.push('Nothing needs you and nothing is in flight — the shop is quiet.');
  } else {
    parts.push(
      `${pluralCount(counts.needsYou, 'task needs', 'tasks need')} your eyes, ` +
        `${counts.inFlight} in flight, and ` +
        `${pluralCount(counts.shipped, 'shipped', 'shipped')} so far.`,
    );
  }

  if (counts.blocked > 0) {
    parts.push(
      `${pluralCount(counts.blocked, 'task is', 'tasks are')} blocked on a failing proof — worth a glance.`,
    );
  }

  if (standout) parts.push(standout.reason);

  return { text: parts.join(' '), counts, standout };
}

/** Pull a usable audio URL out of whatever speak() returned, or null. */
function pickAudioUrl(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result || null;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['audioUrl', 'url', 'dataUrl', 'audio', 'href']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

async function synthesize(text: string): Promise<string | null> {
  try {
    const cleo = await getEmployee(CLEO_SLUG).catch(() => null);
    const synth = speak as unknown as Speak;
    const result = await synth(text, { voiceId: cleo?.voiceId ?? null });
    return pickAudioUrl(result);
  } catch {
    // VoxStation down / network blip — the text still stands on its own.
    return null;
  }
}

function wantsSpeak(req: Request): boolean {
  const flag = new URL(req.url).searchParams.get('speak');
  return flag === '1' || flag === 'true';
}

export async function GET(req: Request) {
  try {
    const floor = await getFloor();
    const brief = buildBrief(floor, new Date());

    if (wantsSpeak(req)) {
      const audioUrl = await synthesize(brief.text);
      return NextResponse.json({ ...brief, audioUrl });
    }

    return NextResponse.json(brief);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'BRIEF_FAILED', detail: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const floor = await getFloor();
    const brief = buildBrief(floor, new Date());
    const audioUrl = await synthesize(brief.text);
    return NextResponse.json({ ...brief, audioUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: 'BRIEF_FAILED', detail: message }, { status: 500 });
  }
}
