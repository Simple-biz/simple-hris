import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole, hasRateVisibility } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import {
  clearPendingHireOrientation,
  manilaDateFromIso,
  markPendingHireOrientation,
  redactPendingRowRates,
} from '@/lib/supabase/hr-pending-employees';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { isLeadGenDepartment } from '@/lib/hr/offboard-webhooks';
import {
  fireOrientationAttendedWebhook,
  type OrientationWebhookResult,
} from '@/lib/hr/orientation-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * Verifies the caller is a manager (or elevated) and — for non-elevated
 * managers — that the pending hire's department appears in their
 * department_managers assignments. Returns `{ ok: true, sessionEmail }` on
 * success or a NextResponse to short-circuit on failure.
 */
async function authorizeForHire(id: number) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = normEmail(user?.email ?? null);
  if (!sessionEmail) {
    return { ok: false as const, res: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) };
  }

  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes('manager') || roles.includes('admin'))) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 }),
    };
  }

  if (hasElevatedRole(roles)) {
    return { ok: true as const, sessionEmail };
  }

  // Department gate: load the pending row, compare its department against the
  // manager's department_managers assignments.
  const sb = createSupabaseServiceRoleClient();
  if (!sb) {
    return {
      ok: false as const,
      res: NextResponse.json({ error: 'Supabase not configured' }, { status: 500 }),
    };
  }
  const { data: hireRow, error: hireErr } = await sb
    .from('hr_pending_employees')
    .select('id, department, status')
    .eq('id', id)
    .single();
  if (hireErr || !hireRow) {
    return { ok: false as const, res: NextResponse.json({ error: 'Pending hire not found' }, { status: 404 }) };
  }

  const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
  const allowed = new Set(assigns.map((a) => a.department.trim().toLowerCase()));
  const hireDept = (hireRow.department as string | null | undefined)?.trim().toLowerCase() ?? '';
  if (!allowed.has(hireDept)) {
    return {
      ok: false as const,
      res: NextResponse.json(
        { error: "You don't manage this hire's department." },
        { status: 403 },
      ),
    };
  }

  return { ok: true as const, sessionEmail };
}

/**
 * The Lead Gen dialer fields captured on the hire's onboarding paperwork —
 * looked up via the submission linked to this pending hire
 * (hr_onboarding_submissions.pending_employee_id, stamped at set-work-email).
 * Best-effort: nulls when there's no linked submission, the hire predates the
 * feature, or the calltools migration hasn't run (missing-column error).
 */
async function loadCallToolsFields(
  pendingId: number,
): Promise<{ calltools_nickname: string | null; calltools_username: string | null }> {
  const none = { calltools_nickname: null, calltools_username: null };
  const sb = createSupabaseServiceRoleClient();
  if (!sb) return none;
  try {
    const { data, error } = await sb
      .from('hr_onboarding_submissions')
      .select('calltools_nickname, calltools_username')
      .eq('pending_employee_id', pendingId)
      .order('submitted_at', { ascending: false })
      .limit(1);
    if (error || !data?.[0]) return none;
    const row = data[0] as { calltools_nickname?: string | null; calltools_username?: string | null };
    return {
      calltools_nickname: row.calltools_nickname ?? null,
      calltools_username: row.calltools_username ?? null,
    };
  } catch {
    return none;
  }
}

/** POST — mark orientation as attended (idempotent). Body: { note?: string }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const feat = await requireFeatureEdit('manager', 'team');
  if (!feat.ok) return deniedResponse(feat);

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }

  const authz = await authorizeForHire(id);
  if (!authz.ok) return authz.res;

  let body: { note?: string | null; attendedOn?: string | null } = {};
  try {
    body = (await req.json()) as { note?: string | null; attendedOn?: string | null };
  } catch {
    // empty body is fine
  }

  // Was orientation already stamped? The mark is idempotent (re-marks edit the
  // date), so this rides the webhook as `already_marked` — n8n's dedupe signal
  // against provisioning the same hire twice.
  let alreadyMarked = false;
  {
    const sb = createSupabaseServiceRoleClient();
    if (sb) {
      const { data: prior } = await sb
        .from('hr_pending_employees')
        .select('orientation_attended_at')
        .eq('id', id)
        .maybeSingle();
      alreadyMarked = Boolean(
        (prior as { orientation_attended_at?: string | null } | null)?.orientation_attended_at,
      );
    }
  }

  const { row, error } = await markPendingHireOrientation(id, {
    markedBy: authz.sessionEmail,
    note: body.note ?? null,
    attendedOn: body.attendedOn ?? null,
  });
  if (error) return NextResponse.json({ error }, { status: 500 });

  // Notify n8n the hire attended (best-effort — the DB mark above is the source
  // of truth and already succeeded). The payload carries the CallTools dialer
  // fields from the hire's onboarding paperwork so the flow can provision the
  // Lead Gen agent account; they're null for other departments.
  let webhook: OrientationWebhookResult | null = null;
  if (row) {
    const calltools = await loadCallToolsFields(id);
    webhook = await fireOrientationAttendedWebhook({
      event: 'hire.orientation_attended',
      pending_employee_id: id,
      name: row.name ?? null,
      work_email: row.work_email ?? null,
      personal_email: row.personal_email ?? null,
      department: row.department ?? null,
      lead_gen: isLeadGenDepartment(row.department),
      ...calltools,
      attended_on: manilaDateFromIso(row.orientation_attended_at),
      orientation_attended_at: row.orientation_attended_at ?? null,
      marked_by: authz.sessionEmail,
      note: body.note?.trim() || null,
      already_marked: alreadyMarked,
    });
  }

  // Managers must never receive the staged hire's pay rate.
  return NextResponse.json({
    row: redactPendingRowRates(row, hasRateVisibility(feat.roles)),
    webhook,
  });
}

/** DELETE — clears the orientation marker (manager changed their mind / typo). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const feat = await requireFeatureEdit('manager', 'team');
  if (!feat.ok) return deniedResponse(feat);

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  const authz = await authorizeForHire(id);
  if (!authz.ok) return authz.res;

  const { row, error } = await clearPendingHireOrientation(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  // Managers must never receive the staged hire's pay rate.
  return NextResponse.json({ row: redactPendingRowRates(row, hasRateVisibility(feat.roles)) });
}
