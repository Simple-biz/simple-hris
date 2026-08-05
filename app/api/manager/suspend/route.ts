import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import { fireOffboardWebhook, MANAGER_SUSPEND_SLUG } from '@/lib/hr/offboard-webhooks';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * POST — "Suspend" from the Manager -> My Team list: fires the n8n temp-pause
 * webhook, which disables (suspends) the person's Google Workspace account.
 *
 * Suspend-only by design: NO offboard stamps, NO scheduled deletion, nothing
 * written to global_master_list — the person stays a normal active roster row
 * and comes back by being re-enabled on the n8n side. The webhook is the whole
 * action, so unlike offboarding (where the DB write is the source of truth and
 * the webhook is best-effort) a webhook failure here fails the request.
 *
 * Auth mirrors the roster read (`/api/manager/department-members`): manager or
 * admin only, and a non-elevated manager may only suspend someone on a
 * department they manage.
 *
 * Body: `{ email: string }` — any of the person's known addresses.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const sessionEmail = normEmail(user?.email ?? null);
  if (!sessionEmail) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const roles = (user?.roles ?? []) as string[];
  if (!(roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
  }

  let body: { email?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const targetEmail = normEmail(body.email);
  if (!targetEmail) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }

  // Resolve the target against the authorized roster + confirm scope.
  const elevated = hasElevatedRole(roles);
  const [{ rows: assigns }, { employees, error }] = await Promise.all([
    listDepartmentsForManager(sessionEmail),
    getEmployeesForAuthorizedServerRoute(),
  ]);
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  const departments = assigns.map((a) => a.department.trim()).filter(Boolean);

  const matchesEmail = (e: EmployeeRow): boolean =>
    [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]
      .map(normEmail)
      .includes(targetEmail);
  const target = employees.find(matchesEmail);
  if (!target) {
    return NextResponse.json({ error: 'Employee not found on your roster' }, { status: 404 });
  }
  if (!elevated) {
    if (departments.length === 0) {
      return NextResponse.json({ error: 'No department assignments' }, { status: 403 });
    }
    if (!departmentMatchesManagedAssignments(target.department, departments)) {
      return NextResponse.json({ error: 'Not authorized for this employee' }, { status: 403 });
    }
  }

  const keyEmail =
    normEmail(target.work_email) || normEmail(target.personal_email) || targetEmail;
  const now = new Date().toISOString();

  // Envelope mirrors the offboarding webhooks (employees[] + Split Out, each
  // item self-contained) so the n8n side parses a familiar shape. action /
  // deletion_mode let the flow branch suspend vs. reactivate on one endpoint.
  const result = await fireOffboardWebhook(MANAGER_SUSPEND_SLUG, {
    action: 'suspend',
    reason: 'temporary_pause',
    deletion_mode: 'none',
    triggered_by: sessionEmail,
    triggered_at: now,
    count: 1,
    employees: [
      {
        work_email: normEmail(target.work_email) || null,
        personal_email: normEmail(target.personal_email) || null,
        name: target.name ?? null,
        departments: target.department ? [target.department] : [],
        action: 'suspend',
        reason: 'temporary_pause',
        deletion_mode: 'none',
        triggered_by: sessionEmail,
        triggered_at: now,
      },
    ],
  });

  if (result.error) {
    return NextResponse.json(
      { error: `Suspend webhook failed: ${result.error}`, fired: result.fired, status: result.status },
      { status: 502 },
    );
  }

  // Best-effort audit trail — the suspension already happened on the n8n side.
  await insertAuditLog({
    user_name: sessionEmail,
    user_role: roles.includes('admin') ? 'admin' : 'manager',
    action: 'manager.suspended',
    resource: 'employee',
    resource_id: keyEmail,
    details: {
      name: target.name ?? null,
      department: target.department ?? null,
      webhook_status: result.status,
    },
  });

  return NextResponse.json({ ok: true, email: keyEmail, fired: result.fired, status: result.status });
}
