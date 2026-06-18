import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { getAppSetting } from '@/lib/supabase/app-settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Lightweight "is my session still valid?" probe for the client-side
 * {@link SessionInvalidationWatcher}. Mirrors the force-logout check the
 * middleware runs on navigation, but here the client can poll it WITHOUT
 * navigating — so an admin "Reset session" yanks the target out live.
 *
 * Reads `auth.force_logout_map` fresh (uncached) so the verdict flips the
 * instant the admin bumps it, not up to 30s later. Returns `{ valid }`:
 *   - valid:false → the caller's JWT was issued before their force-logout
 *     cutoff (or there's no token). The watcher then signs them out.
 *   - valid:true  → token is fine.
 * Fails OPEN on any lookup hiccup (never yank a user over a transient error).
 */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const email = (token?.email ?? '').toString().trim().toLowerCase();
  const iat = typeof (token as { iat?: number } | null)?.iat === 'number'
    ? (token as { iat: number }).iat
    : 0;

  // No identifiable session → nothing to keep alive.
  if (!email) {
    return NextResponse.json({ valid: false }, { headers: { 'cache-control': 'no-store' } });
  }

  let valid = true;
  try {
    const raw = await getAppSetting('auth.force_logout_map');
    if (raw) {
      const map = JSON.parse(raw) as Record<string, string>;
      const iso = map?.[email];
      if (iso) {
        const cutoffMs = Date.parse(iso);
        if (Number.isFinite(cutoffMs) && iat > 0 && Math.floor(cutoffMs / 1000) >= iat) {
          valid = false;
        }
      }
    }
  } catch {
    // Never fail closed on a lookup/parse error — keep the user signed in.
    valid = true;
  }

  return NextResponse.json({ valid }, { headers: { 'cache-control': 'no-store' } });
}
