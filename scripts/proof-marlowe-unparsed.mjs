// scripts/proof-marlowe-unparsed.mjs
//
// Proof harness for QUEUE ticket `atelier-marlowe-parse-fabrication`:
// a garbled critique response must record as "unparsed" (no read), never as a
// fabricated verdict/score on the scoreboard.
//
// Run (repo root): npx tsx scripts/proof-marlowe-unparsed.mjs
//
// Part A — pure: parseCritique on garbled / partial / valid input never
//          synthesizes a score (the old 0.7/0.4 fabrication) and only reports
//          numbers the model actually said.
// Part B — transport failures: critique() with a failing/garbled fetch returns
//          score null (no fabricated 0), and flags NO_CRITIQUE_PARSED.
// Part C — live DB: reviewLatestWren() with a garbled model response logs a
//          dossier entry with payload.class = 'unparsed' and NO verdict key,
//          and the scoreboard's ship/revise counts move by exactly zero.
//          (Writes one honest append-only "couldn't get a clean read" note.)

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// --- tiny .env.local loader (worktree first, then the main checkout) ---------
for (const p of [
  resolve(process.cwd(), '.env.local'),
  resolve(process.cwd(), '../../atelier-evergreen/.env.local'),
]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
  break;
}

const { parseCritique, critique, reviewLatestWren } = await import('../lib/agents/marlowe.ts');
const { getScoreboard } = await import('../lib/scoreboard.ts');
const { sql } = await import('../lib/db.ts');

let failures = 0;
function check(label, ok, actual) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — got: ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

// ── Part A: parseCritique never fabricates ──────────────────────────────────
console.log('— Part A: parseCritique (pure) —');

const garbled = parseCritique('%%% TOTAL GARBAGE — the 9b model rambled, no JSON at all {{{');
check('total garble → score is null (not 0, not 0.4)', garbled.score === null, garbled);
check('total garble → no issues invented', garbled.issues.length === 0, garbled);

const partial = parseCritique('```json\n{"note":"decent headline set","issues":[{"problem":"vague CTA","fix":"name the outcome"}]}\n```');
check('partial parse (no score key) → score is null (not 0.7)', partial.score === null, partial);
check('partial parse → real issues kept', partial.issues.length === 1 && partial.issues[0].problem === 'vague CTA', partial);

const valid = parseCritique('{"verdict":"ship","onBrand":true,"score":0.85,"issues":[],"note":"clean"}');
check('valid response → model\'s own score passes through', valid.score === 0.85 && valid.verdict === 'ship', valid);

// ── Part B: critique() transport/parse failures carry no fabricated score ───
console.log('— Part B: critique() failure paths —');
const realFetch = globalThis.fetch;

globalThis.fetch = async () => ({ ok: false, status: 500 });
const httpFail = await critique('Some headline copy', 'harness copy');
check('HTTP 500 → score null (no fabricated 0), error set', httpFail.score === null && httpFail.error === 'OLLAMA_HTTP_500', httpFail);

globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'NOT JSON >>> beep boop' } }) });
const parseFail = await critique('Some headline copy', 'harness copy');
check('garbled body → score null + NO_CRITIQUE_PARSED', parseFail.score === null && parseFail.error === 'NO_CRITIQUE_PARSED', parseFail);
check('garbled body → no synthesized 0.7/0.4 anywhere', parseFail.score !== 0.7 && parseFail.score !== 0.4, parseFail);

// ── Part C: reviewLatestWren records 'unparsed', scoreboard delta = 0 ───────
console.log('— Part C: live DB — unparsed read, zero scoreboard delta —');

const before = (await getScoreboard(30)).wrenReviews;
console.log(`scoreboard before: ship=${before.ship} revise=${before.revise}`);

globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: 'GARBLED {{{ not json — harness-injected' } }) });
const r = await reviewLatestWren();
globalThis.fetch = realFetch;

if (r.error === 'NO_WREN_DECISION') {
  console.log('SKIP  Part C: no wren decision task in the workspace (nothing to review)');
} else {
  check('garbled read → ok:false, NO_CRITIQUE_PARSED', r.ok === false && r.error === 'NO_CRITIQUE_PARSED', r);

  const rows = await sql`
    select body, payload from atelier_dossier_entry
     where employee_slug = 'marlowe' and payload->>'agent' = 'marlowe'
     order by created_at desc limit 1`;
  const entry = rows[0];
  check("dossier entry → payload.class = 'unparsed'", entry?.payload?.class === 'unparsed', entry);
  check('dossier entry → NO verdict key (excluded from ship/revise counts)', entry && !('verdict' in entry.payload), entry);
  check('dossier entry → NO score key (excluded from any average)', entry && !('score' in entry.payload), entry);
  console.log(`dossier body: ${entry?.body}`);

  const after = (await getScoreboard(30)).wrenReviews;
  console.log(`scoreboard after:  ship=${after.ship} revise=${after.revise}`);
  check('scoreboard ship/revise delta is exactly zero', after.ship === before.ship && after.revise === before.revise, { before, after });
}

await sql.end({ timeout: 5 });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASS');
process.exit(failures ? 1 : 0);
