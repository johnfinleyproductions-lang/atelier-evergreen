-- 0008_atelier_kv.sql
-- Tiny durable key-value store for background sweeps (Otto's substrate watcher
-- state, Cleo's last-brief date). Survives restarts so a redeploy never
-- re-announces an old incident or double-posts a morning brief. Idempotent.
CREATE TABLE IF NOT EXISTS atelier_kv (
  workspace_id uuid NOT NULL,
  key          text NOT NULL,
  value        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
