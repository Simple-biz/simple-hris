import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { listDepartmentsForManager } from '@/lib/supabase/department-managers';
import { departmentMatchesManagedAssignments } from '@/lib/managed-department-scope';
import {
  getTransferRequestById,
  releaseTransfer,
  declineTransfer,
  cancelTransferRequestIfOwned,
  deleteTransferRequestById,
} from '@/lib/supabase/department-transfer-requests';
import { applyApprovedTransfer, manilaTodayIso } from '@/lib/transfers/apply-transfer';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

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
 * PATCH — decide a transfer request. Body: { action, note? }
 *   release  — source-dept manager consents; locks the effective date and either
 *              applies immediately (date already due) or schedules it for the cron.
 *   decline  — source-dept manager refuses (note = reason).
 *   cancel   — the receiving manager withdraws their own pending request.
 * HR no longer approves transfers (v2) — managers own the decision end to end.
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
    const isAdmin = roles.includes('admin');

    const body = (await request.json()) as { action?: string; note?: string | null };
    const action = body.action?.trim();
    const note = body.note?.trim() || null;

    const { row, error: fetchErr } = await getTransferRequestById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Transfer request not found' }, { status: 404 });

    // ── Receiving manager self-cancel (only while pending) ──
    if (action === 'cancel') {
      if (row.status !== 'pending') {
        return NextResponse.json({ error: `Request already ${row.status}` }, { status: 409 });
      }
      if (row.requested_by.toLowerCase() !== sessionEmail) {
        return NextResponse.json({ error: 'Only the requester can cancel this request' }, { status: 403 });
      }
      const { error } = await cancelTransferRequestIfOwned({ id, requested_by: sessionEmail });
      if (error) return NextResponse.json({ error }, { status: 500 });
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: isAdmin ? 'Admin' : 'Manager',
        action: 'department_transfer.cancelled',
        resource: 'department_transfer_requests',
        resource_id: id,
        details: { employee_email: row.employee_email },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── Apply now (push through an already-released transfer) ──
    // A transfer only sits in 'approved' if its release-time apply failed (or it
    // predates apply-on-release). This lets an admin / source-dept manager apply
    // it immediately instead of waiting on the daily cron.
    if (action === 'apply') {
      if (row.status !== 'approved') {
        return NextResponse.json(
          { error: `Only a released (approved) transfer can be applied — this one is ${row.status}.` },
          { status: 409 },
        );
      }
      const authz = await requireFeatureEdit('manager', 'team');
      if (!authz.ok) return deniedResponse(authz);
      if (!isAdmin) {
        const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
        const departments = assigns.map((a) => a.department.trim()).filter(Boolean);
        if (!departmentMatchesManagedAssignments(row.from_department, departments)) {
          return NextResponse.json(
            { error: 'Only a manager of the current department (or an admin) can apply this transfer' },
            { status: 403 },
          );
        }
      }
      const res = await applyApprovedTransfer(row);
      if (res.error) return NextResponse.json({ error: `Could not apply: ${res.error}` }, { status: 500 });
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: isAdmin ? 'Admin' : 'Manager',
        action: 'department_transfer.applied_manual',
        resource: 'department_transfer_requests',
        resource_id: id,
        details: { employee_email: row.employee_email, from_department: row.from_department, to_department: row.to_department, sheet_synced: res.sheetSynced },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, applied: res.applied, sheet_synced: res.sheetSynced, error: null });
    }

    // ── Source-manager decision (release / decline) ──
    if (action !== 'release' && action !== 'decline') {
      return NextResponse.json(
        { error: "action must be 'release', 'decline', 'apply', or 'cancel'" },
        { status: 400 },
      );
    }
    if (row.status !== 'pending') {
      return NextResponse.json({ error: `Request already ${row.status}` }, { status: 409 });
    }

    const authz = await requireFeatureEdit('manager', 'team');
    if (!authz.ok) return deniedResponse(authz);

    // Only a manager of the SOURCE department (or an admin) may decide.
    if (!isAdmin) {
      const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
      const departments = assigns.map((a) => a.department.trim()).filter(Boolean);
      if (!departmentMatchesManagedAssignments(row.from_department, departments)) {
        return NextResponse.json(
          { error: 'Only a manager of the current department can decide this transfer' },
          { status: 403 },
        );
      }
    }

    const supabase = createSupabaseServiceRoleClient();

    if (action === 'decline') {
      const { error } = await declineTransfer({ id, source_manager_email: sessionEmail, note });
      if (error) return NextResponse.json({ error }, { status: 500 });
      if (supabase && row.requested_by) {
        await supabase.from('employee_notifications').insert({
          recipient_email: row.requested_by,
          type: 'transfer.declined',
          tone: 'neutral',
          title: 'Transfer Declined',
          message: `${sessionEmail} declined releasing ${row.employee_name ?? row.employee_email} to ${row.to_department}${note ? `: "${note}"` : '.'}`,
          details: {
            request_id: id,
            employee_email: row.employee_email,
            from_department: row.from_department,
            to_department: row.to_department,
            note,
          },
        });
      }
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: isAdmin ? 'Admin' : 'Manager',
        action: 'department_transfer.declined',
        resource: 'department_transfer_requests',
        resource_id: id,
        details: { employee_email: row.employee_email, from_department: row.from_department, to_department: row.to_department, note },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── release ──
    // Lock the effective date to the receiving manager's proposal (fall back to
    // today for any legacy row that predates the proposed-date field).
    const today = manilaTodayIso();
    const effectiveDate = row.proposed_effective_date || today;

    const { error: relErr } = await releaseTransfer({
      id,
      source_manager_email: sessionEmail,
      effective_date: effectiveDate,
    });
    if (relErr) return NextResponse.json({ error: relErr }, { status: 500 });

    // Notify the receiving manager it was released.
    if (supabase && row.requested_by) {
      await supabase.from('employee_notifications').insert({
        recipient_email: row.requested_by,
        type: 'transfer.released',
        tone: 'positive',
        title: 'Transfer Released',
        message: `${sessionEmail} released ${row.employee_name ?? row.employee_email} to ${row.to_department}, effective ${effectiveDate}.`,
        details: {
          request_id: id,
          employee_email: row.employee_email,
          from_department: row.from_department,
          to_department: row.to_department,
          effective_date: effectiveDate,
        },
      });
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: isAdmin ? 'Admin' : 'Manager',
      action: 'department_transfer.released',
      resource: 'department_transfer_requests',
      resource_id: id,
      details: { employee_email: row.employee_email, from_department: row.from_department, to_department: row.to_department, effective_date: effectiveDate },
      ip_address: clientIp(request),
    });

    // Apply the department move IMMEDIATELY on release, so the change is visible
    // right away (previously a future effective date left the transfer in a
    // "released but nothing changed" limbo waiting on the daily cron). The
    // effective date is retained purely as the RATE-change anchor — payroll
    // prorates PAY by it (see the wizard/dispatch per-day proration) — it does
    // NOT defer the department label move.
    const res = await applyApprovedTransfer({ ...row, status: 'approved', effective_date: effectiveDate });
    if (res.error) {
      // Master-list write failed — the row stays 'approved' so it can be retried
      // via "Apply now" (or the cron). Surface the error.
      return NextResponse.json(
        {
          success: true,
          released: true,
          applied: false,
          error: `Released but could not apply the department change: ${res.error}. Retry with "Apply now" in the Transfers tab.`,
        },
        { status: 200 },
      );
    }

    return NextResponse.json({
      success: true,
      released: true,
      applied: res.applied,
      sheet_synced: res.sheetSynced,
      effective_date: effectiveDate,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE — hard-delete a transfer request record (cleanup of mistaken / test /
 * resolved rows). Allowed for: an admin, the ORIGINAL requester, or a manager of
 * the SOURCE department. Does NOT reverse an already-applied department move — it
 * only removes the request record from the lists/history.
 */
export async function DELETE(
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
    const isAdmin = roles.includes('admin');

    const { row, error: fetchErr } = await getTransferRequestById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ success: true, error: null }); // already gone

    let allowed = isAdmin || row.requested_by.toLowerCase() === sessionEmail;
    if (!allowed) {
      // A manager of the source department may also delete a request on their team.
      const authz = await requireFeatureEdit('manager', 'team');
      if (authz.ok) {
        const { rows: assigns } = await listDepartmentsForManager(sessionEmail);
        const departments = assigns.map((a) => a.department.trim()).filter(Boolean);
        allowed = departmentMatchesManagedAssignments(row.from_department, departments);
      }
    }
    if (!allowed) {
      return NextResponse.json(
        { error: 'Only the requester, a manager of the source department, or an admin can delete this request.' },
        { status: 403 },
      );
    }

    const { error } = await deleteTransferRequestById(id);
    if (error) return NextResponse.json({ error }, { status: 500 });

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: isAdmin ? 'Admin' : 'Manager',
      action: 'department_transfer.deleted',
      resource: 'department_transfer_requests',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        from_department: row.from_department,
        to_department: row.to_department,
        status_when_deleted: row.status,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
