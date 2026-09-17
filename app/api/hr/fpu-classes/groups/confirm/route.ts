import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { divideIntoGroups, fpuGroupSeed, validatePerGroup, type FpuGroupCandidate } from '@/lib/mesa/fpu-groups';
import { fpuSessions } from '@/lib/mesa/fpu-sessions';
import { fpuClassLabel } from '@/lib/mesa/fpu-class';
import { FPU_CLASSES_TABLE, FPU_CLASS_SELECT, isFpuNotMigrated, listFpuEnrollments, type FpuClassRow } from '@/lib/mesa/fpu-server';
import { FPU_GROUPS_TABLE, FPU_GROUP_MEMBERS_TABLE, FPU_GROUP_SELECT, listClassGroups, type FpuGroupRow } from '@/lib/mesa/fpu-groups-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/hr/fpu-classes/groups/confirm — write the division HR just saw.
 * Body: { class_id, per_group, roll }
 *
 * The membership is **re-derived here from the seed**, never read out of the
 * request. A client that posted its own group lists could commit a division
 * nobody reviewed — or one built from a stale population — so the only thing
 * this route accepts is the three inputs the seed is made of, and it rebuilds
 * the exact same answer the preview showed.
 *
 * From this moment the randomizer never runs again for this class: membership is
 * read from the rows, a latecomer is balance-filled, and a leaver is stamped.
 *
 * Gate: HR · MESA · edit.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { class_id?: unknown; per_group?: unknown; roll?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const classId = typeof body.class_id === 'string' ? body.class_id.trim() : '';
  if (!classId) return NextResponse.json({ error: 'class_id is required' }, { status: 400 });
  const roll = Number.isInteger(body.roll) ? Math.max(0, Number(body.roll)) : 0;

  const cls = await sb.from(FPU_CLASSES_TABLE).select(FPU_CLASS_SELECT).eq('id', classId).maybeSingle();
  if (cls.error) {
    if (isFpuNotMigrated(cls.error)) return NextResponse.json({ error: 'FPU groups need their migration — run the FPU Groups migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: cls.error.message }, { status: 500 });
  }
  if (!cls.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  const theClass = cls.data as FpuClassRow;

  const sessions = fpuSessions(theClass);
  if (!sessions.ok) return NextResponse.json({ error: sessions.detail, reason: sessions.reason }, { status: 409 });

  const existing = await listClassGroups(sb, classId);
  if (!existing.migrated) return NextResponse.json({ error: 'FPU groups need their migration — run the FPU Groups migration.', migrated: false }, { status: 503 });
  if (existing.error) return NextResponse.json({ error: existing.error }, { status: 500 });
  if (existing.rows.length > 0) {
    return NextResponse.json({ error: 'This class is already divided. Groups are dealt once.', alreadyDivided: true }, { status: 409 });
  }

  const enrollments = await listFpuEnrollments(sb, { classId });
  if (enrollments.error) return NextResponse.json({ error: enrollments.error }, { status: 500 });
  const seated = enrollments.rows.filter((r) => r.status === 'approved');

  const check = validatePerGroup(body.per_group, seated.length);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const candidates: FpuGroupCandidate[] = seated.map((r) => ({ enrollmentId: r.id, email: r.email, name: r.full_name }));
  const seed = fpuGroupSeed(classId, check.perGroup, roll);
  const division = divideIntoGroups(candidates, check.perGroup, seed);
  if (division.length === 0) return NextResponse.json({ error: 'Nobody has an approved seat in this class yet.' }, { status: 400 });

  // Groups first, then members: a member row cannot exist without its group, and
  // the unique (class_id, group_no) index is what stops a double submit from
  // dealing this class twice.
  const groupsIn = await sb
    .from(FPU_GROUPS_TABLE)
    .insert(division.map((g) => ({ class_id: classId, group_no: g.groupNo, created_by: authz.sessionEmail, updated_by: authz.sessionEmail })))
    .select(FPU_GROUP_SELECT);
  if (groupsIn.error) {
    if (isFpuNotMigrated(groupsIn.error)) return NextResponse.json({ error: 'FPU groups need their migration — run the FPU Groups migration.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: groupsIn.error.message }, { status: 500 });
  }
  const written = (groupsIn.data ?? []) as FpuGroupRow[];
  const idByNo = new Map(written.map((g) => [g.group_no, g.id]));

  const memberRows = division.flatMap((g) =>
    g.members.map((m) => ({ group_id: idByNo.get(g.groupNo)!, enrollment_id: m.enrollmentId, email: m.email })),
  );
  const membersIn = await sb.from(FPU_GROUP_MEMBERS_TABLE).insert(memberRows).select('id');
  if (membersIn.error) {
    // The groups are already in. Roll them back so a retry is a clean deal
    // rather than a half-divided class nothing can re-deal.
    await sb.from(FPU_GROUPS_TABLE).delete().in('id', written.map((g) => g.id));
    return NextResponse.json({ error: membersIn.error.message }, { status: 500 });
  }

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'fpu.groups.divided',
    resource: FPU_GROUPS_TABLE,
    resource_id: classId,
    details: {
      label: fpuClassLabel(theClass),
      per_group: check.perGroup,
      roll,
      seed,
      groups: division.length,
      population: seated.length,
      // The division itself, so the audit row alone can answer "who was in group 3".
      membership: division.map((g) => ({ group_no: g.groupNo, emails: g.members.map((m) => m.email) })),
    },
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, {
    kind: 'enrollment',
    classId,
    emails: seated.map((r) => r.email.toLowerCase()),
    ts: Date.now(),
  });

  return NextResponse.json({ groups: written.length, members: memberRows.length, seed, error: null });
}
