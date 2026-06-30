// scripts/apply-migration.mjs
//
// Applies the Atelier spine migration (drizzle/0001_atelier_spine.sql) against the
// shared Evergreen Postgres referenced by DATABASE_URL. This is the "model-radar
// pattern": a standalone app connecting to evergreen-core's existing database.
//
// Usage:  node scripts/apply-migration.mjs
//         (DATABASE_URL is read from .env.local at the repo root)
//
// Week-1 walking skeleton: no migration framework — we just execute the raw SQL.
// The SQL is written to be idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX
// IF NOT EXISTS), so re-running this script is safe.

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Minimal .env.local loader (no dependency). Parses KEY=VALUE lines, ignores
 * blanks and comments, strips surrounding quotes, and does NOT overwrite vars
 * already present in process.env.
 */
function loadEnvLocal() {
  const envPath = resolve(ROOT, ".env.local");
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    // No .env.local — fall back to whatever is already in process.env.
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function main() {
  loadEnvLocal();

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error(
      "[apply-migration] DATABASE_URL is not set. Add it to .env.local (the shared Evergreen DB)."
    );
    process.exit(1);
  }

  const migrationPath = resolve(ROOT, "drizzle", "0001_atelier_spine.sql");
  let migrationSql;
  try {
    migrationSql = readFileSync(migrationPath, "utf8");
  } catch (err) {
    console.error(
      `[apply-migration] Could not read migration file at ${migrationPath}`
    );
    console.error(err);
    process.exit(1);
  }

  console.log("[apply-migration] Connecting to shared Evergreen Postgres...");
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

  try {
    console.log(
      "[apply-migration] Executing drizzle/0001_atelier_spine.sql (atelier_* spine)..."
    );
    // postgres-js: sql.unsafe() uses the simple query protocol, which supports
    // multiple semicolon-separated statements in a single call.
    await sql.unsafe(migrationSql);
    console.log("[apply-migration] Migration applied successfully.");
  } catch (err) {
    console.error("[apply-migration] Migration FAILED:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("[apply-migration] Unexpected error:");
  console.error(err);
  process.exit(1);
});
