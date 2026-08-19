import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import {
  assignSecondApprover,
  decideTimeAdjustment,
  deleteTimeAdjustment,
  getTimeAdjustmentById,
  managerDecideTimeAdjustment,
  recallTimeAdjustment,
  secondDecideTimeAdjustment,
} from '@/lib/supabase/time-adjustments';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Tells the employee their request was blocked. Under dual approval EITHER reviewer
 * can end it, so `blockedBy` names which one — the old copy always said "your manager",
 * which would be wrong half the time.
 *
 * Reuses the existing `time_adjustment.denied` type deliberately: it is already in the
 * employee_notifications CHECK allowlist and already mapped to the employee view in
 * notification-views.ts, so this needs no constraint migration.
 */
async function notifyAdjustmentBlocked(
  id: string,
  blockedBy: 'your manager' | 'the second approver',
  decisionNote: string | null,
): Promise<void> {
  const { row } = await getTimeAdjustmentById(id);
  if (!row) return;
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return;
  const { error } = await supabase.from('employee_notifications').insert({
    recipient_email: row.work_email,
    type: 'time_adjustment.denied',
    tone: 'neutral',
    title: 'Time Adjustment Not Approved',
    message: `Your time adjustment for ${row.adjust_date} was not approved by ${blockedBy}${
      decisionNote ? `: "${decisionNote}"` : '.'
    }`,
    details: {
      adjust_date: row.adjust_date,
      decision_note: decisionNote,
      blocked_by: blockedBy === 'your manager' ? 'manager' : 'second_approver',
    },
  });
  // Surfaced, not swallowed: a silent failure here is an employee who is never told
  // their request died. (The accounting path already logged; the manager path did not.)
  if (error) {
    console.error('[time-adjustments] blocked-notification insert failed:', error.message);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const body = (await request.json()) as {
      action?: string;
      approved_hours?: number | null;
      decision_note?: string | null;
      second_approver_email?: string | null;
    };

    const validActions = [
      'approve',
      'deny',
      'manager_approve',
      'manager_deny',
      'recall',
      'assign_second_approver',
      'second_approve',
      'second_deny',
    ];
    if (!body.action || !validActions.includes(body.action)) {
      return NextResponse.json(
        { error: `action must be one of: ${validActions.join(', ')}` },
        { status: 400 },
      );
    }

    // Per-tab edit gate: every manager-stage action (including the second approver's,
    // who is eligible precisely BECAUSE they hold this grant) needs
    // manager:time_adjustments; accounting-stage actions need accounting:payroll_wizard.
    // Row-level authorization is enforced separately below — the department check for
    // the manager, the on-row assignment for the second approver.
    const isManagerStage =
      body.action === 'manager_approve' ||
      body.action === 'manager_deny' ||
      body.action === 'recall' ||
      body.action === 'assign_second_approver' ||
      body.action === 'second_approve' ||
      body.action === 'second_deny';
    const authz = isManagerStage
      ? await requireFeatureEdit('manager', 'time_adjustments')
      : await requireFeatureEdit('accounting', 'payroll_wizard');
    if (!authz.ok) return deniedResponse(authz);

    const session = await getServerSession(authOptions);
    const sessionEmail = ((session?.user as { email?: string | null } | undefined)?.email ?? '')
      .toString()
      .trim()
      .toLowerCase();
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    // Manager recall path — pull a forwarded request back into the manager's queue.
    if (body.action === 'recall') {
      const { error } = await recallTimeAdjustment(id, {
        recalled_by: sessionEmail,
        decision_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Request not found' ? 404
          : error.includes('Not authorized') || error.includes('not in your managed') ? 403
          : error.includes('can be recalled') ? 400
          : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, error: null });
    }

    // Naming the second approver, without deciding yet.
    if (body.action === 'assign_second_approver') {
      const target = (body.second_approver_email ?? '').trim();
      if (!target) {
        return NextResponse.json({ error: 'second_approver_email is required' }, { status: 400 });
      }
      const { error } = await assignSecondApprover(id, {
        second_approver_email: target,
        assigned_by: sessionEmail,
      });
      if (error) {
        const code = error === 'Request not found' ? 404
          : error.includes('Not authorized') || error.includes('not in your managed') ? 403
          : error.includes('no longer open')
            || error.includes('already decided')
            || error.includes('cannot approve')
            || error.includes('Pick someone')
            || error.includes('cannot approve it') ? 400
          : 500;
        return NextResponse.json({ error }, { status: code });
      }
      return NextResponse.json({ success: true, error: null });
    }

    // Manager approval path (stage 1 of 2)
    if (body.action === 'manager_approve' || body.action === 'manager_deny') {
      const { error } = await managerDecideTimeAdjustment(id, {
        action: body.action,
        decided_by: sessionEmail,
        decision_note: body.decision_note,
        second_approver_email: body.second_approver_email,
      });
      if (error) {
        const code = error === 'Request not found' ? 404
          : error.includes('Not authorized') || error.includes('not in your managed') ? 403
          : error.includes('no longer pending')
            || error.includes('already decided')
            || error.includes('Select a second approver')
            || error.includes('no longer open')
            || error.includes('cannot approve')
            || error.includes('Pick someone') ? 400
          : 500;
        return NextResponse.json({ error }, { status: code });
      }
      // Notify the employee when the manager's denial ends the request.
      if (body.action === 'manager_deny') {
        await notifyAdjustmentBlocked(id, 'your manager', body.decision_note ?? null);
      }
      return NextResponse.json({ success: true, error: null });
    }

    // Second-approver path (the other half of stage 1). Authorized by the on-row
    // assignment, which is what lets an approver outside the employee's department act.
    if (body.action === 'second_approve' || body.action === 'second_deny') {
      const { error } = await secondDecideTimeAdjustment(id, {
        action: body.action,
        decided_by: sessionEmail,
        decision_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Request not found' ? 404
          : error.includes('Not authorized') ? 403
          : error.includes('already decided') || error.includes('no longer open') ? 400
          : 500;
        return NextResponse.json({ error }, { status: code });
      }
      if (body.action === 'second_deny') {
        await notifyAdjustmentBlocked(id, 'the second approver', body.decision_note ?? null);
      }
      return NextResponse.json({ success: true, error: null });
    }

    // Accounting decision path (stage 2)
    const status = body.action === 'approve' ? 'approved' : 'denied';

    // Fetch before deciding so we have recipient + date for the notification.
    const { row: before } = await getTimeAdjustmentById(id);

    const { error } = await decideTimeAdjustment(id, {
      status,
      decided_by: sessionEmail,
      approved_hours: body.approved_hours,
      decision_note: body.decision_note,
    });

    if (error) {
      const code = error === 'Request not found'
        ? 404
        : error.includes('Not authorized')
          ? 403
          : error.includes('must be approved by a manager')
            ? 400
            : 500;
      return NextResponse.json({ error }, { status: code });
    }

    const notifRow = before ?? (await getTimeAdjustmentById(id)).row;
    if (notifRow) {
      const isApproved = status === 'approved';
      const supabase = createSupabaseServiceRoleClient();
      if (supabase) {
        const { error: notifErr } = await supabase.from('employee_notifications').insert({
          recipient_email: notifRow.work_email,
          type: isApproved ? 'time_adjustment.approved' : 'time_adjustment.denied',
          tone: isApproved ? 'positive' : 'neutral',
          title: isApproved ? 'Time Adjustment Approved' : 'Time Adjustment Not Approved',
          message: isApproved
            ? `Your time adjustment for ${notifRow.adjust_date} was approved.${
                body.approved_hours != null ? ` Hours set to ${body.approved_hours}h for payroll.` : ''
              }`
            : `Your time adjustment for ${notifRow.adjust_date} was not approved${
                body.decision_note ? `: "${body.decision_note}"` : '.'
              }`,
          details: {
            adjust_date: notifRow.adjust_date,
            approved_hours: isApproved ? body.approved_hours ?? null : null,
            decision_note: body.decision_note ?? null,
          },
        });
        if (notifErr) {
          console.error('[time-adjustments] notification insert failed:', notifErr.message);
        }
      }
    }

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const session = await getServerSession(authOptions);
    const sessionEmail = ((session?.user as { email?: string | null } | undefined)?.email ?? '')
      .toString().trim().toLowerCase();
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    const { error } = await deleteTimeAdjustment(id, sessionEmail);
    if (error) {
      const code = error === 'Request not found' ? 404
        : error.includes('Not authorized') ? 403
        : error.includes('Only denied') ? 400
        : 500;
      return NextResponse.json({ error }, { status: code });
    }
    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
