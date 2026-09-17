import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { divideIntoGroups, fpuGroupSeed, validatePerGroup, type FpuGroupCandidate } from '@/lib/mesa/fpu-groups';
import { fpuSessions } from '@/lib/mesa/fpu-sessions';
import { FPU_CLASSES_TABLE, FPU_CLASS_SELECT, isFpuNotMigrated, listFpuEnrollments, type FpuClassRow } from '@/lib/mesa/fpu-server';
import { listClassGroups } from '@/lib/mesa/fpu-groups-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/hr/fpu-classes/groups/preview — show HR the division, write NOTHING.
 * Body: { class_id, per_group, roll? }
 *
 * A POST rather than a GET on purpose: this repo has already been bitten by a
 * GET that wrote (the QC assignments route manufactured phantom periods), and a
 * read-shaped verb on a route that takes parameters invites exactly that. This
 * one is the opposite — it touches no table at all. The division it returns is
 * reproducible from `seed`, and the confirm route RE-DERIVES from that same seed
 * rather than trusting anything posted back, so HR cannot commit a division
 * different from the one on screen.
 *
 * Gate: HR · MESA · edit — it is a step in an editing flow, not a report.
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

  // The end date is what the weekly sessions come from, so a class without one
  // cannot be attended and therefore must not be grouped yet (Kane, Q7).
  const sessions = fpuSessions(theClass);
  if (!sessions.ok) return NextResponse.json({ error: sessions.detail, reason: sessions.reason }, { status: 409 });

  const existing = await listClassGroups(sb, classId);
  if (!existing.migrated) return NextResponse.json({ error: 'FPU groups need their migration — run the FPU Groups migration.', migrated: false }, { status: 503 });
  if (existing.error) return NextResponse.json({ error: existing.error }, { status: 500 });
  if (existing.rows.length > 0) {
    // Never re-deal a class that already has groups: attendance may hang off
    // them, and a fresh shuffle would move people who already have marks.
    return NextResponse.json({ error: 'This class is already divided. Groups are dealt once.', alreadyDivided: true }, { status: 409 });
  }

  const enrollments = await listFpuEnrollments(sb, { classId });
  if (enrollments.error) return NextResponse.json({ error: enrollments.error }, { status: 500 });
  const seated = enrollments.rows.filter((r) => r.status === 'approved');

  const check = validatePerGroup(body.per_group, seated.length);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const candidates: FpuGroupCandidate[] = seated.map((r) => ({ enrollmentId: r.id, email: r.email, name: r.full_name }));
  const seed = fpuGroupSeed(classId, check.perGroup, roll);
  const groups = divideIntoGroups(candidates, check.perGroup, seed);

  return NextResponse.json({
    groups,
    seed,
    roll,
    perGroup: check.perGroup,
    population: seated.length,
    sessionCount: sessions.sessions.length,
    migrated: true,
    error: null,
  });
}
