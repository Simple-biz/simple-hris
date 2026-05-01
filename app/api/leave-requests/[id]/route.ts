import { NextResponse } from 'next/server';
import { getAppSetting } from '@/lib/supabase/app-settings';
import {
  cancelLeaveRequestIfOwned,
  getLeaveRequestById,
  listManagersForDepartment,
  resolveManagerEmailsFromJson,
  splitManagerEmails,
  updateLeaveRequestStatus,
  type LeaveRequestStatus,
} from '@/lib/supabase/leave-requests';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { normEmail } from '@/lib/email/norm-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

/** PATCH { action: 'approve'|'reject', approver_email, approver_note } | { action: 'cancel', employee_email } */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const body = (await request.json()) as {
      action?: string;
      approver_email?: string | null;
      approver_note?: string | null;
      employee_email?: string;
    };

    if (body.action === 'cancel') {
      const em = normEmail(body.employee_email ?? '') ?? body.employee_email?.trim().toLowerCase();
      if (!em) {
        return NextResponse.json({ error: 'employee_email required for cancel' }, { status: 400 });
      }
      const { row, error: fetchErr } = await getLeaveRequestById(id);
      if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
      if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (normEmail(row.employee_email) !== em) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (row.status !== 'pending') {
        return NextResponse.json({ error: 'Only pending requests can be cancelled' }, { status: 400 });
      }
      const { error } = await cancelLeaveRequestIfOwned({ id, employee_email: em });
      if (error) return NextResponse.json({ error }, { status: 500 });

      void insertAuditLog({
        user_name: em,
        user_role: 'Employee',
        action: 'leave.cancelled',
        resource: 'leave_requests',
        resource_id: id,
        details: {},
        ip_address: clientIp(request),
      });

      return NextResponse.json({ success: true, error: null });
    }

    if (body.action !== 'approve' && body.action !== 'reject') {
      return NextResponse.json(
        { error: 'action must be approve, reject, or cancel' },
        { status: 400 },
      );
    }

    const status: LeaveRequestStatus = body.action === 'approve' ? 'approved' : 'rejected';
    const approver = body.approver_email?.trim() || null;
    const note = body.approver_note?.trim() || null;

    const { row, error: fetchErr } = await getLeaveRequestById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (row.status !== 'pending') {
      return NextResponse.json({ error: 'Request is no longer pending' }, { status: 400 });
    }

    if (!approver) {
      return NextResponse.json({ error: 'approver_email is required' }, { status: 400 });
    }

    const managersJson = await getAppSetting('leave_department_managers_json');
    const accountingNotify = await getAppSetting('leave_accounting_notify_emails');
    const approverAllow = await getAppSetting('leave_approver_emails');
    const dept = row.department?.trim() || null;
    const a = normEmail(approver) ?? approver.toLowerCase();

    // Authorize approval if the approver is one of:
    //   1. A department manager listed on the request (comma-joined `manager_email`).
    //   2. A current department manager (role=manager + dept match) — re-resolved live so
    //      newly granted managers can clear backlog.
    //   3. Listed in the legacy json map for this department.
    //   4. In the global allow list / accounting notify list.
    let allowed = false;
    const storedManagers = splitManagerEmails(row.manager_email);
    if (storedManagers.includes(a)) allowed = true;
    if (!allowed) {
      const liveManagers = await listManagersForDepartment(dept);
      if (liveManagers.includes(a)) allowed = true;
    }
    if (!allowed) {
      const jsonManagers = resolveManagerEmailsFromJson(dept, managersJson);
      if (jsonManagers.includes(a)) allowed = true;
    }
    if (!allowed) {
      const extra = accountingNotify
        ?.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (extra?.some((e) => e === a)) allowed = true;
    }
    if (!allowed) {
      const globalAllow = approverAllow
        ?.split(',')
        .map((s) => normEmail(s.trim()))
        .filter((x): x is string => Boolean(x));
      if (globalAllow?.some((e) => e === a)) allowed = true;
    }
    if (!allowed) {
      return NextResponse.json(
        { error: 'Only a department manager (or configured approver) can action this request.' },
        { status: 403 },
      );
    }

    const { error } = await updateLeaveRequestStatus({
      id,
      status,
      approver_email: approver,
      approver_note: note,
    });
    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: approver,
      user_role: 'Approver',
      action: status === 'approved' ? 'leave.approved' : 'leave.rejected',
      resource: 'leave_requests',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        note,
        department: dept,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
