-- 0004_atelier_messages.sql
-- Persistent agent conversations — the "talk to Wren, she remembers" layer.
-- The Hermes experience (identity + conversation + memory) in-app; Slack is a
-- later transport over the same store. Idempotent.
CREATE TABLE IF NOT EXISTS atelier_message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  agent_slug   text NOT NULL,                 -- which employee (wren, ...)
  thread       text NOT NULL DEFAULT 'default',
  role         text NOT NULL,                 -- user | assistant
  content      text NOT NULL,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_message_ws_agent_thread_idx
  ON atelier_message (workspace_id, agent_slug, thread, created_at);
