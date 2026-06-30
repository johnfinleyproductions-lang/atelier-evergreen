-- 0006_atelier_job_zones.sql
-- Zone enforcement for the lane manager (Phase 3). A job can be 'batch-heavy';
-- when the active zone blocks that work, the job is parked as status='deferred'
-- with run_after = when the block lifts, and an in-process ticker runs it then.
-- Interactive jobs are unaffected. Idempotent.
ALTER TABLE atelier_job ADD COLUMN IF NOT EXISTS work_kind text NOT NULL DEFAULT 'interactive'; -- interactive | batch-heavy
ALTER TABLE atelier_job ADD COLUMN IF NOT EXISTS run_after timestamptz;                          -- earliest time a deferred job may run

-- Fast lookup of deferred jobs that are due.
CREATE INDEX IF NOT EXISTS atelier_job_deferred_idx
  ON atelier_job (workspace_id, status, run_after) WHERE status = 'deferred';
