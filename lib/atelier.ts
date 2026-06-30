// lib/atelier.ts
//
// The Atelier repository layer. Every function here is workspace-scoped to
// ATELIER_WS (auth is deferred for week-1 — LAN/Tailscale-local, single
// seeded workspace). All access goes through the shared Evergreen Postgres via
// the raw `sql` tag from lib/db.ts. Rows come back snake_case and are mapped to
// camelCase typed objects below.
//
// The single most important rule lives in moveTask(): a task may only enter
// state='review' if an atelier_proof row with status='pass' exists for it.
// Violations throw an AtelierError with code 'PROOF_REQUIRED', which the
// PATCH /api/task route maps to 422 {error:"PROOF_REQUIRED"}.

import { sql } from './db';
import type {
  TaskState,
  ProofKind,
  ProofStatus,
  TaskProofStatus,
  CreateTaskInput,
  AttachProofInput,
} from './contracts';

// The seeded, single, default workspace for week-1. Every row is scoped to it.
export const ATELIER_WS = '00000000-0000-0000-0000-000000000a11';

// ---------------------------------------------------------------------------
// Row shapes (the camelCase view of the DB spine these functions return).
// ---------------------------------------------------------------------------

export interface Employee {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  role: string | null;
  tier: string | null; // 'staff' | 'specialist'
  brainModel: string | null;
  voiceId: string | null;
  status: string; // 'idle' | 'working' | 'blocked' | 'waiting'
  systemPrompt: string | null;
  config: Record<string, unknown>;
  createdAt: Date;
}

export interface Task {
  id: string;
  workspaceId: string;
  dossierId: string | null;
  assigneeSlug: string | null; // assignee_employee_slug
  title: string;
  intent: string | null;
  state: TaskState;
  station: string | null;
  kind: string | null;
  spec: Record<string, unknown>;
  proofStatus: ProofStatus; // 'pending' | 'passing' | 'failing'
  latestProofId: string | null;
  createdAt: Date;
  shippedAt: Date | null;
}

export interface Proof {
  id: string;
  workspaceId: string;
  taskId: string;
  employeeSlug: string | null;
  kind: ProofKind; // 'build' | 'match_score' | 'passing_test' | 'render_qc' | 'lint'
  status: ProofStatus | 'pass' | 'fail' | 'warn'; // proof.status uses pass/fail/warn
  score: number | null;
  threshold: number | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

export type DossierEntryType =
  | 'handoff'
  | 'note'
  | 'decision'
  | 'proof'
  | 'approval'
  | 'revision'
  | 'asset';

export interface NeedsYouItem {
  task: Task;
  proof: Proof | null;
}

export interface Floor {
  employees: Employee[];
  needsYou: NeedsYouItem[];
  inFlight: Task[];
  blocked: Task[];
  shipped: Task[];
}

// ---------------------------------------------------------------------------
// Errors — the API route inspects `.code` to choose a status (PROOF_REQUIRED -> 422).
// ---------------------------------------------------------------------------

export class AtelierError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'AtelierError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Legal task-state transitions. The proof gate (-> 'review') is enforced
// separately and explicitly in moveTask(); this map governs ordering/shape.
// (lib/contracts.ts also exports a transitions map for client-side use; this
// local copy keeps the repository self-validating regardless of import shape.)
// ---------------------------------------------------------------------------

export const LEGAL_TRANSITIONS: Record<TaskState, TaskState[]> = {
  captured: ['scoped', 'active'],
  scoped: ['active', 'captured'],
  active: ['proofed', 'captured'],
  proofed: ['review', 'active'],
  review: ['shipped', 'active'],
  shipped: [],
};

// ---------------------------------------------------------------------------
// Mappers (snake_case row -> typed camelCase object).
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  return {};
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

function mapEmployee(r: Row): Employee {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    name: r.name,
    role: r.role ?? null,
    tier: r.tier ?? null,
    brainModel: r.brain_model ?? null,
    voiceId: r.voice_id ?? null,
    status: r.status ?? 'idle',
    systemPrompt: r.system_prompt ?? null,
    config: asObject(r.config),
    createdAt: r.created_at,
  };
}

function mapTask(r: Row): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    dossierId: r.dossier_id ?? null,
    assigneeSlug: r.assignee_employee_slug ?? null,
    title: r.title,
    intent: r.intent ?? null,
    state: r.state as TaskState,
    station: r.station ?? null,
    kind: r.kind ?? null,
    spec: asObject(r.spec),
    proofStatus: (r.proof_status ?? 'pending') as ProofStatus,
    latestProofId: r.latest_proof_id ?? null,
    createdAt: r.created_at,
    shippedAt: r.shipped_at ?? null,
  };
}

function mapProof(r: Row): Proof {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    taskId: r.task_id,
    employeeSlug: r.employee_slug ?? null,
    kind: r.kind as ProofKind,
    status: r.status,
    score: asNumber(r.score),
    threshold: asNumber(r.threshold),
    detail: asObject(r.detail),
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

async function getTaskRow(taskId: string): Promise<Task | null> {
  const rows = (await sql`
    select * from atelier_task
     where id = ${taskId} and workspace_id = ${ATELIER_WS}
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapTask(rows[0]) : null;
}

async function getProofRow(proofId: string): Promise<Proof | null> {
  const rows = (await sql`
    select * from atelier_proof
     where id = ${proofId} and workspace_id = ${ATELIER_WS}
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapProof(rows[0]) : null;
}

/**
 * Append-only dossier journal write. Entries require a dossier (the schema's
 * dossier_id is NOT NULL), so this is a no-op for tasks with no dossier.
 */
async function writeEntry(opts: {
  task: Task;
  entryType: DossierEntryType;
  body: string;
  employeeSlug?: string | null;
  taskId?: string | null;
  fromStation?: string | null;
  toStation?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!opts.task.dossierId) return;
  await sql`
    insert into atelier_dossier_entry
      (workspace_id, dossier_id, task_id, employee_slug, entry_type,
       from_station, to_station, body, payload)
    values
      (${ATELIER_WS}, ${opts.task.dossierId}, ${opts.taskId ?? opts.task.id},
       ${opts.employeeSlug ?? opts.task.assigneeSlug ?? null}, ${opts.entryType},
       ${opts.fromStation ?? null}, ${opts.toStation ?? null}, ${opts.body},
       ${sql.json((opts.payload ?? {}) as never)})
  `;
}

// ---------------------------------------------------------------------------
// Public repository API.
// ---------------------------------------------------------------------------

/**
 * Cleo's Floor: the whole-workspace snapshot the home page renders.
 *  - needsYou:  tasks in 'review' (each paired with its latest proof) — the
 *               batched approval queue.
 *  - inFlight:  tasks moving through the line that aren't failing or shipped.
 *  - blocked:   tasks whose latest proof is failing.
 *  - shipped:   the done strip, newest first.
 */
export async function getFloor(): Promise<Floor> {
  const employeeRows = (await sql`
    select * from atelier_employee
     where workspace_id = ${ATELIER_WS}
     order by tier asc nulls last, name asc
  `) as unknown as Row[];

  const reviewRows = (await sql`
    select * from atelier_task
     where workspace_id = ${ATELIER_WS} and state = 'review'
     order by created_at asc
  `) as unknown as Row[];

  const inFlightRows = (await sql`
    select * from atelier_task
     where workspace_id = ${ATELIER_WS}
       and state in ('captured','scoped','active','proofed')
       and proof_status <> 'failing'
     order by created_at asc
  `) as unknown as Row[];

  const blockedRows = (await sql`
    select * from atelier_task
     where workspace_id = ${ATELIER_WS}
       and proof_status = 'failing'
       and state <> 'shipped'
     order by created_at asc
  `) as unknown as Row[];

  const shippedRows = (await sql`
    select * from atelier_task
     where workspace_id = ${ATELIER_WS} and state = 'shipped'
     order by shipped_at desc nulls last, created_at desc
  `) as unknown as Row[];

  const needsYou: NeedsYouItem[] = await Promise.all(
    reviewRows.map(async (r) => {
      const task = mapTask(r);
      const proof = task.latestProofId
        ? await getProofRow(task.latestProofId)
        : null;
      return { task, proof };
    }),
  );

  return {
    employees: employeeRows.map(mapEmployee),
    needsYou,
    inFlight: inFlightRows.map(mapTask),
    blocked: blockedRows.map(mapTask),
    shipped: shippedRows.map(mapTask),
  };
}

/** Capture a new task. Starts in state='captured', proof_status='pending'. */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const rows = (await sql`
    insert into atelier_task
      (workspace_id, dossier_id, assignee_employee_slug, title, intent, kind,
       station, state, proof_status)
    values
      (${ATELIER_WS}, ${input.dossierId ?? null}, ${input.assigneeSlug ?? null},
       ${input.title}, ${input.intent ?? null}, ${input.kind ?? null},
       ${input.station ?? null}, 'captured', 'pending')
    returning *
  `) as unknown as Row[];

  const task = mapTask(rows[0]);
  await writeEntry({
    task,
    entryType: 'note',
    body: `Captured: ${task.title}`,
    toStation: task.station,
  });
  return task;
}

/**
 * Move a task to a new state.
 *
 * THE PROOF GATE: a move to 'review' is rejected with AtelierError
 * 'PROOF_REQUIRED' (HTTP 422) unless a passing atelier_proof exists for the
 * task. Also validates the transition is legal and journals a 'handoff' entry.
 */
export async function moveTask(taskId: string, toState: TaskState): Promise<Task> {
  const task = await getTaskRow(taskId);
  if (!task) {
    throw new AtelierError('TASK_NOT_FOUND', `No task ${taskId}`, 404);
  }

  if (task.state === toState) return task;

  const legal = LEGAL_TRANSITIONS[task.state] ?? [];
  if (!legal.includes(toState)) {
    throw new AtelierError(
      'ILLEGAL_TRANSITION',
      `Cannot move task from '${task.state}' to '${toState}'`,
      422,
    );
  }

  // --- THE PROOF GATE -------------------------------------------------------
  if (toState === 'review') {
    const passing = (await sql`
      select id from atelier_proof
       where task_id = ${taskId}
         and workspace_id = ${ATELIER_WS}
         and status = 'pass'
       limit 1
    `) as unknown as Row[];
    if (!passing[0]) {
      throw new AtelierError(
        'PROOF_REQUIRED',
        'A passing proof is required before a task can enter review.',
        422,
      );
    }
  }
  // --------------------------------------------------------------------------

  const setShipped = toState === 'shipped';
  const rows = (await sql`
    update atelier_task
       set state = ${toState}
           ${setShipped ? sql`, shipped_at = now()` : sql``}
     where id = ${taskId} and workspace_id = ${ATELIER_WS}
    returning *
  `) as unknown as Row[];

  const updated = mapTask(rows[0]);
  await writeEntry({
    task: updated,
    entryType: 'handoff',
    body: `State ${task.state} → ${toState}`,
    fromStation: task.station,
    toStation: updated.station,
    payload: { from: task.state, to: toState },
  });
  return updated;
}

/**
 * Append a proof (append-only) and reconcile the task:
 *  - sets task.proof_status (pass->passing, fail->failing, warn->pending)
 *    and task.latest_proof_id;
 *  - on a 'pass', auto-advances a task that is still 'active' to 'proofed'.
 * Journals a 'proof' entry.
 */
export async function attachProof(input: AttachProofInput): Promise<Proof> {
  const rows = (await sql`
    insert into atelier_proof
      (workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
    values
      (${ATELIER_WS}, ${input.taskId}, ${input.employeeSlug}, ${input.kind},
       ${input.status}, ${input.score ?? null}, ${input.threshold ?? null},
       ${sql.json((input.detail ?? {}) as never)})
    returning *
  `) as unknown as Row[];

  const proof = mapProof(rows[0]);

  const nextProofStatus: TaskProofStatus =
    input.status === 'pass'
      ? 'passing'
      : input.status === 'fail'
        ? 'failing'
        : 'pending';

  await sql`
    update atelier_task
       set proof_status = ${nextProofStatus}, latest_proof_id = ${proof.id}
     where id = ${input.taskId} and workspace_id = ${ATELIER_WS}
  `;

  const task = await getTaskRow(input.taskId);

  // Auto-advance active -> proofed on a passing proof.
  if (input.status === 'pass' && task && task.state === 'active') {
    const advancedRows = (await sql`
      update atelier_task
         set state = 'proofed'
       where id = ${input.taskId} and workspace_id = ${ATELIER_WS}
      returning *
    `) as unknown as Row[];
    const advanced = mapTask(advancedRows[0]);
    await writeEntry({
      task: advanced,
      entryType: 'handoff',
      body: 'State active → proofed (proof passed)',
      employeeSlug: input.employeeSlug,
      fromStation: advanced.station,
      toStation: advanced.station,
      payload: { from: 'active', to: 'proofed', proofId: proof.id },
    });
  }

  if (task) {
    await writeEntry({
      task,
      entryType: 'proof',
      body: `Proof ${input.kind}: ${input.status}`,
      employeeSlug: input.employeeSlug,
      payload: {
        proofId: proof.id,
        kind: input.kind,
        status: input.status,
        score: proof.score,
        threshold: proof.threshold,
      },
    });
  }

  return proof;
}

/**
 * Approve a task: only legal from 'proofed' or 'review'. Records an approval,
 * ships the task (state='shipped', shipped_at=now()) and journals an
 * 'approval' entry. This is what the floor's Approve form ultimately calls.
 */
export async function approveTask(taskId: string): Promise<Task> {
  const task = await getTaskRow(taskId);
  if (!task) {
    throw new AtelierError('TASK_NOT_FOUND', `No task ${taskId}`, 404);
  }
  if (task.state !== 'proofed' && task.state !== 'review') {
    throw new AtelierError(
      'CANNOT_APPROVE',
      `Task in '${task.state}' cannot be approved (need 'proofed' or 'review').`,
      422,
    );
  }

  await sql`
    insert into atelier_approval
      (workspace_id, task_id, proof_id, decision, comment)
    values
      (${ATELIER_WS}, ${taskId}, ${task.latestProofId ?? null}, 'approved', null)
  `;

  const rows = (await sql`
    update atelier_task
       set state = 'shipped', shipped_at = now()
     where id = ${taskId} and workspace_id = ${ATELIER_WS}
    returning *
  `) as unknown as Row[];

  const shipped = mapTask(rows[0]);
  await writeEntry({
    task: shipped,
    entryType: 'approval',
    body: `Approved & shipped: ${shipped.title}`,
    fromStation: task.station,
    toStation: 'shipped',
    payload: { from: task.state, to: 'shipped', proofId: task.latestProofId },
  });
  return shipped;
}

/** A single employee by slug (workspace-scoped). */
export async function getEmployee(slug: string): Promise<Employee | null> {
  const rows = (await sql`
    select * from atelier_employee
     where slug = ${slug} and workspace_id = ${ATELIER_WS}
     limit 1
  `) as unknown as Row[];
  return rows[0] ? mapEmployee(rows[0]) : null;
}

/**
 * All of an employee's tasks (any state), oldest first — the raw rows the
 * LANES ViewSpec on /employee/[slug] groups into columns by state.
 */
export async function getEmployeeTasks(slug: string): Promise<Task[]> {
  const rows = (await sql`
    select * from atelier_task
     where assignee_employee_slug = ${slug} and workspace_id = ${ATELIER_WS}
     order by created_at asc
  `) as unknown as Row[];
  return rows.map(mapTask);
}
