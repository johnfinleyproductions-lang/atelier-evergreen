// lib/gate-auth.ts
//
// One auth core shared by the middleware, /api/gate, and /api/health.
//
// Model: a single shared secret (ATELIER_API_SECRET) authorizes two ways —
//   • browser: POST it once at /gate → an httpOnly cookie holding a DERIVED
//     session token (HMAC of an epoch string, never the raw secret). Bump
//     ATELIER_SESSION_EPOCH to revoke every session without rotating the
//     secret the CLI/bridges use.
//   • programmatic: send the raw secret in an x-atelier-secret header
//     (slack-bridge, curl, pipelines).
//
// Fail-CLOSED: no secret configured → nothing is authorized (the middleware
// 503s with instructions). ATELIER_AUTH_DISABLED=1 is the explicit, deliberate
// opt-out for running open — never the silent default it used to be.
//
// All comparisons are constant-time (both sides HMAC'd to equalize length).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const GATE_SECRET = process.env.ATELIER_API_SECRET ?? '';
export const AUTH_DISABLED = process.env.ATELIER_AUTH_DISABLED === '1';
const EPOCH = process.env.ATELIER_SESSION_EPOCH ?? 'v1';

/** The derived token the browser cookie holds — never the raw secret. */
export function sessionToken(): string {
  return createHmac('sha256', GATE_SECRET).update(`atelier-session-${EPOCH}`).digest('hex');
}

/** Constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'atelier-eq').update(a).digest();
  const hb = createHmac('sha256', 'atelier-eq').update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface AuthableRequest {
  cookies: { get(name: string): { value: string } | undefined };
  headers: { get(name: string): string | null };
}

/** Is this request authorized (valid session cookie OR raw-secret header)? */
export function isAuthorized(req: AuthableRequest): boolean {
  if (AUTH_DISABLED) return true;
  if (!GATE_SECRET) return false;
  const cookie = req.cookies.get('atelier_auth')?.value ?? '';
  if (cookie && safeEqual(cookie, sessionToken())) return true;
  const header = req.headers.get('x-atelier-secret') ?? '';
  return !!header && safeEqual(header, GATE_SECRET);
}
