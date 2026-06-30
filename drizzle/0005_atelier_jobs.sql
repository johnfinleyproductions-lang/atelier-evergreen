-- 0005_atelier_jobs.sql
-- Async job queue — lets long-running agent work (Hugo's coder-model build, which
-- can take ~30–90s) run in the background instead of blocking the HTTP request.
-- The API enqueues a job and returns immediately with a jobId; the client polls
-- /api/job/[id]. A tiny in-process runner (lib/jobs.ts) executes the job on the
-- persistent `next start` server. Idempotent.
CREATE TABLE IF NOT EXISTS atelier_job (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  kind         text NOT NULL,                  -- 'hugo_build'
  agent_slug   text,                           -- which employee (hugo, ...)
  status       text NOT NULL DEFAULT 'queued', -- queued | running | done | error
  input        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result       jsonb,                          -- the agent's typed result on success
  error        text,                           -- error message on failure
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS atelier_job_ws_status_idx
  ON atelier_job (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS atelier_job_ws_kind_idx
  ON atelier_job (workspace_id, kind, created_at DESC);
