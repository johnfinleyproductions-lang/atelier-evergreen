// scripts/verify-proof-registry.ts
//
// Proof harness for the wren-proof-bypass ticket (run: `npx tsx scripts/verify-proof-registry.ts`).
// Proves, against the live DB, that:
//   A. moveTask REJECTS active → 'review' with PROOF_REQUIRED when no passing
//      proof exists (no path reaches review without a proof).
//   B. processJob fires the per-role proof-checker registry for the task a job
//      targets: a marlowe_review job over a Wren decision task runs wren's
//      option_set checker, attaches the proof, auto-advances active → proofed,
//      and logs a [proof-registry] "checker fired" line — after which the move
//      to 'review' succeeds.
//
// The harness is additive and self-cleaning: it creates ONE synthetic
// dossier-less decision task (dossier-less ⇒ no dossier entries are journaled)
// plus one job row with agent_slug = null (⇒ no chat announce), and deletes
// both (and the attached proofs) at the end. It never touches existing rows.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env.local before importing anything that opens the DB (seed.mjs pattern).
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const results: { name: string; pass: boolean; evidence: string }[] = [];
function check(name: string, pass: boolean, evidence: string) {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
}

async function main() {
  const { sql } = await import('../lib/db');
  const { ATELIER_WS, createTask, moveTask, getTask } = await import('../lib/atelier');
  const { processJob } = await import('../lib/jobs');

  const task = await createTask({
    title: '[grind-verify] wren proof-registry harness',
    intent: 'synthetic task for scripts/verify-proof-registry.ts — safe to delete',
    kind: 'decision',
    assigneeSlug: 'wren',
  });
  let jobId: string | null = null;

  try {
    await moveTask(task.id, 'scoped');
    await moveTask(task.id, 'active');

    // A. The gate: review must be unreachable without a passing proof, even
    // from 'proofed' (the only state the transition map lets into review).
    await moveTask(task.id, 'proofed');
    try {
      await moveTask(task.id, 'review');
      check('A. gate blocks proofless review', false, 'moveTask(review) unexpectedly succeeded');
    } catch (err) {
      const code = (err as { code?: string }).code;
      check('A. gate blocks proofless review', code === 'PROOF_REQUIRED', `moveTask(proofed → review) threw code=${code}`);
    }
    await moveTask(task.id, 'active'); // back to active for part B

    // B. Give the task a wren option set, then run a marlowe_review job over it.
    const options = [
      'Ship your first agent this weekend',
      'What nobody tells you about local models',
      'Stop renting intelligence you could own',
      'The 20-minute path to a private AI',
      'Why your best ideas die in drafts',
      'Own the stack, keep the moat',
    ].map((label, i) => ({ key: `h${i + 1}`, label, detail: `Option ${i + 1} · harness` }));
    await sql`
      update atelier_task set spec = ${sql.json({ agent: 'wren', question: 'Which headline should we lead with?', options } as never)}
       where id = ${task.id} and workspace_id = ${ATELIER_WS}
    `;

    const jobRows = (await sql`
      insert into atelier_job (workspace_id, kind, agent_slug, status, work_kind, input)
      values (${ATELIER_WS}, 'marlowe_review', null, 'queued', 'interactive', ${sql.json({ taskId: task.id } as never)})
      returning id
    `) as unknown as { id: string }[];
    jobId = jobRows[0].id;

    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '));
      origLog(...args);
    };
    try {
      await processJob(jobId);
    } finally {
      console.log = origLog;
    }

    const fired = logLines.find((l) => l.includes('[proof-registry]') && l.includes('checker fired'));
    check('B1. registry checker fired in logs', /option_set:pass/.test(fired ?? ''), fired ?? 'no [proof-registry] "checker fired" line captured');

    const proofs = (await sql`
      select kind, status, employee_slug, score from atelier_proof
       where task_id = ${task.id} and workspace_id = ${ATELIER_WS}
       order by created_at asc
    `) as unknown as { kind: string; status: string; employee_slug: string | null; score: string | null }[];
    const optProof = proofs.find((p) => p.kind === 'option_set');
    check(
      'B2. option_set proof attached by wren',
      optProof?.status === 'pass' && optProof?.employee_slug === 'wren',
      `proof rows: ${JSON.stringify(proofs)}`,
    );

    const afterJob = await getTask(task.id);
    check('B3. task auto-advanced active → proofed', afterJob?.state === 'proofed', `state=${afterJob?.state}, proof_status=${afterJob?.proofStatus}`);

    // With the role check run and passing, review is now reachable.
    const reviewed = await moveTask(task.id, 'review');
    check('B4. review reached only after the role check', reviewed.state === 'review', `state=${reviewed.state}`);
  } finally {
    // Cleanup: the harness rows only (proofs → job → task).
    await sql`delete from atelier_proof where task_id = ${task.id} and workspace_id = ${ATELIER_WS}`;
    if (jobId) await sql`delete from atelier_job where id = ${jobId} and workspace_id = ${ATELIER_WS}`;
    await sql`delete from atelier_task where id = ${task.id} and workspace_id = ${ATELIER_WS}`;
    console.log(`cleanup: removed harness task ${task.id}${jobId ? `, job ${jobId}` : ''}, and its proofs`);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(failed.length === 0 ? 'ALL CHECKS PASS' : `${failed.length} CHECK(S) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS CRASHED:', err);
  process.exit(1);
});
