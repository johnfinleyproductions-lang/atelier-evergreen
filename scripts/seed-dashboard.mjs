// Enrich the "Launch Course 19" dossier so the Project Command Center is
// populated across all 6 stages: tasks per stage employee, a Decision Needed,
// activity-feed entries, and render proofs with screenshots. Idempotent.
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const url = readFileSync('.env.local', 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL=')).slice(13);
const sql = postgres(url, { prepare: false });
const WS = '00000000-0000-0000-0000-000000000a11';

const [d] = await sql`select id from atelier_dossier where workspace_id=${WS} and slug='launch-course-19' limit 1`;
if (!d) { console.error('dossier launch-course-19 not found — run npm run seed first'); process.exit(1); }
const DID = d.id;

const shots = readdirSync(path.join('public', 'uploads', 'atelier-qa')).filter((f) => f.endsWith('.png'));
const shot = (i) => (shots.length ? `/uploads/atelier-qa/${shots[i % shots.length]}` : null);

// Wipe prior dashboard-seed rows for idempotency (only our tagged ones).
await sql`delete from atelier_proof where workspace_id=${WS} and detail->>'seed'='dashboard'`;
await sql`delete from atelier_dossier_entry where workspace_id=${WS} and payload->>'seed'='dashboard'`;
await sql`delete from atelier_task where workspace_id=${WS} and spec->>'seed'='dashboard'`;

// stage, slug, title, state, kind, proof?(kind,status,score,shotIdx)
const TASKS = [
  ['vera', 'Competitor + SEO research', 'shipped', 'research', null],
  ['vera', 'Audience pain points + angle', 'shipped', 'research', null],
  ['iris', 'Hero design in @warm-editorial', 'review', 'build', ['render_qc', 'pass', 0.94, 0]],
  ['iris', 'Workbook cover', 'review', 'build', ['render_qc', 'pass', 0.88, 1]],
  ['hugo', 'Build course-19 landing page', 'active', 'build', null],
  ['hugo', 'Wire enrollment form', 'captured', 'build', null],
  ['remy', 'Promo video — VO + thumbnail', 'captured', 'media', null],
  ['marlowe', 'Brand-lock conformance review', 'captured', 'review', null],
  ['lena', 'Launch sequence + scheduling', 'captured', 'distribute', null],
];

let nTask = 0, nProof = 0;
for (const [slug, title, state, kind, proof] of TASKS) {
  const [t] = await sql`
    insert into atelier_task (workspace_id, dossier_id, assignee_employee_slug, title, intent, kind, state, station, spec, proof_status)
    values (${WS}, ${DID}, ${slug}, ${title}, ${title}, ${kind}, ${state}, ${kind},
            ${sql.json({ seed: 'dashboard' })}, ${proof && proof[1] === 'pass' ? 'passing' : 'pending'})
    returning id`;
  nTask++;
  if (proof) {
    const [pr] = proof[1] === 'pass' && proof[3] != null
      ? await sql`
        insert into atelier_proof (workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
        values (${WS}, ${t.id}, ${slug}, ${proof[0]}, ${proof[1]}, ${proof[2]}, 0.6,
                ${sql.json({ seed: 'dashboard', screenshotRef: shot(proof[3]), gate: 'verify' })})
        returning id`
      : await sql`
        insert into atelier_proof (workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
        values (${WS}, ${t.id}, ${slug}, ${proof[0]}, ${proof[1]}, ${proof[2]}, 0.6, ${sql.json({ seed: 'dashboard' })})
        returning id`;
    await sql`update atelier_task set latest_proof_id=${pr.id} where id=${t.id}`;
    nProof++;
  }
}

// Decision Needed — a real kind='decision' task with options.
await sql`
  insert into atelier_task (workspace_id, dossier_id, assignee_employee_slug, title, kind, state, spec, proof_status)
  values (${WS}, ${DID}, 'cleo', 'Which positioning angle should we lead with?', 'decision', 'review',
          ${sql.json({
            seed: 'dashboard',
            question: 'Which primary positioning angle should we lead with?',
            options: [
              { key: 'fast', label: 'Fast & Easy Setup', detail: 'Get started in minutes' },
              { key: 'premium', label: 'Premium Quality', detail: 'Best-in-class results' },
              { key: 'trusted', label: 'Trusted & Reliable', detail: 'Used by thousands' },
            ],
          })}, ${'pending'})`;
nTask++;

// Activity feed (the Dossier log).
const ACT = [
  ['vera', 'Completed competitor analysis — 3 gaps found', 'note'],
  ['iris', 'Generated 6 hero options; 0.94 match on the lead', 'asset'],
  ['iris', 'Created workbook cover concept', 'asset'],
  ['hugo', 'Scaffolded the landing route; build in progress', 'note'],
  ['vera', 'Extracted key product benefits from the brief', 'note'],
  ['marlowe', 'Queued brand-lock review for the hero', 'note'],
];
let nAct = 0;
for (const [slug, body, type] of ACT) {
  await sql`
    insert into atelier_dossier_entry (workspace_id, dossier_id, employee_slug, entry_type, body, payload)
    values (${WS}, ${DID}, ${slug}, ${type}, ${body}, ${sql.json({ seed: 'dashboard' })})`;
  nAct++;
}

console.log(`[seed-dashboard] tasks:${nTask} proofs:${nProof} activity:${nAct} on Launch Course 19`);
await sql.end();
