-- 0007_atelier_thread_read.sql
-- Last-read watermarks for the cross-agent inbox: one row per (agent, thread),
-- single-user. An assistant message newer than the watermark is "unread" —
-- this is what surfaces proactive job report-backs the user hasn't seen.
-- Idempotent.
CREATE TABLE IF NOT EXISTS atelier_thread_read (
  workspace_id uuid NOT NULL,
  agent_slug   text NOT NULL,
  thread       text NOT NULL DEFAULT 'default',
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_slug, thread)
);
