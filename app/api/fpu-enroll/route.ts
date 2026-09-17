import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { getEmployees } from '@/lib/supabase/employees';
import { getEmployeeHourlyRateRowByEmail } from '@/lib/supabase/employee-hourly-rates';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { normEmail } from '@/lib/email/norm-email';
import { fpuClassLabel, pickCurrentFpuClass, type FpuClass } from '@/lib/mesa/fpu-class';
import { fpuVerdict, type FpuVerdict } from '@/lib/mesa/fpu-eligibility';
import {
  FPU_ENROLLMENTS_TABLE,
  FPU_ENROLLMENT_SELECT,
  findRosterRow,
  isFpuNotMigrated,
  listFpuClasses,
  listFpuEnrollments,
  rosterRowEmails,
  type FpuEnrollmentRow,
} from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UNIQUE_VIOLATION = '23505';

function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : req.headers.get('x-real-ip');
}

/** What the employee surface gets: the class it should show, their row in it, the verdict, their history. */
export interface FpuSelfState {
  today: string;
  class: FpuClass | null;
  enrollment: FpuEnrollmentRow | null;
  verdict: FpuVerdict;
  history: (FpuEnrollmentRow & { class_label: string | null })[];
  fpuCompletedOn: string | null;
  isMesaMember: boolean;
  migrated: boolean;
}

/**
 * ONE derivation for GET and POST. Everything the verdict needs is read here,
 * server-side, from the same sources HR uses: the active roster
 * (`active_employees` — Kane: "Promoted to Global Master List and Active"), the
 * person's rate row (FPU date / membership) and their existing enrollments.
 */
async function deriveSelfState(email: string): Promise<{ state: FpuSelfState; error: string | null }> {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return { state: emptyState('Supabase not configured'), error: 'Supabase not configured' };

  const today = manilaTodayIso();
  const [classes, roster, rate] = await Promise.all([listFpuClasses(sb), getEmployees(), getEmployeeHourlyRateRowByEmail(email)]);
  if (classes.error) return { state: emptyState(classes.error), error: classes.error };
  if (roster.error) return { state: emptyState(roster.error), error: roster.error };

  const rosterRow = findRosterRow(roster.employees, email);
  const myEmails = Array.from(new Set([email, ...(rosterRow ? rosterRowEmails(rosterRow) : [])]));
  const enrollments = await listFpuEnrollments(sb, { emails: myEmails });
  if (enrollments.error) return { state: emptyState(enrollments.error), error: enrollments.error };

  const current = pickCurrentFpuClass(classes.classes, today);
  const mine = current ? enrollments.rows.find((r) => r.class_id === current.id) ?? null : null;
  const fpuCompletedOn = rate.row?.mesa_fpu_completed_on ?? null;
  const isMesaMember = !!rate.row?.mesa_member;

  const verdict = fpuVerdict({
    today,
    cls: current,
    onActiveRoster: !!rosterRow,
    startDate: rosterRow?.start_date ?? null,
    alreadyCompletedFpu: !!fpuCompletedOn || isMesaMember,
    existingStatus: mine?.status ?? null,
  });

  const byId = new Map(classes.classes.map((c) => [c.id, c]));
  const history = enrollments.rows.map((r) => {
    const c = r.class_id ? byId.get(r.class_id) : undefined;
    return { ...r, class_label: c ? fpuClassLabel(c) : null };
  });

  return {
    state: {
      today,
      class: current ? publicClass(current) : null,
      enrollment: mine,
      verdict,
      history,
      fpuCompletedOn,
      isMesaMember,
      migrated: classes.migrated && enrollments.migrated,
    },
    error: null,
  };
}

function publicClass(c: FpuClass): FpuClass {
  return {
    id: c.id,
    year: c.year,
    batch: c.batch,
    opens_on: c.opens_on,
    closes_on: c.closes_on,
    class_starts_on: c.class_starts_on,
    class_ends_on: c.class_ends_on,
    schedule_note: c.schedule_note,
    name: c.name ?? null,
    enrollment_closed_on: c.enrollment_closed_on ?? null,
  };
}

function emptyState(detail: string): FpuSelfState {
  return {
    today: manilaTodayIso(),
    class: null,
    enrollment: null,
    verdict: { ok: false, reason: 'no_class', detail },
    history: [],
    fpuCompletedOn: null,
    isMesaMember: false,
    migrated: true,
  };
}

/** GET /api/fpu-enroll?email= — self (or elevated) state. */
export async function GET(req: NextRequest) {
  const requested = req.nextUrl.searchParams.get('email');
  const authz = await authorizeEmailAccess(requested);
  if (!authz.ok) return deniedResponse(authz);
  const { state, error } = await deriveSelfState(authz.effectiveEmail);
  if (error) return NextResponse.json({ ...state, error }, { status: 500 });
  return NextResponse.json({ ...state, error: null });
}

/**
 * POST /api/fpu-enroll — enroll the signed-in employee in the current class.
 * Body: { email?: string; shift_schedule_est: string }
 *
 * The verdict is RE-DERIVED here from the server's own reads; the client's
 * copy is a painting. A refusal answers 409 with the same sentence the
 * employee saw. Identity, name and department come from the roster row, never
 * the body.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string; shift_schedule_est?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const authz = await authorizeEmailAccess(body.email ?? null);
  if (!authz.ok) return deniedResponse(authz);
  const email = normEmail(authz.effectiveEmail)!;
  const shift = (body.shift_schedule_est ?? '').trim().slice(0, 120);
  if (!shift) return NextResponse.json({ success: false, error: 'Your shift schedule (EST) is required.' }, { status: 400 });

  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ success: false, error: 'Supabase not configured' }, { status: 500 });

  const { state, error } = await deriveSelfState(email);
  if (error) return NextResponse.json({ success: false, error }, { status: 500 });
  if (!state.migrated) return NextResponse.json({ success: false, error: 'FPU enrollment is not open yet.' }, { status: 503 });
  if (!state.verdict.ok || !state.class) {
    const v = state.verdict;
    return NextResponse.json({ success: false, error: v.ok ? 'No class' : v.detail, reason: v.ok ? null : v.reason }, { status: 409 });
  }

  const roster = await getEmployees();
  const rosterRow = findRosterRow(roster.employees, email);
  if (!rosterRow) return NextResponse.json({ success: false, error: 'Only active employees on the Global Master List can enroll.' }, { status: 409 });

  const res = await sb
    .from(FPU_ENROLLMENTS_TABLE)
    .insert({
      email,
      full_name: (rosterRow.name ?? '').trim() || email,
      department: (rosterRow.department ?? '').trim() || '—',
      shift_schedule_est: shift,
      class_id: state.class.id,
      status: 'pending',
      start_date_used: state.verdict.startDate,
    })
    .select(FPU_ENROLLMENT_SELECT)
    .single();
  if (res.error) {
    if (res.error.code === UNIQUE_VIOLATION) return NextResponse.json({ success: false, error: 'You already enrolled in this class.', reason: 'already_enrolled' }, { status: 409 });
    if (isFpuNotMigrated(res.error)) return NextResponse.json({ success: false, error: 'FPU enrollment is not open yet.' }, { status: 503 });
    return NextResponse.json({ success: false, error: res.error.message }, { status: 500 });
  }
  const enrollment = res.data as FpuEnrollmentRow;

  void insertAuditLog({
    user_name: rosterRow.name ?? email,
    user_role: 'Employee',
    action: 'fpu.enroll',
    resource: FPU_ENROLLMENTS_TABLE,
    resource_id: enrollment.id,
    details: {
      email,
      full_name: enrollment.full_name,
      department: enrollment.department,
      shift_schedule_est: shift,
      class_id: state.class.id,
      class_label: fpuClassLabel(state.class),
      start_date_used: state.verdict.startDate,
      eligible_from: state.verdict.eligibleFrom,
    },
    ip_address: clientIp(req),
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, { kind: 'enrollment', classId: state.class.id, emails: [email], ts: Date.now() });

  return NextResponse.json({ success: true, enrollment, error: null });
}
