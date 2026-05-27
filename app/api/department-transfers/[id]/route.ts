import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  getTransferRequestById,
  updateTransferRequestStatus,
  cancelTransferRequestIfOwned,
  applyDepartmentTransfer,
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

/**
 * PATCH — HR (or admin) approves/rejects a transfer; the original manager may cancel
 * their own pending request.
 *
 * Body: { decision: 'approved' | 'rejected' | 'cancelled', note?: string }
 *  - approved: applies the department change to global_master_list, then marks approved.
 *  - rejected: marks rejected, no master-list change.
 *  - cancelled: only the requesting manager, only while pending.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const session = await getServerSession(authOptions);
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const roles = rolesOf(session);

    const body = (await request.json()) as { decision?: string; note?: string | null };
    const decision = body.decision?.trim();
    const note = body.note?.trim() || null;

    const { row, error: fetchErr } = await getTransferRequestById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Transfer request not found' }, { status: 404 });
    if (row.status !== 'pending') {
      return NextResponse.json({ error: `Request already ${row.status}` }, { status: 409 });
    }

    // ── Manager self-cancel ──
    if (decision === 'cancelled') {
      if (row.requested_by.toLowerCase() !== sessionEmail) {
        return NextResponse.json({ error: 'Only the requester can cancel this request' }, { status: 403 });
      }
      const { error } = await cancelTransferRequestIfOwned({ id, requested_by: sessionEmail });
      if (error) return NextResponse.json({ error }, { status: 500 });
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: 'Manager',
        action: 'department_transfer.cancelled',
        resource: 'department_transfer_requests',
        resource_id: id,
        details: { employee_email: row.employee_email },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── HR / admin decision ──
    const isHr = roles.includes('hr_coordinator') || roles.includes('admin');
    if (!isHr) {
      return NextResponse.json({ error: 'HR or admin role required' }, { status: 403 });
    }
    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json({ error: "decision must be 'approved', 'rejected', or 'cancelled'" }, { status: 400 });
    }

    let appliedCount = 0;
    if (decision === 'approved') {
      const applied = await applyDepartmentTransfer({
        personalEmail: row.employee_personal_email,
        workEmail: row.employee_work_email,
        fromDepartment: row.from_department,
        toDepartment: row.to_department,
      });
      if (applied.error) {
        return NextResponse.json(
          { error: `Could not apply transfer: ${applied.error}` },
          { status: 500 },
        );
      }
      appliedCount = applied.updated;
    }

    const { error: statusErr } = await updateTransferRequestStatus({
      id,
      status: decision,
      approver_email: sessionEmail,
      approver_note: note,
    });
    if (statusErr) return NextResponse.json({ error: statusErr }, { status: 500 });

    // Notify the requesting manager of the decision.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && row.requested_by) {
      const approved = decision === 'approved';
      await supabase.from('employee_notifications').insert({
        recipient_email: row.requested_by,
        type: approved ? 'transfer.approved' : 'transfer.rejected',
        tone: approved ? 'positive' : 'neutral',
        title: approved ? 'Transfer Approved' : 'Transfer Rejected',
        message: approved
          ? `${row.employee_name ?? row.employee_email} has been moved from ${row.from_department} to ${row.to_department}.`
          : `Your request to move ${row.employee_name ?? row.employee_email} to ${row.to_department} was not approved${note ? `: "${note}"` : '.'}`,
        details: {
          request_id: id,
          employee_email: row.employee_email,
          from_department: row.from_department,
          to_department: row.to_department,
          approver_note: note,
        },
      });
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: roles.includes('admin') ? 'Admin' : 'HR',
      action: decision === 'approved' ? 'department_transfer.approved' : 'department_transfer.rejected',
      resource: 'department_transfer_requests',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        from_department: row.from_department,
        to_department: row.to_department,
        rows_updated: appliedCount,
        note,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, rows_updated: appliedCount, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
