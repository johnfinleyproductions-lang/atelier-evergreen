import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Atelier Style Library schema (migration 0002).
 *
 * Extends the v1 spine. Same shared-DB pattern as lib/schema.ts: snake_case
 * columns, uuid pk default gen_random_uuid(), timestamptz default now(), every
 * table carries workspace_id and is scoped at the repository layer to ATELIER_WS.
 *
 * These pgTable definitions mirror drizzle/0002_*.sql EXACTLY.
 *
 * NOTE on `embedding`: the SQL migration declares it as a real `vector(1536)`
 * (pgvector). drizzle-orm has no native vector type, so we model the column as
 * `text` here purely for typechecking/codegen — reads/writes of the embedding go
 * through raw `sql` (see lib/style-repo.ts), never through drizzle's typed query
 * builder. The underlying Postgres column is genuine pgvector.
 */

// source_type: upload | url | folder | generated
export const atelierReference = pgTable('atelier_reference', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  sourceType: text('source_type'),
  imageUrl: text('image_url'),
  screenshotPath: text('screenshot_path'),
  dedupeHash: text('dedupe_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const atelierStyleProfile = pgTable(
  'atelier_style_profile',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    referenceId: uuid('reference_id'),
    model: text('model').notNull().default('qwen2.5-vl'),
    layout: jsonb('layout').$type<Record<string, unknown>>().notNull().default({}),
    // [{ hex, weight }]
    palette: jsonb('palette').$type<{ hex: string; weight: number }[]>().notNull().default([]),
    typography: jsonb('typography').$type<Record<string, unknown>>().notNull().default({}),
    spacing: jsonb('spacing').$type<Record<string, unknown>>().notNull().default({}),
    mood: jsonb('mood').$type<string[]>().notNull().default([]),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    // pgvector vector(1536) in SQL; modeled as text for drizzle (see file header)
    embedding: text('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    referenceIdx: index('atelier_style_profile_reference_idx').on(table.referenceId),
  }),
);

export const atelierStyleCard = pgTable(
  'atelier_style_card',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    // the @mention, unique-per-ws
    handle: text('handle'),
    name: text('name'),
    mergedProfile: jsonb('merged_profile').$type<Record<string, unknown>>().notNull().default({}),
    heroReferenceIds: jsonb('hero_reference_ids').$type<string[]>().notNull().default([]),
    doRules: jsonb('do_rules').$type<string[]>().notNull().default([]),
    dontRules: jsonb('dont_rules').$type<string[]>().notNull().default([]),
    brandLocked: boolean('brand_locked').notNull().default(true),
    usageCount: integer('usage_count').notNull().default(0),
    status: text('status').notNull().default('ready'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceHandleIdx: index('atelier_style_card_workspace_handle_idx').on(
      table.workspaceId,
      table.handle,
    ),
  }),
);

export const atelierBrandRubric = pgTable('atelier_brand_rubric', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name'),
  // { colors: { teal, gold, page, ink }, type, spacing, rules[] }
  tokens: jsonb('tokens').$type<Record<string, unknown>>().notNull().default({}),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const atelierStyleInjection = pgTable('atelier_style_injection', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  taskId: uuid('task_id'),
  styleCardId: uuid('style_card_id'),
  brandRubricId: uuid('brand_rubric_id'),
  ledger: jsonb('ledger').$type<unknown[]>().notNull().default([]),
  resolvedSpec: jsonb('resolved_spec').$type<Record<string, unknown>>().notNull().default({}),
  conflicts: jsonb('conflicts').$type<unknown[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
