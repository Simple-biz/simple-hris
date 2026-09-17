import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import {
  FPU_GROUPS_TABLE,
  FPU_GROUP_MEMBERS_TABLE,
  FPU_GROUP_MEMBER_SELECT,
  FPU_GROUP_SELECT,
  type FpuGroupMemberRow,
  type FpuGroupRow,
} from '@/lib/mesa/fpu-groups-server';
import { isFpuNotMigrated } from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/hr/fpu-classes/groups/leader — appoint or clear a group's leader.
 * Body: { group_id, enrollment_id: string | null }
 *
 * The leader is stored as an ENROLLMENT, and it must be an enrollment in THIS
 * group. Leadership is the whole authorization behind marking a peer's
 * attendance, so it cannot point at someone outside the group they would be
 * marking. `null` clears it.
 *
 * Gate: HR · MESA · edit. Only HR appoints — a leader is never self-declared.
 */
export async function PATCH(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { group_id?: unknown; enrollment_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
  if (!groupId) return NextResponse.json({ error: 'group_id is required' }, { status: 400 });
  const enrollmentId = typeof body.enrollment_id === 'string' && body.enrollment_id.trim() ? body.enrollment_id.trim() : null;

  const group = await sb.from(FPU_GROUPS_TABLE).select(FPU_GROUP_SELECT).eq('id', groupId).maybeSingle();
  if (group.error) {
    if (isFpuNotMigrated(group.error)) return NextResponse.json({ error: 'FPU groups need their migration — run the FPU Groups migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: group.error.message }, { status: 500 });
  }
  if (!group.data) return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  const g = group.data as FpuGroupRow;

  let member: FpuGroupMemberRow | null = null;
  if (enrollmentId) {
    const m = await sb.from(FPU_GROUP_MEMBERS_TABLE).select(FPU_GROUP_MEMBER_SELECT).eq('enrollment_id', enrollmentId).maybeSingle();
    if (m.error) return NextResponse.json({ error: m.error.message }, { status: 500 });
    if (!m.data) return NextResponse.json({ error: 'That person is not in any group for this class.' }, { status: 404 });
    member = m.data as FpuGroupMemberRow;
    if (member.group_id !== groupId) {
      return NextResponse.json({ error: 'A leader has to be a member of the group they lead.' }, { status: 409 });
    }
    if (member.left_on) {
      return NextResponse.json({ error: 'That person has left this group.' }, { status: 409 });
    }
  }

  const res = await sb
    .from(FPU_GROUPS_TABLE)
    .update({ leader_enrollment_id: enrollmentId, updated_by: authz.sessionEmail })
    .eq('id', groupId)
    .select(FPU_GROUP_SELECT)
    .single();
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: enrollmentId ? 'fpu.groups.leader_set' : 'fpu.groups.leader_cleared',
    resource: FPU_GROUPS_TABLE,
    resource_id: groupId,
    details: {
      class_id: g.class_id,
      group_no: g.group_no,
      leader_enrollment_id: enrollmentId,
      leader_email: member?.email ?? null,
      previous_leader_enrollment_id: g.leader_enrollment_id,
    },
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, {
    kind: 'enrollment',
    classId: g.class_id,
    emails: member ? [member.email] : [],
    ts: Date.now(),
  });

  return NextResponse.json({ group: res.data, error: null });
}
