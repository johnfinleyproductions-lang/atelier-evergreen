// scripts/atelier-worker.mjs
//
// Atelier Week-1 build-proof worker.
//
// Polls atelier_task where state='active' every ~5s. For each active task it
// runs a deterministic build-proof (Week-1: a `next build`-style check, OR the
// stub when ATELIER_OPENCODE_STUB is set), appends an atelier_proof row, updates
// the task's proof_status + latest_proof_id, and — on a passing proof —
// auto-advances the task active -> proofed. Mirrors lib/atelier.ts attachProof.
//
// Idempotent: a passing proof moves the task out of 'active', so it will not be
// re-picked. Failing proofs leave the task in 'active' (proof_status='failing')
// so it can be retried after a fix. Safe to run as a single long-lived process.
//
// Run:  node scripts/atelier-worker.mjs
// Env:  DATABASE_URL              (required — the shared Evergreen Postgres)
//       ATELIER_OPENCODE_STUB=1   (skip the real build, emit a passing stub proof)
//       ATELIER_PROOF_CMD         (shell command for the real build check;
//                                  default: "next build")
//       ATELIER_PROOF_CWD         (cwd for the build command; default: process.cwd())
//       ATELIER_POLL_MS           (poll interval; default: 5000)

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exec, spawn } from "node:child_process";
import postgresFactory from "postgres";

// ---------------------------------------------------------------------------
// Constants (must match the frozen Atelier spec).
// ---------------------------------------------------------------------------
const ATELIER_WS = "00000000-0000-0000-0000-000000000a11";
const POLL_MS = Math.max(Number(process.env.ATELIER_POLL_MS ?? "5000"), 1000);
const PROOF_CMD = process.env.ATELIER_PROOF_CMD ?? "next build";
const PROOF_CWD = process.env.ATELIER_PROOF_CWD ?? process.cwd();
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;
// OpenCode dispatch (the real "hands" — drives the local coder on M90t).
const OPENCODE_HOST = process.env.ATELIER_OPENCODE_SSH_HOST ?? "think";
const OPENCODE_MODEL = process.env.ATELIER_OPENCODE_MODEL ?? "vidbox/qwen3-coder-next-UD-Q2_K_XL";
const OPENCODE_REPO = process.env.ATELIER_OPENCODE_REPO ?? "~/reskin-chunked";

// Drive ONE scoped OpenCode chunk on M90t over SSH (PATH-fixed for the per-user
// node install). Resolves {ok, exitCode, output, error}. Never throws.
function dispatchOpenCodeChunk({ repoPath, model, prompt }) {
  return new Promise((res) => {
    const remote = [
      'export PATH="$HOME/.local/node/current/bin:$PATH"',
      'cd "$1" || exit 3',
      'opencode run --model "$2" "$3"',
    ].join(" && ");
    const args = [OPENCODE_HOST, "bash", "-lc", remote, "--", "atelier-chunk", repoPath, model, prompt];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { child.kill("SIGKILL"); res({ ok: false, error: "timeout" }); }, BUILD_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(t); res({ ok: code === 0, exitCode: code, output: out.slice(-1500), error: code !== 0 ? err.slice(-1500) : undefined }); });
    child.on("error", (e) => { clearTimeout(t); res({ ok: false, error: e.message }); });
  });
}

// ---------------------------------------------------------------------------
// Minimal .env.local loader (mirrors scripts/load-env.ts; no dependency).
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// DB client (raw postgres-js tag; direct SQL per spec).
// ---------------------------------------------------------------------------
function makeSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }
  return postgresFactory(connectionString, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

// ---------------------------------------------------------------------------
// Logging.
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(`[${new Date().toISOString()}] [atelier-worker]`, ...args);
}
function logError(...args) {
  console.error(`[${new Date().toISOString()}] [atelier-worker]`, ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStub() {
  const v = process.env.ATELIER_OPENCODE_STUB;
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// The build-proof. Week-1: a stub (when ATELIER_OPENCODE_STUB) or a real
// shell build check. Returns a proof-shaped result.
// ---------------------------------------------------------------------------
async function runBuildProof(task) {
  if (isStub()) {
    return {
      status: "pass",
      score: 1,
      threshold: 1,
      detail: { note: "stub", cmd: null, taskId: task.id },
    };
  }

  // Real path: if the task carries a scoped chunk prompt, drive OpenCode on
  // M90t to do the work FIRST (the chunked discipline proven this session) —
  // then the build command below is the verifiable proof of that work.
  const chunkPrompt = task?.spec?.chunkPrompt;
  if (chunkPrompt) {
    const d = await dispatchOpenCodeChunk({
      repoPath: task.spec?.repoPath ?? OPENCODE_REPO,
      model: task.spec?.model ?? OPENCODE_MODEL,
      prompt: chunkPrompt,
    });
    if (!d.ok) {
      return {
        status: "fail",
        score: 0,
        threshold: 1,
        detail: { stage: "opencode-dispatch", taskId: task.id, ...d },
      };
    }
  }

  return await new Promise((resolveProof) => {
    exec(
      PROOF_CMD,
      { cwd: PROOF_CWD, timeout: BUILD_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const tail = (s) => (s || "").toString().split("\n").slice(-25).join("\n");
        if (error) {
          resolveProof({
            status: "fail",
            score: 0,
            threshold: 1,
            detail: {
              cmd: PROOF_CMD,
              cwd: PROOF_CWD,
              exitCode: typeof error.code === "number" ? error.code : null,
              message: error.message,
              stdout: tail(stdout),
              stderr: tail(stderr),
            },
          });
          return;
        }
        resolveProof({
          status: "pass",
          score: 1,
          threshold: 1,
          detail: { cmd: PROOF_CMD, cwd: PROOF_CWD, exitCode: 0, stdout: tail(stdout) },
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Persist a proof + reconcile the task (direct SQL, transactional).
// Mirrors lib/atelier.ts attachProof: insert proof, update proof_status +
// latest_proof_id, auto-advance active -> proofed on pass.
// ---------------------------------------------------------------------------
async function attachProofAndAdvance(sql, task, proof) {
  const proofStatus = proof.status === "pass" ? "passing" : "failing";

  return await sql.begin(async (tx) => {
    const [row] = await tx`
      insert into atelier_proof
        (workspace_id, task_id, employee_slug, kind, status, score, threshold, detail)
      values (
        ${ATELIER_WS},
        ${task.id},
        ${task.assignee_employee_slug ?? null},
        ${"build"},
        ${proof.status},
        ${proof.score ?? null},
        ${proof.threshold ?? null},
        ${tx.json(proof.detail ?? {})}
      )
      returning id
    `;
    const proofId = row.id;

    if (proof.status === "pass") {
      // Auto-advance active -> proofed. Guard on state='active' so a task
      // that already moved on is left untouched (idempotent).
      await tx`
        update atelier_task
        set proof_status = ${proofStatus},
            latest_proof_id = ${proofId},
            state = case when state = 'active' then 'proofed' else state end
        where id = ${task.id}
          and workspace_id = ${ATELIER_WS}
      `;
    } else {
      await tx`
        update atelier_task
        set proof_status = ${proofStatus},
            latest_proof_id = ${proofId}
        where id = ${task.id}
          and workspace_id = ${ATELIER_WS}
      `;
    }

    return proofId;
  });
}

// ---------------------------------------------------------------------------
// One poll cycle.
// ---------------------------------------------------------------------------
async function tick(sql) {
  const tasks = await sql`
    select id, title, assignee_employee_slug, station, kind, proof_status
    from atelier_task
    where workspace_id = ${ATELIER_WS}
      and state = 'active'
    order by created_at asc
  `;

  if (tasks.length === 0) return 0;

  log(`picked ${tasks.length} active task(s)`);

  for (const task of tasks) {
    try {
      log(`proving task ${task.id} — "${task.title}"`);
      const proof = await runBuildProof(task);
      const proofId = await attachProofAndAdvance(sql, task, proof);

      if (proof.status === "pass") {
        log(`task ${task.id} PASS — proof ${proofId} — advanced active -> proofed`);
      } else {
        log(`task ${task.id} FAIL — proof ${proofId} — left in 'active' (proof_status=failing)`);
      }
    } catch (error) {
      logError(`task ${task.id} errored`, error);
    }
  }

  return tasks.length;
}

// ---------------------------------------------------------------------------
// Main loop.
// ---------------------------------------------------------------------------
async function main() {
  loadEnv();
  const sql = makeSql();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down`);
    try {
      await sql.end({ timeout: 5 });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log(
    `started — poll=${POLL_MS}ms — mode=${isStub() ? "STUB" : `build("${PROOF_CMD}")`} — ws=${ATELIER_WS}`,
  );

  while (!shuttingDown) {
    try {
      await tick(sql);
    } catch (error) {
      logError("poll cycle failed", error);
    }
    await sleep(POLL_MS);
  }
}

main().catch((error) => {
  logError("fatal", error);
  process.exit(1);
});
