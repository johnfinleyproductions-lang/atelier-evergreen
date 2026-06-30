-- 0002_atelier_style.sql
-- Style Library increment: the 5 atelier_ style tables on Evergreen's shared Postgres.
-- Idempotent. No FKs to external tables (plain uuid columns).
-- Every table carries workspace_id (single seeded workspace).
-- Requires the pgvector extension (the `vector` type is already available on the shared DB).

-- atelier_reference --------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_reference (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  source_type     text,                       -- upload | url | folder | generated
  image_url       text,
  screenshot_path text,
  dedupe_hash     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- atelier_style_profile ----------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_style_profile (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  reference_id  uuid,
  model         text NOT NULL DEFAULT 'qwen2.5-vl',
  layout        jsonb NOT NULL DEFAULT '{}'::jsonb,
  palette       jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{hex, weight}]
  typography    jsonb NOT NULL DEFAULT '{}'::jsonb,
  spacing       jsonb NOT NULL DEFAULT '{}'::jsonb,
  mood          jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding     vector(1536),                 -- nullable; real pgvector
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_style_profile_reference_idx
  ON atelier_style_profile (reference_id);

-- atelier_style_card -------------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_style_card (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL,
  handle            text,                       -- the @mention, unique-per-ws
  name              text,
  merged_profile    jsonb NOT NULL DEFAULT '{}'::jsonb,
  hero_reference_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  do_rules          jsonb NOT NULL DEFAULT '[]'::jsonb,
  dont_rules        jsonb NOT NULL DEFAULT '[]'::jsonb,
  brand_locked      boolean NOT NULL DEFAULT true,
  usage_count       integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'ready',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_style_card_ws_handle_idx
  ON atelier_style_card (workspace_id, handle);

-- atelier_brand_rubric -----------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_brand_rubric (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL,
  name          text,
  tokens        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {colors:{teal,gold,page,ink}, type, spacing, rules[]}
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- atelier_style_injection --------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_style_injection (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL,
  task_id         uuid,
  style_card_id   uuid,
  brand_rubric_id uuid,
  ledger          jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_spec   jsonb NOT NULL DEFAULT '{}'::jsonb,
  conflicts       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
