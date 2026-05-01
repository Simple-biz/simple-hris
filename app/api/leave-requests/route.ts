import { NextResponse } from 'next/server';
import { getAppSetting } from '@/lib/supabase/app-settings';
import {
  insertLeaveRequest,
  listAllLeaveRequests,
  listLeaveRequestsByEmployee,
  listManagersForDepartment,
  lookupEmployeeNameAndDepartment,
  resolveManagerEmailsFromJson,
} from '@/lib/supabase/leave-requests';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SYSTEM_USER = { name: 'HRIS', role: 'System' } as const;

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

/** GET ?employee_email=… | ?scope=all */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');
    if (scope === 'all') {
      const authz = await requireElevatedSession();
      const session = await getServerSession(authOptions);
      const roles =
        ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
      const sessionEmail = (session?.user?.email ?? '').trim().toLowerCase();

      if (!authz.ok && !roles.includes('manager')) {
        return deniedResponse(authz);
      }

      const { rows: deptRows, error: dmErr } = await listDepartmentsForManager(
        sessionEmail || undefined,
      );
      if (dmErr) return NextResponse.json({ rows: [], error: dmErr }, { status: 500 });
      const departmentStrings = deptRows.map((r) => r.department.trim()).filter(Boolean);

      const { rows: allRows, error } = await listAllLeaveRequests(500);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

      /** People with dept assignments always see leaves only for those depts — matches My Team scope. */
      const applyDeptFilter = departmentStrings.length > 0;

      if (!authz.ok) {
        if (!sessionEmail) {
          return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
        }
        const filtered = applyDeptFilter
          ? allRows.filter((r) =>
              departmentMatchesManagedAssignments(r.department, departmentStrings),
            )
          : [];
        return NextResponse.json({ rows: filtered.slice(0, 300), error: null });
      }

      if (!applyDeptFilter) {
        return NextResponse.json({ rows: allRows.slice(0, 300), error: null });
      }

      const filtered = allRows.filter((r) =>
        departmentMatchesManagedAssignments(r.department, departmentStrings),
      );
      return NextResponse.json({ rows: filtered.slice(0, 300), error: null });
    }
    const raw = searchParams.get('employee_email');
    const em = normEmail(raw ?? '') ?? raw?.trim().toLowerCase();
    if (!em) {
      return NextResponse.json({ error: 'Missing employee_email' }, { status: 400 });
    }
    const authz = await authorizeEmailAccess(em);
    if (!authz.ok) return deniedResponse(authz);
    const { rows, error } = await listLeaveRequestsByEmployee(authz.effectiveEmail);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      employee_email?: string;
      employee_name?: string | null;
      department?: string | null;
      start_date?: string;
      end_date?: string;
      leave_type?: string;
      reason?: string | null;
    };

    const employee_email = normEmail(body.employee_email ?? '') ?? body.employee_email?.trim().toLowerCase();
    if (!employee_email) {
      return NextResponse.json({ error: 'employee_email is required' }, { status: 400 });
    }

    const authz = await authorizeEmailAccess(employee_email);
    if (!authz.ok) return deniedResponse(authz);

    const start_date = body.start_date?.trim();
    const end_date = body.end_date?.trim();
    const leave_type = body.leave_type?.trim();
    if (!start_date || !end_date || !leave_type) {
      return NextResponse.json({ error: 'start_date, end_date, and leave_type are required' }, { status: 400 });
    }
    const sd = new Date(start_date);
    const ed = new Date(end_date);
    if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) {
      return NextResponse.json({ error: 'Invalid dates' }, { status: 400 });
    }
    if (ed < sd) {
      return NextResponse.json({ error: 'end_date must be on or after start_date' }, { status: 400 });
    }

    const managersJson = await getAppSetting('leave_department_managers_json');
    const accountingNotify = await getAppSetting('leave_accounting_notify_emails');

    // Server-side fallback for name + department: if the client didn't resolve them
    // (master-list race or email-drift) we look the employee up in `active_employees`
    // before insert so the manager view never shows a bare email.
    const clientName = body.employee_name?.trim() || null;
    const clientDept = body.department?.trim() || null;
    let resolvedName = clientName;
    let dept = clientDept;
    if (!resolvedName || !dept) {
      const lookup = await lookupEmployeeNameAndDepartment(authz.effectiveEmail);
      resolvedName = resolvedName ?? lookup.name;
      dept = dept ?? lookup.department;
    }

    // Department managers = employees with role=manager AND matching department.
    // Falls back to legacy `leave_department_managers_json` when none are found.
    const roleManagers = await listManagersForDepartment(dept);
    const jsonManagers = roleManagers.length
      ? []
      : resolveManagerEmailsFromJson(dept, managersJson);
    const managerList = roleManagers.length ? roleManagers : jsonManagers;
    const manager_email = managerList.length ? managerList.join(', ') : null;

    const { id, error } = await insertLeaveRequest({
      employee_email: authz.effectiveEmail,
      employee_name: resolvedName,
      department: dept,
      start_date: start_date.slice(0, 10),
      end_date: end_date.slice(0, 10),
      leave_type,
      reason: body.reason?.trim() || null,
      manager_email,
    });

    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: authz.effectiveEmail,
      user_role: 'Employee',
      action: 'leave.request',
      resource: 'leave_requests',
      resource_id: id ?? undefined,
      details: {
        leave_type,
        start_date: start_date.slice(0, 10),
        end_date: end_date.slice(0, 10),
        department: dept,
        manager_email,
        accounting_notify: accountingNotify
          ? accountingNotify.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({
      success: true,
      id,
      manager_email,
      manager_emails: managerList,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
