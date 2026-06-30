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

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  kind: string;
  agentSlug: string | null;
  status: JobStatus;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function mapRow(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    kind: r.kind as string,
    agentSlug: (r.agent_slug as string | null) ?? null,
    status: r.status as JobStatus,
    input: (r.input as Record<string, unknown>) ?? {},
    result: (r.result as Record<string, unknown> | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : null,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
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
    return hugoBuild(slug, brief);
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
      const model = JOB_MODEL[job.kind];
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

/** Enqueue a job and start it in the background. Returns the job id immediately. */
export async function enqueueJob(
  kind: string,
  input: Record<string, unknown>,
  agentSlug: string | null = null,
): Promise<string> {
  const rows = (await sql`
    insert into atelier_job (workspace_id, kind, agent_slug, status, input)
    values (${ATELIER_WS}, ${kind}, ${agentSlug}, 'queued', ${sql.json(input as never)})
    returning id
  `) as unknown as Record<string, unknown>[];
  const id = rows[0].id as string;
  void processJob(id); // fire-and-forget on the persistent server
  return id;
}

export async function enqueueHugoBuild(slug: string, brief: string): Promise<string> {
  return enqueueJob('hugo_build', { slug, brief }, 'hugo');
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
