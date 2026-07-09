import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listDepartmentsForManager, listManagersByDepartment } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  insertTransferRequest,
  listAllTransferRequests,
  listTransferRequestsByRequester,
  listIncomingTransfersForDepartments,
  listResolvedTransfersForDepartments,
  hasPendingTransferForEmployee,
} from '@/lib/supabase/department-transfer-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;
function rolesOf(session: SessionLike): string[] {
  return (session?.user?.roles ?? []) as string[];
}

/**
 * GET — list transfer requests.
 *   HR (hr_coordinator) / admin        -> every request (read-only history).
 *   manager, scope=incoming            -> release requests for depts they manage
 *                                          (their consent queue).
 *   manager, default (scope=outgoing)  -> requests they raised (their outbox).
 */
export async function GET(request: Request) {
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
    const scope = new URL(request.url).searchParams.get('scope');
    if (scope === 'incoming') {
      const { rows: depts } = await listDepartmentsForManager(sessionEmail);
      const departments = depts.map((d) => d.department).filter(Boolean);
      const { rows, error } = await listIncomingTransfersForDepartments(departments);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    if (scope === 'done') {
      // Resolved release requests on the manager's team — released/declined/
      // applied/cancelled. Once a manager acts, the row leaves the pending
      // `incoming` queue and lands here so there's still a record of it.
      const { rows: depts } = await listDepartmentsForManager(sessionEmail);
      const departments = depts.map((d) => d.department).filter(Boolean);
      const { rows, error } = await listResolvedTransfersForDepartments(departments);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    const { rows, error } = await listTransferRequestsByRequester(sessionEmail);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  }
  return NextResponse.json({ rows: [], error: 'Manager, HR, or admin role required' }, { status: 403 });
}

/**
 * POST — initiate a transfer: pull an employee INTO a target department. The
 * person's current (source) department manager(s) are notified to release or
 * decline. Body:
 *   { employee_name, employee_work_email, employee_personal_email,
 *     from_department (person's current dept), to_department (target dept),
 *     reason?, proposed_effective_date (YYYY-MM-DD) }
 *
 * Initiating a transfer requires ADMIN rights — a plain manager can only release
 * or decline requests raised for their own team, not start one. A manager who
 * also holds admin can initiate (admin bypasses the gate).
 */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const roles = rolesOf(session);
    const isAdmin = roles.includes('admin');
    const isManager = roles.includes('manager');
    if (!isAdmin && !isManager) {
      return NextResponse.json({ error: 'Manager or admin role required' }, { status: 403 });
    }

    const body = (await request.json()) as {
      employee_name?: string | null;
      employee_work_email?: string | null;
      employee_personal_email?: string | null;
      from_department?: string | null;
      to_department?: string | null;
      reason?: string | null;
      proposed_effective_date?: string | null;
    };

    const fromDept = body.from_department?.trim() ?? '';
    const toDept = body.to_department?.trim() ?? '';
    const workEmail = body.employee_work_email?.trim().toLowerCase() || null;
    const personalEmail = body.employee_personal_email?.trim().toLowerCase() || null;
    const identifying = personalEmail ?? workEmail;
    const proposed = body.proposed_effective_date?.trim() || '';

    if (!identifying) {
      return NextResponse.json({ error: 'Employee email is required' }, { status: 400 });
    }
    if (!fromDept || !toDept) {
      return NextResponse.json({ error: 'from_department and to_department are required' }, { status: 400 });
    }
    if (fromDept.toLowerCase() === toDept.toLowerCase()) {
      return NextResponse.json({ error: 'Target department must differ from the current one' }, { status: 400 });
    }
    if (!ISO_DATE.test(proposed)) {
      return NextResponse.json({ error: 'A proposed effective date (YYYY-MM-DD) is required' }, { status: 400 });
    }

    // A non-admin manager may only pull people INTO a department they manage,
    // and only FROM a department they DON'T manage (never poach off their own
    // team — that's the source manager's call). Admins are unrestricted, as are
    // managers with no explicit department assignments (elevated).
    if (!isAdmin) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      const departments = assigns.map((a) => a.department.trim()).filter(Boolean);
      if (departments.length > 0) {
        if (!departmentMatchesManagedAssignments(toDept, departments)) {
          return NextResponse.json(
            { error: 'You can only transfer people into a department you manage.' },
            { status: 403 },
          );
        }
        if (departmentMatchesManagedAssignments(fromDept, departments)) {
          return NextResponse.json(
            { error: "You can't initiate a transfer out of your own department." },
            { status: 403 },
          );
        }
      }
    }

    if (await hasPendingTransferForEmployee(identifying)) {
      return NextResponse.json(
        { error: 'This employee already has an in-flight transfer request.' },
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
      proposed_effective_date: proposed,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Notify the SOURCE department's manager(s) — they release or decline.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase) {
      const sourceManagers = (await listManagersByDepartment(fromDept)).filter(
        (m) => m !== sessionEmail,
      );
      if (sourceManagers.length > 0) {
        const who = body.employee_name?.trim() || identifying;
        await supabase.from('employee_notifications').insert(
          sourceManagers.map((to) => ({
            recipient_email: to,
            type: 'transfer.release_requested',
            tone: 'neutral',
            title: 'Transfer Release Request',
            message: `${sessionEmail} would like to move ${who} from ${fromDept} to ${toDept} (proposed ${proposed}). Release or decline in My Team.`,
            details: {
              request_id: id,
              employee_email: identifying,
              from_department: fromDept,
              to_department: toDept,
              requested_by: sessionEmail,
              proposed_effective_date: proposed,
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
        proposed_effective_date: proposed,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, id, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
