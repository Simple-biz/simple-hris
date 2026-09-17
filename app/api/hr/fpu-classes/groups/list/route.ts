import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { FPU_ENROLLMENTS_TABLE, FPU_ENROLLMENT_SELECT, type FpuEnrollmentRow } from '@/lib/mesa/fpu-server';
import { listClassAttendance, listClassGroups, listGroupMembers } from '@/lib/mesa/fpu-groups-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/hr/fpu-classes/groups/list — a class's groups, their members and
 * every attendance mark, in one read.
 *
 * A POST that only reads, deliberately: its sibling `preview` is a POST for the
 * safety reason (a parameterised GET is how this repo ended up with a read route
 * that wrote), and having the panel's two calls disagree on verb is how someone
 * later adds a write to the wrong one. Nothing here touches a row.
 *
 * Gate: HR · MESA · view.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { class_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const classId = typeof body.class_id === 'string' ? body.class_id.trim() : '';
  if (!classId) return NextResponse.json({ error: 'class_id is required' }, { status: 400 });

  const groups = await listClassGroups(sb, classId);
  if (!groups.migrated) return NextResponse.json({ groups: [], marks: [], migrated: false, error: null });
  if (groups.error) return NextResponse.json({ error: groups.error }, { status: 500 });

  const [members, marks] = await Promise.all([
    listGroupMembers(sb, groups.rows.map((g) => g.id)),
    listClassAttendance(sb, classId),
  ]);
  if (members.error) return NextResponse.json({ error: members.error }, { status: 500 });
  if (marks.error) return NextResponse.json({ error: marks.error }, { status: 500 });

  // Names live on the enrollment row; the member row carries only the email.
  const enrollmentIds = members.rows.map((m) => m.enrollment_id);
  const nameById = new Map<string, string>();
  if (enrollmentIds.length) {
    const enr = await sb.from(FPU_ENROLLMENTS_TABLE).select(FPU_ENROLLMENT_SELECT).in('id', enrollmentIds);
    if (enr.error) return NextResponse.json({ error: enr.error.message }, { status: 500 });
    for (const r of (enr.data as FpuEnrollmentRow[] | null) ?? []) nameById.set(r.id, r.full_name);
  }

  return NextResponse.json({
    groups: groups.rows.map((g) => ({
      id: g.id,
      groupNo: g.group_no,
      leaderEnrollmentId: g.leader_enrollment_id,
      members: members.rows
        .filter((m) => m.group_id === g.id)
        .map((m) => ({ enrollmentId: m.enrollment_id, email: m.email, name: nameById.get(m.enrollment_id) ?? m.email, leftOn: m.left_on })),
    })),
    marks: marks.rows.map((m) => ({ enrollmentId: m.enrollment_id, sessionNo: m.session_no, present: m.present })),
    migrated: true,
    error: null,
  });
}
