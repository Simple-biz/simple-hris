import { NextResponse } from 'next/server';
import {
  getAppSettingStrict,
  getAppSettingWithMetaStrict,
  getAppSettings,
  upsertAppSetting,
} from '@/lib/supabase/app-settings';
import { requireElevatedSession, requireAdminSession, deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit, requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import {
  PAYOUT_GUARDRAIL_KEY,
  PAYOUT_GUARDRAIL_VALUES,
  isPayoutGuardrailKey,
} from '@/lib/banking/payout-change-safety';
import { isWizardAdditionsKey } from '@/lib/payroll/wizard-additions';
import { isComparePasteKey } from '@/lib/qc/compare-paste';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { auditFrom } from '@/lib/audit/context';
import { describeAppSettingChange, isAppSettingChangeAudited } from '@/lib/audit/app-settings-change';
import { PAB_PERIOD_LIVE_EVENT, PAB_PERIOD_LIVE_TOPIC, isPabPeriodLiveKey } from '@/lib/pab-period-live';

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

/**
 * `qc.compare_paste.*` — the manager's shared Compare sheet — is refused on
 * READ as well as write. Every other family here is gated by role; this one is
 * gated by DEPARTMENT (a manager sees only the departments they manage, and the
 * `qc` role must never see the sheet it is being compared against), which this
 * generic route cannot express. `/api/qc/compare-paste` is the only door.
 */
function comparePasteRefusal(shape: 'value' | 'values'): NextResponse {
  const error = 'qc.compare_paste.* is department-scoped — read and write it through /api/qc/compare-paste.';
  return NextResponse.json(shape === 'values' ? { values: {}, error } : { value: null, error }, { status: 400 });
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
    if (keys.some(isComparePasteKey)) return comparePasteRefusal('values');
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
  if (isComparePasteKey(key)) return comparePasteRefusal('value');
  if (isAdminOnlyKey(key)) {
    const authz = await requireAdminSession();
    if (!authz.ok) return deniedResponse(authz);
  } else if (isSensitiveKey(key)) {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);
  }
  try {
    // `?meta=1` also returns the row's `updated_at`. Payment Dispatch needs it to
    // decide whether the wizard's final-pay snapshot post-dates the lock it is
    // being weighed against — the same comparison paystub-fresh.ts makes
    // server-side. Additive: without the flag the response shape is unchanged.
    if (searchParams.get('meta') === '1') {
      const row = await getAppSettingWithMetaStrict(key);
      return NextResponse.json({ value: row?.value ?? null, updatedAt: row?.updatedAt ?? null, error: null });
    }
    // Strict read: a failed Supabase read THROWS (→ 500) instead of masquerading
    // as a missing key — callers like the wizard's additions hydration must be
    // able to tell "absent" from "unreadable".
    const value = await getAppSettingStrict(key);
    return NextResponse.json({ value, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ value: null, updatedAt: null, error: msg }, { status: 500 });
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

    // 0. The wizard additions blob is CAS-only. This generic POST is
    //    last-write-wins on the whole value, which for that map meant a save
    //    from a stale tab silently reverted every person in it (the 2026-08
    //    orphanage incident, twice). Refusing here — with no admin bypass — is
    //    what makes "no un-CAS'd writer remains" true.
    if (isWizardAdditionsKey(body.key)) {
      return NextResponse.json(
        { error: 'payroll.wizard.additions.* is concurrency-checked — write it through /api/payroll-wizard/additions.' },
        { status: 400 },
      );
    }
    // 0b. The manager's shared Compare sheet is department-scoped and must
    //     never reach the QC officers who are being compared against it. This
    //     route cannot scope by department, so the family is refused here on
    //     write as on read — its only door is /api/qc/compare-paste.
    if (isComparePasteKey(body.key)) return comparePasteRefusal('value');

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

    // 4. The bank-change guardrail (Accounting → System Settings, 2026-10-09).
    //    Switching it off lets employees change where they are paid without the
    //    notice, so the bar is Accounting → System Settings EDIT (admin
    //    bypasses), not merely elevated: `hr_coordinator` is elevated and must
    //    not be able to drop it. Exactly 'on' or 'off', nothing else: the reader
    //    treats any other value as ON, so a typo would look saved and do nothing.
    if (isPayoutGuardrailKey(body.key)) {
      if (body.key !== PAYOUT_GUARDRAIL_KEY || !(PAYOUT_GUARDRAIL_VALUES as readonly string[]).includes(body.value)) {
        return NextResponse.json(
          { error: `${PAYOUT_GUARDRAIL_KEY} takes exactly "on" or "off".` },
          { status: 400 },
        );
      }
      if (!isAdmin) {
        const settingsAuthz = await requireFeatureEdit('accounting', 'settings');
        if (!settingsAuthz.ok) {
          return NextResponse.json(
            { error: 'Forbidden — the bank guardrail needs Accounting → System Settings edit access.' },
            { status: 403 },
          );
        }
      }
    }

    // Every other key is audited by KEY as `app_settings.changed` (below), so
    // the value it replaces is read first. A failed read never blocks the save
    // and never reads as "unchanged" — the event says the old value is unknown.
    const policed = isPayrollLockKey(body.key) || isSensitiveKey(body.key) || isAdminOnlyKey(body.key);
    const auditChange = !policed && isAppSettingChangeAudited(body.key);
    let before: string | null = null;
    let beforeUnavailable = false;
    if (auditChange) {
      try {
        before = await getAppSettingStrict(body.key);
      } catch {
        beforeUnavailable = true;
      }
    }

    const { error } = await upsertAppSetting(body.key, body.value);
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Who changed it, from what, to what (session log item 239: the PAB Period
    // moved with no trail). After the write succeeded, never before; awaited so
    // the row is not cut off with the response. `insertAuditLog` shouts on a
    // lost event.
    if (auditChange) {
      const change = describeAppSettingChange(body.key, before, body.value, { beforeUnavailable });
      if (change) {
        await insertAuditLog({
          ...auditFrom(request, authz),
          action: 'app_settings.changed',
          resource: 'app_settings',
          resource_id: body.key.trim(),
          details: change,
        }).catch(() => undefined);
      }
    }

    // The PAB period moved: tell every open employee Overview to re-read it.
    // After the write succeeded, never before; the payload names the key only
    // (listeners always re-fetch the stored value). Fire-and-forget — a lost
    // message costs the listener's poll/focus floor, never the save.
    if (isPabPeriodLiveKey(body.key)) {
      void broadcastFromServer(PAB_PERIOD_LIVE_TOPIC, PAB_PERIOD_LIVE_EVENT, {
        key: body.key.trim(),
        ts: Date.now(),
      });
    }

    // Leave a trail for the two families that can move money or re-open
    // sessions. The dedicated lock route already audits its own writes; this
    // covers the generic path so a lock toggle can never be silent. (Every
    // other key is `app_settings.changed`, above — no key written here is silent
    // except the derived snapshots in APP_SETTING_AUDIT_EXEMPT.)
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
