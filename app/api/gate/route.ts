import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SECRET = process.env.ATELIER_API_SECRET ?? '';

// Exchange the shared secret for an httpOnly session cookie so the browser UI's
// own /api/* fetches are authorized. Public (middleware allowlists it).
export async function POST(req: NextRequest) {
  let secret = '';
  try { secret = (await req.json())?.secret ?? ''; } catch { /* ignore */ }
  if (!SECRET || secret !== SECRET) {
    return NextResponse.json({ ok: false, error: 'BAD_SECRET' }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set('atelier_auth', SECRET, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
