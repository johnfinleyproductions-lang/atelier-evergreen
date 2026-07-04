import { NextResponse, type NextRequest } from 'next/server';
import { GATE_SECRET, safeEqual, sessionToken } from '@/lib/gate-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Exchange the shared secret for an httpOnly session cookie. The cookie holds
// a DERIVED token (HMAC), never the raw secret — so a browser can't leak the
// master credential, and bumping ATELIER_SESSION_EPOCH revokes every session
// without rotating the secret the CLI/bridges use.
export async function POST(req: NextRequest) {
  let secret = '';
  try { secret = (await req.json())?.secret ?? ''; } catch { /* ignore */ }
  if (!GATE_SECRET || !secret || !safeEqual(secret, GATE_SECRET)) {
    return NextResponse.json({ ok: false, error: 'BAD_SECRET' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('atelier_auth', sessionToken(), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

// Logout: clear the session cookie.
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set('atelier_auth', '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
