// lib/visual-qa.ts
//
// The Visual-QA gate. Render an artifact (HTML or URL) headless, screenshot it,
// and score it against a style card's resolved spec. The pass is DETERMINISTIC:
// palette ΔE (real rendered pixels vs the brand-locked colors) + DOM assertions.
// Any VL/aesthetic judgment is ADVISORY only — it can fail a card but can never
// pass one alone. Output is a render_qc PROOF blob ready for attachProof().

import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { extractPalette, type PaletteSwatch } from './palette';
import { resolveSpec, type ResolvedSpec } from './merge-ledger';
import { getStyleCard, getDefaultBrandRubric } from './style-repo';

const PALETTE_DELTAE_THRESHOLD = 35; // CIE76 — below this two colors are "the same brand color"

export interface RenderAndScoreInput {
  html?: string;
  url?: string;
  styleCardHandle?: string;
  resolvedSpec?: ResolvedSpec | null;
  assertions?: string[]; // CSS selectors that must each match >=1 element
}

export interface AssertionResult {
  selector: string;
  ok: boolean;
}

export interface RenderQcProof {
  proofKind: 'render_qc';
  pass: boolean;
  matchScore: number; // 0..1
  breakdown: {
    paletteDeltaE: { max: number; mean: number; pass: boolean } | null;
    assertions: { noHorizontalScroll: boolean; selectors: AssertionResult[]; pass: boolean };
  };
  screenshotRef: string | null;
  vl: { advisory: true; note: string; score: number | null };
  error?: string;
}

// ── color math (sRGB hex -> Lab -> CIE76 ΔE) ────────────────────────────────
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
  let [R, G, B] = [r / 255, g / 255, b / 255].map((v) =>
    v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92,
  ) as [number, number, number];
  R *= 100; G *= 100; B *= 100;
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 95.047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 100.0;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 108.883;
  [x, y, z] = [x, y, z].map((v) => (v > 0.008856 ? v ** (1 / 3) : 7.787 * v + 16 / 116)) as [number, number, number];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(a: string, b: string): number | null {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return null;
  const la = rgbToLab(ra), lb = rgbToLab(rb);
  return Math.sqrt((la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2);
}

function specColors(spec: ResolvedSpec | null | undefined): string[] {
  const c = spec?.colors as Record<string, unknown> | undefined;
  if (!c) return [];
  return Object.values(c).filter((v): v is string => typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v));
}

/** Render the artifact, screenshot it, score it. Fails closed — never throws. */
export async function renderAndScore(input: RenderAndScoreInput): Promise<RenderQcProof> {
  const fail = (error: string): RenderQcProof => ({
    proofKind: 'render_qc',
    pass: false,
    matchScore: 0,
    breakdown: { paletteDeltaE: null, assertions: { noHorizontalScroll: false, selectors: [], pass: false } },
    screenshotRef: null,
    vl: { advisory: true, note: 'not evaluated', score: null },
    error,
  });

  try {
    // Resolve the brand-locked spec colors (explicit spec wins; else from the card).
    let spec = input.resolvedSpec ?? null;
    if (!spec && input.styleCardHandle) {
      const card = await getStyleCard(input.styleCardHandle);
      const rubric = await getDefaultBrandRubric();
      if (card) spec = resolveSpec(card as never, rubric as never).resolvedSpec;
    }
    const wantColors = specColors(spec);

    // Render headless. Dynamic import keeps the app buildable before chromium is installed.
    const { chromium } = (await import('playwright-core')) as typeof import('playwright-core');
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

    if (input.html) await page.setContent(input.html, { waitUntil: 'networkidle' });
    else if (input.url) await page.goto(input.url, { waitUntil: 'networkidle', timeout: 30000 });
    else { await browser.close(); return fail('NO_ARTIFACT'); }
    await page.waitForTimeout(400);

    const dir = path.join(process.cwd(), 'public', 'uploads', 'atelier-qa');
    await mkdir(dir, { recursive: true });
    const id = randomUUID();
    const file = path.join(dir, `${id}.png`);
    await page.screenshot({ path: file, fullPage: true });

    // DOM assertions (in-page).
    const dom = await page.evaluate((selectors: string[]) => {
      const de = document.documentElement;
      const noScroll = de.scrollWidth - de.clientWidth <= 2 && document.body.scrollWidth - document.body.clientWidth <= 2;
      const sel = selectors.map((s) => ({ selector: s, ok: !!document.querySelector(s) }));
      return { noScroll, sel };
    }, input.assertions ?? []);

    await browser.close();

    // DETERMINISTIC gate 1 — palette conformance on the real rendered pixels.
    // Metric: every PROMINENT rendered color must sit near SOME brand color.
    // (Off-brand pages introduce foreign hues; on-brand pages only use the
    // house palette — even when accents are small, the dominant swatches that
    // survive a k-means palette are all brand colors on a compliant page.)
    let paletteDeltaE: RenderQcProof['breakdown']['paletteDeltaE'] = null;
    if (wantColors.length) {
      const shot = await readFile(file);
      const rendered: PaletteSwatch[] = await extractPalette(shot);
      // weight-filter trivial noise swatches (< 4% of pixels)
      const totalW = rendered.reduce((a, s) => a + s.weight, 0) || 1;
      const prominent = rendered.filter((s) => s.weight / totalW >= 0.008);
      const deltas = (prominent.length ? prominent : rendered).map((s) => {
        const best = wantColors.reduce((min, c) => {
          const d = deltaE(s.hex, c);
          return d !== null && d < min ? d : min;
        }, Infinity);
        return Number.isFinite(best) ? best : 999;
      });
      const max = deltas.length ? Math.max(...deltas) : 0;
      const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      paletteDeltaE = { max: Math.round(max * 10) / 10, mean: Math.round(mean * 10) / 10, pass: max <= PALETTE_DELTAE_THRESHOLD };
    }

    // DETERMINISTIC gate 2 — DOM assertions.
    const selResults: AssertionResult[] = dom.sel;
    const assertionsPass = dom.noScroll && selResults.every((s) => s.ok);

    const palettePass = paletteDeltaE ? paletteDeltaE.pass : true; // no spec colors -> no color constraint
    const pass = palettePass && assertionsPass;

    const paletteScore = paletteDeltaE ? Math.max(0, 1 - paletteDeltaE.max / 60) : 1;
    const assertScore = selResults.length ? selResults.filter((s) => s.ok).length / selResults.length : 1;
    const matchScore = Math.round((0.6 * paletteScore + 0.4 * (dom.noScroll ? assertScore : 0)) * 100) / 100;

    return {
      proofKind: 'render_qc',
      pass,
      matchScore,
      breakdown: {
        paletteDeltaE,
        assertions: { noHorizontalScroll: dom.noScroll, selectors: selResults, pass: assertionsPass },
      },
      screenshotRef: `/uploads/atelier-qa/${id}.png`,
      vl: { advisory: true, note: 'deterministic gate only; VL not consulted in v2', score: null },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'RENDER_FAILED');
  }
}
