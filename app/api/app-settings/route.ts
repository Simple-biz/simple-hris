import { NextResponse } from 'next/server';
import { getAppSetting, getAppSettings, upsertAppSetting } from '@/lib/supabase/app-settings';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Sensitive setting families never readable by non-elevated callers: auth state
 * (force-logout map), webhook URLs, and any secret/token. Benign keys
 * (usd_to_php_rate, holidays, OT flags, dispute reason codes) stay open so the
 * employee portal and payroll wizard keep working without elevation.
 */
function isSensitiveKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return (
    k.startsWith('auth.') ||
    k.startsWith('auth_') ||
    k.includes('force_logout') ||
    k.includes('webhook') ||
    k.includes('secret') ||
    k.includes('token')
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Bulk mode: ?keys=a,b,c → one round-trip for many settings. Returns
  // `{ values: { a, b, c }, error }`. Used to collapse the Payroll Wizard's
  // ~10 parallel single-key fetches (global + per-dept OT flags) into one.
  const keysParam = searchParams.get('keys');
  if (keysParam !== null) {
    const keys = keysParam.split(',').map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      return NextResponse.json({ values: {}, error: null });
    }
    if (keys.some(isSensitiveKey)) {
      const authz = await requireElevatedSession();
      if (!authz.ok) return deniedResponse(authz);
    }
    try {
      const values = await getAppSettings(keys);
      return NextResponse.json({ values, error: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ values: {}, error: msg }, { status: 500 });
    }
  }

  const key = searchParams.get('key');
  if (!key) {
    return NextResponse.json({ value: null, error: 'Missing key parameter' }, { status: 400 });
  }
  if (isSensitiveKey(key)) {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
  }
  try {
    const value = await getAppSetting(key);
    return NextResponse.json({ value, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ value: null, error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Writing settings (force-logout map, dispatch lock, webhook URLs, OT flags)
    // is an elevated action. All current callers are admin/payroll/HR surfaces.
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as { key?: string; value?: string };
    if (!body.key || body.value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
    }
    const { error } = await upsertAppSetting(body.key, body.value);
    if (error) return NextResponse.json({ error }, { status: 500 });
    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
