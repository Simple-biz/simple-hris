import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { hasElevatedRole } from '@/lib/auth/elevated-roles';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { getEmployeesForAuthorizedServerRoute } from '@/lib/supabase/employees';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  fireOffboardWebhook,
  MANAGER_SUSPEND_SLUG,
  MANAGER_REACTIVATE_SLUG,
} from '@/lib/hr/offboard-webhooks';
import {
  buildManagerSuspendPayload,
  buildManagerReactivatePayload,
} from '@/lib/hr/manager-temp-pause-webhooks';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function normEmail(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * POST — "Suspend" / "Reactivation" from the Manager -> My Team list, the
 * manager-facing temporary-pause pair (the temp-pause reason is disabled in
 * the manager offboard modal; these buttons replace it):
 *
 *   suspend    -> fires the offboarding-deactivate flow with the exact HR
 *                 temporary_pause envelope (deletion_mode "none") — the
 *                 Workspace account is DISABLED, nothing is deleted.
 *   reactivate -> fires the reactivate-temp-pause flow — the account is
 *                 re-enabled.
 *
 * Neither writes offboard stamps or queue rows — account state lives on the
 * n8n/Workspace side, so the webhook IS the action and a webhook failure
 * fails the request (unlike offboarding, where the DB write is the source of
 * truth and the webhook is best-effort). The audit log is the HRIS-side trace
 * (`manager.suspended` / `manager.reactivated`, resource_id = work email).
 *
 * Auth mirrors the roster read (`/api/manager/department-members`): manager or
 * admin only; a non-elevated manager may only act on someone who has a roster
 * row in a department they manage (dual-department people match on ANY row).
 *
 * Body: `{ email: string; action: 'suspend' | 'reactivate' }` — any of the
 * person's known addresses.
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

  let body: { email?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const targetEmail = normEmail(body.email);
  const action = body.action === 'suspend' || body.action === 'reactivate' ? body.action : null;
  if (!targetEmail) {
    return NextResponse.json({ error: 'email is required' }, { status: 400 });
  }
  if (!action) {
    return NextResponse.json(
      { error: 'action is required and must be "suspend" or "reactivate"' },
      { status: 400 },
    );
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
  // Dual-department people have one roster row per department — collect them
  // ALL so (a) a manager of ANY of those departments is authorized (a .find()
  // would make authorization depend on row order) and (b) the webhook carries
  // the department union, like the offboarding envelopes do.
  const matches = employees.filter(matchesEmail);
  if (matches.length === 0) {
    return NextResponse.json({ error: 'Employee not found on your roster' }, { status: 404 });
  }
  if (!elevated) {
    if (departments.length === 0) {
      return NextResponse.json({ error: 'No department assignments' }, { status: 403 });
    }
    const anyManaged = matches.some((t) =>
      departmentMatchesManagedAssignments(t.department, departments),
    );
    if (!anyManaged) {
      return NextResponse.json({ error: 'Not authorized for this employee' }, { status: 403 });
    }
  }
  const target = matches[0];
  const allDepartments = [
    ...new Set(matches.map((t) => (t.department ?? '').trim()).filter(Boolean)),
  ];

  const keyEmail =
    normEmail(target.work_email) || normEmail(target.personal_email) || targetEmail;
  const now = new Date().toISOString();
  const person = {
    work_email: normEmail(target.work_email) || null,
    personal_email: normEmail(target.personal_email) || null,
    name: target.name ?? null,
    departments: allDepartments,
    start_date: target.start_date ?? null,
  };

  const result =
    action === 'suspend'
      ? await fireOffboardWebhook(
          MANAGER_SUSPEND_SLUG,
          buildManagerSuspendPayload(person, sessionEmail, now),
        )
      : await fireOffboardWebhook(
          MANAGER_REACTIVATE_SLUG,
          buildManagerReactivatePayload(person, sessionEmail, now),
        );

  if (result.error) {
    return NextResponse.json(
      {
        error: `${action === 'suspend' ? 'Suspend' : 'Reactivation'} webhook failed: ${result.error}`,
        fired: result.fired,
        status: result.status,
      },
      { status: 502 },
    );
  }

  // Best-effort audit trail — the account change already happened on the n8n side.
  await insertAuditLog({
    user_name: sessionEmail,
    user_role: roles.includes('admin') ? 'admin' : 'manager',
    action: action === 'suspend' ? 'manager.suspended' : 'manager.reactivated',
    resource: 'employee',
    resource_id: keyEmail,
    details: {
      name: target.name ?? null,
      departments: allDepartments,
      webhook_status: result.status,
    },
  });

  return NextResponse.json({ ok: true, action, email: keyEmail, fired: result.fired, status: result.status });
}
