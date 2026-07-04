import { NextResponse, type NextRequest } from 'next/server';
import { GATE_SECRET, AUTH_DISABLED, isAuthorized } from '@/lib/gate-auth';

// S1 — lock the whole app, fail-CLOSED. Every route (pages AND /api/*) requires
// auth except the gate itself and a trimmed health probe. Pages redirect to
// /gate; APIs get 401. If ATELIER_API_SECRET is unset the app 503s with
// instructions rather than silently running open (the old fail-open default
// meant a missing env var = auth off on a box wired to production Postgres).
// ATELIER_AUTH_DISABLED=1 is the explicit opt-out.
//
// runtime nodejs: self-hosted `next start` box; also keeps node:crypto usable
// and avoids the edge compile of instrumentation's job graph.

const PUBLIC_PATHS = new Set(['/gate', '/api/gate', '/api/health']);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (AUTH_DISABLED) return NextResponse.next();

  const isApi = pathname.startsWith('/api');
  if (!GATE_SECRET) {
    const hint = 'Gate not configured: set ATELIER_API_SECRET in the environment (or ATELIER_AUTH_DISABLED=1 to explicitly run open).';
    return isApi
      ? NextResponse.json({ error: 'GATE_NOT_CONFIGURED', hint }, { status: 503 })
      : new NextResponse(hint, { status: 503, headers: { 'content-type': 'text/plain' } });
  }

  if (isAuthorized(req)) return NextResponse.next();

  if (isApi) {
    return NextResponse.json({ error: 'UNAUTHORIZED', hint: 'gate in at /gate or send x-atelier-secret' }, { status: 401 });
  }
  const gate = req.nextUrl.clone();
  gate.pathname = '/gate';
  gate.search = `next=${encodeURIComponent(pathname + (req.nextUrl.search || ''))}`;
  return NextResponse.redirect(gate);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
  runtime: 'nodejs',
};
