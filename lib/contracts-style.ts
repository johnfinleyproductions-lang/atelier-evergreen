import { z } from 'zod';

/**
 * lib/contracts-style.ts — the single source of types for the Style Library.
 *
 * Sibling to lib/contracts.ts (the v1 spine). Every enum here mirrors the
 * `text`-typed columns in the shared Postgres schema (atelier_reference,
 * atelier_style_profile, atelier_style_card, atelier_brand_rubric,
 * atelier_style_injection). The drizzle schema (lib/style-schema.ts), the
 * palette extractor (lib/palette.ts), the profiler (lib/style-profiler.ts),
 * the merge ledger (lib/merge-ledger.ts), the repository (lib/style-repo.ts)
 * and the API routes all consume these zod schemas / inferred types.
 * Keep names in lockstep with migration 0002.
 */

/* ------------------------------------------------------------------ */
/* Enums (mirror the snake_case text columns)                          */
/* ------------------------------------------------------------------ */

/** atelier_reference.source_type */
export const REFERENCE_SOURCE_TYPES = [
  'upload',
  'url',
  'folder',
  'generated',
] as const;
export const ReferenceSourceTypeSchema = z.enum(REFERENCE_SOURCE_TYPES);
export type ReferenceSourceType = z.infer<typeof ReferenceSourceTypeSchema>;

/** atelier_style_card.status */
export const STYLE_CARD_STATUSES = ['draft', 'ready', 'archived'] as const;
export const StyleCardStatusSchema = z.enum(STYLE_CARD_STATUSES);
export type StyleCardStatus = z.infer<typeof StyleCardStatusSchema>;

/**
 * atelier_style_injection.ledger[].winner — the visible precedence verdict.
 * 'brand-lock' = the rubric won (colors/logo/a11y/components).
 * 'style'      = the style card won (layout/type-rhythm/spacing/mood/motifs).
 */
export const MERGE_WINNERS = ['brand-lock', 'style'] as const;
export const MergeWinnerSchema = z.enum(MERGE_WINNERS);
export type MergeWinner = z.infer<typeof MergeWinnerSchema>;

/* ------------------------------------------------------------------ */
/* The palette — the load-bearing accurate part                        */
/* ------------------------------------------------------------------ */

/**
 * One swatch from extractPalette() (lib/palette.ts). These are REAL pixels
 * sampled via `sharp`, NOT model-guessed. `weight` is the fraction of the
 * sampled image the color occupies (0..1); the array is sorted by weight desc.
 */
export const PaletteSwatchSchema = z.object({
  hex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'hex must be #RRGGBB'),
  weight: z.number().min(0).max(1),
});
export type PaletteSwatch = z.infer<typeof PaletteSwatchSchema>;

export const PaletteSchema = z.array(PaletteSwatchSchema);
export type Palette = z.infer<typeof PaletteSchema>;

/* ------------------------------------------------------------------ */
/* The structured VL profile (layout/typography/spacing/mood)          */
/* ------------------------------------------------------------------ */

/**
 * atelier_style_profile — the per-reference analysis. `palette` is always
 * REAL (from sharp); `layout`/`typography`/`spacing`/`mood` come from the
 * qwen2.5-VL pass when ATELIER_VL_URL is set, otherwise a clearly-marked
 * heuristic stub ({ note: 'vl-stub' }) lives in `raw`. The columns are jsonb,
 * so the inner shapes stay permissive on read.
 */
export const StyleProfileSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  referenceId: z.string().uuid(),
  model: z.string().default('qwen2.5-vl'),
  layout: z.record(z.string(), z.unknown()).default({}),
  palette: PaletteSchema.default([]),
  typography: z.record(z.string(), z.unknown()).default({}),
  spacing: z.record(z.string(), z.unknown()).default({}),
  mood: z.array(z.string()).default([]),
  raw: z.record(z.string(), z.unknown()).default({}),
  embedding: z.array(z.number()).nullable().default(null),
  createdAt: z.union([z.string(), z.date()]).optional(),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

/* ------------------------------------------------------------------ */
/* The reference row                                                   */
/* ------------------------------------------------------------------ */

/** atelier_reference — the captured image a profile is derived from. */
export const ReferenceSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sourceType: ReferenceSourceTypeSchema,
  imageUrl: z.string().nullable().optional(),
  screenshotPath: z.string().nullable().optional(),
  dedupeHash: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
});
export type Reference = z.infer<typeof ReferenceSchema>;

/* ------------------------------------------------------------------ */
/* The style card — the @mention members reach for                     */
/* ------------------------------------------------------------------ */

/**
 * atelier_style_card — the reusable, @handle-addressable style. `merged_profile`
 * is the rolled-up shape across `hero_reference_ids`; `do_rules`/`dont_rules`
 * are human-readable guardrails; `brand_locked` keeps the rubric in charge of
 * colors/logo/a11y when this card is injected.
 */
export const StyleCardSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  handle: z.string().min(1),
  name: z.string().min(1),
  mergedProfile: z.record(z.string(), z.unknown()).default({}),
  heroReferenceIds: z.array(z.string().uuid()).default([]),
  doRules: z.array(z.string()).default([]),
  dontRules: z.array(z.string()).default([]),
  brandLocked: z.boolean().default(true),
  usageCount: z.number().int().default(0),
  status: StyleCardStatusSchema.default('ready'),
  createdAt: z.union([z.string(), z.date()]).optional(),
});
export type StyleCard = z.infer<typeof StyleCardSchema>;

/* ------------------------------------------------------------------ */
/* The brand rubric — the brand-lock source of truth                   */
/* ------------------------------------------------------------------ */

/**
 * atelier_brand_rubric.tokens — the locked brand vocabulary. Colors carry the
 * canonical teal/gold/page/ink; `rules` are the verbatim brand-lock statements
 * the merge ledger cites when it overrides a style card.
 */
export const BrandRubricTokensSchema = z.object({
  colors: z
    .object({
      teal: z.string(),
      gold: z.string(),
      page: z.string(),
      ink: z.string(),
    })
    .partial()
    .extend({ teal: z.string(), gold: z.string(), page: z.string(), ink: z.string() })
    .catchall(z.string()),
  type: z.record(z.string(), z.unknown()).default({}),
  spacing: z.record(z.string(), z.unknown()).default({}),
  rules: z.array(z.string()).default([]),
});
export type BrandRubricTokens = z.infer<typeof BrandRubricTokensSchema>;

/** atelier_brand_rubric — the row wrapping the tokens. */
export const BrandRubricSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  tokens: BrandRubricTokensSchema,
  isDefault: z.boolean().default(false),
  createdAt: z.union([z.string(), z.date()]).optional(),
});
export type BrandRubric = z.infer<typeof BrandRubricSchema>;

/* ------------------------------------------------------------------ */
/* The merge ledger — the core contract                                */
/* ------------------------------------------------------------------ */

/**
 * One line of resolveSpec()'s decision log (lib/merge-ledger.ts). Every
 * resolved property records WHO won and WHY, so the precedence is always
 * visible. `value` is whatever was resolved for that property (jsonb).
 */
export const MergeLedgerEntrySchema = z.object({
  property: z.string().min(1),
  winner: MergeWinnerSchema,
  value: z.unknown(),
  reason: z.string().min(1),
});
export type MergeLedgerEntry = z.infer<typeof MergeLedgerEntrySchema>;

/** A flagged disagreement (e.g. ref accent != brand teal -> kept brand). */
export const MergeConflictSchema = z.object({
  property: z.string().min(1),
  styleValue: z.unknown(),
  brandValue: z.unknown(),
  resolution: z.string().min(1),
});
export type MergeConflict = z.infer<typeof MergeConflictSchema>;

/**
 * The full output of resolveSpec(styleCard, brandRubric) and the persisted
 * shape behind atelier_style_injection (ledger/resolved_spec/conflicts).
 */
export const ResolvedSpecSchema = z.object({
  ledger: z.array(MergeLedgerEntrySchema),
  resolvedSpec: z.record(z.string(), z.unknown()),
  conflicts: z.array(MergeConflictSchema),
});
export type ResolvedSpec = z.infer<typeof ResolvedSpecSchema>;

/* ------------------------------------------------------------------ */
/* Input contracts (what the API routes / repo accept)                 */
/* ------------------------------------------------------------------ */

/**
 * profileReference() input. Exactly one image source is required: a remote
 * `imageUrl` OR base64 bytes. `handle` is the @mention the resulting style
 * card will be addressable by (unique-per-workspace).
 */
export const ProfileReferenceInputSchema = z
  .object({
    imageUrl: z.string().url().optional(),
    imageBase64: z.string().min(1).optional(),
    handle: z
      .string()
      .min(1, 'handle is required')
      .regex(/^@?[a-z0-9][a-z0-9-]*$/i, 'handle must be a slug-like @mention'),
    name: z.string().optional(),
    sourceType: ReferenceSourceTypeSchema.optional(),
  })
  .refine((v) => Boolean(v.imageUrl) !== Boolean(v.imageBase64), {
    message: 'provide exactly one of imageUrl or imageBase64',
    path: ['imageUrl'],
  });
export type ProfileReferenceInput = z.infer<typeof ProfileReferenceInputSchema>;

/**
 * resolveSpec() / inject input. `styleCardId` selects the card; `brandRubricId`
 * is optional — when omitted the repo falls back to the default brand rubric.
 */
export const ResolveSpecInputSchema = z.object({
  styleCardId: z.string().uuid().optional(),
  handle: z.string().optional(),
  brandRubricId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
});
export type ResolveSpecInput = z.infer<typeof ResolveSpecInputSchema>;
