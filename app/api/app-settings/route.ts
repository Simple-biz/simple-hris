import { NextResponse } from 'next/server';
import { getAppSettingStrict, getAppSettings, upsertAppSetting } from '@/lib/supabase/app-settings';
import { requireElevatedSession, requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';

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

/**
 * Raw credential keys (API keys / tokens kept under the `secret.` family) are
 * ADMIN-only — stricter than {@link isSensitiveKey}'s elevated gate, because
 * `accounting` / `hr_coordinator` are elevated but must not see API secrets.
 */
function isAdminOnlyKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('secret.');
}

/**
 * The payroll dispatch locks — BOTH the global "Start processing" flag
 * (`payroll.dispatch_locked` + its _at/_by companions) and every per-cycle
 * `payroll.dispatch_lock.<sourceFile>` key.
 *
 * These decide whether bank details can be edited mid-payout, so writing one
 * must clear the same bar as the dedicated `/api/payroll-dispatch-lock` route
 * (which requires accounting→payment_dispatch edit AND writes an audit row).
 * Plain `requireElevatedSession()` is NOT enough: `hr_coordinator` is elevated
 * but maps to the `hr` feature view, so it must never be able to drop the
 * bank-edit freeze through this generic endpoint.
 */
function isPayrollLockKey(key: string): boolean {
  return key.trim().toLowerCase().startsWith('payroll.dispatch_lock');
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
    if (keys.some(isAdminOnlyKey)) {
      const authz = await requireAdminSession();
      if (!authz.ok) return deniedResponse(authz);
    } else if (keys.some(isSensitiveKey)) {
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
  if (isAdminOnlyKey(key)) {
    const authz = await requireAdminSession();
    if (!authz.ok) return deniedResponse(authz);
  } else if (isSensitiveKey(key)) {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
  }
  try {
    // Strict read: a failed Supabase read THROWS (→ 500) instead of masquerading
    // as a missing key — callers like the wizard's additions hydration must be
    // able to tell "absent" from "unreadable".
    const value = await getAppSettingStrict(key);
    return NextResponse.json({ value, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ value: null, error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    // Baseline: writing any setting is an elevated action. Benign keys
    // (OT flags, FX rate, PAB overrides) stop here. The three families below
    // are then gated ABOVE that baseline — writes are held to a stricter bar
    // than reads, because this generic endpoint would otherwise be a way
    // around the purpose-built routes that own those keys.
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as { key?: string; value?: string };
    if (!body.key || body.value === undefined) {
      return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
    }
    const isAdmin = authz.roles.includes('admin');

    // 1. Secret credential keys: admin-only, even for elevated callers.
    if (isAdminOnlyKey(body.key) && !isAdmin) {
      return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 });
    }
    // 2. Auth state / webhook URLs / tokens: admin-only to WRITE. Reads are
    //    merely elevated (see isSensitiveKey's use in GET), but a write here
    //    can un-revoke every force-logged-out session or point an n8n webhook
    //    carrying employee PII at an arbitrary host. No non-admin surface
    //    legitimately posts these.
    if (isSensitiveKey(body.key) && !isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden — this setting can only be changed by an admin.' },
        { status: 403 },
      );
    }
    // 3. Payroll dispatch locks: same bar as /api/payroll-dispatch-lock.
    //    Accepted from either payment_dispatch or payroll_wizard edit, since
    //    the per-cycle lock is set by the Wizard's "Lock in Values" action and
    //    the global one by the Dispatch "Start processing" button.
    if (isPayrollLockKey(body.key) && !isAdmin) {
      const dispatchOk = await requireFeatureEditAnyView('payment_dispatch');
      const lockAuthz = dispatchOk.ok ? dispatchOk : await requireFeatureEditAnyView('payroll_wizard');
      if (!lockAuthz.ok) {
        return NextResponse.json(
          { error: 'Forbidden — changing the payroll lock needs Payment Dispatch or Payroll Wizard edit access.' },
          { status: 403 },
        );
      }
    }

    const { error } = await upsertAppSetting(body.key, body.value);
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Leave a trail for the two families that can move money or re-open
    // sessions. The dedicated lock route already audits its own writes; this
    // covers the generic path so a lock toggle can never be silent.
    if (isPayrollLockKey(body.key) || isSensitiveKey(body.key) || isAdminOnlyKey(body.key)) {
      const actor = await getSessionActor().catch(() => ({ user_name: authz.sessionEmail, user_role: 'unknown' }));
      await insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: isPayrollLockKey(body.key) ? 'payroll.dispatch.lock_changed' : 'app_settings.sensitive_write',
        resource: 'app_settings',
        resource_id: body.key,
        details: {
          via: 'app_settings_api',
          key: body.key,
          // Never log the value of a secret/token key — only that it changed.
          value: isAdminOnlyKey(body.key) || isSensitiveKey(body.key) ? '[redacted]' : body.value,
        },
      }).catch(() => undefined);
    }

    return NextResponse.json({ error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
