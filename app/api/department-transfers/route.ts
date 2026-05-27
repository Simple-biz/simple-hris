import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  insertTransferRequest,
  listAllTransferRequests,
  listTransferRequestsByRequester,
  hasPendingTransferForEmployee,
} from '@/lib/supabase/department-transfer-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;
function rolesOf(session: SessionLike): string[] {
  return (session?.user?.roles ?? []) as string[];
}

/** Active work emails for everyone holding one of `roles`. Used to notify HR. */
async function recipientsForRoles(roles: string[]): Promise<string[]> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return [];
  const { data } = await supabase
    .from('employee_roles')
    .select('work_email, role')
    .in('role', roles)
    .is('revoked_at', null);
  const out = new Set<string>();
  for (const r of (data ?? []) as Array<{ work_email?: string | null }>) {
    const e = (r.work_email ?? '').trim().toLowerCase();
    if (e) out.add(e);
  }
  return Array.from(out);
}

/**
 * GET — list transfer requests.
 *   HR (hr_coordinator) / admin  -> every request (approval queue).
 *   manager                       -> their own raised requests (outbox).
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });

  const roles = rolesOf(session);
  const isHr = roles.includes('hr_coordinator') || roles.includes('admin');
  const isManager = roles.includes('manager');

  if (isHr) {
    const { rows, error } = await listAllTransferRequests();
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  }
  if (isManager) {
    const { rows, error } = await listTransferRequestsByRequester(sessionEmail);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  }
  return NextResponse.json({ rows: [], error: 'Manager, HR, or admin role required' }, { status: 403 });
}

/** POST — a manager raises a transfer request for an employee. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const roles = rolesOf(session);
    const isManager = roles.includes('manager');
    const isAdmin = roles.includes('admin');
    if (!isManager && !isAdmin) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const body = (await request.json()) as {
      employee_name?: string | null;
      employee_work_email?: string | null;
      employee_personal_email?: string | null;
      from_department?: string | null;
      to_department?: string | null;
      reason?: string | null;
    };

    const fromDept = body.from_department?.trim() ?? '';
    const toDept = body.to_department?.trim() ?? '';
    const workEmail = body.employee_work_email?.trim().toLowerCase() || null;
    const personalEmail = body.employee_personal_email?.trim().toLowerCase() || null;
    const identifying = personalEmail ?? workEmail;

    if (!identifying) {
      return NextResponse.json({ error: 'Employee email is required' }, { status: 400 });
    }
    if (!fromDept || !toDept) {
      return NextResponse.json({ error: 'from_department and to_department are required' }, { status: 400 });
    }
    if (fromDept.toLowerCase() === toDept.toLowerCase()) {
      return NextResponse.json({ error: 'Target department must differ from the current one' }, { status: 400 });
    }

    // A department-scoped manager may only move employees out of departments they
    // manage. Admins (and managers with no explicit assignments) are unrestricted.
    if (!isAdmin) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      const departments = assigns.map((a) => a.department.trim()).filter(Boolean);
      if (departments.length > 0 && !departmentMatchesManagedAssignments(fromDept, departments)) {
        return NextResponse.json(
          { error: 'You can only transfer employees out of departments you manage' },
          { status: 403 },
        );
      }
    }

    if (await hasPendingTransferForEmployee(identifying)) {
      return NextResponse.json(
        { error: 'This employee already has a pending transfer request.' },
        { status: 409 },
      );
    }

    const { id, error } = await insertTransferRequest({
      employee_email: identifying,
      employee_name: body.employee_name?.trim() || null,
      employee_work_email: workEmail,
      employee_personal_email: personalEmail,
      from_department: fromDept,
      to_department: toDept,
      reason: body.reason ?? null,
      requested_by: sessionEmail,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Notify HR (+ admins) that a request is waiting.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase) {
      const recipients = await recipientsForRoles(['hr_coordinator', 'admin']);
      if (recipients.length > 0) {
        await supabase.from('employee_notifications').insert(
          recipients.map((to) => ({
            recipient_email: to,
            type: 'transfer.requested',
            tone: 'neutral',
            title: 'Department Transfer Request',
            message: `${body.employee_name?.trim() || identifying} - requested move from ${fromDept} to ${toDept} by ${sessionEmail}.`,
            details: {
              request_id: id,
              employee_email: identifying,
              from_department: fromDept,
              to_department: toDept,
              requested_by: sessionEmail,
              reason: body.reason?.trim() || null,
            },
          })),
        );
      }
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: isAdmin ? 'Admin' : 'Manager',
      action: 'department_transfer.requested',
      resource: 'department_transfer_requests',
      resource_id: id ?? undefined,
      details: {
        employee_email: identifying,
        from_department: fromDept,
        to_department: toDept,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
