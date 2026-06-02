import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import {
  decideTimeAdjustment,
  deleteTimeAdjustment,
  getTimeAdjustmentById,
  managerDecideTimeAdjustment,
} from '@/lib/supabase/time-adjustments';
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
      approved_hours?: number | null;
      decision_note?: string | null;
    };

    const validActions = ['approve', 'deny', 'manager_approve', 'manager_deny'];
    if (!body.action || !validActions.includes(body.action)) {
      return NextResponse.json(
        { error: 'action must be approve, deny, manager_approve, or manager_deny' },
        { status: 400 },
      );
    }

    const session = await getServerSession(authOptions);
    const sessionEmail = ((session?.user as { email?: string | null } | undefined)?.email ?? '')
      .toString()
      .trim()
      .toLowerCase();
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

    // Manager approval path (stage 1)
    if (body.action === 'manager_approve' || body.action === 'manager_deny') {
      const { error } = await managerDecideTimeAdjustment(id, {
        action: body.action,
        decided_by: sessionEmail,
        decision_note: body.decision_note,
      });
      if (error) {
        const code = error === 'Request not found' ? 404
          : error.includes('Not authorized') || error.includes('not in your managed') ? 403
          : error.includes('no longer pending') ? 400
          : 500;
        return NextResponse.json({ error }, { status: code });
      }
      // Notify employee when manager denies
      if (body.action === 'manager_deny') {
        const { row: notifRow } = await getTimeAdjustmentById(id);
        if (notifRow) {
          const supabase = createSupabaseServiceRoleClient();
          if (supabase) {
            await supabase.from('employee_notifications').insert({
              recipient_email: notifRow.work_email,
              type: 'time_adjustment.denied',
              tone: 'neutral',
              title: 'Time Adjustment Not Approved',
              message: `Your time adjustment for ${notifRow.adjust_date} was not approved by your manager${
                body.decision_note ? `: "${body.decision_note}"` : '.'
              }`,
              details: { adjust_date: notifRow.adjust_date, decision_note: body.decision_note ?? null },
            });
          }
        }
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
