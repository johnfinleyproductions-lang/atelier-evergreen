// lib/marlowe.ts
//
// Marlowe — the brand-lock critic. She is the proofed -> review gate for
// DESIGN-kind tasks: before a styled artifact is allowed in front of Cleo for
// approval, Marlowe re-runs the merge-ledger precedence and checks that the
// thing that actually got built still honors the brand-lock (colors / logo /
// a11y / components are the rubric's, not the reference's).
//
// Two modes, picked automatically:
//
//   RENDER mode  — if a render_qc proof already exists on the task (Remy's
//                  visual-QA gate ran), Marlowe reuses its DETERMINISTIC
//                  palette ΔE. Palette ΔE gates the pass: the brand colors
//                  must show up in the rendered pixels within threshold.
//   LEDGER mode  — if there is no render yet, Marlowe falls back to ledger
//                  conformance: resolveSpec(card, rubric) and verify every
//                  brand-locked property was won by 'brand-lock' (and that no
//                  conflict slipped through resolved in the style's favor).
//
// She writes a 'brand_lock' proof (kind reuse: 'lint', detail.gate='marlowe')
// via lib/atelier.attachProof and returns { pass, reasons[] }. The application
// layer requires marloweReview(...).pass before moving a design task to
// 'review' — it is enforced ON TOP of the sacred proof gate, never instead of
// it.
//
// Pure-ish: the conformance math is a pure function (resolveSpec from
// lib/merge-ledger); the only side effect is the one append-only proof write.

import { sql } from './db';
import { ATELIER_WS, attachProof } from './atelier';
import type { Task, Proof } from './atelier';
import {
  resolveSpec,
  BRAND_LOCKED_PROPERTIES,
  type ResolveSpecResult,
  type StyleCardLike,
  type BrandRubricLike,
  type SpecConflict,
  type LedgerEntry,
  type BrandColors,
} from './merge-ledger';
import { getStyleCard, getDefaultBrandRubric } from './style-repo';

// ---------------------------------------------------------------------------
// Tunables — the brand-lock pass-lines. Both modes report a 0..1 conformance
// score with an explicit threshold so the proof blob is self-explaining.
// ---------------------------------------------------------------------------

/** Max acceptable palette ΔE for a brand color to count as "rendered". */
export const MARLOWE_DELTA_E_MAX = 10;

/** Denominator that normalizes a ΔE into a 0..1 score (ΔE 0 -> 1, 100 -> 0). */
const DELTA_E_DENOM = 100;

/** Render-mode pass-line as a 0..1 score (mirrors MARLOWE_DELTA_E_MAX). */
const RENDER_PASS_SCORE = 1 - MARLOWE_DELTA_E_MAX / DELTA_E_DENOM;

/** Ledger-mode pass-line: every brand-locked property must conform. */
const LEDGER_PASS_SCORE = 1;

/** Employee slug stamped on the proof Marlowe writes. */
export const MARLOWE_SLUG = 'marlowe';

/** Task kinds (substring-matched, lowercased) that Marlowe gates. */
const DESIGN_KIND_TOKENS = [
  'design',
  'render',
  'visual',
  'graphic',
  'image',
  'cover',
  'layout',
  'ui',
  'brand',
  'style',
];

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type MarloweMode = 'render' | 'ledger' | 'skipped';

export interface BrandLockBreakdown {
  mode: MarloweMode;
  /** The deterministic palette ΔE from the render_qc proof (render mode). */
  paletteDeltaE: number | null;
  deltaEThreshold: number;
  /** Per brand-locked property: was it won by 'brand-lock'? */
  lockedProperties: { property: string; winner: string | null; honored: boolean }[];
  /** Fraction of brand-locked properties honored (ledger mode signal). */
  honoredFraction: number;
  /** Conflicts the precedence arbitrated (all should resolve to brand-lock). */
  conflicts: SpecConflict[];
  /** The render_qc screenshot, when a render existed. */
  screenshotRef: string | null;
}

export interface MarloweReviewResult {
  pass: boolean;
  reasons: string[];
  mode: MarloweMode;
  score: number;
  threshold: number;
  breakdown: BrandLockBreakdown;
  /** The 'brand_lock' proof written (null when the task isn't design-kind). */
  proof: Proof | null;
}

export interface MarloweOptions {
  /** Override the style card (else resolved from the task / its injection). */
  styleCard?: StyleCardLike | null;
  /** Override the brand rubric (else the workspace default). */
  brandRubric?: BrandRubricLike | null;
  /** Force the gate to run even if the task doesn't look design-kind. */
  force?: boolean;
  /** Skip the proof write (dry-run conformance check). */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Small honest helpers.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** True if a task's kind/intent reads as a styled, design-kind deliverable. */
export function isDesignKind(task: Task): boolean {
  const hay = `${task.kind ?? ''} ${task.intent ?? ''} ${task.station ?? ''}`.toLowerCase();
  return DESIGN_KIND_TOKENS.some((t) => hay.includes(t));
}

/** Dig a style-card handle/id out of the task's spec jsonb, if present. */
function readStyleHandleFromSpec(task: Task): string | null {
  const spec = asObject(task.spec);
  const candidates = [
    spec.styleCardHandle,
    spec.styleCard,
    spec.styleCardId,
    spec.style_card_id,
    spec.style,
    spec.handle,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB reads (workspace-scoped) — the latest style injection + render_qc proof.
// ---------------------------------------------------------------------------

interface InjectionLite {
  styleCardId: string | null;
  brandRubricId: string | null;
  ledger: unknown[];
  resolvedSpec: Record<string, unknown>;
  conflicts: unknown[];
}

async function latestInjection(taskId: string): Promise<InjectionLite | null> {
  const rows = (await sql`
    select style_card_id, brand_rubric_id, ledger, resolved_spec, conflicts
      from atelier_style_injection
     where task_id = ${taskId} and workspace_id = ${ATELIER_WS}
     order by created_at desc
     limit 1
  `) as unknown as Record<string, any>[];
  const r = rows[0];
  if (!r) return null;
  return {
    styleCardId: r.style_card_id ?? null,
    brandRubricId: r.brand_rubric_id ?? null,
    ledger: Array.isArray(r.ledger) ? r.ledger : [],
    resolvedSpec: asObject(r.resolved_spec),
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
  };
}

interface RenderProofLite {
  status: string;
  paletteDeltaE: number | null;
  screenshotRef: string | null;
  matchScore: number | null;
}

async function latestRenderQc(taskId: string): Promise<RenderProofLite | null> {
  const rows = (await sql`
    select status, score, detail
      from atelier_proof
     where task_id = ${taskId}
       and workspace_id = ${ATELIER_WS}
       and kind = 'render_qc'
     order by created_at desc
     limit 1
  `) as unknown as Record<string, any>[];
  const r = rows[0];
  if (!r) return null;
  const detail = asObject(r.detail);
  const breakdown = asObject(detail.breakdown);
  return {
    status: String(r.status ?? ''),
    paletteDeltaE: finiteNumber(breakdown.palette_deltaE),
    screenshotRef:
      typeof detail.screenshot_ref === 'string' ? detail.screenshot_ref : null,
    matchScore: finiteNumber(detail.match_score ?? r.score),
  };
}

// ---------------------------------------------------------------------------
// Conformance math (pure).
// ---------------------------------------------------------------------------

/**
 * Inspect a resolveSpec result: for every brand-locked property, was it won by
 * 'brand-lock'? Returns the per-property verdict, the honored fraction, and any
 * reasons a property failed to conform.
 */
function ledgerConformance(result: ResolveSpecResult): {
  lockedProperties: { property: string; winner: string | null; honored: boolean }[];
  honoredFraction: number;
  conflicts: SpecConflict[];
  reasons: string[];
} {
  const byProp = new Map<string, LedgerEntry>();
  for (const e of result.ledger) byProp.set(e.property, e);

  const reasons: string[] = [];
  const lockedProperties = BRAND_LOCKED_PROPERTIES.map((property) => {
    const entry = byProp.get(property) ?? null;
    const winner = entry ? entry.winner : null;
    // A locked property conforms when the brand-lock won it. If it has no value
    // at all (the rubric simply doesn't specify a logo, say) there is nothing
    // to violate, so it conforms vacuously.
    const hasValue =
      entry != null && entry.value != null &&
      !(Array.isArray(entry.value) && entry.value.length === 0) &&
      !(isObject(entry.value) && Object.keys(entry.value).length === 0);
    const honored = !hasValue || winner === 'brand-lock';
    if (!honored) {
      reasons.push(
        `Brand-locked '${property}' was won by '${winner ?? 'none'}' — the brand rubric must win it, but no lock was enforced (is a brand rubric attached?).`,
      );
    }
    return { property, winner, honored };
  });

  // Any conflict that did NOT resolve in the brand's favor is a hard violation.
  for (const c of result.conflicts) {
    if (c.resolution !== 'brand-lock') {
      reasons.push(
        `Conflict on '${c.property}' resolved as '${c.resolution}', not 'brand-lock' — brand-lock breached.`,
      );
    }
  }

  const honoredCount = lockedProperties.filter((p) => p.honored).length;
  const honoredFraction =
    lockedProperties.length === 0 ? 1 : honoredCount / lockedProperties.length;

  return { lockedProperties, honoredFraction, conflicts: result.conflicts, reasons };
}

// ---------------------------------------------------------------------------
// marloweReview — the gate.
// ---------------------------------------------------------------------------

/**
 * Run Marlowe's brand-lock conformance review for a (design-kind) task and
 * write the resulting 'brand_lock' proof.
 *
 * @param task  the task being moved proofed -> review.
 * @param opts  optional overrides (card / rubric / force / dryRun).
 * @returns { pass, reasons, mode, score, threshold, breakdown, proof }.
 */
export async function marloweReview(
  task: Task,
  opts: MarloweOptions = {},
): Promise<MarloweReviewResult> {
  // --- Applicability: Marlowe only gates design-kind work. ------------------
  if (!opts.force && !isDesignKind(task)) {
    return {
      pass: true,
      reasons: [
        `Task kind '${task.kind ?? 'none'}' is not design-kind; Marlowe's brand-lock gate does not apply.`,
      ],
      mode: 'skipped',
      score: 1,
      threshold: 0,
      breakdown: {
        mode: 'skipped',
        paletteDeltaE: null,
        deltaEThreshold: MARLOWE_DELTA_E_MAX,
        lockedProperties: [],
        honoredFraction: 1,
        conflicts: [],
        screenshotRef: null,
      },
      proof: null,
    };
  }

  // --- Resolve the negotiation inputs (card + rubric). ----------------------
  const injection = await latestInjection(task.id);

  let card: StyleCardLike | null = opts.styleCard ?? null;
  if (!card) {
    const handleOrId = readStyleHandleFromSpec(task) ?? injection?.styleCardId ?? null;
    if (handleOrId) {
      card = (await getStyleCard(handleOrId)) as unknown as StyleCardLike | null;
    }
  }

  const rubric: BrandRubricLike | null =
    opts.brandRubric ??
    ((await getDefaultBrandRubric()) as unknown as BrandRubricLike | null);

  // The transparent re-resolution. If we have no card we fall back to whatever
  // the stored injection recorded (still honest — it's the spec that shipped).
  const resolveResult: ResolveSpecResult = card
    ? resolveSpec(card, rubric)
    : {
        ledger: (injection?.ledger as LedgerEntry[]) ?? [],
        conflicts: (injection?.conflicts as SpecConflict[]) ?? [],
        resolvedSpec: {
          colors: asObject(injection?.resolvedSpec?.colors) as BrandColors,
          logo: injection?.resolvedSpec?.logo ?? null,
          a11y: injection?.resolvedSpec?.a11y ?? null,
          components: injection?.resolvedSpec?.components ?? null,
          layout: asObject(injection?.resolvedSpec?.layout),
          typography: asObject(injection?.resolvedSpec?.typography),
          spacing: asObject(injection?.resolvedSpec?.spacing),
          mood: Array.isArray(injection?.resolvedSpec?.mood)
            ? (injection?.resolvedSpec?.mood as unknown[])
            : [],
          motifs: Array.isArray(injection?.resolvedSpec?.motifs)
            ? (injection?.resolvedSpec?.motifs as unknown[])
            : [],
        },
      };

  const ledger = ledgerConformance(resolveResult);

  // --- Mode select: render (deterministic ΔE) if Remy already rendered. -----
  const render = await latestRenderQc(task.id);

  let mode: MarloweMode;
  let pass: boolean;
  let score: number;
  let threshold: number;
  const reasons: string[] = [];

  if (render && render.paletteDeltaE !== null) {
    // RENDER MODE — palette ΔE gates the pass (it is the deterministic signal).
    mode = 'render';
    threshold = RENDER_PASS_SCORE;
    score = clamp01(1 - render.paletteDeltaE / DELTA_E_DENOM);
    const withinDeltaE = render.paletteDeltaE <= MARLOWE_DELTA_E_MAX;
    pass = withinDeltaE;
    reasons.push(
      withinDeltaE
        ? `Rendered palette ΔE ${render.paletteDeltaE.toFixed(2)} ≤ ${MARLOWE_DELTA_E_MAX}: the built artifact honors the brand colors.`
        : `Rendered palette ΔE ${render.paletteDeltaE.toFixed(2)} > ${MARLOWE_DELTA_E_MAX}: the built artifact drifts from the brand-lock colors.`,
    );
    // Ledger violations are still surfaced (and can fail the gate) even when a
    // render exists — a breached lock is a breached lock.
    if (ledger.reasons.length > 0) {
      pass = false;
      reasons.push(...ledger.reasons);
    }
  } else {
    // LEDGER MODE — no render yet; conformance is the merge-ledger verdict.
    mode = 'ledger';
    threshold = LEDGER_PASS_SCORE;
    score = ledger.honoredFraction;
    pass = ledger.reasons.length === 0 && score >= LEDGER_PASS_SCORE;
    if (pass) {
      reasons.push(
        'No render yet; ledger conformance confirms every brand-locked property is won by brand-lock.',
      );
    } else {
      reasons.push(...ledger.reasons);
      if (ledger.reasons.length === 0) {
        reasons.push('Brand-lock conformance incomplete.');
      }
    }
  }

  // Conflicts arbitrated in the brand's favor are not failures, but Marlowe
  // names them so the decision stays visible.
  for (const c of resolveResult.conflicts) {
    if (c.resolution === 'brand-lock') {
      reasons.push(`Noted: ${c.note}`);
    }
  }

  const breakdown: BrandLockBreakdown = {
    mode,
    paletteDeltaE: render?.paletteDeltaE ?? null,
    deltaEThreshold: MARLOWE_DELTA_E_MAX,
    lockedProperties: ledger.lockedProperties,
    honoredFraction: ledger.honoredFraction,
    conflicts: resolveResult.conflicts,
    screenshotRef: render?.screenshotRef ?? null,
  };

  // --- Write the 'brand_lock' proof (kind reuse: 'lint'). -------------------
  let proof: Proof | null = null;
  if (!opts.dryRun) {
    proof = await attachProof({
      taskId: task.id,
      employeeSlug: MARLOWE_SLUG,
      kind: 'lint',
      status: pass ? 'pass' : 'fail',
      score,
      threshold,
      detail: {
        gate: 'marlowe',
        proof_kind: 'brand_lock',
        mode,
        pass,
        reasons,
        palette_deltaE: render?.paletteDeltaE ?? null,
        delta_e_threshold: MARLOWE_DELTA_E_MAX,
        honored_fraction: ledger.honoredFraction,
        locked_properties: ledger.lockedProperties,
        conflicts: resolveResult.conflicts,
        screenshot_ref: render?.screenshotRef ?? null,
      },
    });
  }

  return { pass, reasons, mode, score, threshold, breakdown, proof };
}

export default marloweReview;