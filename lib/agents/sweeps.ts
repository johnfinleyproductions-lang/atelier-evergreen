// lib/agents/sweeps.ts
//
// The RESPONSIVE fulfillment layer: standing jobs that run on the in-process
// ticker and post to agent threads — WITHOUT ever waking a model. Both sweeps
// follow the zero-cost-idle rule: a deterministic pre-check decides there is
// something to say BEFORE anything speaks; "nothing to report" costs nothing.
//
//   • Otto's substrate watcher — flags green→at-risk transitions (and
//     recoveries) before being asked. His soul always promised this; now the
//     ticker keeps the promise. Pure reads: systemHealth() + a kv diff.
//   • Cleo's morning brief — once a day, composed deterministically from real
//     floor state (decisions waiting, overnight jobs, unread report-backs,
//     blocked work). If nothing needs John and nothing happened, she stays
//     quiet — her own rule: no stream of pings, and no manufactured ones.

import { sql } from '../db';
import { ATELIER_WS, getFloor } from '../atelier';
import { kvGet, kvSet } from '../kv';
import { systemHealth, formatHealth } from './otto';
import { unreadSummary } from '../inbox';

async function postToThread(slug: string, content: string): Promise<void> {
  await sql`insert into atelier_message (workspace_id, agent_slug, thread, role, content)
            values (${ATELIER_WS}, ${slug}, 'default', 'assistant', ${content})`;
}

// ── Otto: the substrate watcher ─────────────────────────────────────────────

interface WatchState { green: boolean; issues: string[]; at: string }
const WATCH_EVERY_MS = 4 * 60_000; // health probes aren't free; every ~4 min is plenty

export async function ottoWatch(now = new Date()): Promise<'skipped' | 'baseline' | 'quiet' | 'flagged' | 'recovered'> {
  const last = await kvGet<{ at: string }>('otto_watch_ran');
  if (last && now.getTime() - new Date(last.at).getTime() < WATCH_EVERY_MS) return 'skipped';
  await kvSet('otto_watch_ran', { at: now.toISOString() });

  const h = await systemHealth();
  const issues: string[] = [];
  if (!h.db.up) issues.push('DB down');
  if (!h.ollama.up) issues.push('Ollama unreachable');
  for (const s of h.services) if (s.state === 'inactive') issues.push(`${s.name} inactive`);
  const state: WatchState = { green: issues.length === 0, issues, at: now.toISOString() };

  const prev = await kvGet<WatchState>('otto_watch_state');
  await kvSet('otto_watch_state', state);
  if (!prev) return 'baseline'; // first run establishes the baseline silently

  const wentBad = prev.green && !state.green;
  const issuesChanged = !prev.green && !state.green && prev.issues.join('|') !== state.issues.join('|');
  const recovered = !prev.green && state.green;

  if (wentBad || issuesChanged) {
    await postToThread('otto', `At-risk — flagging before you ask. ${state.issues.join('; ')}.\n\n${formatHealth(h)}`);
    return 'flagged';
  }
  if (recovered) {
    await postToThread('otto', `Green again — ${prev.issues.join('; ')} cleared. Back to boring.`);
    return 'recovered';
  }
  return 'quiet';
}

// ── Cleo: the morning brief ─────────────────────────────────────────────────

const BRIEF_TZ = process.env.ATELIER_TZ ?? 'America/Los_Angeles';
const BRIEF_HOUR = Number(process.env.ATELIER_BRIEF_HOUR ?? 7);

function localParts(now: Date): { date: string; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIEF_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

/** Compose the brief from real state. Returns null when there is nothing worth a ping. */
export async function composeBrief(): Promise<string | null> {
  const floor = await getFloor();
  const unread = await unreadSummary();
  const jobs = (await sql`
    select status, count(*)::int as n from atelier_job
     where workspace_id = ${ATELIER_WS} and finished_at > now() - interval '18 hours'
     group by status
  `) as unknown as { status: string; n: number }[];
  const done = jobs.find((j) => j.status === 'done')?.n ?? 0;
  const failed = jobs.find((j) => j.status === 'error')?.n ?? 0;

  const needs = (floor.needsYou as { task?: { title?: string } }[]).map((n) => ({ title: n.task?.title }));
  const blocked = floor.blocked as { title?: string }[];
  const unreadAgents = [...unread.values()].filter((u) => u.slug !== 'cleo');
  const unreadTotal = unreadAgents.reduce((a, u) => a + u.unread, 0);

  // The pre-check: nothing needs him, nothing happened, nothing stuck → no ping.
  if (!needs.length && !blocked.length && !done && !failed && !unreadTotal) return null;

  const lines: string[] = ['Morning. Here’s the floor:'];
  if (needs.length) {
    const first = needs[0]?.title ? ` — first up: “${needs[0].title}”` : '';
    lines.push(`• Needs you (${needs.length})${first}${needs.length > 1 ? ` +${needs.length - 1} more` : ''}. That’s the pile to clear.`);
  } else {
    lines.push('• Nothing needs a decision. Routed work is moving on its own.');
  }
  if (done || failed) {
    lines.push(`• Overnight: ${done} job${done === 1 ? '' : 's'} finished${failed ? `, ${failed} failed — the owner has it in their thread` : ''}.`);
  }
  if (unreadTotal) {
    const who = unreadAgents.filter((u) => u.unread > 0).sort((a, b) => b.unread - a.unread).slice(0, 3).map((u) => u.slug).join(', ');
    lines.push(`• ${unreadTotal} unread report-back${unreadTotal === 1 ? '' : 's'} on the floor (${who}).`);
  }
  if (blocked.length) {
    lines.push(`• Blocked (${blocked.length}): ${blocked.slice(0, 2).map((b) => `“${b.title ?? 'untitled'}”`).join(', ')} — these don’t age well.`);
  }
  lines.push(`${floor.inFlight.length} in flight. Moving.`);
  return lines.join('\n');
}

export async function cleoMorningBrief(now = new Date(), force = false): Promise<'skipped' | 'quiet' | 'posted'> {
  const { date, hour } = localParts(now);
  if (!force) {
    if (hour < BRIEF_HOUR) return 'skipped';
    const last = await kvGet<{ date: string }>('cleo_brief_last');
    if (last?.date === date) return 'skipped';
    // Claim the date BEFORE composing so a racing tick can't double-post.
    await kvSet('cleo_brief_last', { date });
  }
  const brief = await composeBrief();
  if (!brief) return 'quiet'; // her rule: no manufactured pings
  await postToThread('cleo', brief);
  return 'posted';
}

/** One entry point for the ticker: every sweep is best-effort and isolated. */
export async function runAgentSweeps(): Promise<void> {
  try { await ottoWatch(); } catch { /* watcher never takes the ticker down */ }
  try { await cleoMorningBrief(); } catch { /* neither does the brief */ }
}
