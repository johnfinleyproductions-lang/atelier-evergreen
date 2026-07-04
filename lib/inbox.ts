// lib/inbox.ts
//
// The cross-agent inbox layer. Proactive job report-backs land in each agent's
// own thread — without this, ten threads have to be polled by hand to notice
// "Build passed — want Marlowe on it?" sitting unseen. A last-read watermark
// per (agent, thread) makes unread counts cheap; the watermark advances when
// the thread is actually open (TalkPage render + the UI's polling GET).

import { sql } from './db';
import { ATELIER_WS } from './atelier';

export interface UnreadAgent {
  slug: string;
  unread: number;
  latestAt: string | null;
  snippet: string | null; // first ~80 chars of the newest unread assistant message
}

/** Advance the watermark — the user has this thread in front of them. */
export async function markThreadRead(slug: string, thread = 'default'): Promise<void> {
  await sql`
    insert into atelier_thread_read (workspace_id, agent_slug, thread, last_read_at)
    values (${ATELIER_WS}, ${slug}, ${thread}, now())
    on conflict (workspace_id, agent_slug, thread) do update set last_read_at = now()
  `;
}

/** Per-agent unread assistant messages (default thread) + newest snippet. */
export async function unreadSummary(): Promise<Map<string, UnreadAgent>> {
  const rows = (await sql`
    select m.agent_slug,
           count(*)::int as unread,
           max(m.created_at) as latest_at,
           (array_agg(m.content order by m.created_at desc))[1] as latest_content
      from atelier_message m
      left join atelier_thread_read r
        on r.workspace_id = m.workspace_id and r.agent_slug = m.agent_slug and r.thread = m.thread
     where m.workspace_id = ${ATELIER_WS} and m.thread = 'default' and m.role = 'assistant'
       and m.created_at > coalesce(r.last_read_at, to_timestamp(0))
     group by m.agent_slug
  `) as unknown as { agent_slug: string; unread: number; latest_at: string; latest_content: string }[];
  return new Map(rows.map((r) => [r.agent_slug, {
    slug: r.agent_slug,
    unread: r.unread,
    latestAt: String(r.latest_at),
    snippet: r.latest_content ? r.latest_content.replace(/\s+/g, ' ').slice(0, 80) : null,
  }]));
}
