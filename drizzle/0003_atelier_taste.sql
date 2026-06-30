-- 0003_atelier_taste.sql
-- Taste-memory increment: the atelier_taste_memory table on Evergreen's shared Postgres.
-- Records approve/reject/edit/love signals so Marlowe and the merge-ledger can learn what passes.
-- Idempotent. No FKs to external tables (plain uuid columns).
-- Every row carries workspace_id (single seeded workspace).
-- Requires the pgvector extension (the `vector` type is already available on the shared DB).

-- atelier_taste_memory -----------------------------------------------------
CREATE TABLE IF NOT EXISTS atelier_taste_memory (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL,
  subject_kind       text,                        -- task | style_card | proof | reference | resolved_spec
  subject_ref        jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal             text,                        -- approved | rejected | edited | loved
  kind               text,                        -- taste | veto | build
  weight             real NOT NULL DEFAULT 1,
  embedding          vector(1536),                -- nullable; real pgvector
  source_approval_id uuid,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atelier_taste_memory_ws_kind_idx
  ON atelier_taste_memory (workspace_id, kind);
