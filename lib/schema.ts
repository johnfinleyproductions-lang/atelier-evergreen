import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
  real,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Atelier shared-DB schema (the spine).
 *
 * Connects to evergreen-core's existing shared Postgres via DATABASE_URL
 * (the "model-radar pattern"). Every table carries workspace_id and is
 * scoped at the repository layer to ATELIER_WS. Auth is deferred (week 1).
 *
 * These pgTable definitions mirror the frozen CREATE TABLE spec EXACTLY:
 * snake_case columns, uuid pk default gen_random_uuid(), timestamptz default now().
 */

export const atelierEmployee = pgTable('atelier_employee', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  // staff | specialist
  tier: text('tier'),
  brainModel: text('brain_model'),
  voiceId: text('voice_id'),
  // idle | working | blocked | waiting
  status: text('status').notNull().default('idle'),
  systemPrompt: text('system_prompt'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const atelierViewSpec = pgTable('atelier_view_spec', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  employeeSlug: text('employee_slug'),
  key: text('key'),
  // lanes | grid | time_axis | status_wall | build_line | radar
  layout: text('layout'),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  columns: jsonb('columns').$type<unknown[]>().notNull().default([]),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const atelierDossier = pgTable('atelier_dossier', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  slug: text('slug'),
  title: text('title'),
  objective: text('objective'),
  status: text('status').notNull().default('active'),
  currentStation: text('current_station'),
  currentEmployeeSlug: text('current_employee_slug'),
  artifactRef: jsonb('artifact_ref').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const atelierTask = pgTable(
  'atelier_task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    dossierId: uuid('dossier_id'),
    assigneeEmployeeSlug: text('assignee_employee_slug'),
    title: text('title').notNull(),
    intent: text('intent'),
    // captured | scoped | active | proofed | review | shipped
    state: text('state').notNull().default('captured'),
    station: text('station'),
    kind: text('kind'),
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull().default({}),
    // pending | passing | failing
    proofStatus: text('proof_status').notNull().default('pending'),
    latestProofId: uuid('latest_proof_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
  },
  (table) => ({
    workspaceStateIdx: index('atelier_task_workspace_state_idx').on(
      table.workspaceId,
      table.state,
    ),
    workspaceProofStatusIdx: index('atelier_task_workspace_proof_status_idx').on(
      table.workspaceId,
      table.proofStatus,
    ),
  }),
);

// APPEND-ONLY, no updated_at
export const atelierProof = pgTable(
  'atelier_proof',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    taskId: uuid('task_id').notNull(),
    employeeSlug: text('employee_slug'),
    // build | match_score | passing_test | render_qc | lint
    kind: text('kind'),
    // pass | fail | warn
    status: text('status'),
    score: real('score'),
    threshold: real('threshold'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskIdx: index('atelier_proof_task_idx').on(table.taskId),
  }),
);

// APPEND-ONLY
export const atelierDossierEntry = pgTable(
  'atelier_dossier_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    dossierId: uuid('dossier_id'),
    taskId: uuid('task_id'),
    employeeSlug: text('employee_slug'),
    // handoff | note | decision | proof | approval | revision | asset
    entryType: text('entry_type'),
    fromStation: text('from_station'),
    toStation: text('to_station'),
    body: text('body'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dossierIdx: index('atelier_dossier_entry_dossier_idx').on(table.dossierId),
  }),
);

export const atelierApproval = pgTable('atelier_approval', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  taskId: uuid('task_id').notNull(),
  proofId: uuid('proof_id'),
  // approved | rejected | revise
  decision: text('decision'),
  comment: text('comment'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
});
