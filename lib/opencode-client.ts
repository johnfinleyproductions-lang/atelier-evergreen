/**
 * lib/opencode-client.ts
 *
 * Atelier — OpenCode dispatch client.
 *
 * One employee = one scoped OpenCode "chunk" of work executed on the M90t box
 * ("think" over SSH / Tailscale). This module is the ONLY place that knows how
 * to actually run an OpenCode chunk; the repository (lib/atelier.ts) and the
 * worker (scripts/atelier-worker.mjs) call dispatchChunk() and stay agnostic.
 *
 * Week-1 walking skeleton: the interface is REAL (two transports — local HTTP
 * to the OpenCode server, or SSH shell-out to `opencode run`), but a clearly
 * marked stub short-circuits everything when ATELIER_OPENCODE_STUB is set so
 * the acceptance flow runs without a live M90t.
 *
 * Env knobs:
 *   ATELIER_OPENCODE_STUB      — when truthy ("1"/"true"), never touch the
 *                                network; return {ok:true, note:"stub"}.
 *   ATELIER_OPENCODE_URL       — OpenCode server base URL (default
 *                                http://127.0.0.1:4096). If reachable we POST.
 *   ATELIER_OPENCODE_SSH_HOST  — ssh host alias for shell-out (default "think").
 *   ATELIER_OPENCODE_MODEL     — fallback model id when a chunk omits one.
 *   ATELIER_OPENCODE_TIMEOUT_MS— per-chunk timeout (default 600000 = 10min).
 */

import { spawn } from 'node:child_process';

// ── Public contract ─────────────────────────────────────────────────────────

export interface DispatchChunkInput {
  /** Absolute path to the repo/worktree the chunk operates in (on the M90t). */
  repoPath: string;
  /** The scoped instruction for this single chunk of work. */
  prompt: string;
  /** Model id (e.g. "qwen3.5:27b"). Falls back to ATELIER_OPENCODE_MODEL. */
  model?: string;
}

export interface DispatchChunkResult {
  /** True when the chunk completed without a non-zero exit / HTTP error. */
  ok: boolean;
  /** Which path produced this result. */
  transport: 'stub' | 'http' | 'ssh';
  /** Captured stdout / response body (may be truncated by the transport). */
  output?: string;
  /** Captured stderr or error text when ok === false. */
  error?: string;
  /** Process exit code (ssh transport) when available. */
  exitCode?: number;
  /** Human note — set to "stub" for the env-guarded stub path. */
  note?: string;
}

// ── Config helpers ──────────────────────────────────────────────────────────

const DEFAULT_URL = 'http://127.0.0.1:4096';
const DEFAULT_SSH_HOST = 'think';
const DEFAULT_MODEL = 'qwen3.5:27b';
const DEFAULT_TIMEOUT_MS = 600_000;

function isStub(): boolean {
  const v = (process.env.ATELIER_OPENCODE_STUB ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function serverUrl(): string {
  return (process.env.ATELIER_OPENCODE_URL ?? DEFAULT_URL).replace(/\/+$/, '');
}

function sshHost(): string {
  return process.env.ATELIER_OPENCODE_SSH_HOST ?? DEFAULT_SSH_HOST;
}

function resolveModel(model?: string): string {
  return model ?? process.env.ATELIER_OPENCODE_MODEL ?? DEFAULT_MODEL;
}

function timeoutMs(): number {
  const raw = Number(process.env.ATELIER_OPENCODE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run ONE scoped OpenCode chunk on the M90t.
 *
 * Order of preference:
 *   1. Stub (env-guarded) — instant, no network. For the walking skeleton.
 *   2. HTTP — POST to the OpenCode server if it answers a quick health probe.
 *   3. SSH — shell out to `opencode run` on the configured host.
 *
 * Never throws: all failures are returned as { ok:false, error }.
 */
export async function dispatchChunk(
  input: DispatchChunkInput,
): Promise<DispatchChunkResult> {
  const { repoPath, prompt } = input;
  const model = resolveModel(input.model);

  if (!repoPath || !prompt) {
    return {
      ok: false,
      transport: 'stub',
      error: 'dispatchChunk requires both repoPath and prompt',
    };
  }

  // 1. ── STUB ───────────────────────────────────────────────────────────────
  // TODO(week-2): remove this short-circuit once the M90t OpenCode server is a
  // hard dependency of the worker. Keep it env-guarded so CI / acceptance can
  // run the full capture→proof→ship loop without a live box.
  if (isStub()) {
    return {
      ok: true,
      transport: 'stub',
      note: 'stub',
      output: `[stub] would run model=${model} in ${repoPath}\n--- prompt ---\n${prompt}`,
    };
  }

  // 2. ── HTTP ─────────────────────────────────────────────────────────────────
  if (await serverReachable()) {
    return dispatchViaHttp({ repoPath, prompt, model });
  }

  // 3. ── SSH ─────────────────────────────────────────────────────────────────
  return dispatchViaSsh({ repoPath, prompt, model });
}

// ── Transport: HTTP (local OpenCode server) ─────────────────────────────────

async function serverReachable(): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1_500);
  try {
    // OpenCode exposes a JSON API; any 2xx/4xx on the base means it's up.
    const res = await fetch(serverUrl(), { signal: ctrl.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function dispatchViaHttp(input: {
  repoPath: string;
  prompt: string;
  model: string;
}): Promise<DispatchChunkResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    // TODO(week-2): pin to the exact OpenCode `/session` + `/run` route shape
    // once the server contract is frozen. This is the documented run endpoint.
    const res = await fetch(`${serverUrl()}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: input.repoPath,
        model: input.model,
        prompt: input.prompt,
      }),
      signal: ctrl.signal,
    });

    const body = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        transport: 'http',
        error: `OpenCode HTTP ${res.status}: ${body.slice(0, 2_000)}`,
      };
    }
    return { ok: true, transport: 'http', output: body };
  } catch (err) {
    return {
      ok: false,
      transport: 'http',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(t);
  }
}

// ── Transport: SSH shell-out (`opencode run` on the M90t) ────────────────────

async function dispatchViaSsh(input: {
  repoPath: string;
  prompt: string;
  model: string;
}): Promise<DispatchChunkResult> {
  // Build: ssh <host> bash -lc '<remote command>'
  // We single-quote the remote command and escape any embedded single quotes,
  // then pass repoPath/prompt as positional args to a tiny inline runner so the
  // untrusted prompt never participates in shell parsing on the remote side.
  const remote = [
    // opencode lives in the per-user node install, not the default login PATH.
    'export PATH="$HOME/.local/node/current/bin:$PATH"',
    'cd "$1" || exit 3',
    'opencode run --model "$2" "$3"',
  ].join(' && ');

  const args = [
    sshHost(),
    'bash',
    '-lc',
    shSingleQuote(remote),
    '--', // $0 sentinel for `bash -c`
    'atelier-chunk',
    input.repoPath,
    input.model,
    input.prompt,
  ];

  return runProcess('ssh', args, timeoutMs(), 'ssh');
}

/** Wrap a string in single quotes, safely escaping embedded single quotes. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Process runner ──────────────────────────────────────────────────────────

function runProcess(
  cmd: string,
  args: string[],
  ms: number,
  transport: 'ssh',
): Promise<DispatchChunkResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        ok: false,
        transport,
        error: `chunk timed out after ${ms}ms`,
        output: stdout,
      });
    }, ms);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, transport, error: err.message, output: stdout });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({
        ok: exitCode === 0,
        transport,
        exitCode,
        output: stdout,
        error: exitCode === 0 ? undefined : stderr || `exit ${exitCode}`,
      });
    });
  });
}
