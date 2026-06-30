// lib/agents/context.ts
//
// Shared project grounding for the planner agents (Vera/Lena/Remy): the active
// project's objective + a few recent log lines, so a generated plan is about
// THIS project rather than generic boilerplate.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

/** The active project's context as a short prompt block. '' if no project yet. */
export async function projectContext(): Promise<string> {
  const d = (await sql`
    select title, objective from atelier_dossier
     where workspace_id = ${ATELIER_WS} order by created_at desc limit 1
  `) as unknown as { title: string | null; objective: string | null }[];
  if (!d[0]) return '';
  const entries = (await sql`
    select body from atelier_dossier_entry
     where workspace_id = ${ATELIER_WS} and body is not null
     order by created_at desc limit 4
  `) as unknown as { body: string }[];
  const log = entries.map((e) => `- ${e.body.slice(0, 120)}`).join('\n');
  return `Current project: ${d[0].title ?? ''}${d[0].objective ? ` — ${d[0].objective}` : ''}.\nRecent log:\n${log}`;
}

/** Append a note to the active project's dossier. Returns true if logged. */
export async function logToProject(employeeSlug: string, body: string, payload: Record<string, unknown>): Promise<boolean> {
  const d = (await sql`
    select id from atelier_dossier where workspace_id = ${ATELIER_WS} order by created_at desc limit 1
  `) as unknown as { id: string }[];
  if (!d[0]) return false;
  await sql`
    insert into atelier_dossier_entry (workspace_id, dossier_id, employee_slug, entry_type, body, payload)
    values (${ATELIER_WS}, ${d[0].id}, ${employeeSlug}, 'note', ${body}, ${sql.json(payload as never)})`;
  return true;
}
