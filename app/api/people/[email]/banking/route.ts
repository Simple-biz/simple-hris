import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory, getPeopleBankHistory } from '@/lib/supabase/bank-update-history';
import { pulseBankChanges } from '@/lib/supabase/app-settings';
import { getPayrollDispatchLock } from '@/lib/supabase/payroll-dispatch-lock';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { maskFieldValue } from '@/lib/bank-update/mask-field';
import { getEmployeeIdRowByEmail } from '@/lib/supabase/employee-ids';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import { getPeopleBanking } from '@/lib/people/people-banking';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Payout fields Accounting may edit from the People -> View modal. Exactly the
 * bank/payout columns of employee_ids — the same allowlist as the employee
 * self-service route (app/api/bank-update/save) so the two channels can never
 * write different column sets.
 */
const ALLOWED_FIELDS = [
  'preferred_processor',
  'bank_name',
  'account_holder_name',
  'account_number',
  'routing_number',
  'alt_bank_name',
  'alt_account_holder_name',
  'alt_account_number',
  'alt_routing_number',
  'hurupay_email',
  'wepay_email',
  'higlobe_email',
  'higlobe_account_name',
  'wise_email',
  'wise_tag',
  'phone_number',
  'swift_code',
  'full_address',
  'preferred_bank_slot',
] as const;
const ALLOWED_PROCESSORS = new Set(['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires']);
const ALLOWED_BANK_SLOTS = new Set(['primary', 'alternative']);

interface Body {
  patch?: Record<string, unknown>;
}

/**
 * Edit one person's bank & payout details from the People -> View modal.
 * Writes the canonical employee_ids row — the single source of truth every
 * dashboard (People, Payroll Wizard, dispatch, employee profile) reads — so the
 * change is reflected everywhere immediately. Audit-logged with a masked
 * before→after, recorded in bank_update_history (same feed as the employee
 * self-service link), and blocked while payroll dispatch is locked. Gated to
 * `people` edit access (accounting | ceo | admin).
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ email: string }> }) {
  const authz = await requireFeatureEditAnyView('people');
  if (!authz.ok) return deniedResponse(authz);

  const { email: rawEmail } = await context.params;
  const email = decodeURIComponent(rawEmail ?? '').trim();
  if (!email) return NextResponse.json({ ok: false, error: 'Missing email' }, { status: 400 });

  let body: Body | null;
  try {
    body = (await req.json()) as Body | null;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  // Allowlist + validate the patch, mirroring the self-service save route.
  const raw = body?.patch ?? {};
  const update: Record<string, string | null> = {};
  for (const key of ALLOWED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const val = raw[key];
    const trimmed = val != null && String(val).trim() !== '' ? String(val).trim() : null;
    if (key === 'preferred_processor' && trimmed != null && !ALLOWED_PROCESSORS.has(trimmed)) {
      return NextResponse.json({ ok: false, error: `Invalid payment method: ${trimmed}` }, { status: 400 });
    }
    if (key === 'preferred_bank_slot' && trimmed != null && !ALLOWED_BANK_SLOTS.has(trimmed)) {
      return NextResponse.json({ ok: false, error: `Invalid bank slot: ${trimmed}` }, { status: 400 });
    }
    update[key] = trimmed;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: 'No payout fields provided' }, { status: 400 });
  }

  // Same guard as the self-service link: no payout edits mid-dispatch, so a
  // salary can't be redirected while Accounting is actively paying it out.
  const lock = await getPayrollDispatchLock();
  if (lock.locked) {
    return NextResponse.json(
      { ok: false, error: 'Payroll is being processed right now, so bank details are temporarily locked. Please try again after the dispatch completes.' },
      { status: 423 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is required to save bank details.' },
      { status: 500 },
    );
  }

  // Resolve the row the modal is actually showing (work_email, then
  // personal_email — same lookup the read path uses) so the edit targets the
  // exact same record, keyed precisely on employee_id (ilike on email could hit
  // the known duplicate-email rows).
  const { row, error: rowErr } = await getEmployeeIdRowByEmail(email);
  if (rowErr) return NextResponse.json({ ok: false, error: rowErr }, { status: 500 });

  const changedFields = Object.keys(update);
  // Snapshot BEFORE values from the resolved row for the masked before→after trail.
  const beforeRow = (row ?? {}) as unknown as Record<string, unknown>;

  let created = false;
  if (row?.employee_id) {
    const { error: updateError } = await supabase
      .from('employee_ids')
      .update(update)
      .eq('employee_id', row.employee_id);
    if (updateError) {
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }
  } else {
    // No payout record yet (a "Missing bank info" person) — bootstrap one, the
    // same way the self-service link does for first-time setup.
    const { employee } = await getEmployeeMasterRecord(email).catch(() => ({ employee: null }));
    const insertRow: Record<string, string | null> = {
      employee_id: `SELF-${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`,
      name: employee?.name ?? email,
      work_email: employee?.work_email ?? email,
      personal_email: employee?.personal_email ?? null,
      ...update,
    };
    const { error: insertError } = await supabase.from('employee_ids').insert(insertRow);
    if (insertError) {
      return NextResponse.json({ ok: false, error: insertError.message }, { status: 500 });
    }
    created = true;
  }

  invalidateRateProfilesCache();

  // Masked before→after per written field — masked HERE so the audit trail never
  // stores a full account number; `changed` is computed on the raw values.
  const changes = changedFields.map((field) => {
    const rawBefore = beforeRow[field] != null ? String(beforeRow[field]) : null;
    const rawAfter = update[field];
    return {
      field,
      before: maskFieldValue(field, rawBefore),
      after: maskFieldValue(field, rawAfter),
      changed: (rawBefore ?? '').trim() !== (rawAfter ?? '').trim(),
    };
  });

  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    actor = await getSessionActor();
  } catch { /* best-effort */ }

  // Await the audit write — a payout change must not be reported successful
  // without leaving a trail.
  await insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'people.banking.updated',
    resource: 'employee_ids',
    resource_id: row?.work_email ?? email,
    details: {
      via: 'people_tab',
      edited_for: row?.work_email ?? email,
      fields: changedFields,
      processor: update.preferred_processor ?? row?.preferred_processor ?? null,
      created,
      changes,
    },
  });
  // Best-effort: the dedicated, non-clearable history table that feeds the
  // People-tab "Bank changes" feed + the per-person history list.
  await insertBankUpdateHistory({
    work_email: row?.work_email ?? email,
    employee_name: row?.name ?? null,
    fields: changedFields,
    changes,
    processor: update.preferred_processor ?? row?.preferred_processor ?? null,
    created_new: created,
    via: 'people_tab',
    ip_address: null,
  }).catch(() => undefined);
  // Nudge the live "Bank changes" feed to refetch.
  await pulseBankChanges().catch(() => undefined);

  // Return the fresh record UNMASKED — the editor had already revealed it, and
  // this edit is itself audit-logged above — plus the refreshed change history
  // so the modal updates in place without a refetch.
  const [{ banking }, { rows: bankHistory }] = await Promise.all([
    getPeopleBanking(row?.work_email ?? email, true),
    getPeopleBankHistory(row?.work_email ?? email),
  ]);

  return NextResponse.json({ ok: true, created, banking, bankHistory });
}
