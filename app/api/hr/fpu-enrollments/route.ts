import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLogs } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import {
  FPU_ENROLLMENTS_TABLE,
  FPU_ENROLLMENT_SELECT,
  isFpuNotMigrated,
  listFpuEnrollments,
  type FpuEnrollmentRow,
} from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Bulk decisions are capped so one click cannot flip an unbounded set. */
const MAX_BULK = 200;

/**
 * GET /api/hr/fpu-enrollments?class_id= — a class's enrollments (or every
 * class-linked enrollment with no filter). Legacy pre-class rows never appear.
 * Gate: HR · MESA · view — this route was one of the four ungated ones in
 * pre-release-security-readiness.md until 2026-09-16.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const classId = req.nextUrl.searchParams.get('class_id')?.trim() || null;
  const { rows, error, migrated } = await listFpuEnrollments(sb, { classId });
  if (error) return NextResponse.json({ rows: [], migrated, error }, { status: 500 });
  return NextResponse.json({ rows, migrated, error: null });
}

type Decision = 'approved' | 'denied' | 'pending';

/**
 * PATCH /api/hr/fpu-enrollments — bulk decision.
 * Body: { ids: string[], status: 'approved' | 'denied' | 'pending', review_notes?: string | null }
 *
 * `approved` is a SEAT in the class — no money moves and nothing touches MESA
 * membership; that happens on Mark completed (`./complete`). `pending` resets a
 * decision. A `completed` row is never changed here: completion has already
 * stamped the FPU date and enrolled the member, so it is skipped and counted.
 * Gate: HR · MESA · edit.
 */
export async function PATCH(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { ids?: unknown; status?: unknown; review_notes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
  if (ids.length === 0) return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  if (ids.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} enrollments per decision.` }, { status: 400 });
  const status = body.status as Decision;
  if (!['approved', 'denied', 'pending'].includes(status)) {
    return NextResponse.json({ error: "status must be 'approved', 'denied' or 'pending'" }, { status: 400 });
  }
  const notes = typeof body.review_notes === 'string' && body.review_notes.trim() ? body.review_notes.trim().slice(0, 500) : null;

  const patch =
    status === 'pending'
      ? { status, reviewed_by: null, reviewed_at: null, review_notes: null }
      : { status, reviewed_by: authz.sessionEmail, reviewed_at: new Date().toISOString(), review_notes: notes };

  const res = await sb
    .from(FPU_ENROLLMENTS_TABLE)
    .update(patch)
    .in('id', ids)
    .neq('status', 'completed')
    .select(FPU_ENROLLMENT_SELECT);
  if (res.error) {
    if (isFpuNotMigrated(res.error)) return NextResponse.json({ error: 'FPU classes are not set up yet — run the migration first.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const updated = (res.data ?? []) as FpuEnrollmentRow[];

  const actor = await getSessionActor();
  void insertAuditLogs(
    updated.map((r) => ({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: status === 'pending' ? 'fpu.enrollment.reset' : `fpu.enrollment.${status}`,
      resource: FPU_ENROLLMENTS_TABLE,
      resource_id: r.id,
      details: { email: r.email, full_name: r.full_name, class_id: r.class_id, status, review_notes: notes },
    })),
  );

  if (updated.length) {
    void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, {
      kind: 'enrollment',
      classId: updated[0]?.class_id ?? null,
      emails: Array.from(new Set(updated.map((r) => r.email.toLowerCase()))),
      ts: Date.now(),
    });
  }

  return NextResponse.json({ updated: updated.length, skipped: ids.length - updated.length, rows: updated, error: null });
}

/**
 * DELETE /api/hr/fpu-enrollments — remove entries. Body: { ids: string[] }
 *
 * Pending, approved and denied rows may go — a mistaken sign-up, a duplicate
 * from an old address, a test. A `completed` row is REFUSED (skipped and
 * counted): it is the record that the FPU date was stamped and the MESA
 * membership opened, and deleting it reverses neither. The person can enroll
 * again while the window is open. Gate: HR · MESA · edit.
 */
export async function DELETE(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];
  if (ids.length === 0) return NextResponse.json({ error: 'ids is required' }, { status: 400 });
  if (ids.length > MAX_BULK) return NextResponse.json({ error: `At most ${MAX_BULK} entries per delete.` }, { status: 400 });

  const res = await sb
    .from(FPU_ENROLLMENTS_TABLE)
    .delete()
    .in('id', ids)
    .neq('status', 'completed')
    .select(FPU_ENROLLMENT_SELECT);
  if (res.error) {
    if (isFpuNotMigrated(res.error)) return NextResponse.json({ error: 'FPU classes are not set up yet — run the migration first.', migrated: false }, { status: 503 });
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  const deleted = (res.data ?? []) as FpuEnrollmentRow[];

  const actor = await getSessionActor();
  void insertAuditLogs(
    deleted.map((r) => ({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'fpu.enrollment.deleted',
      resource: FPU_ENROLLMENTS_TABLE,
      resource_id: r.id,
      details: { email: r.email, full_name: r.full_name, class_id: r.class_id, status_at_delete: r.status, deleted_row: r },
    })),
  );

  if (deleted.length) {
    void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, {
      kind: 'enrollment',
      classId: deleted[0]?.class_id ?? null,
      emails: Array.from(new Set(deleted.map((r) => r.email.toLowerCase()))),
      ts: Date.now(),
    });
  }

  return NextResponse.json({ deleted: deleted.length, skipped: ids.length - deleted.length, error: null });
}
