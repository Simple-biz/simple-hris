import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { elapsedFpuSessions, fpuSessions, isMarkableSession } from '@/lib/mesa/fpu-sessions';
import { fpuClassLabel } from '@/lib/mesa/fpu-class';
import { FPU_CLASSES_TABLE, FPU_CLASS_SELECT, FPU_ENROLLMENTS_TABLE, FPU_ENROLLMENT_SELECT, isFpuNotMigrated, type FpuClassRow, type FpuEnrollmentRow } from '@/lib/mesa/fpu-server';
import {
  FPU_ATTENDANCE_SELECT,
  FPU_ATTENDANCE_TABLE,
  findMembership,
  listClassAttendance,
  type FpuAttendanceRow,
} from '@/lib/mesa/fpu-groups-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The group-leader surface. A leader is an ordinary employee with ONE extra
 * power: recording whether their own groupmates showed up.
 *
 * This is the repo's first row-level capability on an employee surface — every
 * other employee route is self-scoped through `authorizeEmailAccess`, which
 * 403s any non-elevated cross-email call. So the capability is resolved HERE,
 * server-side, on every single request:
 *
 *   elevated (admin / accounting / hr_coordinator) → may mark anyone
 *   otherwise → must lead the target's group, and the target must not be them
 *
 * **A leader never marks themselves** (Kane, Q5), mirroring the standing rule
 * that a reviewer cannot approve their own hours. HR marks the leaders.
 * Leadership is re-read from the database on every call, never trusted from the client,
 * so replacing a leader revokes the power on their next request.
 */

interface Marker {
  sessionEmail: string;
  elevated: boolean;
}

async function resolveMarker(): Promise<{ ok: true; marker: Marker } | { ok: false; res: NextResponse }> {
  const authz = await authorizeEmailAccess(null);
  if (!authz.ok) return { ok: false, res: deniedResponse(authz) };
  return { ok: true, marker: { sessionEmail: authz.sessionEmail, elevated: authz.elevated } };
}

/**
 * GET /api/fpu-attendance?email= — the viewer's group, its sessions and its marks.
 *
 * Self-or-elevated on the email, as everywhere else on the employee surface. A
 * member sees the group roster and their OWN marks; a leader additionally sees
 * every groupmate's marks, because marking is what they are there to do.
 */
export async function GET(req: NextRequest) {
  const authz = await authorizeEmailAccess(req.nextUrl.searchParams.get('email'));
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const { membership, error, migrated } = await findMembership(sb, authz.effectiveEmail);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!migrated) return NextResponse.json({ group: null, migrated: false, error: null });
  if (!membership) return NextResponse.json({ group: null, migrated: true, error: null });

  const cls = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', membership.group.class_id).maybeSingle();
  if (cls.error) return NextResponse.json({ error: cls.error.message }, { status: 500 });
  const theClass = cls.data as FpuClassRow | null;
  const sessions = theClass ? fpuSessions(theClass) : null;

  // Enrollment rows carry the display names; the member row only has the email.
  const enr = await sb.from(FPU_ENROLLMENTS_TABLE).select(FPU_ENROLLMENT_SELECT).in('id', membership.members.map((m) => m.enrollment_id));
  if (enr.error) return NextResponse.json({ error: enr.error.message }, { status: 500 });
  const nameById = new Map((enr.data as FpuEnrollmentRow[] | null ?? []).map((r) => [r.id, r.full_name]));

  const marks = await listClassAttendance(sb, membership.group.class_id);
  if (marks.error) return NextResponse.json({ error: marks.error }, { status: 500 });
  const visible = membership.isLeader || authz.elevated
    ? marks.rows.filter((m) => membership.members.some((mem) => mem.enrollment_id === m.enrollment_id))
    : marks.rows.filter((m) => m.enrollment_id === membership.mine.enrollment_id);

  return NextResponse.json({
    group: {
      id: membership.group.id,
      classId: membership.group.class_id,
      groupNo: membership.group.group_no,
      classLabel: theClass ? fpuClassLabel(theClass) : null,
      isLeader: membership.isLeader,
      myEnrollmentId: membership.mine.enrollment_id,
      // Directory parity, the standing ruling: short name + work email, nothing more.
      members: membership.members
        .filter((m) => !m.left_on)
        .map((m) => ({
          enrollmentId: m.enrollment_id,
          email: m.email,
          name: nameById.get(m.enrollment_id) ?? m.email,
          isLeader: membership.group.leader_enrollment_id === m.enrollment_id,
        })),
      sessions: sessions?.ok ? sessions.sessions : [],
      sessionsUnavailable: sessions && !sessions.ok ? sessions.detail : null,
      markable: theClass ? elapsedFpuSessions(theClass, manilaTodayIso()).map((s) => s.no) : [],
      marks: visible.map((m) => ({ enrollmentId: m.enrollment_id, sessionNo: m.session_no, present: m.present, markedBy: m.marked_by })),
    },
    migrated: true,
    error: null,
  });
}

/**
 * POST /api/fpu-attendance — record one mark.
 * Body: { enrollment_id, session_no, present, note? }
 *
 * Idempotent per (person, session): re-marking corrects the existing row rather
 * than stacking a second one, which is what the unique index enforces anyway.
 */
export async function POST(req: NextRequest) {
  const who = await resolveMarker();
  if (!who.ok) return who.res;
  const { marker } = who;
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { enrollment_id?: unknown; session_no?: unknown; present?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const enrollmentId = typeof body.enrollment_id === 'string' ? body.enrollment_id.trim() : '';
  if (!enrollmentId) return NextResponse.json({ error: 'enrollment_id is required' }, { status: 400 });
  const sessionNo = Number(body.session_no);
  if (!Number.isInteger(sessionNo) || sessionNo < 1) return NextResponse.json({ error: 'session_no must be a whole number.' }, { status: 400 });
  if (typeof body.present !== 'boolean') return NextResponse.json({ error: 'present must be true or false.' }, { status: 400 });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 300) : null;

  // The target's own membership — the group the mark belongs to.
  const target = await sb.from(FPU_ENROLLMENTS_TABLE).select(FPU_ENROLLMENT_SELECT).eq('id', enrollmentId).maybeSingle();
  if (target.error) {
    if (isFpuNotMigrated(target.error)) return NextResponse.json({ error: 'FPU groups need their migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: target.error.message }, { status: 500 });
  }
  if (!target.data) return NextResponse.json({ error: 'That enrollment does not exist.' }, { status: 404 });
  const targetRow = target.data as FpuEnrollmentRow;

  // ── the capability check, re-derived every call ──────────────────────────
  if (!marker.elevated) {
    const mine = await findMembership(sb, marker.sessionEmail);
    if (mine.error) return NextResponse.json({ error: mine.error }, { status: 500 });
    const me = mine.membership;
    if (!me || !me.isLeader) {
      return NextResponse.json({ error: 'Only the group leader or HR can record attendance.' }, { status: 403 });
    }
    const inMyGroup = me.members.some((m) => m.enrollment_id === enrollmentId && !m.left_on);
    if (!inMyGroup) return NextResponse.json({ error: 'That person is not in your group.' }, { status: 403 });
    if (me.mine.enrollment_id === enrollmentId) {
      // Kane, Q5. Same shape as "a reviewer cannot approve their own hours".
      return NextResponse.json({ error: 'A group leader cannot mark their own attendance — HR records it.' }, { status: 403 });
    }
  }

  const cls = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', targetRow.class_id ?? '').maybeSingle();
  if (cls.error) return NextResponse.json({ error: cls.error.message }, { status: 500 });
  if (!cls.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  const theClass = cls.data as FpuClassRow;

  if (theClass.class_closed_on) {
    return NextResponse.json({ error: 'This class is closed — its attendance is final.' }, { status: 409 });
  }
  const today = manilaTodayIso();
  if (!isMarkableSession(theClass, sessionNo, today)) {
    const list = fpuSessions(theClass);
    return NextResponse.json(
      { error: list.ok ? `Session ${sessionNo} has not happened yet.` : list.detail },
      { status: 409 },
    );
  }

  const res = await sb
    .from(FPU_ATTENDANCE_TABLE)
    .upsert(
      { enrollment_id: enrollmentId, class_id: theClass.id, session_no: sessionNo, present: body.present, marked_by: marker.sessionEmail, marked_at: new Date().toISOString(), note },
      { onConflict: 'enrollment_id,session_no' },
    )
    .select(FPU_ATTENDANCE_SELECT)
    .single();
  if (res.error) {
    if (isFpuNotMigrated(res.error)) return NextResponse.json({ error: 'FPU groups need their migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.attendance.marked',
    resource: FPU_ATTENDANCE_TABLE,
    resource_id: (res.data as FpuAttendanceRow).id,
    details: {
      class_id: theClass.id,
      class_label: fpuClassLabel(theClass),
      enrollment_id: enrollmentId,
      email: targetRow.email,
      session_no: sessionNo,
      present: body.present,
      by_elevated: marker.elevated,
      note,
    },
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, { kind: 'enrollment', classId: theClass.id, emails: [targetRow.email.toLowerCase()], ts: Date.now() });

  return NextResponse.json({ mark: res.data, error: null });
}
