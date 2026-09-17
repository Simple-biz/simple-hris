import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { getEmployeeHourlyRateRowByEmail } from '@/lib/supabase/employee-hourly-rates';
import { getOpenMesaAccount } from '@/lib/supabase/mesa-accounts';
import { mesaEmailAliasesFor } from '@/lib/mesa/email-aliases';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { fpuClassLabel } from '@/lib/mesa/fpu-class';
import { fpuSessions } from '@/lib/mesa/fpu-sessions';
import { fpuAttendanceVerdict, type FpuAttendanceVerdict } from '@/lib/mesa/fpu-attendance';
import {
  FPU_CLASSES_TABLE,
  FPU_CLASS_SELECT,
  FPU_ENROLLMENTS_TABLE,
  isFpuNotMigrated,
  listFpuEnrollments,
  type FpuClassRow,
  type FpuEnrollmentRow,
} from '@/lib/mesa/fpu-server';
import { indexAttendance, listClassAttendance } from '@/lib/mesa/fpu-groups-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RATES_TABLE = process.env.NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE?.trim() || 'employee_hourly_rates';

interface Person {
  enrollmentId: string;
  email: string;
  name: string;
  verdict: FpuAttendanceVerdict;
}

export interface FpuClassCloseResult {
  classLabel: string;
  sessionCount: number;
  completedOn: string;
  eligible: Person[];
  ineligible: Person[];
  /** Eligible AND not yet a MESA member — the client opts each in. */
  toEnroll: { enrollmentId: string; workEmail: string; name: string; since: string }[];
  alreadyMembers: { email: string; name: string }[];
  noRateRow: { email: string; name: string }[];
  /** Total unmarked cells across the class — what HR still has to chase. */
  unmarkedTotal: number;
  closed: boolean;
  migrated: boolean;
  error: string | null;
}

/**
 * POST /api/hr/fpu-classes/class-close — the completion event.
 * Body: { class_id, confirm: boolean }
 *
 * Kane, 2026-09-17: *"once the class is closed ... there would be a list of
 * eligible and ineligible people at the end and only then they can have their
 * Deduction of MESA through Payroll Wizard."* Closing a class means its end date
 * has arrived: attendance stops, the split is published, the eligible are
 * enrolled in MESA, and the next batch may proceed.
 *
 * `confirm: false` computes the split and writes NOTHING — HR reads the two
 * lists first. `confirm: true` then:
 *   - stamps `mesa_fpu_completed_on` on every rate row of the ELIGIBLE only;
 *   - marks eligible enrollments `completed`, ineligible ones `failed`;
 *   - stamps `class_closed_on` / `_by`;
 *   - returns `toEnroll` for the client to open each MESA account through
 *     `POST /api/toggle-mesa-member`, the one choke point.
 *
 * An INELIGIBLE person is never stamped with an FPU date. That stamp bars every
 * future class forever and nothing can clear it, and Kane's ruling is that a
 * miss fails THIS class only — they may enroll in a later batch.
 *
 * Gate: HR · MESA · edit.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { class_id?: unknown; confirm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const classId = typeof body.class_id === 'string' ? body.class_id.trim() : '';
  if (!classId) return NextResponse.json({ error: 'class_id is required' }, { status: 400 });
  const confirm = body.confirm === true;

  const cls = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', classId).maybeSingle();
  if (cls.error) {
    if (isFpuNotMigrated(cls.error)) return NextResponse.json({ error: 'Closing a class needs the FPU Groups migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: cls.error.message }, { status: 500 });
  }
  if (!cls.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  const theClass = cls.data as FpuClassRow;
  if (theClass.class_closed_on) return NextResponse.json({ error: 'This class is already closed.' }, { status: 409 });

  const sessions = fpuSessions(theClass);
  if (!sessions.ok) return NextResponse.json({ error: sessions.detail, reason: sessions.reason }, { status: 409 });
  const sessionCount = sessions.sessions.length;

  const [enrollments, attendance] = await Promise.all([listFpuEnrollments(sb, { classId }), listClassAttendance(sb, classId)]);
  if (enrollments.error) return NextResponse.json({ error: enrollments.error }, { status: 500 });
  if (attendance.error) return NextResponse.json({ error: attendance.error }, { status: 500 });
  if (!attendance.migrated) return NextResponse.json({ error: 'Closing a class needs the FPU Groups migration.', migrated: false }, { status: 503 });

  const marksBy = indexAttendance(attendance.rows);
  // Everyone holding a seat. Someone approved but never grouped has no marks at
  // all, so they land in `ineligible` as fully unmarked — fail closed, and HR can
  // see exactly why.
  const seated = enrollments.rows.filter((r) => r.status === 'approved');

  const people: Person[] = seated.map((r) => ({
    enrollmentId: r.id,
    email: r.email,
    name: r.full_name,
    verdict: fpuAttendanceVerdict({
      sessionCount,
      marks: marksBy.get(r.id) ?? new Map<number, boolean>(),
      override: r.attendance_override ?? null,
    }),
  }));

  const eligible = people.filter((p) => p.verdict.outcome === 'eligible');
  const ineligible = people.filter((p) => p.verdict.outcome === 'failed');
  const unmarkedTotal = people.reduce((n, p) => n + p.verdict.unmarked.length, 0);
  // The class ended on its end date — that is when these people finished FPU, and
  // it is what MESA membership dates from. Never "today", which could be weeks later.
  const completedOn = theClass.class_ends_on ?? manilaTodayIso();

  const out: FpuClassCloseResult = {
    classLabel: fpuClassLabel(theClass),
    sessionCount,
    completedOn,
    eligible,
    ineligible,
    toEnroll: [],
    alreadyMembers: [],
    noRateRow: [],
    unmarkedTotal,
    closed: false,
    migrated: true,
    error: null,
  };

  if (!confirm) return NextResponse.json(out);

  const actor = await getSessionActor();

  for (const p of eligible) {
    const stamped = await sb.from(RATES_TABLE).update({ mesa_fpu_completed_on: completedOn }).eq('Work Email', p.email).select('id');
    if (stamped.error) {
      out.error = out.error ?? `${p.email}: ${stamped.error.message}`;
      continue;
    }
    if ((stamped.data ?? []).length === 0) out.noRateRow.push({ email: p.email, name: p.name });

    const done = await sb
      .from(FPU_ENROLLMENTS_TABLE)
      .update({ status: 'completed', completed_on: completedOn, reviewed_by: authz.sessionEmail, reviewed_at: new Date().toISOString() })
      .eq('id', p.enrollmentId)
      .eq('status', 'approved')
      .select('id');
    if (done.error || (done.data ?? []).length === 0) {
      out.error = out.error ?? `${p.email}: ${done.error?.message ?? 'enrollment changed underneath'}`;
      continue;
    }

    // Never through a second account: an alias-drifted member already holds one,
    // and the toggle route would mint another and hide their balance.
    const rate = await getEmployeeHourlyRateRowByEmail(p.email);
    let alreadyMember = !!rate.row?.mesa_member;
    if (!alreadyMember) {
      for (const alias of mesaEmailAliasesFor(p.email)) {
        if (await getOpenMesaAccount(alias)) {
          alreadyMember = true;
          break;
        }
      }
    }
    if (alreadyMember) out.alreadyMembers.push({ email: p.email, name: p.name });
    else out.toEnroll.push({ enrollmentId: p.enrollmentId, workEmail: p.email, name: p.name, since: completedOn });
  }

  for (const p of ineligible) {
    // `failed`, and NO FPU date: this class is lost, the next batch is not.
    const res = await sb
      .from(FPU_ENROLLMENTS_TABLE)
      .update({ status: 'failed', reviewed_by: authz.sessionEmail, reviewed_at: new Date().toISOString(), review_notes: p.verdict.reason })
      .eq('id', p.enrollmentId)
      .eq('status', 'approved')
      .select('id');
    if (res.error) out.error = out.error ?? `${p.email}: ${res.error.message}`;
  }

  const closed = await sb
    .from(FPU_CLASSES_TABLE)
    .update({ class_closed_on: manilaTodayIso(), class_closed_by: authz.sessionEmail })
    .eq('id', classId)
    .select(FPU_CLASS_SELECT)
    .single();
  if (closed.error) return NextResponse.json({ ...out, error: closed.error.message }, { status: 500 });
  out.closed = true;

  if (eligible.length) invalidateRateProfilesCache();

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.class.closed',
    resource: FPU_CLASSES_TABLE,
    resource_id: classId,
    details: {
      label: out.classLabel,
      session_count: sessionCount,
      completed_on: completedOn,
      // The whole split, so the audit row alone answers "who passed this class".
      eligible: eligible.map((p) => p.email),
      ineligible: ineligible.map((p) => ({ email: p.email, reason: p.verdict.reason })),
      unmarked_total: unmarkedTotal,
      already_mesa_members: out.alreadyMembers.map((m) => m.email),
    },
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, { kind: 'class', classId, emails: people.map((p) => p.email.toLowerCase()), ts: Date.now() });

  return NextResponse.json(out);
}
