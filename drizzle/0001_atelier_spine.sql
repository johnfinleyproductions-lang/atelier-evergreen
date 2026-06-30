-- 0001_atelier_spine.sql
-- Atelier spine: the 7 atelier_ tables on Evergreen's shared Postgres.
-- Idempotent. No FKs to external tables (plain uuid columns).
-- Every table carries workspace_id (single seeded workspace in week 1).

-- atelier_employee ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_employee (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  slug          text NOT NULL,
  name          text NOT NULL,
  role          text,
  tier          text,                       -- staff | specialist
  brain_model   text,
  voice_id      text,
  status        text NOT NULL DEFAULT 'idle', -- idle | working | blocked | waiting
  system_prompt text,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- slug unique per workspace
CREATE UNIQUE INDEX IF NOT EXISTS atelier_employee_ws_slug_uq
  ON atelier_employee (workspace_id, slug);

-- atelier_view_spec --------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_view_spec (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL,
  employee_slug  text,
  key            text,
  layout         text,                       -- lanes | grid | time_axis | status_wall | build_line | radar
  filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  columns        jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- atelier_dossier ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_dossier (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL,
  slug                  text,
  title                 text,
  objective             text,
  status                text NOT NULL DEFAULT 'active',
  current_station       text,
  current_employee_slug text,
  artifact_ref          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- atelier_task -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_task (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL,
  dossier_id             uuid,
  assignee_employee_slug text,
  title                  text NOT NULL,
  intent                 text,
  state                  text NOT NULL DEFAULT 'captured', -- captured | scoped | active | proofed | review | shipped
  station                text,
  kind                   text,
  spec                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  proof_status           text NOT NULL DEFAULT 'pending',  -- pending | passing | failing
  latest_proof_id        uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  shipped_at             timestamptz
);
CREATE INDEX IF NOT EXISTS atelier_task_ws_state_idx
  ON atelier_task (workspace_id, state);
CREATE INDEX IF NOT EXISTS atelier_task_ws_proof_status_idx
  ON atelier_task (workspace_id, proof_status);

-- atelier_proof (APPEND-ONLY, no updated_at) -------------------------------
CREATE TABLE IF NOT EXISTS atelier_proof (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  task_id       uuid NOT NULL,
  employee_slug text,
  kind          text,                        -- build | match_score | passing_test | render_qc | lint
  status        text,                        -- pass | fail | warn
  score         real,
  threshold     real,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_proof_task_idx
  ON atelier_proof (task_id);

-- atelier_dossier_entry (APPEND-ONLY) --------------------------------------
CREATE TABLE IF NOT EXISTS atelier_dossier_entry (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  dossier_id    uuid NOT NULL,
  task_id       uuid,
  employee_slug text,
  entry_type    text,                        -- handoff | note | decision | proof | approval | revision | asset
  from_station  text,
  to_station    text,
  body          text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_dossier_entry_dossier_idx
  ON atelier_dossier_entry (dossier_id);

-- atelier_approval ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_approval (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  task_id      uuid NOT NULL,
  proof_id     uuid,
  decision     text,                         -- approved | rejected | revise
  comment      text,
  decided_at   timestamptz NOT NULL DEFAULT now()
);
