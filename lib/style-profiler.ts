// lib/style-profiler.ts
//
// The Style Library profiler. profileReference() is the one entrypoint that
// turns a single visual reference (an upload, a URL, a screenshot) into the
// three persisted rows the @-mention system needs:
//
//   atelier_reference        — the raw source pointer (+ dedupe hash)
//   atelier_style_profile    — the analysed style (palette + VL structure)
//   atelier_style_card       — the @handle other employees inject by name
//
// HONESTY CONTRACT (the whole point of this module):
//   • The PALETTE is REAL. It comes from extractPalette() in lib/palette.ts,
//     which reads actual pixels via `sharp` and k-means quantises them. It is
//     never model-guessed.
//   • The STRUCTURED PROFILE (layout / typography / spacing / mood) is REAL
//     only when a vision-language endpoint is configured via ATELIER_VL_URL
//     (qwen2.5-VL). When it is NOT configured — or the call fails — we DO NOT
//     block the feature: we return a clearly-marked heuristic stub
//     ({ note: 'vl-stub' }) so the caller can always create a usable card.
//
// Every write goes through lib/style-repo.ts, which scopes to ATELIER_WS.

import { createHash } from 'crypto';
import { extractPalette } from './palette';
import { insertReference, insertProfile, createStyleCard } from './style-repo';
import type { Reference, StyleProfile, StyleCard, PaletteSwatch } from './contracts-style';

// ---------------------------------------------------------------------------
// Public shapes.
// ---------------------------------------------------------------------------

/** Input to profileReference(): supply image bytes/path OR a URL, plus the @handle. */
export interface ProfileReferenceInput {
  /** Raw image bytes (Buffer/Uint8Array) or a local filesystem path. */
  imageBytes?: Buffer | Uint8Array | string;
  imageBase64?: string;
  /** A remote image URL. Fetched for the palette pass when imageBytes is absent. */
  imageUrl?: string;
  /** Optional pre-captured screenshot path (e.g. for source_type 'url' | 'folder'). */
  screenshotPath?: string;
  /** Where this reference came from. Defaults to 'upload' (or 'url' when only imageUrl is set). */
  sourceType?: 'upload' | 'url' | 'folder' | 'generated';
  /** The @mention handle this reference becomes (unique-per-workspace). */
  handle: string;
  /** Human-friendly card name. Defaults to a title-cased version of the handle. */
  name?: string;
}

/** What profileReference() returns: the three freshly persisted rows. */
export interface ProfileReferenceResult {
  reference: Reference;
  profile: StyleProfile;
  card: StyleCard;
}

/** The structured (VL) half of a profile — real or stub, but always this shape. */
export interface VlProfile {
  layout: Record<string, unknown>;
  typography: Record<string, unknown>;
  spacing: Record<string, unknown>;
  mood: unknown[];
  raw: Record<string, unknown>;
  /** True only when ATELIER_VL_URL answered; false for the heuristic stub. */
  real: boolean;
}

const VL_MODEL = 'qwen2.5-vl';

// ---------------------------------------------------------------------------
// Image acquisition.
// ---------------------------------------------------------------------------

/**
 * Resolve the input to a concrete Buffer (or a local path string) that
 * extractPalette() can read. extractPalette accepts bytes OR a path; a remote
 * URL is fetched here so the palette pass always works on real pixels.
 */
async function resolveImageInput(
  input: ProfileReferenceInput,
): Promise<Buffer | string> {
  if (input.imageBytes !== undefined) {
    if (typeof input.imageBytes === 'string') return input.imageBytes; // local path
    return Buffer.from(input.imageBytes);
  }
if (input.imageBase64) return Buffer.from(input.imageBase64, 'base64');
    if (input.imageUrl) {
    const res = await fetch(input.imageUrl);
    if (!res.ok) {
      throw new Error(
        `STYLE_PROFILE_FETCH_FAILED: ${input.imageUrl} -> ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('STYLE_PROFILE_NO_IMAGE: provide imageBytes or imageUrl');
}

/** Stable dedupe hash of the actual image bytes (sha256, first 32 hex chars). */
function dedupeHashOf(image: Buffer | string): string {
  const h = createHash('sha256');
  h.update(typeof image === 'string' ? `path:${image}` : image);
  return h.digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// The VL pass (real when ATELIER_VL_URL is set; honest stub otherwise).
// ---------------------------------------------------------------------------

/** The clearly-marked heuristic stub. Never pretends to be real analysis. */
function vlStub(reason: string): VlProfile {
  const note = 'vl-stub';
  return {
    layout: { note },
    typography: { note },
    spacing: { note },
    mood: [],
    raw: { note, vlConfigured: Boolean(process.env.ATELIER_VL_URL), reason },
    real: false,
  };
}

/**
 * Call the configured qwen2.5-VL endpoint for the structured profile. The
 * endpoint is expected to accept { image, prompt } and return JSON with
 * layout / typography / spacing / mood. ANY failure (no endpoint, network,
 * bad JSON) degrades gracefully to vlStub() — the feature must never block on
 * a vision service being up.
 */
async function runVlProfile(
  image: Buffer | string,
  imageUrl?: string,
): Promise<VlProfile> {
  const endpoint = process.env.ATELIER_VL_URL;
  if (!endpoint) return vlStub('ATELIER_VL_URL not set');

  try {
    // Prefer a URL the VL service can fetch itself; else inline base64 bytes.
    const imageField =
      imageUrl ??
      (typeof image === 'string'
        ? image
        : `data:image/png;base64,${image.toString('base64')}`);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: VL_MODEL,
        image: imageField,
        prompt:
          'Analyse this UI/visual reference. Return strict JSON with keys: ' +
          'layout (object: grid, structure, density), ' +
          'typography (object: families, scale, weight, rhythm), ' +
          'spacing (object: unit, rhythm, whitespace), ' +
          'mood (array of short adjectives). No prose, JSON only.',
      }),
    });

    if (!res.ok) return vlStub(`VL endpoint ${res.status}`);

    const data = (await res.json()) as Record<string, unknown>;
    // Accept either a flat object or { result: {...} } / { content: "json..." }.
    const parsed = coerceVlPayload(data);
    if (!parsed) return vlStub('VL response unparseable');

    return {
      layout: asObject(parsed.layout),
      typography: asObject(parsed.typography),
      spacing: asObject(parsed.spacing),
      mood: asArray(parsed.mood),
      raw: { vlConfigured: true, model: VL_MODEL, response: data },
      real: true,
    };
  } catch (err) {
    return vlStub(`VL call threw: ${(err as Error).message}`);
  }
}

/** Pull the structured object out of common VL response envelopes. */
function coerceVlPayload(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  // 1) already the structured object
  if ('layout' in data || 'typography' in data || 'mood' in data) return data;
  // 2) { result: {...} }
  if (data.result && typeof data.result === 'object') {
    return data.result as Record<string, unknown>;
  }
  // 3) { content: "<json string>" } (chat-completion style)
  const content =
    typeof data.content === 'string'
      ? data.content
      : typeof (data as { text?: unknown }).text === 'string'
        ? ((data as { text: string }).text)
        : null;
  if (content) {
    try {
      const stripped = content.replace(/```json\s*|\s*```/g, '').trim();
      const obj = JSON.parse(stripped);
      return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

function titleCaseHandle(handle: string): string {
  return handle
    .replace(/^@/, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// The entrypoint.
// ---------------------------------------------------------------------------

/**
 * Profile a single visual reference end-to-end.
 *
 * Steps:
 *   1. REAL palette — extractPalette() over actual pixels (sharp + k-means).
 *   2. Structured VL profile — real if ATELIER_VL_URL is set, else a clearly
 *      marked { note: 'vl-stub' } heuristic stub.
 *   3. Persist atelier_reference + atelier_style_profile, then create the
 *      atelier_style_card under the given @handle.
 *
 * Returns the three freshly persisted rows. The result is honest about which
 * parts are real: profile.palette is always real; the layout/typography/
 * spacing/mood are real only when profile.raw.vlConfigured === true and there
 * is no { note: 'vl-stub' }.
 */
export async function profileReference(
  input: ProfileReferenceInput,
): Promise<ProfileReferenceResult> {
  if (!input.handle || !input.handle.trim()) {
    throw new Error('STYLE_PROFILE_NO_HANDLE: a handle is required');
  }

  const image = await resolveImageInput(input);
  const sourceType =
    input.sourceType ?? (input.imageUrl && input.imageBytes === undefined ? 'url' : 'upload');

  // (1) REAL palette — actual pixels, never model-guessed.
  const palette: PaletteSwatch[] = await extractPalette(image);

  // (2) Structured profile — real VL or honest stub.
  const vl = await runVlProfile(image, input.imageUrl);

  // (3a) Persist the reference (with a dedupe hash over the real bytes).
  const reference = await insertReference({
    sourceType,
    imageUrl: input.imageUrl ?? null,
    screenshotPath: input.screenshotPath ?? null,
    dedupeHash: dedupeHashOf(image),
  });

  // (3b) Persist the profile linked to that reference.
  const profile = await insertProfile({
    referenceId: reference.id,
    model: VL_MODEL,
    layout: vl.layout,
    palette,
    typography: vl.typography,
    spacing: vl.spacing,
    mood: vl.mood,
    raw: vl.raw,
    embedding: null, // semantic embedding is computed by a separate pass
  });

  // (3c) Create the @-card. The merged_profile seeds from this single
  //      reference; the merge ledger refines it once a rubric is applied.
  const card = await createStyleCard({
    handle: input.handle.trim().replace(/^@/, ''),
    name: input.name ?? titleCaseHandle(input.handle),
    mergedProfile: {
      palette,
      layout: vl.layout,
      typography: vl.typography,
      spacing: vl.spacing,
      mood: vl.mood,
      vlReal: vl.real,
    },
    heroReferenceIds: [reference.id],
    doRules: [],
    dontRules: [],
    brandLocked: true,
    status: 'ready',
  });

  return { reference, profile, card } as unknown as ProfileReferenceResult;
}
