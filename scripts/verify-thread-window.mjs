// scripts/verify-thread-window.mjs
//
// Proof harness for QUEUE ticket atelier-getthread-oldest-n:
// a 25-message thread must feed the model the LAST 12 messages, newest included.
//
// Exercises the REAL read path (lib/agents/chat.ts getThread + wren-chat.ts
// getWrenThread — the two sites the audit flagged), not a copy of the SQL:
//   1. seeds 25 messages into a uniquely-named scratch thread (additive only,
//      explicit spaced created_at so ordering is deterministic),
//   2. calls getThread(slug, thread, 20) and slices -12 exactly as agentChat does,
//   3. asserts the window is messages #14..#25 with #25 (the newest) last,
//   4. repeats the assertion through getWrenThread,
//   5. deletes the scratch rows (finally-block, also on failure).
//
// Run from the repo root: npx --no-install tsx scripts/verify-thread-window.mjs
// Exit 0 = PASS, 1 = FAIL. Needs DATABASE_URL (.env.local at the repo root).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- tiny .env.local loader (only fills values that aren't already set) ------
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const { sql, closeDb } = await import("../lib/db.ts");
const { ATELIER_WS } = await import("../lib/atelier.ts");
const { getThread } = await import("../lib/agents/chat.ts");
const { getWrenThread } = await import("../lib/agents/wren-chat.ts");

const SLUG = "wren"; // both flagged read paths key on an agent; wren covers each
const THREAD = `verify-window-${Date.now()}`;
const TOTAL = 25;
const FETCH = 20; // agentChat: getThread(slug, thread, 20)
const WINDOW = 12; // agentChat: history.slice(-12)

const label = (i) => `window-probe #${i}`;

function assertWindow(name, history) {
  const window = history.slice(-WINDOW).map((m) => m.content);
  const expected = [];
  for (let i = TOTAL - WINDOW + 1; i <= TOTAL; i++) expected.push(label(i));
  const pass =
    history.length === FETCH &&
    window.length === WINDOW &&
    JSON.stringify(window) === JSON.stringify(expected);
  console.log(`\n[${name}] fetched=${history.length} window=${window.length}`);
  console.log(`[${name}] window contents: ${window.join(", ")}`);
  console.log(
    `[${name}] newest (#${TOTAL}) present: ${window.includes(label(TOTAL))}, last in window: ${window[window.length - 1] === label(TOTAL)}`,
  );
  console.log(`[${name}] ${pass ? "PASS" : "FAIL"} (expected #${TOTAL - WINDOW + 1}..#${TOTAL} in order)`);
  return pass;
}

let ok = false;
try {
  const base = Date.now() - TOTAL * 1000;
  for (let i = 1; i <= TOTAL; i++) {
    const at = new Date(base + i * 1000).toISOString();
    const role = i % 2 === 1 ? "user" : "assistant";
    await sql`
      insert into atelier_message (workspace_id, agent_slug, thread, role, content, created_at)
      values (${ATELIER_WS}, ${SLUG}, ${THREAD}, ${role}, ${label(i)}, ${at}::timestamptz)
    `;
  }
  console.log(`Seeded ${TOTAL} messages into scratch thread '${THREAD}' (agent '${SLUG}').`);

  const viaChat = await getThread(SLUG, THREAD, FETCH);
  const viaWren = await getWrenThread(THREAD, FETCH);
  ok = assertWindow("getThread", viaChat) && assertWindow("getWrenThread", viaWren);
} catch (err) {
  console.error("verify-thread-window errored:", err instanceof Error ? err.message : err);
  ok = false;
} finally {
  try {
    const gone = await sql`
      delete from atelier_message
       where workspace_id = ${ATELIER_WS} and agent_slug = ${SLUG} and thread = ${THREAD}
    `;
    console.log(`\nCleaned up ${gone.count} scratch rows from '${THREAD}'.`);
  } catch (err) {
    console.error(`CLEANUP FAILED for thread '${THREAD}':`, err instanceof Error ? err.message : err);
  }
  await closeDb();
}

console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
