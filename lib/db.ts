// @ts-nocheck
// lib/db.ts — Atelier DB client (model-radar pattern).
//
// Atelier is a standalone Next.js app that CONNECTS to evergreen-core's existing
// shared Postgres via DATABASE_URL. This module is the single source of the DB
// connection: ONE postgres-js client is created lazily and shared between
//   - `db`  : the drizzle-orm query builder (typed against ./schema)
//   - `sql` : the raw postgres tagged-template (e.g. await sql`select 1`)
//   - `pg`  : the underlying postgres-js client instance (same object as `sql`)
//
// Sharing a single client keeps us to one connection pool across the app, the
// API routes, and scripts/atelier-worker.mjs.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

let client: Sql | null = null;
let drizzleDb: Db | null = null;

function getClient(): Sql {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Atelier reads the shared Evergreen Postgres via DATABASE_URL.",
    );
  }

  if (!client) {
    client = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  return client;
}

function getDb(): Db {
  if (!drizzleDb) {
    drizzleDb = drizzle(getClient(), { schema });
  }

  return drizzleDb;
}

/**
 * Raw postgres-js tagged-template client (singleton).
 * Usage: const rows = await sql`select * from atelier_task where workspace_id = ${ws}`;
 */
export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    // postgres-js client is itself a callable tagged-template function.
    return (getClient() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, prop) {
    return (getClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Underlying postgres-js client instance (same singleton as `sql`).
 * Exposed for lifecycle helpers (.end()) and parity with the model-radar pattern.
 */
export const pg: Sql = sql;

/**
 * Drizzle query builder (singleton), typed against ./schema.
 */
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Close the shared connection pool. Used by scripts on shutdown.
 */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = null;
    drizzleDb = null;
  }
}
