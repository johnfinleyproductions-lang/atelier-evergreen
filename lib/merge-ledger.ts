// lib/merge-ledger.ts
//
// The Style Library merge ledger — the core, visible contract of the whole
// feature. resolveSpec() takes a Style Card (the @mention, distilled from a
// reference) and a Brand Rubric (the locked house tokens) and produces a
// single resolved spec PLUS a transparent ledger of every decision and the
// conflicts it had to arbitrate.
//
// The precedence is FIXED and human-legible — never model-guessed:
//
//   brand-lock (the rubric) WINS:  colors · logo · a11y · components
//   style card            WINS:  layout · type-rhythm · spacing · mood · motifs
//
// When the reference's own accent disagrees with the brand color (e.g. the
// screenshot is purple but the house color is teal) we KEEP the brand and
// record the disagreement in `conflicts` so it is never silently dropped.
//
// This module is a PURE function: no DB, no I/O, no env. The repository layer
// (lib/style-repo.ts → recordInjection) persists the {ledger, resolvedSpec,
// conflicts} it returns.

/* ------------------------------------------------------------------ */
/* Input shapes (structural — mirror the atelier_* jsonb columns)      */
/* ------------------------------------------------------------------ */

/** One swatch from lib/palette.ts (REAL pixels, sorted by weight). */
export interface PaletteSwatch {
  hex: string;
  weight: number;
}

/**
 * The `merged_profile` jsonb of an atelier_style_card — the style half of the
 * negotiation. All fields optional: a card may have been built from a VL stub.
 */
export interface MergedProfile {
  layout?: Record<string, unknown>;
  palette?: PaletteSwatch[];
  typography?: Record<string, unknown>;
  spacing?: Record<string, unknown>;
  mood?: unknown[];
  motifs?: unknown[];
  [key: string]: unknown;
}

/** The subset of atelier_style_card resolveSpec() consumes. */
export interface StyleCardLike {
  id?: string | null;
  handle?: string | null;
  name?: string | null;
  mergedProfile?: MergedProfile | null;
  /** snake_case escape hatch for raw DB rows. */
  merged_profile?: MergedProfile | null;
  doRules?: unknown[];
  do_rules?: unknown[];
  dontRules?: unknown[];
  dont_rules?: unknown[];
  brandLocked?: boolean;
  brand_locked?: boolean;
}

/** The `colors` block of a brand rubric's tokens. */
export interface BrandColors {
  teal?: string;
  gold?: string;
  page?: string;
  ink?: string;
  [key: string]: string | undefined;
}

/**
 * The `tokens` jsonb of an atelier_brand_rubric — the brand-lock half.
 * {colors:{teal,gold,page,ink}, type, spacing, rules[]} plus optional
 * logo / a11y / components locks.
 */
export interface BrandTokens {
  colors?: BrandColors;
  type?: Record<string, unknown>;
  spacing?: Record<string, unknown>;
  rules?: unknown[];
  logo?: unknown;
  a11y?: unknown;
  components?: unknown;
  [key: string]: unknown;
}

/** The subset of atelier_brand_rubric resolveSpec() consumes. */
export interface BrandRubricLike {
  id?: string | null;
  name?: string | null;
  tokens?: BrandTokens | null;
  isDefault?: boolean;
  is_default?: boolean;
}

/* ------------------------------------------------------------------ */
/* Output shapes                                                       */
/* ------------------------------------------------------------------ */

/** Who won a given property in the negotiation. */
export type LedgerWinner = 'brand-lock' | 'style';

/** One visible decision line. The ledger is the whole point of the feature. */
export interface LedgerEntry {
  /** The negotiated property: 'colors' | 'logo' | 'a11y' | 'components' |
   *  'layout' | 'typography' | 'spacing' | 'mood' | 'motifs'. */
  property: string;
  winner: LedgerWinner;
  /** The value that ended up in resolvedSpec for this property. */
  value: unknown;
  /** Plain-English why — references the fixed precedence. */
  reason: string;
}

/** A disagreement the precedence resolved in the brand's favor. */
export interface SpecConflict {
  property: string;
  /** What the style card / reference wanted. */
  styleValue: unknown;
  /** What the brand lock enforced (and won). */
  brandValue: unknown;
  /** Always 'brand-lock' for now — colors/logo/a11y/components are locked. */
  resolution: LedgerWinner;
  note: string;
}

/** The single resolved spec downstream generation consumes. */
export interface ResolvedSpec {
  // brand-lock domains
  colors: BrandColors | Record<string, never>;
  logo: unknown;
  a11y: unknown;
  components: unknown;
  // style domains
  layout: Record<string, unknown>;
  typography: Record<string, unknown>;
  spacing: Record<string, unknown>;
  mood: unknown[];
  motifs: unknown[];
}

export interface ResolveSpecResult {
  ledger: LedgerEntry[];
  resolvedSpec: ResolvedSpec;
  conflicts: SpecConflict[];
}

/* ------------------------------------------------------------------ */
/* The fixed precedence map (single source of truth)                   */
/* ------------------------------------------------------------------ */

/** Properties the brand rubric owns, no matter what the reference shows. */
export const BRAND_LOCKED_PROPERTIES = [
  'colors',
  'logo',
  'a11y',
  'components',
] as const;

/** Properties the style card owns — the look distilled from the reference. */
export const STYLE_OWNED_PROPERTIES = [
  'layout',
  'typography',
  'spacing',
  'mood',
  'motifs',
] as const;

/* ------------------------------------------------------------------ */
/* Small, honest color helpers (used only for conflict detection)      */
/* ------------------------------------------------------------------ */

/** Parse '#rrggbb' / '#rgb' / 'rrggbb' to [r,g,b] or null if unparseable. */
function parseHex(input: unknown): [number, number, number] | null {
  if (typeof input !== 'string') return null;
  let h = input.trim().toLowerCase();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 || /[^0-9a-f]/.test(h)) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Euclidean RGB distance (0–441.67). Good enough to flag a clash. */
function colorDistance(a: string, b: string): number | null {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (!pa || !pb) return null;
  const dr = pa[0] - pb[0];
  const dg = pa[1] - pb[1];
  const db = pa[2] - pb[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Below this RGB distance two colors are "the same brand color". */
const COLOR_MATCH_THRESHOLD = 48;

/**
 * The reference's dominant *accent*: the most-weighted swatch that isn't an
 * obvious page/ink neutral. Falls back to the single most-weighted swatch.
 */
function dominantAccent(palette: PaletteSwatch[]): PaletteSwatch | null {
  if (!Array.isArray(palette) || palette.length === 0) return null;
  const sorted = [...palette]
    .filter((s) => s && typeof s.hex === 'string')
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  if (sorted.length === 0) return null;
  const isNeutral = (hex: string): boolean => {
    const rgb = parseHex(hex);
    if (!rgb) return false;
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const nearWhite = min > 224;
    const nearBlack = max < 32;
    const lowChroma = max - min < 24; // gray-ish
    return nearWhite || nearBlack || lowChroma;
  };
  return sorted.find((s) => !isNeutral(s.hex)) ?? sorted[0];
}

/* ------------------------------------------------------------------ */
/* Normalizers (accept camelCase typed objects OR raw snake_case rows) */
/* ------------------------------------------------------------------ */

function readProfile(card: StyleCardLike | null | undefined): MergedProfile {
  if (!card) return {};
  return card.mergedProfile ?? card.merged_profile ?? {};
}

function readTokens(rubric: BrandRubricLike | null | undefined): BrandTokens {
  if (!rubric) return {};
  return rubric.tokens ?? {};
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isObject(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

/* ------------------------------------------------------------------ */
/* resolveSpec — the core contract                                     */
/* ------------------------------------------------------------------ */

/**
 * Negotiate a Style Card against a Brand Rubric under the fixed precedence.
 *
 * @param styleCard   the @mention card (its merged_profile is the style half)
 * @param brandRubric the house tokens (brand-lock half). May be null/undefined,
 *                     in which case there is nothing to lock and the style card
 *                     wins every property (each ledger line still records it).
 * @returns { ledger, resolvedSpec, conflicts } — fully transparent.
 */
export function resolveSpec(
  styleCard: StyleCardLike | null | undefined,
  brandRubric: BrandRubricLike | null | undefined,
): ResolveSpecResult {
  const profile = readProfile(styleCard);
  const tokens = readTokens(brandRubric);
  const hasBrand = hasValue(tokens);

  const ledger: LedgerEntry[] = [];
  const conflicts: SpecConflict[] = [];

  /* ---- brand-lock domains: rubric wins (or style falls through if no rubric) */

  // colors
  const brandColors = asObject(tokens.colors) as BrandColors;
  const stylePalette = Array.isArray(profile.palette) ? profile.palette : [];
  let colorsValue: BrandColors | Record<string, never>;
  if (hasBrand && hasValue(brandColors)) {
    colorsValue = brandColors;
    ledger.push({
      property: 'colors',
      winner: 'brand-lock',
      value: brandColors,
      reason:
        'Brand rubric locks the palette. Colors are a brand-lock domain, so the house tokens override the reference swatches.',
    });
    // conflict: does the reference's own accent clash with the brand color?
    const accent = dominantAccent(stylePalette);
    if (accent) {
      const brandKeys = Object.keys(brandColors).filter(
        (k) => typeof brandColors[k] === 'string',
      );
      let matched = false;
      let closest = Number.POSITIVE_INFINITY;
      let closestKey = 'teal';
      for (const key of brandKeys) {
        const d = colorDistance(accent.hex, brandColors[key] as string);
        if (d == null) continue;
        if (d < closest) {
          closest = d;
          closestKey = key;
        }
        if (d <= COLOR_MATCH_THRESHOLD) matched = true;
      }
      if (!matched && Number.isFinite(closest)) {
        const brandHex =
          (brandColors[closestKey] as string | undefined) ??
          (brandColors.teal as string | undefined) ??
          '(unset)';
        conflicts.push({
          property: 'colors',
          styleValue: accent.hex,
          brandValue: brandHex,
          resolution: 'brand-lock',
          note: `Reference accent ${accent.hex} differs from brand ${closestKey} ${brandHex}; kept brand color (brand-lock).`,
        });
      }
    }
  } else {
    // No brand colors to lock — surface the reference palette as the colors.
    const fallback = stylePalette.reduce<Record<string, string>>(
      (acc, s, i) => {
        if (s && typeof s.hex === 'string') acc[`c${i + 1}`] = s.hex;
        return acc;
      },
      {},
    );
    colorsValue = hasValue(fallback) ? (fallback as BrandColors) : {};
    ledger.push({
      property: 'colors',
      winner: 'style',
      value: colorsValue,
      reason: hasBrand
        ? 'Brand rubric defines no colors; fell back to the reference palette.'
        : 'No brand rubric supplied; colors taken from the reference palette.',
    });
  }

  // logo / a11y / components — pure brand locks, no style equivalent.
  const lockOnly = (
    property: 'logo' | 'a11y' | 'components',
  ): unknown => {
    const brandVal = tokens[property];
    if (hasBrand && hasValue(brandVal)) {
      ledger.push({
        property,
        winner: 'brand-lock',
        value: brandVal,
        reason: `${property} is a brand-lock domain; enforced from the brand rubric.`,
      });
      return brandVal;
    }
    ledger.push({
      property,
      winner: hasBrand ? 'brand-lock' : 'style',
      value: null,
      reason: hasBrand
        ? `Brand rubric specifies no ${property}; nothing to lock.`
        : `No brand rubric supplied; no ${property} lock applied.`,
    });
    return null;
  };
  const logoValue = lockOnly('logo');
  const a11yValue = lockOnly('a11y');
  const componentsValue = lockOnly('components');

  /* ---- style-owned domains: style card wins layout/type/spacing/mood/motifs */

  // layout — style only.
  const layoutValue = asObject(profile.layout);
  ledger.push({
    property: 'layout',
    winner: 'style',
    value: layoutValue,
    reason:
      'Layout is a style-owned domain; the style card defines structure and composition.',
  });

  // typography (type-rhythm) — style wins; brand `type` is only a fallback.
  let typographyValue = asObject(profile.typography);
  if (!hasValue(typographyValue) && hasValue(asObject(tokens.type))) {
    typographyValue = asObject(tokens.type);
    ledger.push({
      property: 'typography',
      winner: 'style',
      value: typographyValue,
      reason:
        'Type-rhythm is style-owned, but the style card had none — fell back to the brand type tokens.',
    });
  } else {
    ledger.push({
      property: 'typography',
      winner: 'style',
      value: typographyValue,
      reason:
        'Type-rhythm is a style-owned domain; the style card sets the typographic scale and rhythm over the brand defaults.',
    });
  }

  // spacing — style wins; brand spacing is only a fallback.
  let spacingValue = asObject(profile.spacing);
  if (!hasValue(spacingValue) && hasValue(asObject(tokens.spacing))) {
    spacingValue = asObject(tokens.spacing);
    ledger.push({
      property: 'spacing',
      winner: 'style',
      value: spacingValue,
      reason:
        'Spacing is style-owned, but the style card had none — fell back to the brand spacing tokens.',
    });
  } else {
    ledger.push({
      property: 'spacing',
      winner: 'style',
      value: spacingValue,
      reason:
        'Spacing is a style-owned domain; the style card sets the spatial rhythm.',
    });
  }

  // mood — style only.
  const moodValue = asArray(profile.mood);
  ledger.push({
    property: 'mood',
    winner: 'style',
    value: moodValue,
    reason: 'Mood is a style-owned domain; carried from the style card.',
  });

  // motifs — style only.
  const motifsValue = asArray(profile.motifs);
  ledger.push({
    property: 'motifs',
    winner: 'style',
    value: motifsValue,
    reason:
      'Motifs are a style-owned domain; carried from the style card.',
  });

  const resolvedSpec: ResolvedSpec = {
    colors: colorsValue,
    logo: logoValue,
    a11y: a11yValue,
    components: componentsValue,
    layout: layoutValue,
    typography: typographyValue,
    spacing: spacingValue,
    mood: moodValue,
    motifs: motifsValue,
  };

  return { ledger, resolvedSpec, conflicts };
}

export default resolveSpec;
