// lib/taste-memory.ts
//
// Dewey's domain: the team's learned taste. Every approve/reject/edit/love on a
// piece of work writes a signal here; recall surfaces what Tyler has favored or
// vetoed; graduateRule promotes a repeated veto into a suggested hard rule.
// Workspace-scoped to ATELIER_WS. The pgvector `embedding` column exists but is
// optional for v2 (recall is recency-ordered; semantic recall comes later).

import { sql } from './db';
import { ATELIER_WS } from './atelier';

export type TasteSignal = 'approved' | 'rejected' | 'edited' | 'loved';
export type TasteKind = 'taste' | 'veto' | 'build';

export interface RecordTasteInput {
  subjectKind: string; // task | style_card | proof | resolved_spec | ...
  subjectRef: Record<string, unknown>;
  signal: TasteSignal;
  kind: TasteKind;
  weight?: number;
  note?: string | null;
  sourceApprovalId?: string | null;
}

export interface TasteMemoryRow {
  id: string;
  subjectKind: string | null;
  subjectRef: Record<string, unknown>;
  signal: string | null;
  kind: string | null;
  weight: number;
  note: string | null;
  createdAt: Date;
}

function mapRow(r: Record<string, unknown>): TasteMemoryRow {
  return {
    id: r.id as string,
    subjectKind: (r.subject_kind as string) ?? null,
    subjectRef: (r.subject_ref as Record<string, unknown>) ?? {},
    signal: (r.signal as string) ?? null,
    kind: (r.kind as string) ?? null,
    weight: typeof r.weight === 'number' ? r.weight : Number(r.weight ?? 1),
    note: (r.note as string) ?? null,
    createdAt: r.created_at as Date,
  };
}

/** Record one taste signal (idempotency is by intent, not enforced). */
export async function recordTasteSignal(input: RecordTasteInput): Promise<TasteMemoryRow> {
  const rows = (await sql`
    insert into atelier_taste_memory
      (workspace_id, subject_kind, subject_ref, signal, kind, weight, source_approval_id, note)
    values
      (${ATELIER_WS}, ${input.subjectKind}, ${sql.json((input.subjectRef ?? {}) as never)},
       ${input.signal}, ${input.kind}, ${input.weight ?? 1},
       ${input.sourceApprovalId ?? null}, ${input.note ?? null})
    returning *
  `) as unknown as Record<string, unknown>[];
  return mapRow(rows[0]);
}

/** Recall recent taste signals, optionally filtered by kind. */
export async function recallTaste(
  opts: { kind?: TasteKind; limit?: number } = {},
): Promise<TasteMemoryRow[]> {
  const limit = Math.min(opts.limit ?? 25, 200);
  const rows = opts.kind
    ? ((await sql`
        select * from atelier_taste_memory
         where workspace_id = ${ATELIER_WS} and kind = ${opts.kind}
         order by created_at desc limit ${limit}
      `) as unknown as Record<string, unknown>[])
    : ((await sql`
        select * from atelier_taste_memory
         where workspace_id = ${ATELIER_WS}
         order by created_at desc limit ${limit}
      `) as unknown as Record<string, unknown>[]);
  return rows.map(mapRow);
}

export interface GraduatedRule {
  pattern: string;
  occurrences: number;
  confidence: number;
  suggestedRule: string;
}

/**
 * When a veto pattern (keyed by subject_ref.pattern) repeats >= threshold, return
 * a suggested hard brand rule. A simple count-based promoter for v2; the
 * embedding column lets this become semantic clustering later.
 */
export async function graduateRule(threshold = 3): Promise<GraduatedRule[]> {
  const rows = (await sql`
    select coalesce(subject_ref->>'pattern', note) as pattern, count(*)::int as n
      from atelier_taste_memory
     where workspace_id = ${ATELIER_WS} and kind = 'veto'
     group by 1
    having count(*) >= ${threshold}
     order by n desc
  `) as unknown as { pattern: string | null; n: number }[];
  return rows
    .filter((r) => r.pattern)
    .map((r) => ({
      pattern: r.pattern as string,
      occurrences: r.n,
      confidence: Math.min(0.5 + r.n * 0.1, 0.95),
      suggestedRule: `Tyler has rejected "${r.pattern}" ${r.n}x — promote to a hard brand rule.`,
    }));
}

/**
 * Recall recent taste signals and format them as a prompt snippet an agent can
 * use to bias generation toward what Tyler picks and away from what he rejects.
 * Returns '' when there's no history yet (cold start).
 */
export async function recallTasteForPrompt(subjectKind: string, limit = 12): Promise<string> {
  const rows = (await sql`
    select signal, note from atelier_taste_memory
     where workspace_id = ${ATELIER_WS} and subject_kind = ${subjectKind} and note is not null
     order by created_at desc limit ${limit}
  `) as unknown as { signal: string; note: string }[];
  if (!rows.length) return '';
  const liked = rows.filter((r) => r.signal === 'approved' || r.signal === 'loved').map((r) => r.note);
  const avoided = rows.filter((r) => r.signal === 'rejected' || r.signal === 'edited').map((r) => r.note);
  const parts: string[] = [];
  if (liked.length) parts.push(`Tyler has PICKED these before (match this voice): ${liked.slice(0, 6).map((l) => `"${l}"`).join('; ')}.`);
  if (avoided.length) parts.push(`He has REJECTED these (avoid this voice): ${avoided.slice(0, 8).map((l) => `"${l}"`).join('; ')}.`);
  return parts.length ? `\n\nLEARNED TASTE — ${parts.join(' ')} Lean toward what he picks.` : '';
}
