import { z } from 'zod';

/**
 * lib/contracts.ts — the single source of types for Atelier.
 *
 * Every enum here mirrors the `text`-typed columns in the shared Postgres
 * schema (atelier_*). The drizzle schema, the API routes, the repository
 * (lib/atelier.ts) and the UI all consume these zod schemas / inferred types.
 * Keep names in lockstep with the frozen DB spine.
 */

/* ------------------------------------------------------------------ */
/* Enums (mirror the snake_case text columns)                          */
/* ------------------------------------------------------------------ */

/** atelier_task.state */
export const TASK_STATES = [
  'captured',
  'scoped',
  'active',
  'proofed',
  'review',
  'shipped',
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

/** atelier_proof.kind */
export const PROOF_KINDS = [
  'build',
  'match_score',
  'passing_test',
  'render_qc',
  'lint',
] as const;
export const ProofKindSchema = z.enum(PROOF_KINDS);
export type ProofKind = z.infer<typeof ProofKindSchema>;

/** atelier_proof.status */
export const PROOF_STATUSES = ['pass', 'fail', 'warn'] as const;
export const ProofStatusSchema = z.enum(PROOF_STATUSES);
export type ProofStatus = z.infer<typeof ProofStatusSchema>;

/** atelier_task.proof_status (the rolled-up gate signal on the task) */
export const TASK_PROOF_STATUSES = ['pending', 'passing', 'failing'] as const;
export const TaskProofStatusSchema = z.enum(TASK_PROOF_STATUSES);
export type TaskProofStatus = z.infer<typeof TaskProofStatusSchema>;

/** atelier_employee.tier */
export const EMPLOYEE_TIERS = ['staff', 'specialist'] as const;
export const EmployeeTierSchema = z.enum(EMPLOYEE_TIERS);
export type EmployeeTier = z.infer<typeof EmployeeTierSchema>;

/** atelier_employee.status */
export const EMPLOYEE_STATUSES = ['idle', 'working', 'blocked', 'waiting'] as const;
export const EmployeeStatusSchema = z.enum(EMPLOYEE_STATUSES);
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;

/** atelier_view_spec.layout */
export const VIEW_LAYOUTS = [
  'lanes',
  'grid',
  'time_axis',
  'status_wall',
  'build_line',
  'radar',
] as const;
export const ViewLayoutSchema = z.enum(VIEW_LAYOUTS);
export type ViewLayout = z.infer<typeof ViewLayoutSchema>;

/** atelier_dossier_entry.entry_type */
export const DOSSIER_ENTRY_TYPES = [
  'handoff',
  'note',
  'decision',
  'proof',
  'approval',
  'revision',
  'asset',
] as const;
export const DossierEntryTypeSchema = z.enum(DOSSIER_ENTRY_TYPES);
export type DossierEntryType = z.infer<typeof DossierEntryTypeSchema>;

/** atelier_approval.decision */
export const APPROVAL_DECISIONS = ['approved', 'rejected', 'revise'] as const;
export const ApprovalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/* ------------------------------------------------------------------ */
/* Input contracts (what the API routes / repo accept)                 */
/* ------------------------------------------------------------------ */

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1, 'title is required'),
  intent: z.string().optional(),
  kind: z.string().optional(),
  assigneeSlug: z.string().optional(),
  dossierId: z.string().uuid().optional(),
  station: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const AttachProofInputSchema = z.object({
  taskId: z.string().uuid(),
  employeeSlug: z.string().min(1),
  kind: ProofKindSchema,
  status: ProofStatusSchema,
  score: z.number().optional(),
  threshold: z.number().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AttachProofInput = z.infer<typeof AttachProofInputSchema>;

export const MoveTaskInputSchema = z.object({
  taskId: z.string().uuid(),
  toState: TaskStateSchema,
});
export type MoveTaskInput = z.infer<typeof MoveTaskInputSchema>;

/* ------------------------------------------------------------------ */
/* The task state machine                                              */
/* ------------------------------------------------------------------ */

/**
 * Legal forward (and revise-backward) transitions for atelier_task.state.
 *
 * The single most important rule lives in the repository, not here:
 * moving INTO 'review' additionally requires a passing atelier_proof row
 * (the PROOF GATE — otherwise the API answers 422 PROOF_REQUIRED). This
 * map only declares which state-to-state moves are structurally legal.
 */
export const LEGAL_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  captured: ['scoped'],
  scoped: ['active'],
  active: ['proofed'],
  proofed: ['review', 'active'], // active = kick back for revision
  review: ['shipped', 'active'], // active = rejected / needs revision
  shipped: [],
} as const;

/** True if `from -> to` is a structurally legal state transition. */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** The proof gate applies to exactly this target state. */
export const PROOF_GATED_STATE: TaskState = 'review';

/** Error code returned by the API when the proof gate blocks a move. */
export const PROOF_REQUIRED = 'PROOF_REQUIRED' as const;
