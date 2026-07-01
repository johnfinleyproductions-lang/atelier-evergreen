// lib/jobs.ts
//
// Async job queue for long-running agent work. Hugo's build calls a local coder
// model and then the Visual-QA gate — together ~30–90s. Awaiting that inside an
// HTTP handler makes the UI hang, so instead we:
//   1. enqueue a job row (status='queued') and return its id immediately,
//   2. kick off processing in the background (fire-and-forget),
//   3. let the client poll /api/job/[id] until status is 'done' | 'error'.
//
// Atelier runs as a persistent `next start` systemd service, so a floating
// promise keeps executing after the HTTP response returns — no separate worker
// process needed. Jobs are claimed with a conditional UPDATE so a job runs once
// even if processJob is called more than once.

import { sql } from './db';
import { ATELIER_WS } from './atelier';
import { hugoBuild } from './agents/hugo';
import { researchAndLog } from './agents/vera';
import { reviewLatestWren } from './agents/marlowe';
import { planAndLog } from './agents/lena';
import { scriptAndLog } from './agents/remy';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'deferred';
export type WorkKind = 'interactive' | 'batch-heavy';

export interface Job {
  id: string;
  kind: string;
  agentSlug: string | null;
  status: JobStatus;
  workKind: WorkKind;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  runAfter: string | null;
}

function mapRow(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    kind: r.kind as string,
    agentSlug: (r.agent_slug as string | null) ?? null,
    status: r.status as JobStatus,
    workKind: ((r.work_kind as string) ?? 'interactive') as WorkKind,
    input: (r.input as Record<string, unknown>) ?? {},
    result: (r.result as Record<string, unknown> | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : null,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    runAfter: r.run_after ? String(r.run_after) : null,
  };
}

export async function getJob(id: string): Promise<Job | null> {
  const rows = (await sql`
    select * from atelier_job where workspace_id = ${ATELIER_WS} and id = ${id} limit 1
  `) as unknown as Record<string, unknown>[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listRecentJobs(limit = 20): Promise<Job[]> {
  const rows = (await sql`
    select * from atelier_job where workspace_id = ${ATELIER_WS}
    order by created_at desc limit ${limit}
  `) as unknown as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Atomically claim a queued job → running. Returns true only for the winner. */
async function claim(id: string): Promise<boolean> {
  const rows = (await sql`
    update atelier_job set status = 'running', started_at = now()
    where workspace_id = ${ATELIER_WS} and id = ${id} and status = 'queued'
    returning id
  `) as unknown as Record<string, unknown>[];
  return rows.length > 0;
}

async function finishOk(id: string, result: unknown): Promise<void> {
  await sql`
    update atelier_job set status = 'done', result = ${sql.json(result as never)}, finished_at = now()
    where workspace_id = ${ATELIER_WS} and id = ${id}
  `;
}

async function finishErr(id: string, error: string): Promise<void> {
  await sql`
    update atelier_job set status = 'error', error = ${error.slice(0, 500)}, finished_at = now()
    where workspace_id = ${ATELIER_WS} and id = ${id}
  `;
}

// Each job kind maps to a runner. Add new long-running agent actions here.
const RUNNERS: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {
  hugo_build: async (input) => {
    const slug = (input.slug as string) || 'launch-course-19';
    const brief = (input.brief as string) || '';
    return hugoBuild(slug, brief, '@warm-editorial', Boolean(input.heavy));
  },
  vera_research: async (input) => {
    const brief = (input.brief as string) || '';
    return researchAndLog(brief);
  },
  marlowe_review: async (input) => {
    const taskId = (input.taskId as string) || undefined;
    return reviewLatestWren(taskId);
  },
  lena_plan: async (input) => planAndLog((input.brief as string) || ''),
  remy_script: async (input) => scriptAndLog((input.brief as string) || ''),
};

// Which model each job kind loads — so we can free the lane for it first.
const JOB_MODEL: Record<string, string> = {
  hugo_build: process.env.ATELIER_HUGO_MODEL ?? 'qwen2.5-coder:14b',
  vera_research: 'qwen3.5:9b',
  marlowe_review: 'qwen3.5:9b',
  lena_plan: 'qwen3.5:9b',
  remy_script: 'qwen3.5:9b',
};

/** Run a claimed job to completion. Safe to fire-and-forget; never throws. */
export async function processJob(id: string): Promise<void> {
  try {
    if (!(await claim(id))) return; // already taken or not queued
    const job = await getJob(id);
    if (!job) return;
    const runner = RUNNERS[job.kind];
    if (!runner) {
      await finishErr(id, `NO_RUNNER_FOR_${job.kind}`);
      return;
    }
    try {
      // Free the on-demand lane for this job's model first (kick idle models).
      // Heavy Hugo builds run on the vidbox coder lane (its proxy manages ComfyUI),
      // so skip the Framerstation kick for those.
      const model = (job.kind === 'hugo_build' && job.input.heavy) ? undefined : JOB_MODEL[job.kind];
      if (model) {
        try {
          const { ensureAtelierLaneRoom } = await import('./lanes');
          await ensureAtelierLaneRoom(model);
        } catch { /* lane prep is best-effort */ }
      }
      const result = await runner(job.input);
      await finishOk(id, result);
    } catch (err) {
      await finishErr(id, err instanceof Error ? err.message : 'JOB_FAILED');
    }
  } catch {
    try { await finishErr(id, 'JOB_RUNNER_CRASHED'); } catch { /* swallow */ }
  }
}

/**
 * Enqueue a job and start it in the background. If it's batch-heavy and the
 * active zone blocks that work, it's parked as 'deferred' with run_after set to
 * when the block lifts (the ticker runs it then) instead of firing now.
 */
export async function enqueueJob(
  kind: string,
  input: Record<string, unknown>,
  agentSlug: string | null = null,
  workKind: WorkKind = 'interactive',
): Promise<string> {
  // Zone gate (batch-heavy only). Import lazily to avoid a cycle.
  let deferUntil: Date | null = null;
  if (workKind === 'batch-heavy') {
    try {
      const { zoneBlocks, nextAllowedAt } = await import('./lanes');
      if (zoneBlocks('batch-heavy')) {
        // nextAllowedAt is null only for a pinned/forced block → fall back to +30m.
        deferUntil = nextAllowedAt('batch-heavy') ?? new Date(Date.now() + 30 * 60_000);
      }
    } catch { /* if the lane manager is unavailable, just run it */ }
  }

  const status = deferUntil ? 'deferred' : 'queued';
  const rows = (await sql`
    insert into atelier_job (workspace_id, kind, agent_slug, status, work_kind, input, run_after)
    values (${ATELIER_WS}, ${kind}, ${agentSlug}, ${status}, ${workKind}, ${sql.json(input as never)}, ${deferUntil ?? null})
    returning id
  `) as unknown as Record<string, unknown>[];
  const id = rows[0].id as string;
  if (!deferUntil) void processJob(id); // fire now; deferred jobs wait for the ticker
  return id;
}

/**
 * Run any deferred jobs that are now due (run_after passed) and whose zone no
 * longer blocks them. Promotes them to 'queued' and fires them. Called by the
 * in-process ticker (instrumentation.ts) and exposed for a manual/cron trigger.
 */
export async function runDueDeferredJobs(): Promise<{ started: string[]; stillDeferred: number }> {
  const due = (await sql`
    select id, work_kind from atelier_job
     where workspace_id = ${ATELIER_WS} and status = 'deferred' and run_after <= now()
     order by run_after asc limit 20
  `) as unknown as { id: string; work_kind: string }[];
  const started: string[] = [];
  const { zoneBlocks } = await import('./lanes');
  for (const j of due) {
    if (zoneBlocks((j.work_kind as WorkKind) ?? 'batch-heavy')) continue; // zone still blocks → leave deferred
    const won = (await sql`
      update atelier_job set status = 'queued' where id = ${j.id} and status = 'deferred' returning id
    `) as unknown as Record<string, unknown>[];
    if (won.length) { started.push(j.id); void processJob(j.id); }
  }
  const rest = (await sql`
    select count(*)::int as n from atelier_job where workspace_id = ${ATELIER_WS} and status = 'deferred'
  `) as unknown as { n: number }[];
  return { started, stillDeferred: rest[0]?.n ?? 0 };
}

export async function enqueueHugoBuild(slug: string, brief: string, heavy = false): Promise<string> {
  return enqueueJob('hugo_build', { slug, brief, heavy }, 'hugo');
}

export async function enqueueVeraResearch(brief: string): Promise<string> {
  return enqueueJob('vera_research', { brief }, 'vera');
}

export async function enqueueMarloweReview(taskId?: string): Promise<string> {
  return enqueueJob('marlowe_review', taskId ? { taskId } : {}, 'marlowe');
}

export async function enqueueLenaPlan(brief: string): Promise<string> {
  return enqueueJob('lena_plan', { brief }, 'lena');
}

export async function enqueueRemyScript(brief: string): Promise<string> {
  return enqueueJob('remy_script', { brief }, 'remy');
}
