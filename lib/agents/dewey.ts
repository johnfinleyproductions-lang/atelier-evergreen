// lib/agents/dewey.ts
//
// Dewey — the Archivist. Real recall over the team's own memory (no model, no
// fabrication): he answers "what did we decide about X?" / "have we done this?"
// straight from the DB —
//   - shipped decisions  (atelier_task kind='decision' → spec.question + chosenLabel)
//   - dossier entries     (notes, assets, handoffs that were logged)
//   - taste signals       (what Tyler favored / vetoed, atelier_taste_memory.note)
// Everything Dewey says is a row that exists; if there's no match he says so.

import { sql } from '../db';
import { ATELIER_WS } from '../atelier';

export interface RecallHit {
  kind: 'decision' | 'note' | 'asset' | 'taste';
  when: string;          // ISO
  ageDays: number | null;
  project: string | null;
  text: string;
  detail?: string;
}

const STOP = new Set([
  'what', 'did', 'we', 'decide', 'decided', 'about', 'have', 'has', 'do', 'does', 'the', 'a', 'an',
  'on', 'for', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'our', 'my', 'me', 'you', 'i', 'and',
  'or', 'with', 'remember', 'recall', 'say', 'said', 'tell', 'show', 'history', 'past', 'notes', 'note',
  'anything', 'something', 'ever', 'any', 'this', 'that', 'how', 'why', 'when', 'where', 'which', 'whats',
  'recent', 'recently', 'latest', 'lately', 'all', 'everything', 'know', 'knows', 'been', 'up', 'going', 'lately',
]);

/** Pull meaningful search terms out of a natural-language question. */
function terms(q: string): string[] {
  return Array.from(new Set(
    q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )).slice(0, 6);
}

// postgres-js returns timestamptz as Date objects — normalize to ISO strings.
function iso(v: unknown): string {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function ageDays(when: string): number | null {
  if (!when) return null;
  const ms = Date.now() - new Date(when).getTime();
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Recall from the team's memory. With terms → keyword match; without → recent. */
export async function recall(query: string, limit = 8): Promise<{ hits: RecallHit[]; terms: string[] }> {
  const ts = terms(query);
  const like = ts.length ? `%${ts.join('%')}%` : null; // loose AND-ish via ordered wildcards
  const anyLike = ts.map((t) => `%${t}%`);

  // 1) Shipped decisions — the highest-signal memory.
  const decisions = (await sql`
    select t.spec, t.shipped_at, d.slug as project
      from atelier_task t
      left join atelier_dossier d on d.id = t.dossier_id
     where t.workspace_id = ${ATELIER_WS} and t.kind = 'decision' and t.state = 'shipped'
       and (${like}::text is null
            or t.spec->>'question' ilike ${like} or t.spec->>'chosenLabel' ilike ${like})
     order by t.shipped_at desc nulls last
     limit ${limit}
  `) as unknown as { spec: Record<string, unknown>; shipped_at: string | null; project: string | null }[];

  // 2) Logged dossier entries (notes / assets / handoffs).
  const entries = (await sql`
    select e.entry_type, e.body, e.created_at, d.slug as project
      from atelier_dossier_entry e
      left join atelier_dossier d on d.id = e.dossier_id
     where e.workspace_id = ${ATELIER_WS} and e.body is not null
       and (${like}::text is null or e.body ilike ${like}
            or (${anyLike}::text[] is not null and e.body ilike any(${anyLike})))
       and e.entry_type in ('note', 'asset', 'handoff', 'revision')
     order by e.created_at desc
     limit ${limit}
  `) as unknown as { entry_type: string; body: string; created_at: string; project: string | null }[];

  // 3) Taste signals — what was favored / vetoed.
  const taste = (await sql`
    select signal, kind, note, created_at
      from atelier_taste_memory
     where workspace_id = ${ATELIER_WS} and note is not null
       and (${like}::text is null or note ilike ${like})
     order by created_at desc
     limit ${limit}
  `) as unknown as { signal: string; kind: string; note: string; created_at: string }[];

  const hits: RecallHit[] = [];
  for (const d of decisions) {
    const q = (d.spec?.question as string) ?? 'a decision';
    const chosen = (d.spec?.chosenLabel as string) ?? '(unrecorded)';
    const w = iso(d.shipped_at);
    hits.push({
      kind: 'decision', when: w, ageDays: ageDays(w),
      project: d.project, text: `“${q}” → ${chosen}`,
    });
  }
  for (const e of entries) {
    const w = iso(e.created_at);
    hits.push({
      kind: e.entry_type === 'asset' ? 'asset' : 'note', when: w, ageDays: ageDays(w),
      project: e.project, text: e.body.slice(0, 180),
    });
  }
  for (const t of taste) {
    const verb = t.signal === 'approved' ? 'favored' : t.signal === 'rejected' ? 'vetoed' : t.signal;
    const w = iso(t.created_at);
    hits.push({
      kind: 'taste', when: w, ageDays: ageDays(w),
      project: null, text: `You ${verb}: ${t.note}`,
    });
  }

  // Most recent first, capped.
  hits.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  return { hits: hits.slice(0, limit), terms: ts };
}

const ICON: Record<RecallHit['kind'], string> = { decision: '✓', note: '•', asset: '▣', taste: '★' };

export function formatRecall(query: string, hits: RecallHit[], ts: string[]): string {
  if (!hits.length) {
    return ts.length
      ? `I don't have anything on “${ts.join(' ')}” in our records yet — no decisions, notes, or taste signals match.`
      : `Our log is empty so far — nothing decided or noted yet.`;
  }
  const head = ts.length ? `Here's what we have on “${ts.join(' ')}”:` : `Most recent from our memory:`;
  const lines = hits.map((h) => {
    const age = h.ageDays == null ? '' : h.ageDays === 0 ? ' · today' : ` · ${h.ageDays}d ago`;
    const proj = h.project ? ` [${h.project}]` : '';
    return `  ${ICON[h.kind]} ${h.text}${proj}${age}`;
  });
  return [head, ...lines].join('\n');
}
