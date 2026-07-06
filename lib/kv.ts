// lib/kv.ts — durable key-value helpers for background sweeps.
import { sql } from './db';
import { ATELIER_WS } from './atelier';

export async function kvGet<T>(key: string): Promise<T | null> {
  const rows = (await sql`
    select value from atelier_kv where workspace_id = ${ATELIER_WS} and key = ${key} limit 1
  `) as unknown as { value: T }[];
  return rows[0]?.value ?? null;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await sql`
    insert into atelier_kv (workspace_id, key, value, updated_at)
    values (${ATELIER_WS}, ${key}, ${sql.json(value as never)}, now())
    on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()
  `;
}
