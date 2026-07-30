import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  listDepartmentsForManager,
  listManagersByDepartment,
  listAllDepartmentManagers,
} from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  insertTransferRequest,
  listAllTransferRequests,
  listTransferRequestsByRequester,
  listIncomingTransfersForDepartments,
  listResolvedTransfersForDepartments,
  listPendingTransfers,
  listAllResolvedTransfers,
  hasPendingTransferForEmployee,
  type DepartmentTransferRequestRow,
} from '@/lib/supabase/department-transfer-requests';
import { loadActiveDeptsByEmail, partitionStaleTransfers } from '@/lib/transfers/stale-transfers';
import { resolveTransferListQuery } from '@/lib/transfers/list-scope';

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
 * Tag each still-pending request with the source-department manager(s) whose
 * Release it's waiting on ("whom do I nudge?"), excluding the requester
 * themselves. An empty `pending_with` means the source department has NO
 * manager assigned — i.e. the request is orphaned and only an admin can move
 * it. Resolved decline/apply rows are left untouched. Uses a single
 * department_managers read (not one per row).
 */
async function attachPendingWith(
  rows: Awaited<ReturnType<typeof listTransferRequestsByRequester>>['rows'],
  requesterEmail: string,
) {
  if (!rows.some((r) => r.status === 'pending')) return rows;
  const { rows: mgrs } = await listAllDepartmentManagers();
  const byDept = new Map<string, string[]>();
  for (const m of mgrs) {
    const key = m.department.trim().toLowerCase();
    const list = byDept.get(key) ?? [];
    const e = m.manager_email.trim().toLowerCase();
    if (e && !list.includes(e)) list.push(e);
    byDept.set(key, list);
  }
  const me = requesterEmail.toLowerCase();
  return rows.map((r) =>
    r.status === 'pending'
      ? {
          ...r,
          pending_with: (byDept.get(r.from_department.trim().toLowerCase()) ?? []).filter(
            (e) => e !== me,
          ),
        }
      : r,
  );
}

/**
 * Hide release requests for people who've already been transferred OUT of
 * the source department by another path (a co-manager releasing them, the
 * master-list Sheet sync, a direct roster edit, a re-hire). The source
 * manager shouldn't be asked to release someone who's no longer on their
 * team — releasing it is a no-op that just errors. The daily transfer cron
 * then cancels these stale rows for good. Fail-open: if the roster read
 * hiccups we return the unfiltered queue rather than hiding legit requests.
 */
async function hideStalePending(
  rows: DepartmentTransferRequestRow[],
): Promise<DepartmentTransferRequestRow[]> {
  if (rows.length === 0) return rows;
  const { index, error } = await loadActiveDeptsByEmail();
  if (error) return rows;
  return partitionStaleTransfers(rows, index).live;
}

/**
 * GET — list transfer requests. The (roles, scope) → list contract lives in
 * resolveTransferListQuery (tested in src/lib/transfers/list-scope.test.ts):
 *   HR/admin, scope=all       -> every request, every status (read-only history).
 *   HR/admin, scope=incoming  -> only PENDING, all teams (action queue).
 *   HR/admin, scope=done      -> only RESOLVED, all teams.
 *   manager,  scope=incoming  -> pending releases for depts they manage.
 *   manager,  scope=done      -> resolved rows for depts they manage.
 *   default (any role)        -> requests the caller raised (their outbox).
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
  if (!sessionEmail) return NextResponse.json({ rows: [], error: 'Not signed in' }, { status: 401 });

  const scope = new URL(request.url).searchParams.get('scope');
  const query = resolveTransferListQuery(rolesOf(session), scope);

  switch (query) {
    case 'all-requests': {
      // The HR Transfers tab — the full trail across all teams and statuses.
      // No stale-hide: it's a record, and stale pending rows show their true
      // state once the daily cron cancels them.
      const { rows, error } = await listAllTransferRequests();
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    case 'all-pending': {
      const { rows, error } = await listPendingTransfers();
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows: await hideStalePending(rows), error: null });
    }
    case 'all-resolved': {
      const { rows, error } = await listAllResolvedTransfers();
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    case 'dept-incoming': {
      const { rows: depts } = await listDepartmentsForManager(sessionEmail);
      const departments = depts.map((d) => d.department).filter(Boolean);
      const { rows, error } = await listIncomingTransfersForDepartments(departments);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows: await hideStalePending(rows), error: null });
    }
    case 'dept-resolved': {
      // Resolved release requests on the manager's team — released/declined/
      // applied/cancelled. Once a manager acts, the row leaves the pending
      // `incoming` queue and lands here so there's still a record of it.
      const { rows: depts } = await listDepartmentsForManager(sessionEmail);
      const departments = depts.map((d) => d.department).filter(Boolean);
      const { rows, error } = await listResolvedTransfersForDepartments(departments);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows, error: null });
    }
    case 'own-outbox': {
      const { rows, error } = await listTransferRequestsByRequester(sessionEmail);
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      return NextResponse.json({ rows: await attachPendingWith(rows, sessionEmail), error: null });
    }
    case 'forbidden':
      return NextResponse.json({ rows: [], error: 'Manager, HR, or admin role required' }, { status: 403 });
  }
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
