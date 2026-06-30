import { NextResponse, type NextRequest } from 'next/server';
import { ResolveSpecInputSchema } from '@/lib/contracts-style';
import {
  getStyleCard,
  getDefaultBrandRubric,
  recordInjection,
} from '@/lib/style-repo';
import { resolveSpec } from '@/lib/merge-ledger';

// postgres-js needs the Node runtime; never run on the edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/style/resolve
 * Body: ResolveSpecInput { handle? | styleCardId?, brandRubricId?, taskId? }
 *
 * Resolves a single style card against the brand rubric using the fixed,
 * visible precedence in lib/merge-ledger (brand-lock WINS colors/logo/a11y/
 * components; the style card WINS layout/type-rhythm/spacing/mood/motifs).
 *
 * Steps:
 *   (1) getStyleCard(handle | id)        — workspace-scoped
 *   (2) getDefaultBrandRubric()          — the brand-lock side of the merge
 *   (3) resolveSpec(card, rubric)        — { ledger, resolvedSpec, conflicts }
 *   (4) recordInjection(...)             — persist the merge (with optional taskId)
 *
 * Returns { ledger, resolvedSpec, conflicts, injectionId }.
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

  const parsed = ResolveSpecInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'VALIDATION_FAILED', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { handle, styleCardId, brandRubricId, taskId } = parsed.data;

  try {
    // (1) Resolve the style card by handle or id (workspace-scoped).
    const styleCard = await getStyleCard(styleCardId ?? handle!);
    if (!styleCard) {
      return NextResponse.json({ error: 'STYLE_CARD_NOT_FOUND' }, { status: 404 });
    }

    // (2) The brand-lock side. A missing rubric is not fatal — the merge still
    //     runs (style card simply wins every property), but it is honest about
    //     there being no brand lock in play.
    const brandRubric = await getDefaultBrandRubric();

    // (3) The core contract: the visible merge ledger + resolved spec.
    const { ledger, resolvedSpec, conflicts } = resolveSpec(styleCard, brandRubric);

    // (4) Persist the injection (optionally bound to a task).
    const injection = await recordInjection({
      taskId: taskId ?? null,
      styleCardId: styleCard.id,
      brandRubricId: brandRubric?.id ?? null,
      ledger,
      resolvedSpec: resolvedSpec as unknown as Record<string, unknown>,
      conflicts,
    });

    return NextResponse.json(
      { ledger, resolvedSpec, conflicts, injectionId: injection.id },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[POST /api/style/resolve] resolveSpec failed:', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
  }
}
