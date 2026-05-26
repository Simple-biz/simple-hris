import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import {
  DISPUTE_DELETE_ROLES,
  adminDeleteDispute,
  decideDispute,
  decideOrphanageManagerDispute,
  editDisputeDecision,
  getDisputeById,
  returnOrphanageDisputeToManagerQueue,
  revokeDisputeDecision,
  withdrawDispute,
} from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const body = (await request.json()) as {
      action?: string;
      status?: string;
      decided_by?: string;
      decision_note?: string | null;
      override_hours?: number | null;
    };

    if (
      body.action !== 'approve' &&
      body.action !== 'deny' &&
      body.action !== 'edit' &&
      body.action !== 'revoke' &&
      body.action !== 'orphanage_manager_approve' &&
      body.action !== 'orphanage_manager_deny' &&
      body.action !== 'return_to_orphanage'
    ) {
      return NextResponse.json({
        error: 'action must be approve, deny, edit, revoke, orphanage_manager_approve, orphanage_manager_deny, or return_to_orphanage',
      }, { status: 400 });
    }

    const decided_by = body.decided_by?.trim();
    if (!decided_by) {
      return NextResponse.json({ error: 'decided_by is required' }, { status: 400 });
    }

    if (body.action === 'revoke') {
      const { row: disputeRow } = await getDisputeById(id);
      const { error } = await revokeDisputeDecision(id, {
        revoked_by: decided_by,
        revoke_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Dispute not found'
          ? 404
          : error.includes('Not authorized')
            ? 403
            : error.includes('Only approved')
              ? 400
              : 500;
        return NextResponse.json({ error }, { status: code });
      }
      if (disputeRow) {
        const supabase = createSupabaseServiceRoleClient();
        if (supabase) {
          const { error: notifErr } = await supabase.from('employee_notifications').insert({
            recipient_email: disputeRow.work_email,
            type: 'dispute.revoked',
            tone: 'neutral',
            title: 'Dispute Approval Revoked',
            message: `The approval for your attendance dispute on ${disputeRow.dispute_date} has been revoked${body.decision_note ? `: "${body.decision_note}"` : '.'}`,
            details: {
              dispute_date: disputeRow.dispute_date,
              reason: disputeRow.reason,
              revoke_note: body.decision_note ?? null,
            },
          });
          if (notifErr) {
            console.error('[pab-disputes] revoke notification insert failed:', notifErr.message);
          }
        }
      }
      return NextResponse.json({ success: true, error: null });
    }

    if (body.action === 'return_to_orphanage') {
      const { error } = await returnOrphanageDisputeToManagerQueue(id, {
        decided_by,
        return_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Dispute not found'
          ? 404
          : error.includes('Not authorized')
            ? 403
            : error.includes('Not an orphanage') || error.includes('not awaiting')
              ? 400
              : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, error: null });
    }

    if (body.action === 'orphanage_manager_approve' || body.action === 'orphanage_manager_deny') {
      const status = body.action === 'orphanage_manager_approve'
        ? 'orphanage_manager_approved'
        : 'orphanage_manager_denied';
      const { error } = await decideOrphanageManagerDispute(id, {
        status,
        decided_by,
        decision_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Dispute not found'
          ? 404
          : error.includes('Not authorized')
            ? 403
            : error.includes('no longer') || error.includes('Not an orphanage')
              ? 400
              : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, error: null });
    }

    if (body.action === 'edit') {
      const statusRaw = typeof (body as { status?: string }).status === 'string'
        ? (body as { status: string }).status
        : '';
      if (statusRaw !== 'approved' && statusRaw !== 'denied') {
        return NextResponse.json({ error: 'edit requires status=approved|denied' }, { status: 400 });
      }
      const { error } = await editDisputeDecision(id, {
        status: statusRaw as 'approved' | 'denied',
        decided_by,
        decision_note: body.decision_note,
        override_hours: body.override_hours,
      });
      if (error) {
        const code = error === 'Dispute not found' ? 404 : error.includes('pending') ? 400 : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, error: null });
    }

    const status = body.action === 'approve' ? 'approved' : 'denied';

    // Fetch dispute before deciding so we have recipient + date for the notification.
    const { row: disputeRow } = await getDisputeById(id);

    const { error, stage } = await decideDispute(id, {
      status: status as 'approved' | 'denied',
      decided_by,
      decision_note: body.decision_note,
      override_hours: body.override_hours,
    });

    if (error) {
      const code = error === 'Dispute not found'
        ? 404
        : error.includes('Not authorized') || error.includes('already cast')
          ? 403
          : error.includes('no longer pending')
            ? 400
            : 500;
      return NextResponse.json({ error }, { status: code });
    }

    // Notify the employee of the decision. Re-fetch if the pre-fetch row was missing.
    const notifRow = disputeRow ?? (await getDisputeById(id)).row;
    if (notifRow) {
      const isApproved = status === 'approved';
      const supabase = createSupabaseServiceRoleClient();
      if (supabase) {
        const { error: notifErr } = await supabase.from('employee_notifications').insert({
          recipient_email: notifRow.work_email,
          type: isApproved ? 'dispute.approved' : 'dispute.denied',
          tone: isApproved ? 'positive' : 'neutral',
          title: isApproved ? 'Dispute Approved' : 'Dispute Not Approved',
          message: isApproved
            ? `Your attendance dispute for ${notifRow.dispute_date} was approved. This day now counts toward your PAB eligibility.`
            : `Your attendance dispute for ${notifRow.dispute_date} was not approved${body.decision_note ? `: "${body.decision_note}"` : '.'}`,
          details: {
            dispute_date: notifRow.dispute_date,
            reason: notifRow.reason,
            decision_note: body.decision_note ?? null,
            override_hours: body.override_hours ?? null,
          },
        });
        if (notifErr) {
          console.error('[pab-disputes] notification insert failed:', notifErr.message);
        }
      }
    }

    return NextResponse.json({ success: true, stage: stage ?? null, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * Two modes:
 *  1. `?mode=admin` — accounting hard-delete. Requires the caller to hold one of
 *     `DISPUTE_DELETE_ROLES` (admin or payroll_manager). Wipes the dispute regardless
 *     of status; logs `pab_dispute.admin_deleted` to the audit log.
 *  2. `?employee_email=…` (default) — employee withdraw. Caller must own the dispute
 *     AND it must still be pending. Logs `pab_dispute.withdrawn`.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('mode');

    // Admin / payroll-manager hard delete path.
    if (mode === 'admin') {
      const session = await getServerSession(authOptions);
      const user = session?.user as
        | { email?: string | null; roles?: string[] }
        | undefined;
      const sessionEmail = (user?.email ?? '').toString().trim().toLowerCase();
      const roles = user?.roles ?? [];
      if (!sessionEmail) {
        return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
      }
      const allowedRole = roles.find((r) => DISPUTE_DELETE_ROLES.includes(r));
      if (!allowedRole) {
        return NextResponse.json(
          { error: 'Requires admin or payroll_manager' },
          { status: 403 },
        );
      }
      const { error } = await adminDeleteDispute(id, {
        actor_email: sessionEmail,
        actor_role: allowedRole,
      });
      if (error) {
        const code = error === 'Dispute not found' ? 404 : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, mode: 'admin', error: null });
    }

    // Employee withdraw path (legacy / default).
    const rawEmail = searchParams.get('employee_email');
    const email = normEmail(rawEmail ?? '') ?? rawEmail?.trim().toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'employee_email query param is required' }, { status: 400 });
    }

    const authz = await authorizeEmailAccess(email);
    if (!authz.ok) return deniedResponse(authz);

    const { error } = await withdrawDispute(id, { employee_email: authz.effectiveEmail });
    if (error) {
      const code = error === 'Dispute not found' ? 404
        : error === 'Forbidden' ? 403
        : error.includes('pending') ? 400
        : 500;
      return NextResponse.json({ error }, { status: code });
    }

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
