# Atelier

Atelier is a standalone Next.js app that runs **CLEO's Floor** — a proof-gated production line for AI employees. Tasks flow through stations (`captured → scoped → active → proofed → review → shipped`), each AI employee renders the same shared data model as a role-appropriate board (a ViewSpec), and **nothing reaches you for approval until a machine-verified proof passes**. Atelier is its own repo with its own UI, but it shares Evergreen's existing Postgres via `DATABASE_URL` (the "model-radar pattern") — every `atelier_*` table carries a `workspace_id` and Week-1 defaults to a single seeded workspace.

---

## The Week-1 walking skeleton

This is a deliberately thin vertical slice that proves the spine end to end:

- **Shared DB schema** — seven `atelier_*` tables (employee, view_spec, dossier, task, proof, dossier_entry, approval) created by a Drizzle migration against the shared Evergreen Postgres.
- **The proof gate** — a task may move to `state='review'` **only** if it has an `atelier_proof` row with `status='pass'`. `PATCH /api/task` enforces this and rejects with `422 {error:"PROOF_REQUIRED"}` otherwise. This is the heart of the product.
- **CLEO's Floor** (`/`) — server-rendered from `getFloor()`: a header brief, a **NEEDS-YOU** batched list of `review` tasks each with an Approve form, an in-flight grid of employees, and a shipped strip.
- **Role boards** (`/employee/[slug]`) — the same task data rendered as a `lanes` ViewSpec (columns by state), proving one data model → many role views.
- **The worker** (`scripts/atelier-worker.mjs`) — polls `active` tasks, runs a deterministic build-proof, writes an `atelier_proof`, and advances `active → proofed`.

No Better-Auth, no Tailwind, no multi-tenant routing yet. Auth is deferred (LAN/Tailscale-local). Every query is scoped to:

```
ATELIER_WS = '00000000-0000-0000-0000-000000000a11'
```

---

## Stack

- **Next 15** (App Router) · **React 19** · **TypeScript 5.8**
- **drizzle-orm** `^0.45` (postgres-js driver) · **postgres** `^3.4`
- **tsx** for TS scripts; `.mjs` scripts run on plain Node
- Plain CSS (teal `#0d9488` / gold `#c79320` / page `#f5f3ec` / ink `#15201c`)
- Port **3040**

---

## Setup

Requires Node 20+ and access to the shared Evergreen Postgres.

```bash
# 1. Configure the DB connection (the shared Evergreen Postgres)
cp .env.example .env.local
#    then edit .env.local and set DATABASE_URL=postgres://...

# 2. Install dependencies
npm install

# 3. Create the atelier_* tables in the shared DB
npm run migrate

# 4. Seed the default workspace, employees, and a few demo tasks
npm run seed

# 5. Run the app  →  http://localhost:3040
npm run dev

# 6. In a second terminal, run the proof worker
npm run worker
```

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | The shared Evergreen Postgres connection string. |
| `ATELIER_OPENCODE_STUB` | no | Set to `1` to stub OpenCode dispatch (no M90t needed) for the walking-skeleton acceptance. |

---

## Walking-skeleton acceptance test

This is the proof that the spine works. Run it after `npm run seed` with the app and worker both running.

**1. The Floor renders.** Open `http://localhost:3040`. You see CLEO's Floor: a header brief, the NEEDS-YOU list, an in-flight employee grid, and the shipped strip.

**2. A role board renders the same data.** Open `http://localhost:3040/employee/<slug>` (use a seeded employee slug). The same tasks appear as `lanes` columns keyed by `state` — one data model, a role-specific view.

**3. The proof gate blocks an unproven move.** Pick a task that has **no** passing proof and try to move it to `review`:

```bash
curl -i -X PATCH http://localhost:3040/api/task \
  -H 'content-type: application/json' \
  -d '{"taskId":"<TASK_ID>","toState":"review"}'
# → HTTP/1.1 422   {"error":"PROOF_REQUIRED"}
```

The move is rejected. This is the single most important behavior in the product.

**4. The worker proves an active task.** A seeded `active` task is picked up by `scripts/atelier-worker.mjs`, which runs a build-proof, writes an `atelier_proof` with `status='pass'`, and auto-advances the task `active → proofed`. Watch the worker logs; the task leaves the in-flight grid as `proofed`.

**5. The gate now allows the move.** With a passing proof attached, the same `PATCH /api/task` to `review` now succeeds and the task surfaces in the Floor's NEEDS-YOU list.

**6. Approve ships it.** Click **Approve** on that task (a form POST to `/api/approve`). The task moves `review → shipped` with `shipped_at` set, a `dossier_entry` of type `approval` is appended, the Floor revalidates, and the task moves to the shipped strip.

If all six steps hold, the walking skeleton is complete: capture → active → machine proof → proof gate → human approval → shipped.

---

## Project layout

```
app/
  layout.tsx                 # imports globals.css, sets <html><body>
  globals.css                # teal/gold/page/ink design tokens
  page.tsx                   # CLEO'S FLOOR (SSR via getFloor())
  employee/[slug]/page.tsx   # lanes ViewSpec for one employee
  _components/               # inline Floor / board components
  api/
    task/route.ts            # PATCH — move task (ENFORCES THE PROOF GATE)
    approve/route.ts         # POST — approve → ship
lib/
  contracts.ts               # zod schemas, TaskState, transitions map
  db.ts                      # { db (drizzle), sql (raw postgres tag) }
  schema.ts                  # drizzle table definitions (atelier_*)
  atelier.ts                 # repository: getFloor, createTask, moveTask, attachProof, approveTask, ...
  opencode-client.ts         # dispatchChunk() → OpenCode on M90t (stub-guarded)
scripts/
  migrate.mjs                # applies the migration to the shared DB
  seed.mjs                   # seeds ATELIER_WS, employees, demo tasks
  atelier-worker.mjs         # polls active tasks, writes build-proofs
drizzle/                     # generated migration SQL
```

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Next dev server on port 3040 |
| `npm run build` | Production build |
| `npm run start` | Serve the production build on port 3040 |
| `npm run migrate` | Create the `atelier_*` tables in the shared DB |
| `npm run seed` | Seed the default workspace, employees, and demo tasks |
| `npm run worker` | Run the proof worker (polls `active` tasks every ~5s) |

---

## Notes

- **Append-only tables:** `atelier_proof` and `atelier_dossier_entry` are never updated — they form the audit trail. The proof IS the receipt.
- **One workspace, for now:** Week-1 hardcodes `ATELIER_WS`. Every table already carries `workspace_id` so real auth and multi-workspace routing drop in later without a schema change.
- **OpenCode is real but stubbable:** `lib/opencode-client.ts` keeps a real dispatch interface; set `ATELIER_OPENCODE_STUB=1` to pass acceptance without the M90t box.
