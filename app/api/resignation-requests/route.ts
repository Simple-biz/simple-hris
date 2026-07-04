import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { getAppSetting } from '@/lib/supabase/app-settings';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  listManagersForDepartment,
  resolveManagerEmailsFromJson,
  lookupEmployeeNameAndDepartment,
} from '@/lib/supabase/leave-requests';
import {
  insertResignationRequest,
  listResignationRequestsByEmployee,
  listAllResignationRequests,
  hasActiveResignation,
} from '@/lib/supabase/resignation-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[]; name?: string | null } | null } | null;

/**
 * GET
 *   ?scope=all           → manager/elevated view, dept-scoped (drives My Team float-to-top).
 *   ?employee_email=…    → the employee's own resignation history.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get('scope');

    if (scope === 'all') {
      const authz = await requireElevatedSession();
      const session = (await getServerSession(authOptions)) as SessionLike;
      const roles = (session?.user?.roles ?? []) as string[];
      const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';

      if (!authz.ok && !roles.includes('manager')) {
        return deniedResponse(authz);
      }
      if (!sessionEmail) {
        return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });
      }

      const { rows: deptRows, error: dmErr } = await listDepartmentsForManager(sessionEmail);
      if (dmErr) return NextResponse.json({ rows: [], error: dmErr }, { status: 500 });
      const managedDepartments = deptRows.map((r) => r.department.trim()).filter(Boolean);
      const applyDeptFilter = managedDepartments.length > 0;

      const { rows: allRows, error } = await listAllResignationRequests();
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });

      // Elevated + no assignments → whole org. Elevated/manager WITH assignments →
      // just their departments. A non-elevated manager with no assignments → none.
      if (authz.ok && !applyDeptFilter) {
        return NextResponse.json({ rows: allRows, scope: 'all', error: null });
      }
      if (!applyDeptFilter) {
        return NextResponse.json({ rows: [], scope: 'department', error: null });
      }
      const filtered = allRows.filter((r) =>
        departmentMatchesManagedAssignments(r.department ?? '', managedDepartments),
      );
      return NextResponse.json({ rows: filtered, scope: 'department', error: null });
    }

    const raw = searchParams.get('employee_email');
    const em = normEmail(raw ?? '') ?? raw?.trim().toLowerCase();
    if (!em) return NextResponse.json({ error: 'Missing employee_email' }, { status: 400 });

    const authz = await authorizeEmailAccess(em);
    if (!authz.ok) return deniedResponse(authz);
    const { rows, error } = await listResignationRequestsByEmployee([authz.effectiveEmail]);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], error: msg }, { status: 500 });
  }
}

/** POST — an employee files their own resignation. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      employee_email?: string;
      employee_name?: string | null;
      employee_work_email?: string | null;
      employee_personal_email?: string | null;
      department?: string | null;
      effective_date?: string;
      message?: string | null;
    };

    const employee_email = normEmail(body.employee_email ?? '') ?? body.employee_email?.trim().toLowerCase();
    if (!employee_email) {
      return NextResponse.json({ error: 'employee_email is required' }, { status: 400 });
    }

    // Identity is session-derived: an employee may only file their own resignation.
    const authz = await authorizeEmailAccess(employee_email);
    if (!authz.ok) return deniedResponse(authz);

    const effective_date = body.effective_date?.trim();
    if (!effective_date) {
      return NextResponse.json({ error: 'effective_date is required' }, { status: 400 });
    }
    const ed = new Date(effective_date);
    if (Number.isNaN(ed.getTime())) {
      return NextResponse.json({ error: 'Invalid effective date' }, { status: 400 });
    }
    // Effective date must be today or later (compared in UTC day terms).
    const todayIso = new Date().toISOString().slice(0, 10);
    if (effective_date.slice(0, 10) < todayIso) {
      return NextResponse.json({ error: 'Effective date must be today or later' }, { status: 400 });
    }

    const workEmail = normEmail(body.employee_work_email ?? '') || null;
    const personalEmail = normEmail(body.employee_personal_email ?? '') || null;

    // Guard: one in-flight resignation per person at a time.
    const identityEmails = [authz.effectiveEmail, workEmail, personalEmail].filter(Boolean) as string[];
    if (await hasActiveResignation(identityEmails)) {
      return NextResponse.json(
        { error: 'You already have a resignation request awaiting your manager.' },
        { status: 409 },
      );
    }

    // Resolve name + department (fall back to active_employees if the client didn't).
    let resolvedName = body.employee_name?.trim() || null;
    let dept = body.department?.trim() || null;
    if (!resolvedName || !dept) {
      const lookup = await lookupEmployeeNameAndDepartment(authz.effectiveEmail);
      resolvedName = resolvedName ?? lookup.name;
      dept = dept ?? lookup.department;
    }

    // The department's manager(s) — same resolution the leave flow uses, so
    // resignations go to whoever already approves leave for the department.
    const roleManagers = await listManagersForDepartment(dept);
    const managersJson = await getAppSetting('leave_department_managers_json');
    const jsonManagers = roleManagers.length ? [] : resolveManagerEmailsFromJson(dept, managersJson);
    const managerList = roleManagers.length ? roleManagers : jsonManagers;
    const manager_email = managerList.length ? managerList.join(', ') : null;

    const { id, error } = await insertResignationRequest({
      employee_email: authz.effectiveEmail,
      employee_name: resolvedName,
      employee_work_email: workEmail ?? authz.effectiveEmail,
      employee_personal_email: personalEmail,
      department: dept,
      effective_date,
      message: body.message?.trim() || null,
      manager_email,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    // Notify the department manager(s) — the resigning person floats to the top
    // of their My Team roster with this message.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && managerList.length > 0) {
      const who = resolvedName || authz.effectiveEmail;
      await supabase.from('employee_notifications').insert(
        managerList.map((to) => ({
          recipient_email: to,
          type: 'resignation.submitted',
          tone: 'neutral',
          title: 'Resignation Submitted',
          message: `${who} submitted a resignation (effective ${effective_date.slice(0, 10)}). Review it in My Team.`,
          details: {
            request_id: id,
            employee_email: authz.effectiveEmail,
            employee_name: resolvedName,
            department: dept,
            effective_date: effective_date.slice(0, 10),
          },
        })),
      );
    }

    void insertAuditLog({
      user_name: authz.effectiveEmail,
      user_role: 'Employee',
      action: 'resignation.submitted',
      resource: 'resignation_requests',
      resource_id: id ?? undefined,
      details: {
        department: dept,
        effective_date: effective_date.slice(0, 10),
        manager_email,
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
