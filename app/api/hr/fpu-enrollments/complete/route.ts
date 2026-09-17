import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { getEmployeeHourlyRateRowByEmail } from '@/lib/supabase/employee-hourly-rates';
import { getOpenMesaAccount } from '@/lib/supabase/mesa-accounts';
import { mesaEmailAliasesFor } from '@/lib/mesa/email-aliases';
import { isCalendarDate } from '@/lib/mesa/enrollment-date';
import { FPU_ENROLLMENTS_TABLE, FPU_ENROLLMENT_SELECT, isFpuNotMigrated, type FpuEnrollmentRow } from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';
const MAX_BULK = 200;

export interface FpuCompleteResult {
  /** Rows now `completed`. */
  completed: { id: string; email: string; full_name: string }[];
  /** Completed AND not yet a MESA member — the client opts each in via
   *  POST /api/toggle-mesa-member with `since` = completed_on. */
  toEnroll: { id: string; workEmail: string; name: string; since: string }[];
  /** Completed but already a member (flag or an open account under any alias)
   *  — NOT re-enrolled: the toggle route would mint a SECOND account. */
  alreadyMembers: { email: string; full_name: string }[];
  /** Completed but no rate row carries their work email, so the FPU date had
   *  nowhere to land. Named so HR can chase it. */
  noRateRow: { email: string; full_name: string }[];
  /** Not `approved`, so not completed. */
  skipped: { id: string; email: string; status: string }[];
  error: string | null;
}

/**
 * POST /api/hr/fpu-enrollments/complete — Mark completed.
 * Body: { ids: string[], completed_on: 'YYYY-MM-DD' }
 *
 * For each APPROVED enrollment:
 *   1. stamp `employee_hourly_rates.mesa_fpu_completed_on = completed_on` on
 *      every rate row keyed by the work email (the flag is denormalised per
 *      upload, so a partial stamp drifts back — same rule as the membership
 *      repair in scripts/fix-mesa-aliased-membership.mjs);
 *   2. mark the enrollment `completed`;
 *   3. decide whether the person may be opted in to MESA. Someone already
 *      flagged `mesa_member`, or holding an OPEN `mesa_accounts` row under any
 *      alias email, is returned under `alreadyMembers` and never sent to the
 *      toggle route (memory/mesa-alias-members-never-flagged: that route mints a
 *      second account for a drifted member and hides their balance).
 *
 * The MESA enrollment itself stays with `POST /api/toggle-mesa-member` — the
 * one choke point that opens accounts — which the client calls per `toEnroll`
 * row, exactly as the old HR opt-in approval did. Gate: HR · MESA · edit.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { ids?: unknown; completed_on?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
  if (ids.length === 0) return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  if (ids.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} enrollments at once.` }, { status: 400 });
  const completedOn = typeof body.completed_on === 'string' ? body.completed_on.trim() : '';
  if (!isCalendarDate(completedOn)) {
    return NextResponse.json({ error: 'completed_on must be a real calendar date (YYYY-MM-DD).' }, { status: 400 });
  }

  const loaded = await sb.from(FPU_ENROLLMENTS_TABLE).select(FPU_ENROLLMENT_SELECT).in('id', ids);
  if (loaded.error) {
    if (isFpuNotMigrated(loaded.error)) return NextResponse.json({ error: 'FPU classes are not set up yet — run the migration first.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: loaded.error.message }, { status: 500 });
  }
  const rows = (loaded.data ?? []) as FpuEnrollmentRow[];

  const out: FpuCompleteResult = { completed: [], toEnroll: [], alreadyMembers: [], noRateRow: [], skipped: [], error: null };
  const actor = await getSessionActor();

  for (const r of rows) {
    if (r.status !== 'approved') {
      out.skipped.push({ id: r.id, email: r.email, status: r.status });
      continue;
    }

    // 1. FPU date onto every rate row for this work email.
    const stamped = await sb.from(RATES_TABLE).update({ mesa_fpu_completed_on: completedOn }).eq('Work Email', r.email).select('id');
    if (stamped.error) {
      out.error = out.error ?? `${r.email}: ${stamped.error.message}`;
      out.skipped.push({ id: r.id, email: r.email, status: `error: ${stamped.error.message}` });
      continue;
    }
    const rateRows = (stamped.data ?? []).length;

    // 2. The enrollment itself.
    const done = await sb
      .from(FPU_ENROLLMENTS_TABLE)
      .update({ status: 'completed', completed_on: completedOn, reviewed_by: authz.sessionEmail, reviewed_at: new Date().toISOString() })
      .eq('id', r.id)
      .eq('status', 'approved')
      .select('id');
    if (done.error || (done.data ?? []).length === 0) {
      out.error = out.error ?? `${r.email}: ${done.error?.message ?? 'enrollment changed underneath'}`;
      out.skipped.push({ id: r.id, email: r.email, status: 'error' });
      continue;
    }
    out.completed.push({ id: r.id, email: r.email, full_name: r.full_name });
    if (rateRows === 0) out.noRateRow.push({ email: r.email, full_name: r.full_name });

    // 3. May they be opted in? Never through a second account.
    const rate = await getEmployeeHourlyRateRowByEmail(r.email);
    let alreadyMember = !!rate.row?.mesa_member;
    if (!alreadyMember) {
      for (const alias of mesaEmailAliasesFor(r.email)) {
        if (await getOpenMesaAccount(alias)) {
          alreadyMember = true;
          break;
        }
      }
    }
    if (alreadyMember) out.alreadyMembers.push({ email: r.email, full_name: r.full_name });
    else out.toEnroll.push({ id: r.id, workEmail: r.email, name: r.full_name, since: completedOn });

    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'fpu.enrollment.completed',
      resource: FPU_ENROLLMENTS_TABLE,
      resource_id: r.id,
      details: {
        email: r.email,
        full_name: r.full_name,
        class_id: r.class_id,
        completed_on: completedOn,
        fpu_date_rate_rows: rateRows,
        already_mesa_member: alreadyMember,
      },
    });
  }

  if (out.completed.length) {
    invalidateRateProfilesCache();
    void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, {
      kind: 'enrollment',
      classId: rows.find((r) => r.status === 'approved')?.class_id ?? rows[0]?.class_id ?? null,
      emails: out.completed.map((c) => c.email.toLowerCase()),
      ts: Date.now(),
    });
  }

  return NextResponse.json(out);
}
