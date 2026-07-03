import { NextResponse, type NextRequest } from 'next/server';

// S1 — lock the control plane. Every /api/* route had zero auth while wired to
// evergreen-core's PRODUCTION Postgres over 0.0.0.0. This gate requires a shared
// secret (cookie for the browser, or x-atelier-secret header for CLI/programmatic)
// on all /api/* except the public health check and the gate itself.
//
// Rollout-safe: if ATELIER_API_SECRET is unset, auth is OFF (fail-open) so a
// misconfigured deploy can't brick the app; set the env var to turn it ON.
const SECRET = process.env.ATELIER_API_SECRET ?? '';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/api/health' || pathname === '/api/gate') return NextResponse.next();

  if (!SECRET) return NextResponse.next(); // auth not configured → allow

  const provided = req.cookies.get('atelier_auth')?.value ?? req.headers.get('x-atelier-secret') ?? '';
  if (provided === SECRET) return NextResponse.next();

  return NextResponse.json({ error: 'UNAUTHORIZED', hint: 'gate in at /gate or send x-atelier-secret' }, { status: 401 });
}

// runtime: 'nodejs' — this is a self-hosted `next start` box, and edge middleware
// forces an edge compile of instrumentation.ts whose graph (jobs → lanes/hugo →
// postgres/sharp/playwright) can't bundle for edge. Node middleware avoids that
// entire compile. Requires experimental.nodeMiddleware in next.config.ts.
export const config = { matcher: ['/api/:path*'], runtime: 'nodejs' };
