// scripts/seed.mjs
//
// Atelier — Week-1 walking-skeleton seed.
//
// Standalone Node ESM script (run: `node scripts/seed.mjs`). It talks to the
// shared Evergreen Postgres directly via the `postgres` driver — no Next.js
// runtime, no drizzle — mirroring the apps/model-radar "model-radar pattern".
//
// Everything is workspace-scoped to the single seeded workspace constant
// ATELIER_WS (auth is deferred in week 1). The script is IDEMPOTENT: it uses
// deterministic UUIDs plus ON CONFLICT, so it can be re-run safely.
//   - mutable rows (employees / view_specs / dossier / tasks): ON CONFLICT DO UPDATE
//   - append-only rows (proofs / dossier_entries / approvals): ON CONFLICT DO NOTHING
//
// It seeds the Floor so the UI has something to show on first boot:
//   * 10 employees (3 staff, 7 specialists), each with a default `lanes` view.
//   * one demo dossier "Launch Course 19".
//   * three tasks: one in `review` WITH a pass proof (a Needs-You for Cleo),
//     one `active` (waiting for the worker), one `shipped` (already approved).
//   * supporting proofs, dossier_entries, and one approval.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as postgresModule from "postgres";

// --- tiny .env.local loader (only fills values that aren't already set) -------
const envPath = resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// `postgres` ships as both ESM + CJS; normalize the callable factory.
const createPostgres = (
  "default" in postgresModule ? postgresModule.default : postgresModule
);

// --- the workspace constant (the spine's tenancy key) ------------------------
const ATELIER_WS = "00000000-0000-0000-0000-000000000a11";

// --- deterministic ids (idempotency + cross-row references) ------------------
const ID = {
  // employees e1..ea
  employee: {
    cleo: "00000000-0000-0000-0000-0000000000e1",
    marlowe: "00000000-0000-0000-0000-0000000000e2",
    dewey: "00000000-0000-0000-0000-0000000000e3",
    vera: "00000000-0000-0000-0000-0000000000e4",
    wren: "00000000-0000-0000-0000-0000000000e5",
    iris: "00000000-0000-0000-0000-0000000000e6",
    hugo: "00000000-0000-0000-0000-0000000000e7",
    remy: "00000000-0000-0000-0000-0000000000e8",
    lena: "00000000-0000-0000-0000-0000000000e9",
    otto: "00000000-0000-0000-0000-0000000000ea",
  },
  // view_specs f1..fa (one default `lanes` per employee, same order)
  view: {
    cleo: "00000000-0000-0000-0000-0000000000f1",
    marlowe: "00000000-0000-0000-0000-0000000000f2",
    dewey: "00000000-0000-0000-0000-0000000000f3",
    vera: "00000000-0000-0000-0000-0000000000f4",
    wren: "00000000-0000-0000-0000-0000000000f5",
    iris: "00000000-0000-0000-0000-0000000000f6",
    hugo: "00000000-0000-0000-0000-0000000000f7",
    remy: "00000000-0000-0000-0000-0000000000f8",
    lena: "00000000-0000-0000-0000-0000000000f9",
    otto: "00000000-0000-0000-0000-0000000000fa",
  },
  dossier: "00000000-0000-0000-0000-0000000d0019",
  task: {
    cover: "00000000-0000-0000-0000-000000000101", // review (Needs-You)
    copy: "00000000-0000-0000-0000-000000000102", // active (worker)
    research: "00000000-0000-0000-0000-000000000103", // shipped
  },
  proof: {
    cover: "00000000-0000-0000-0000-000000000201",
    research: "00000000-0000-0000-0000-000000000203",
  },
  entry: {
    handoff: "00000000-0000-0000-0000-000000000301",
    proof: "00000000-0000-0000-0000-000000000302",
    approval: "00000000-0000-0000-0000-000000000303",
    note: "00000000-0000-0000-0000-000000000304",
  },
  approval: "00000000-0000-0000-0000-000000000401",
};

// The six task states, in flow order — the default lane columns.
const LANES = ["captured", "scoped", "active", "proofed", "review", "shipped"];

// --- the cast: 3 staff + 7 specialists ---------------------------------------
const EMPLOYEES = [
  {
    id: ID.employee.cleo,
    slug: "cleo",
    name: "Cleo",
    role: "Studio Director / Floor Lead",
    tier: "staff",
    brain_model: "anthropic/claude-opus-4",
    voice_id: "el_cleo",
    status: "working",
    system_prompt:
      "You are Cleo, the Atelier floor lead. You triage the floor, batch what needs the owner, and never let a task reach review without a passing proof.",
    config: { primaryStation: "floor", canApprove: true },
  },
  {
    id: ID.employee.marlowe,
    slug: "marlowe",
    name: "Marlowe",
    role: "Editor / Proof Marshal",
    tier: "staff",
    brain_model: "anthropic/claude-sonnet-4",
    voice_id: "el_marlowe",
    status: "idle",
    system_prompt:
      "You are Marlowe, the proof marshal. You define the bar for each task kind and read every proof before it counts.",
    config: { primaryStation: "review" },
  },
  {
    id: ID.employee.dewey,
    slug: "dewey",
    name: "Dewey",
    role: "Archivist / Dossier Keeper",
    tier: "staff",
    brain_model: "qwen3.5:27b",
    voice_id: "el_dewey",
    status: "idle",
    system_prompt:
      "You are Dewey, the dossier keeper. Every handoff, decision, and asset is logged in the dossier — append-only, in order.",
    config: { primaryStation: "archive" },
  },
  {
    id: ID.employee.vera,
    slug: "vera",
    name: "Vera",
    role: "Visual Designer",
    tier: "specialist",
    brain_model: "qwen3.5:27b",
    voice_id: "el_vera",
    status: "waiting",
    system_prompt:
      "You are Vera, the visual designer. You compose covers, layouts, and brand systems, and you ship them to render QC.",
    config: { primaryStation: "design" },
  },
  {
    id: ID.employee.wren,
    slug: "wren",
    name: "Wren",
    role: "Copywriter",
    tier: "specialist",
    brain_model: "anthropic/claude-sonnet-4",
    voice_id: "el_wren",
    status: "working",
    system_prompt:
      "You are Wren, the copywriter. You draft lesson copy, hooks, and microcopy in the house voice.",
    config: { primaryStation: "build" },
  },
  {
    id: ID.employee.iris,
    slug: "iris",
    name: "Iris",
    role: "Illustrator / Image",
    tier: "specialist",
    brain_model: "qwen3.5:27b",
    voice_id: "el_iris",
    status: "idle",
    system_prompt:
      "You are Iris, the illustrator. You author image prompts and assemble image assets for each dossier.",
    config: { primaryStation: "design" },
  },
  {
    id: ID.employee.hugo,
    slug: "hugo",
    name: "Hugo",
    role: "Frontend Builder",
    tier: "specialist",
    brain_model: "qwen3-coder-next",
    voice_id: "el_hugo",
    status: "idle",
    system_prompt:
      "You are Hugo, the frontend builder. You turn specs into working pages and prove them with a build.",
    config: { primaryStation: "build" },
  },
  {
    id: ID.employee.remy,
    slug: "remy",
    name: "Remy",
    role: "Researcher",
    tier: "specialist",
    brain_model: "qwen3.5:27b",
    voice_id: "el_remy",
    status: "idle",
    system_prompt:
      "You are Remy, the researcher. You gather competitor and source material and hand off clean briefs.",
    config: { primaryStation: "research" },
  },
  {
    id: ID.employee.lena,
    slug: "lena",
    name: "Lena",
    role: "Curriculum Architect",
    tier: "specialist",
    brain_model: "anthropic/claude-sonnet-4",
    voice_id: "el_lena",
    status: "idle",
    system_prompt:
      "You are Lena, the curriculum architect. You shape course outlines into modules and lessons.",
    config: { primaryStation: "scope" },
  },
  {
    id: ID.employee.otto,
    slug: "otto",
    name: "Otto",
    role: "Automation / Ops Engineer",
    tier: "specialist",
    brain_model: "qwen3-coder-next",
    voice_id: "el_otto",
    status: "idle",
    system_prompt:
      "You are Otto, the ops engineer. You wire automations, exports, and publishing pipelines.",
    config: { primaryStation: "build" },
  },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Atelier seeds the shared Evergreen Postgres.");
  }

  const sql = createPostgres(connectionString, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  try {
    console.log(`[seed] workspace ${ATELIER_WS}`);

    // 1) Employees -----------------------------------------------------------
    for (const e of EMPLOYEES) {
      await sql`
        insert into atelier_employee
          (id, workspace_id, slug, name, role, tier, brain_model, voice_id, status, system_prompt, config)
        values
          (${e.id}, ${ATELIER_WS}, ${e.slug}, ${e.name}, ${e.role}, ${e.tier},
           ${e.brain_model}, ${e.voice_id}, ${e.status}, ${e.system_prompt},
           ${JSON.stringify(e.config)}::jsonb)
        on conflict (workspace_id, slug) do update set
          name          = excluded.name,
          role          = excluded.role,
          tier          = excluded.tier,
          brain_model   = excluded.brain_model,
          voice_id      = excluded.voice_id,
          status        = excluded.status,
          system_prompt = excluded.system_prompt,
          config        = excluded.config
      `;
    }
    console.log(`[seed] employees: ${EMPLOYEES.length}`);

    // 2) A default `lanes` view_spec per employee ----------------------------
    for (const e of EMPLOYEES) {
      const viewId = ID.view[e.slug];
      await sql`
        insert into atelier_view_spec
          (id, workspace_id, employee_slug, key, layout, filters, columns, is_default)
        values
          (${viewId}, ${ATELIER_WS}, ${e.slug}, ${"lanes"}, ${"lanes"},
           ${JSON.stringify({ assigneeSlug: e.slug })}::jsonb,
           ${JSON.stringify(LANES)}::jsonb,
           ${true})
        on conflict (id) do update set
          employee_slug = excluded.employee_slug,
          key           = excluded.key,
          layout        = excluded.layout,
          filters       = excluded.filters,
          columns       = excluded.columns,
          is_default    = excluded.is_default
      `;
    }
    console.log(`[seed] view_specs: ${EMPLOYEES.length} (lanes default each)`);

    // 3) The demo dossier ----------------------------------------------------
    await sql`
      insert into atelier_dossier
        (id, workspace_id, slug, title, objective, status, current_station, current_employee_slug, artifact_ref)
      values
        (${ID.dossier}, ${ATELIER_WS}, ${"launch-course-19"}, ${"Launch Course 19"},
         ${"Ship Course 19 end to end — research the market, write the lessons, design the cover, and stand up the landing experience."},
         ${"active"}, ${"design"}, ${"vera"},
         ${JSON.stringify({ courseSlug: "course-19", target: "landing+lessons" })}::jsonb)
      on conflict (id) do update set
        slug                  = excluded.slug,
        title                 = excluded.title,
        objective             = excluded.objective,
        status                = excluded.status,
        current_station       = excluded.current_station,
        current_employee_slug = excluded.current_employee_slug,
        artifact_ref          = excluded.artifact_ref
    `;
    console.log(`[seed] dossier: Launch Course 19`);

    // 4) Tasks ---------------------------------------------------------------
    // 4a) review task — has a passing proof, so it shows up as a Needs-You.
    await sql`
      insert into atelier_task
        (id, workspace_id, dossier_id, assignee_employee_slug, title, intent, state, station, kind, spec, proof_status, latest_proof_id, shipped_at)
      values
        (${ID.task.cover}, ${ATELIER_WS}, ${ID.dossier}, ${"vera"},
         ${"Cover art for Course 19"},
         ${"Compose the course cover in the teal/gold house style and pass render QC."},
         ${"review"}, ${"review"}, ${"image"},
         ${JSON.stringify({ ratio: "16:9", palette: ["#0d9488", "#c79320"] })}::jsonb,
         ${"passing"}, ${ID.proof.cover}, ${null})
      on conflict (id) do update set
        dossier_id             = excluded.dossier_id,
        assignee_employee_slug = excluded.assignee_employee_slug,
        title                  = excluded.title,
        intent                 = excluded.intent,
        state                  = excluded.state,
        station                = excluded.station,
        kind                   = excluded.kind,
        spec                   = excluded.spec,
        proof_status           = excluded.proof_status,
        latest_proof_id        = excluded.latest_proof_id,
        shipped_at             = excluded.shipped_at
    `;

    // 4b) active task — waiting for the worker to attach a build proof.
    await sql`
      insert into atelier_task
        (id, workspace_id, dossier_id, assignee_employee_slug, title, intent, state, station, kind, spec, proof_status, latest_proof_id, shipped_at)
      values
        (${ID.task.copy}, ${ATELIER_WS}, ${ID.dossier}, ${"wren"},
         ${"Write Module 1 lesson copy"},
         ${"Draft the three lessons of Module 1 in the house voice, ready for editing."},
         ${"active"}, ${"build"}, ${"copy"},
         ${JSON.stringify({ module: 1, lessons: 3 })}::jsonb,
         ${"pending"}, ${null}, ${null})
      on conflict (id) do update set
        dossier_id             = excluded.dossier_id,
        assignee_employee_slug = excluded.assignee_employee_slug,
        title                  = excluded.title,
        intent                 = excluded.intent,
        state                  = excluded.state,
        station                = excluded.station,
        kind                   = excluded.kind,
        spec                   = excluded.spec,
        proof_status           = excluded.proof_status,
        latest_proof_id        = excluded.latest_proof_id,
        shipped_at             = excluded.shipped_at
    `;

    // 4c) shipped task — already proofed + approved.
    await sql`
      insert into atelier_task
        (id, workspace_id, dossier_id, assignee_employee_slug, title, intent, state, station, kind, spec, proof_status, latest_proof_id, shipped_at)
      values
        (${ID.task.research}, ${ATELIER_WS}, ${ID.dossier}, ${"remy"},
         ${"Research competitor course outlines"},
         ${"Survey the top five comparable courses and hand off a structured outline brief."},
         ${"shipped"}, ${"research"}, ${"research"},
         ${JSON.stringify({ competitors: 5 })}::jsonb,
         ${"passing"}, ${ID.proof.research}, ${sql`now()`})
      on conflict (id) do update set
        dossier_id             = excluded.dossier_id,
        assignee_employee_slug = excluded.assignee_employee_slug,
        title                  = excluded.title,
        intent                 = excluded.intent,
        state                  = excluded.state,
        station                = excluded.station,
        kind                   = excluded.kind,
        spec                   = excluded.spec,
        proof_status           = excluded.proof_status,
        latest_proof_id        = excluded.latest_proof_id,
        shipped_at             = excluded.shipped_at
    `;
    console.log(`[seed] tasks: review(cover) / active(copy) / shipped(research)`);

    // 5) Proofs (append-only) ------------------------------------------------
    await sql`
      insert into atelier_proof
        (id, workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
      values
        (${ID.proof.cover}, ${ATELIER_WS}, ${ID.task.cover}, ${"vera"},
         ${"render_qc"}, ${"pass"}, ${0.94}, ${0.85},
         ${JSON.stringify({ note: "Composition, palette, and legibility all within bar." })}::jsonb)
      on conflict (id) do nothing
    `;
    await sql`
      insert into atelier_proof
        (id, workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
      values
        (${ID.proof.research}, ${ATELIER_WS}, ${ID.task.research}, ${"remy"},
         ${"passing_test"}, ${"pass"}, ${1.0}, ${1.0},
         ${JSON.stringify({ note: "Five competitor outlines captured and structured." })}::jsonb)
      on conflict (id) do nothing
    `;
    console.log(`[seed] proofs: 2 (both pass)`);

    // 6) Dossier entries (append-only) ---------------------------------------
    await sql`
      insert into atelier_dossier_entry
        (id, workspace_id, dossier_id, task_id, employee_slug, entry_type, from_station, to_station, body, payload)
      values
        (${ID.entry.handoff}, ${ATELIER_WS}, ${ID.dossier}, ${ID.task.research}, ${"remy"},
         ${"handoff"}, ${"research"}, ${"build"},
         ${"Competitor research complete — handing the outline brief to Wren for Module 1 copy."},
         ${JSON.stringify({ to: "wren" })}::jsonb)
      on conflict (id) do nothing
    `;
    await sql`
      insert into atelier_dossier_entry
        (id, workspace_id, dossier_id, task_id, employee_slug, entry_type, from_station, to_station, body, payload)
      values
        (${ID.entry.proof}, ${ATELIER_WS}, ${ID.dossier}, ${ID.task.cover}, ${"vera"},
         ${"proof"}, ${null}, ${null},
         ${"Render QC passed at 0.94 (bar 0.85). Cover is ready for the owner to approve."},
         ${JSON.stringify({ proofId: ID.proof.cover, score: 0.94 })}::jsonb)
      on conflict (id) do nothing
    `;
    await sql`
      insert into atelier_dossier_entry
        (id, workspace_id, dossier_id, task_id, employee_slug, entry_type, from_station, to_station, body, payload)
      values
        (${ID.entry.approval}, ${ATELIER_WS}, ${ID.dossier}, ${ID.task.research}, ${"cleo"},
         ${"approval"}, ${null}, ${null},
         ${"Approved the competitor research and shipped it into the dossier."},
         ${JSON.stringify({ approvalId: ID.approval })}::jsonb)
      on conflict (id) do nothing
    `;
    await sql`
      insert into atelier_dossier_entry
        (id, workspace_id, dossier_id, task_id, employee_slug, entry_type, from_station, to_station, body, payload)
      values
        (${ID.entry.note}, ${ATELIER_WS}, ${ID.dossier}, ${null}, ${"dewey"},
         ${"note"}, ${null}, ${null},
         ${"Dossier opened for Course 19. Stations: research -> scope -> build -> design -> review."},
         ${JSON.stringify({})}::jsonb)
      on conflict (id) do nothing
    `;
    console.log(`[seed] dossier_entries: 4`);

    // 7) Approval (append-only) — the shipped task's decision ----------------
    await sql`
      insert into atelier_approval
        (id, workspace_id, task_id, proof_id, decision, comment)
      values
        (${ID.approval}, ${ATELIER_WS}, ${ID.task.research}, ${ID.proof.research},
         ${"approved"}, ${"Clean brief — good to build from."})
      on conflict (id) do nothing
    `;
    console.log(`[seed] approvals: 1`);

    console.log("[seed] done. Cleo's Floor should show 1 Needs-You, 1 in-flight, 1 shipped.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
