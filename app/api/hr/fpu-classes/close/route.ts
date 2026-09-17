import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { broadcastFromServer } from '@/lib/supabase/realtime-broadcast';
import { FPU_LIVE_EVENT, FPU_LIVE_TOPIC } from '@/lib/mesa/fpu-live';
import { fpuClassLabel } from '@/lib/mesa/fpu-class';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import { FPU_CLASSES_TABLE, FPU_CLASS_SELECT, isFpuNotMigrated, type FpuClassRow } from '@/lib/mesa/fpu-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/hr/fpu-classes/close — shut enrollment now, or reopen it.
 * Body: { id: string; closed: boolean }
 *
 * Kane, 2026-09-17: *"a button where we can close the enrollment period at any
 * time we want — this would prohibit the Employees from enrolling."*
 *
 * Closing stamps `enrollment_closed_on` (today in Manila) + the actor, and that
 * alone makes `fpuClassPhase` report `closed`, so `POST /api/fpu-enroll` refuses
 * with the same sentence the employee is already reading. The planned
 * `closes_on` is NOT touched: the window is a record of what HR announced, and
 * an early close is a separate decision. Reopening clears both columns and the
 * class returns to its planned window.
 *
 * Own route rather than a field on PATCH: that handler takes the whole class
 * form and validates every date, so a one-click toggle would have to ship a full
 * payload it does not own. Gate: HR · MESA · edit.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('hr', 'mesa', 'edit');
  if (!authz.ok) return deniedResponse(authz);
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let body: { id?: unknown; closed?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  if (typeof body.closed !== 'boolean') return NextResponse.json({ error: 'closed must be a boolean' }, { status: 400 });
  const closed = body.closed;

  const patch = closed
    ? { enrollment_closed_on: manilaTodayIso(), enrollment_closed_by: authz.sessionEmail }
    : { enrollment_closed_on: null, enrollment_closed_by: null };

  const res = await sb.from(FPU_CLASSES_TABLE).update(patch).eq('id', id).select(FPU_CLASS_SELECT).maybeSingle();
  if (res.error) {
    if (isFpuNotMigrated(res.error)) {
      return NextResponse.json({ error: 'Closing enrollment needs the latest migration — run the FPU classes migration.', migrated: false }, { status: 503 });
    }
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  if (!res.data) return NextResponse.json({ error: 'Class not found' }, { status: 404 });
  const cls = res.data as FpuClassRow;

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: closed ? 'fpu.class.enrollment_closed' : 'fpu.class.enrollment_reopened',
    resource: FPU_CLASSES_TABLE,
    resource_id: cls.id,
    details: {
      label: fpuClassLabel(cls),
      // The planned window, unchanged — so the log shows what was cut short.
      opens_on: cls.opens_on,
      closes_on: cls.closes_on,
      enrollment_closed_on: cls.enrollment_closed_on ?? null,
    },
  });
  void broadcastFromServer(FPU_LIVE_TOPIC, FPU_LIVE_EVENT, { kind: 'class', classId: cls.id, ts: Date.now() });

  return NextResponse.json({ class: cls, error: null });
}
