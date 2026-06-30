// lib/proof-checkers.ts
//
// Per-role proof checkers — the v2 layer that turns an employee's *role* into a
// concrete, scored proof. Each Atelier specialist proves their work in their
// own currency:
//
//   iris  → match_score   (REAL)  deterministic palette/spec conformance ΔE
//   hugo  → build         (REAL)  shell build / tsc exit-code 0 == pass
//   remy  → render_qc     (REAL)  delegates to lib/visual-qa (Playwright render)
//   lena  → match_score   (stub)  honest predicted-engagement heuristic
//   vera  → passing_test  (stub)  honest coverage gate (uses real data if present)
//
// Two of the conceptual kinds — predicted_engagement (lena) and coverage
// (vera) — are not members of the frozen ProofKind enum, so the storable
// `kind` is mapped to the nearest legal kind and the true label is preserved in
// detail.proof_label. The three that MUST be real (build, render_qc,
// match_score) are real.
//
// A checker NEVER fabricates a pass: when it lacks the inputs to judge (no
// artifact to render, no brand to match, no coverage data) it returns 'warn'
// with a null score, never 'pass'. The proof gate in lib/atelier.ts only opens
// for status='pass'.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import {
  AtelierError,
  attachProof,
  type Employee,
  type Proof,
  type Task,
} from './atelier';
import type { ProofKind, ProofStatus } from './contracts';
import { resolveSpec, type ResolvedSpec } from './merge-ledger';
import { getDefaultBrandRubric, getStyleCard } from './style-repo';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public result shapes.
// ---------------------------------------------------------------------------

/** The scored verdict a checker returns (before it is persisted as a proof). */
export interface CheckerResult {
  status: ProofStatus; // 'pass' | 'fail' | 'warn'
  score: number | null;
  threshold: number | null;
  detail: Record<string, unknown>;
}

/** One entry in the registry: the legal proof kind plus the checker fn. */
export interface RoleProofChecker {
  kind: ProofKind;
  run: (task: Task) => Promise<CheckerResult>;
}

/** runRoleProof()'s return — a CheckerResult enriched with routing fields. */
export interface RoleProofResult extends CheckerResult {
  kind: ProofKind;
  role: string;
  employeeSlug: string;
}

/** The canonical role keys the registry is indexed by. */
export type RoleKey = 'iris' | 'hugo' | 'remy' | 'lena' | 'vera';

// ---------------------------------------------------------------------------
// Small, dependency-free helpers (deterministic — no I/O).
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

const HEX_RE = /^#?[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const HEX_IN_TEXT_RE = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

function normalizeHex(raw: string): string | null {
  if (!HEX_RE.test(raw)) return null;
  let h = raw.startsWith('#') ? raw.slice(1) : raw;
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return '#' + h.toLowerCase();
}

/** Recursively pull every hex color string out of an arbitrary jsonb value. */
function collectHexes(value: unknown, depth = 0): string[] {
  const out: string[] = [];
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    const direct = normalizeHex(value.trim());
    if (direct) {
      out.push(direct);
    } else {
      const found = value.match(HEX_IN_TEXT_RE);
      if (found) {
        for (const f of found) {
          const n = normalizeHex(f);
          if (n) out.push(n);
        }
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectHexes(item, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // A PaletteSwatch {hex, weight} is the common shape — handle it directly.
    if (typeof obj.hex === 'string') {
      const n = normalizeHex(obj.hex.trim());
      if (n) out.push(n);
    }
    for (const v of Object.values(obj)) out.push(...collectHexes(v, depth + 1));
    return out;
  }
  return out;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ---- Deterministic perceptual color distance (CIE76 ΔE over CIELab) --------

interface Lab {
  L: number;
  a: number;
  b: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.slice(1);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function pivotXyz(n: number): number {
  return n > 0.008856 ? Math.cbrt(n) : 7.787 * n + 16 / 116;
}

function rgbToLab(rgb: [number, number, number]): Lab {
  let [r, g, b] = rgb.map((c) => c / 255) as [number, number, number];
  // sRGB → linear
  const lin = (c: number) =>
    c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  r = lin(r);
  g = lin(g);
  b = lin(b);
  // linear RGB → XYZ (D65)
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const fx = pivotXyz(x);
  const fy = pivotXyz(y);
  const fz = pivotXyz(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function deltaE76(h1: string, h2: string): number {
  const l1 = rgbToLab(hexToRgb(h1));
  const l2 = rgbToLab(hexToRgb(h2));
  const dL = l1.L - l2.L;
  const da = l1.a - l2.a;
  const db = l1.b - l2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Distance at which a color is considered a total miss (ΔE >= this → score 0). */
const DELTA_E_MAX = 60;
/** Mean ΔE at or below which iris/remy palette conformance passes. */
const DELTA_E_ACCEPT = 12;

// ---------------------------------------------------------------------------
// Style-spec resolution (shared by iris). Reads the style card referenced on
// the task and resolves it against the default brand rubric.
// ---------------------------------------------------------------------------

function readStyleCardRef(task: Task): string | null {
  const spec = task.spec ?? {};
  const candidates = [
    spec.styleCardId,
    spec.styleCard,
    spec.style_card_id,
    spec.card,
    spec['@card'],
    spec.handle,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

async function resolveTaskSpec(
  task: Task,
): Promise<{ resolvedSpec: ResolvedSpec | null; styleCardId: string | null }> {
  const ref = readStyleCardRef(task);
  if (!ref) return { resolvedSpec: null, styleCardId: null };
  const card = await getStyleCard(ref);
  if (!card) return { resolvedSpec: null, styleCardId: null };
  const rubric = await getDefaultBrandRubric();
  const { resolvedSpec } = resolveSpec(card, rubric);
  return { resolvedSpec, styleCardId: card.id };
}

/** Expected brand hexes from a resolved spec's brand-lock color domain. */
function expectedHexesFromSpec(resolvedSpec: ResolvedSpec | null): string[] {
  if (!resolvedSpec) return [];
  return uniq(collectHexes(resolvedSpec.colors));
}

/** Hexes actually present on the task's produced artifact / spec. */
function actualHexesFromTask(task: Task): string[] {
  const spec = task.spec ?? {};
  const sources = [
    spec.palette,
    spec.colors,
    spec.tokens,
    spec.html,
    spec.css,
    spec.artifact,
    spec.render,
  ];
  return uniq(sources.flatMap((s) => collectHexes(s)));
}

// ---------------------------------------------------------------------------
// lib/visual-qa bridge (remy). visual-qa is authored alongside this file; we
// load it defensively so a missing/renamed export degrades to an honest 'warn'
// rather than a build break or a false pass. The specifier is typed as a plain
// string so it is not statically resolved at type-check time.
// ---------------------------------------------------------------------------

// Mirrors lib/visual-qa.ts RenderAndScoreInput.
interface VisualQaInput {
  html?: string | null;
  url?: string | null;
  styleCardHandle?: string | null;
  resolvedSpec?: ResolvedSpec | Record<string, unknown> | null;
  assertions?: string[] | null;
  viewport?: { width: number; height: number } | null;
}

// Mirrors lib/visual-qa.ts RenderQcProof (snake_case keys kept as defensive
// fallbacks in case the renderer's blob shape ever drifts).
interface VisualQaBreakdown {
  paletteDeltaE?: { mean?: number; max?: number; pass?: boolean } | number | null;
  palette_deltaE?: { mean?: number; max?: number; pass?: boolean } | number | null;
  assertions?: Record<string, unknown>;
}

interface VisualQaResult {
  proofKind?: 'render_qc';
  proof_kind?: 'render_qc';
  pass: boolean;
  matchScore?: number;
  match_score?: number;
  threshold?: number;
  breakdown?: VisualQaBreakdown;
  screenshotRef?: string | null;
  screenshot_ref?: string | null;
  error?: string;
}

type VisualQaFn = (input: VisualQaInput) => Promise<VisualQaResult>;

async function loadVisualQa(): Promise<VisualQaFn | null> {
  try {
    const specifier: string = './visual-qa';
    const mod = (await import(specifier)) as Record<string, unknown>;
    const fn = (mod.renderAndScore ??
      mod.runVisualQa ??
      mod.runVisualQA ??
      mod.default) as VisualQaFn | undefined;
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

/** Pull a scalar ΔE (the mean) out of visual-qa's paletteDeltaE blob. */
function meanDeltaEOf(bd: VisualQaBreakdown | undefined): number | null {
  const pd = bd?.paletteDeltaE ?? bd?.palette_deltaE;
  if (pd === null || pd === undefined) return null;
  if (typeof pd === 'number') return pd;
  return asNumber(pd.mean);
}

function readArtifact(task: Task): { html: string | null; url: string | null } {
  const spec = task.spec ?? {};
  const artifact = asObject(spec.artifact);
  const html =
    (typeof spec.html === 'string' && spec.html) ||
    (typeof artifact.html === 'string' && artifact.html) ||
    null;
  const url =
    (typeof spec.url === 'string' && spec.url) ||
    (typeof artifact.url === 'string' && artifact.url) ||
    (typeof spec.previewUrl === 'string' && spec.previewUrl) ||
    null;
  return { html: html || null, url: url || null };
}

// ---------------------------------------------------------------------------
// The checkers.
// ---------------------------------------------------------------------------

/**
 * iris → match_score (REAL, deterministic).
 *
 * Resolves the task's style card against the brand rubric, then scores how
 * close the colors actually present on the artifact are to the resolved
 * brand-lock palette using perceptual ΔE. No model, no network — pure pixels
 * and arithmetic, so the score is reproducible.
 */
async function irisMatchScore(task: Task): Promise<CheckerResult> {
  const { resolvedSpec, styleCardId } = await resolveTaskSpec(task);
  const expected = expectedHexesFromSpec(resolvedSpec);
  const actual = actualHexesFromTask(task);
  const threshold = asNumber(asObject(task.spec).matchThreshold) ?? 0.85;

  if (expected.length === 0) {
    return {
      status: 'warn',
      score: null,
      threshold,
      detail: {
        proof_label: 'match_score',
        message:
          'No brand-lock palette to match against (style card missing or unresolved).',
        styleCardId,
      },
    };
  }

  if (actual.length === 0) {
    return {
      status: 'fail',
      score: 0,
      threshold,
      detail: {
        proof_label: 'match_score',
        message: 'No colors found on the produced artifact to compare.',
        expected,
        styleCardId,
      },
    };
  }

  const perColor = expected.map((want) => {
    let nearest = actual[0];
    let best = Infinity;
    for (const got of actual) {
      const d = deltaE76(want, got);
      if (d < best) {
        best = d;
        nearest = got;
      }
    }
    return { expected: want, nearest, deltaE: Number(best.toFixed(2)) };
  });

  const meanDeltaE =
    perColor.reduce((s, c) => s + c.deltaE, 0) / perColor.length;
  const matchScore = clamp01(1 - meanDeltaE / DELTA_E_MAX);
  const pass = meanDeltaE <= DELTA_E_ACCEPT && matchScore >= threshold;

  return {
    status: pass ? 'pass' : 'fail',
    score: Number(matchScore.toFixed(4)),
    threshold,
    detail: {
      proof_label: 'match_score',
      styleCardId,
      expected,
      actual,
      perColor,
      meanDeltaE: Number(meanDeltaE.toFixed(2)),
      acceptDeltaE: DELTA_E_ACCEPT,
    },
  };
}

/**
 * hugo → build (REAL, shell).
 *
 * Runs a real build/typecheck command and gates on its exit code. The command
 * and working directory are taken from task.spec.build, defaulting to a
 * no-emit TypeScript check. stdout/stderr tails are kept for the dossier.
 */
async function hugoBuild(task: Task): Promise<CheckerResult> {
  const build = asObject(asObject(task.spec).build);
  const cmd =
    (typeof build.cmd === 'string' && build.cmd) ||
    (typeof asObject(task.spec).cmd === 'string' &&
      (asObject(task.spec).cmd as string)) ||
    'npx --yes tsc --noEmit';
  const cwd =
    (typeof build.cwd === 'string' && build.cwd) || process.cwd();
  const timeout = asNumber(build.timeoutMs) ?? 180_000;

  const tail = (s: string, n = 4000) =>
    s.length > n ? s.slice(s.length - n) : s;

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      status: 'pass',
      score: 1,
      threshold: 1,
      detail: {
        proof_label: 'build',
        cmd,
        cwd,
        exitCode: 0,
        stdout: tail(stdout ?? ''),
        stderr: tail(stderr ?? ''),
      },
    };
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      status: 'fail',
      score: 0,
      threshold: 1,
      detail: {
        proof_label: 'build',
        cmd,
        cwd,
        exitCode: e.code ?? null,
        killed: e.killed ?? false,
        signal: e.signal ?? null,
        stdout: tail(e.stdout ?? ''),
        stderr: tail(e.stderr ?? e.message ?? ''),
      },
    };
  }
}

/**
 * remy → render_qc (REAL, delegates to lib/visual-qa).
 *
 * Hands the artifact (HTML or URL) plus the resolved style spec to the
 * Playwright-backed visual-qa gate and relays its verdict. The palette ΔE
 * inside visual-qa is what gates the pass; the VL aesthetic read is advisory.
 * If there is no artifact to render, or visual-qa is unavailable, remy returns
 * an honest 'warn' — never a pass.
 */
async function remyRenderQc(task: Task): Promise<CheckerResult> {
  const { html, url } = readArtifact(task);
  const { resolvedSpec, styleCardId } = await resolveTaskSpec(task);

  if (!html && !url) {
    return {
      status: 'warn',
      score: null,
      threshold: null,
      detail: {
        proof_label: 'render_qc',
        message: 'No HTML or URL artifact on the task to render.',
      },
    };
  }

  const run = await loadVisualQa();
  if (!run) {
    return {
      status: 'warn',
      score: null,
      threshold: null,
      detail: {
        proof_label: 'render_qc',
        message: 'visual-qa renderer unavailable; cannot produce a render proof.',
      },
    };
  }

  const specAssertions = asObject(task.spec).assertions;
  const assertions = Array.isArray(specAssertions)
    ? specAssertions.filter((s): s is string => typeof s === 'string')
    : null;

  const result = await run({
    html,
    url,
    resolvedSpec,
    styleCardHandle: readStyleCardRef(task),
    assertions,
  });

  const matchScore = asNumber(result.matchScore ?? result.match_score);
  const paletteDeltaE = meanDeltaEOf(result.breakdown);
  const screenshotRef = result.screenshotRef ?? result.screenshot_ref ?? null;
  const domAssertions = asObject(result.breakdown?.assertions);
  const threshold = asNumber(result.threshold) ?? 0.85;

  return {
    // visual-qa's palette ΔE gates the pass; the VL read is advisory only.
    status: result.pass === true ? 'pass' : 'fail',
    score: matchScore,
    threshold,
    detail: {
      // Preserve the visual-qa render_qc proof blob under canonical keys.
      proof_kind: 'render_qc',
      proof_label: 'render_qc',
      pass: result.pass === true,
      match_score: matchScore,
      breakdown: {
        palette_deltaE: paletteDeltaE,
        assertions: domAssertions,
      },
      screenshot_ref: screenshotRef,
      styleCardId,
      error: result.error ?? null,
    },
  };
}

/**
 * lena → predicted_engagement (HONEST STUB, kind match_score).
 *
 * A transparent, deterministic heuristic over the task's copy: rewards a
 * present hook, a CTA, a question, and a punchy (not bloated) headline. It is
 * explicitly advisory — below threshold it returns 'warn', never 'fail', and
 * detail.stub flags that this is a heuristic, not a measured engagement.
 */
async function lenaPredictedEngagement(task: Task): Promise<CheckerResult> {
  const spec = asObject(task.spec);
  const text = [
    task.title,
    task.intent ?? '',
    typeof spec.copy === 'string' ? spec.copy : '',
    typeof spec.body === 'string' ? spec.body : '',
    typeof spec.hook === 'string' ? spec.hook : '',
    typeof spec.cta === 'string' ? spec.cta : '',
  ]
    .join('\n')
    .trim();
  const lower = text.toLowerCase();
  const threshold = asNumber(spec.engagementThreshold) ?? 0.5;

  const signals = {
    hasHook: typeof spec.hook === 'string' && spec.hook.trim().length > 0,
    hasCta:
      (typeof spec.cta === 'string' && spec.cta.trim().length > 0) ||
      /\b(get|join|start|grab|download|try|buy|claim)\b/.test(lower),
    asksQuestion: text.includes('?'),
    hasNumber: /\d/.test(text),
    crispHeadline: task.title.length >= 12 && task.title.length <= 72,
    notEmpty: text.length >= 20,
  };

  const weights: Record<keyof typeof signals, number> = {
    hasHook: 0.28,
    hasCta: 0.24,
    asksQuestion: 0.12,
    hasNumber: 0.12,
    crispHeadline: 0.14,
    notEmpty: 0.1,
  };

  let score = 0;
  for (const key of Object.keys(signals) as (keyof typeof signals)[]) {
    if (signals[key]) score += weights[key];
  }
  score = clamp01(score);

  return {
    status: score >= threshold ? 'pass' : 'warn',
    score: Number(score.toFixed(4)),
    threshold,
    detail: {
      proof_label: 'predicted_engagement',
      stub: true,
      advisory: true,
      signals,
      method: 'weighted copy-signal heuristic (deterministic)',
    },
  };
}

/**
 * vera → coverage (HONEST STUB, kind passing_test).
 *
 * If the task carries a real coverage number (task.spec.coverage as a 0..1 or
 * 0..100 value) vera gates on it. Without coverage data she does NOT invent a
 * pass — she returns 'warn' with a null score so the gate stays closed.
 */
async function veraCoverage(task: Task): Promise<CheckerResult> {
  const spec = asObject(task.spec);
  const raw =
    asNumber(spec.coverage) ??
    asNumber(asObject(spec.tests).coverage) ??
    asNumber(asObject(spec.coverage).total);
  const threshold = asNumber(spec.coverageThreshold) ?? 0.8;

  if (raw === null) {
    return {
      status: 'warn',
      score: null,
      threshold,
      detail: {
        proof_label: 'coverage',
        stub: true,
        message: 'No coverage data on the task; cannot gate.',
      },
    };
  }

  const score = clamp01(raw > 1 ? raw / 100 : raw);
  return {
    status: score >= threshold ? 'pass' : 'fail',
    score: Number(score.toFixed(4)),
    threshold,
    detail: {
      proof_label: 'coverage',
      stub: true,
      rawCoverage: raw,
      normalized: score,
    },
  };
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const PROOF_CHECKERS: Record<RoleKey, RoleProofChecker> = {
  iris: { kind: 'match_score', run: irisMatchScore },
  hugo: { kind: 'build', run: hugoBuild },
  remy: { kind: 'render_qc', run: remyRenderQc },
  // predicted_engagement is not a legal ProofKind — stored as the nearest
  // scored kind (match_score); the true label lives in detail.proof_label.
  lena: { kind: 'match_score', run: lenaPredictedEngagement },
  // coverage is not a legal ProofKind — stored as passing_test; true label in
  // detail.proof_label.
  vera: { kind: 'passing_test', run: veraCoverage },
};

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

/** Resolve the checker for an employee by role, then slug, then name. */
function resolveChecker(
  employee: Employee,
): { key: RoleKey; checker: RoleProofChecker } | null {
  const keys: (string | null)[] = [
    employee.role,
    employee.slug,
    employee.name ? employee.name.toLowerCase() : null,
  ];
  for (const k of keys) {
    if (!k) continue;
    const norm = k.trim().toLowerCase() as RoleKey;
    if (norm in PROOF_CHECKERS) {
      return { key: norm, checker: PROOF_CHECKERS[norm] };
    }
  }
  return null;
}

/**
 * Run the proof checker that matches an employee's role against a task and
 * return the scored verdict (kind + status + score + threshold + detail).
 *
 * Throws AtelierError 'NO_CHECKER' (422) when no checker is registered for the
 * employee — callers map that to a 422 response. This function does NOT
 * persist; use runAndAttachRoleProof to write the proof and trip the gate.
 */
export async function runRoleProof(
  task: Task,
  employee: Employee,
): Promise<RoleProofResult> {
  const resolved = resolveChecker(employee);
  if (!resolved) {
    throw new AtelierError(
      'NO_CHECKER',
      `No proof checker registered for employee '${employee.slug}' (role '${employee.role ?? 'none'}').`,
      422,
    );
  }
  const result = await resolved.checker.run(task);
  return {
    kind: resolved.checker.kind,
    role: resolved.key,
    employeeSlug: employee.slug,
    ...result,
  };
}

/**
 * Run the role proof AND persist it via attachProof — the wired path that
 * reconciles task.proof_status, auto-advances active→proofed on a pass, and
 * makes the proof count toward the review gate. Returns the stored Proof.
 */
export async function runAndAttachRoleProof(
  task: Task,
  employee: Employee,
): Promise<Proof> {
  const result = await runRoleProof(task, employee);
  return attachProof({
    taskId: task.id,
    employeeSlug: result.employeeSlug,
    kind: result.kind,
    status: result.status,
    score: result.score ?? undefined,
    threshold: result.threshold ?? undefined,
    detail: result.detail,
  });
}
