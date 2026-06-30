// lib/style-repo.ts
//
// The Style Library repository layer. Every function here is workspace-scoped
// to ATELIER_WS and goes through the shared Evergreen Postgres via the raw
// `sql` tag from lib/db.ts. Rows come back snake_case and are mapped to
// camelCase typed objects below — same pattern as lib/atelier.ts.
//
// This module owns persistence for the five Style Library tables:
//   atelier_reference        — a captured visual reference (upload/url/folder/generated)
//   atelier_style_profile    — the per-reference profile (REAL palette + VL/heuristic)
//   atelier_style_card       — the @handle a user @-mentions; the merged identity
//   atelier_brand_rubric     — the brand-lock tokens that win colors/logo/a11y
//   atelier_style_injection  — a resolved spec + merge ledger for one task
//
// Functions: insertReference, insertProfile, createStyleCard, listStyleCards,
// getStyleCard, getDefaultBrandRubric, recordInjection.

import { sql } from './db';
import { ATELIER_WS } from './atelier';

// ---------------------------------------------------------------------------
// Row shapes (the camelCase view of the Style Library tables).
// ---------------------------------------------------------------------------

export interface AtelierReference {
  id: string;
  workspaceId: string;
  sourceType: string; // 'upload' | 'url' | 'folder' | 'generated'
  imageUrl: string | null;
  screenshotPath: string | null;
  dedupeHash: string | null;
  createdAt: Date;
}

export interface PaletteSwatch {
  hex: string;
  weight: number;
}

export interface StyleProfile {
  id: string;
  workspaceId: string;
  referenceId: string | null;
  model: string; // default 'qwen2.5-vl'
  layout: Record<string, unknown>;
  palette: PaletteSwatch[];
  typography: Record<string, unknown>;
  spacing: Record<string, unknown>;
  mood: unknown[];
  raw: Record<string, unknown>;
  embedding: number[] | null; // vector(1536)
  createdAt: Date;
}

export interface StyleCard {
  id: string;
  workspaceId: string;
  handle: string; // the @mention, unique-per-workspace
  name: string | null;
  mergedProfile: Record<string, unknown>;
  heroReferenceIds: string[];
  doRules: unknown[];
  dontRules: unknown[];
  brandLocked: boolean;
  usageCount: number;
  status: string; // default 'ready'
  createdAt: Date;
}

export interface BrandRubric {
  id: string;
  workspaceId: string;
  name: string | null;
  tokens: Record<string, unknown>; // {colors:{teal,gold,page,ink}, type, spacing, rules[]}
  isDefault: boolean;
  createdAt: Date;
}

export interface StyleInjection {
  id: string;
  workspaceId: string;
  taskId: string | null;
  styleCardId: string | null;
  brandRubricId: string | null;
  ledger: unknown[];
  resolvedSpec: Record<string, unknown>;
  conflicts: unknown[];
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Input shapes.
// ---------------------------------------------------------------------------

export interface InsertReferenceInput {
  sourceType: string; // 'upload' | 'url' | 'folder' | 'generated'
  imageUrl?: string | null;
  screenshotPath?: string | null;
  dedupeHash?: string | null;
}

export interface InsertProfileInput {
  referenceId: string;
  model?: string;
  layout?: Record<string, unknown>;
  palette?: PaletteSwatch[];
  typography?: Record<string, unknown>;
  spacing?: Record<string, unknown>;
  mood?: unknown[];
  raw?: Record<string, unknown>;
  embedding?: number[] | null;
}

export interface CreateStyleCardInput {
  handle: string;
  name?: string | null;
  mergedProfile?: Record<string, unknown>;
  heroReferenceIds?: string[];
  doRules?: unknown[];
  dontRules?: unknown[];
  brandLocked?: boolean;
  status?: string;
}

export interface RecordInjectionInput {
  taskId?: string | null;
  styleCardId: string;
  brandRubricId?: string | null;
  ledger?: unknown[];
  resolvedSpec?: Record<string, unknown>;
  conflicts?: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers (snake_case row -> typed camelCase object).
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

function asPalette(v: unknown): PaletteSwatch[] {
  if (!Array.isArray(v)) return [];
  return (v as any[])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ hex: String(s.hex), weight: Number(s.weight) }));
}

function asInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * pgvector accepts a text literal of the form '[0.1,0.2,...]'. We serialize a
 * number[] to that shape on insert and parse the same shape back on read.
 */
function serializeEmbedding(embedding: number[] | null | undefined): string | null {
  if (!embedding || embedding.length === 0) return null;
  return `[${embedding.join(',')}]`;
}

function parseEmbedding(v: unknown): number[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return (v as any[]).map(Number);
  if (typeof v === 'string') {
    const trimmed = v.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!trimmed) return null;
    return trimmed.split(',').map((n) => Number(n.trim()));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mappers.
// ---------------------------------------------------------------------------

function mapReference(r: Row): AtelierReference {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sourceType: r.source_type,
    imageUrl: r.image_url ?? null,
    screenshotPath: r.screenshot_path ?? null,
    dedupeHash: r.dedupe_hash ?? null,
    createdAt: r.created_at,
  };
}

function mapProfile(r: Row): StyleProfile {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    referenceId: r.reference_id ?? null,
    model: r.model ?? 'qwen2.5-vl',
    layout: asObject(r.layout),
    palette: asPalette(r.palette),
    typography: asObject(r.typography),
    spacing: asObject(r.spacing),
    mood: asArray(r.mood),
    raw: asObject(r.raw),
    embedding: parseEmbedding(r.embedding),
    createdAt: r.created_at,
  };
}

function mapStyleCard(r: Row): StyleCard {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    handle: r.handle,
    name: r.name ?? null,
    mergedProfile: asObject(r.merged_profile),
    heroReferenceIds: asArray(r.hero_reference_ids) as string[],
    doRules: asArray(r.do_rules),
    dontRules: asArray(r.dont_rules),
    brandLocked: r.brand_locked ?? true,
    usageCount: asInt(r.usage_count),
    status: r.status ?? 'ready',
    createdAt: r.created_at,
  };
}

function mapBrandRubric(r: Row): BrandRubric {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name ?? null,
    tokens: asObject(r.tokens),
    isDefault: r.is_default ?? false,
    createdAt: r.created_at,
  };
}

function mapInjection(r: Row): StyleInjection {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    taskId: r.task_id ?? null,
    styleCardId: r.style_card_id ?? null,
    brandRubricId: r.brand_rubric_id ?? null,
    ledger: asArray(r.ledger),
    resolvedSpec: asObject(r.resolved_spec),
    conflicts: asArray(r.conflicts),
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Public repository API (all workspace-scoped to ATELIER_WS).
// ---------------------------------------------------------------------------

/** Persist a captured visual reference. */
export async function insertReference(
  input: InsertReferenceInput,
): Promise<AtelierReference> {
  const rows = (await sql`
    insert into atelier_reference
      (workspace_id, source_type, image_url, screenshot_path, dedupe_hash)
    values
      (${ATELIER_WS}, ${input.sourceType}, ${input.imageUrl ?? null},
       ${input.screenshotPath ?? null}, ${input.dedupeHash ?? null})
    returning *
  `) as unknown as Row[];
  return mapReference(rows[0]);
}

/**
 * Persist a style profile for a reference. The `palette` is the REAL,
 * sharp-extracted palette; `embedding` (vector(1536)) is optional and stored as
 * a pgvector literal when present.
 */
export async function insertProfile(
  input: InsertProfileInput,
): Promise<StyleProfile> {
  const embedding = serializeEmbedding(input.embedding);
  const rows = (await sql`
    insert into atelier_style_profile
      (workspace_id, reference_id, model, layout, palette, typography,
       spacing, mood, raw, embedding)
    values
      (${ATELIER_WS}, ${input.referenceId}, ${input.model ?? 'qwen2.5-vl'},
       ${sql.json((input.layout ?? {}) as never)},
       ${sql.json((input.palette ?? []) as never)},
       ${sql.json((input.typography ?? {}) as never)},
       ${sql.json((input.spacing ?? {}) as never)},
       ${sql.json((input.mood ?? []) as never)},
       ${sql.json((input.raw ?? {}) as never)},
       ${embedding}::vector)
    returning *
  `) as unknown as Row[];
  return mapProfile(rows[0]);
}

/**
 * Create a style card (the @handle). Handle is unique-per-workspace; a clash
 * surfaces as a Postgres unique-violation from the (workspace_id, handle) index.
 */
export async function createStyleCard(
  input: CreateStyleCardInput,
): Promise<StyleCard> {
  const rows = (await sql`
    insert into atelier_style_card
      (workspace_id, handle, name, merged_profile, hero_reference_ids,
       do_rules, dont_rules, brand_locked, status)
    values
      (${ATELIER_WS}, ${input.handle}, ${input.name ?? null},
       ${sql.json((input.mergedProfile ?? {}) as never)},
       ${sql.json((input.heroReferenceIds ?? []) as never)},
       ${sql.json((input.doRules ?? []) as never)},
       ${sql.json((input.dontRules ?? []) as never)},
       ${input.brandLocked ?? true}, ${input.status ?? 'ready'})
    returning *
  `) as unknown as Row[];
  return mapStyleCard(rows[0]);
}

/** All style cards in the workspace, newest first. */
export async function listStyleCards(): Promise<StyleCard[]> {
  const rows = (await sql`
    select * from atelier_style_card
     where workspace_id = ${ATELIER_WS}
     order by created_at desc
  `) as unknown as Row[];
  return rows.map(mapStyleCard);
}

/**
 * Fetch a single style card by its @handle OR by id (uuid is auto-detected).
 * A leading '@' on a handle is tolerated and stripped.
 */
export async function getStyleCard(
  handleOrId: string,
): Promise<StyleCard | null> {
  if (UUID_RE.test(handleOrId)) {
    const rows = (await sql`
      select * from atelier_style_card
       where id = ${handleOrId} and workspace_id = ${ATELIER_WS}
       limit 1
    `) as unknown as Row[];
    return rows[0] ? mapStyleCard(rows[0]) : null;
  }
  const handle = handleOrId.startsWith('@') ? handleOrId.slice(1) : handleOrId;
  const rows = (await sql`
    select * from atelier_style_card
     where handle = ${handle} and workspace_id = ${ATELIER_WS}
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapStyleCard(rows[0]) : null;
}

/**
 * The workspace's default brand rubric (the brand-lock token source). Prefers
 * the row flagged is_default; falls back to the most recent rubric.
 */
export async function getDefaultBrandRubric(): Promise<BrandRubric | null> {
  const rows = (await sql`
    select * from atelier_brand_rubric
     where workspace_id = ${ATELIER_WS}
     order by is_default desc, created_at desc
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapBrandRubric(rows[0]) : null;
}

/**
 * Persist a resolved style injection (the merge ledger + resolved spec for one
 * task) and bump the style card's usage_count. Returns the injection row.
 */
export async function recordInjection(
  input: RecordInjectionInput,
): Promise<StyleInjection> {
  const rows = (await sql`
    insert into atelier_style_injection
      (workspace_id, task_id, style_card_id, brand_rubric_id, ledger,
       resolved_spec, conflicts)
    values
      (${ATELIER_WS}, ${input.taskId ?? null}, ${input.styleCardId},
       ${input.brandRubricId ?? null},
       ${sql.json((input.ledger ?? []) as never)},
       ${sql.json((input.resolvedSpec ?? {}) as never)},
       ${sql.json((input.conflicts ?? []) as never)})
    returning *
  `) as unknown as Row[];

  await sql`
    update atelier_style_card
       set usage_count = usage_count + 1
     where id = ${input.styleCardId} and workspace_id = ${ATELIER_WS}
  `;

  return mapInjection(rows[0]);
}
