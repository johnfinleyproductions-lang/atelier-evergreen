import { NextResponse, type NextRequest } from 'next/server';
import { ProfileReferenceInputSchema } from '@/lib/contracts-style';
import { profileReference } from '@/lib/style-profiler';

// postgres-js (via lib/style-repo) needs the Node runtime; never run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/style/profile
 * Body: ProfileReferenceInput { imageUrl?, imageBytes?, handle, name? }
 *
 * Runs the Style Library profiler:
 *   (1) extractPalette() — REAL pixels via `sharp` (the honesty guarantee),
 *   (2) the structured VL profile (layout/typography/spacing/mood) — real if
 *       ATELIER_VL_URL is set, otherwise a clearly-marked {note:'vl-stub'},
 *   (3) persists the reference + profile and mints a style card with @handle.
 *
 * Returns { reference, profile, card }.
 */
export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_JSON', message: 'Request body must be valid JSON.' },
      { status: 400 },
    );
  }

  const parsed = ProfileReferenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await profileReference(parsed.data);
    // result = { reference, profile, card }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const code =
      err instanceof Error
        ? (err as Error & { code?: string }).code ?? err.message
        : String(err);

    if (code === 'HANDLE_TAKEN') {
      return NextResponse.json({ error: 'HANDLE_TAKEN' }, { status: 409 });
    }
    if (code === 'NO_IMAGE') {
      return NextResponse.json({ error: 'NO_IMAGE' }, { status: 400 });
    }
    if (code === 'PALETTE_FAILED') {
      return NextResponse.json({ error: 'PALETTE_FAILED' }, { status: 422 });
    }

    console.error('[POST /api/style/profile] profileReference failed:', err);
    return NextResponse.json({ error: 'PROFILE_FAILED' }, { status: 500 });
  }
}
