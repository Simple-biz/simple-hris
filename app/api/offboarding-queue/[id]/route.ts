import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { offboardReasonLabel, isQueueableOffboardReason } from '@/lib/hr/offboard-reasons';
import {
  getOffboardingQueueById,
  decideOffboardingQueueEntry,
  cancelOffboardingQueueIfOwned,
  deleteOffboardingQueueEntry,
} from '@/lib/supabase/offboarding-queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function clientIp(request: Request): string | null {
  const fwd = request.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0].trim() : request.headers.get('x-real-ip');
}

type SessionLike = { user?: { email?: string | null; roles?: string[] } | null } | null;

/**
 * PATCH — advance a single queue row.
 *   decision 'cancelled' : the requesting manager withdraws their own pending request.
 *   decision 'dismissed' : HR rejects the request (note = dismiss reason).
 *   decision 'completed' : HR marks it done AFTER POST /api/hr/offboard succeeded
 *                          (offboard_reason = the reason HR actually used).
 * Body: { decision, note?, offboard_reason? }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const session = (await getServerSession(authOptions)) as SessionLike;
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const roles = (session?.user?.roles ?? []) as string[];

    const body = (await request.json()) as {
      decision?: string;
      note?: string | null;
      offboard_reason?: string | null;
    };
    const decision = body.decision?.trim();
    const note = body.note?.trim() || null;

    const { row, error: fetchErr } = await getOffboardingQueueById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    // ── Manager self-cancel ──
    if (decision === 'cancelled') {
      if (row.requested_by.toLowerCase() !== sessionEmail) {
        return NextResponse.json({ error: 'Only the requester can cancel this request' }, { status: 403 });
      }
      const { updated, error } = await cancelOffboardingQueueIfOwned({ id, requested_by: sessionEmail });
      if (error) return NextResponse.json({ error }, { status: 500 });
      if (updated === 0) {
        return NextResponse.json({ error: `Request is already ${row.status}` }, { status: 409 });
      }
      void insertAuditLog({
        user_name: sessionEmail,
        user_role: 'Manager',
        action: 'offboarding.request_cancelled',
        resource: 'offboarding_queue',
        resource_id: id,
        details: { employee_email: row.employee_email },
        ip_address: clientIp(request),
      });
      return NextResponse.json({ success: true, error: null });
    }

    // ── HR decision (complete / dismiss / return) ──
    const authz = await requireFeatureEdit('hr', 'offboarding');
    if (!authz.ok) return deniedResponse(authz);
    if (decision !== 'dismissed' && decision !== 'completed' && decision !== 'returned') {
      return NextResponse.json(
        { error: "decision must be 'completed', 'dismissed', 'returned', or 'cancelled'" },
        { status: 400 },
      );
    }
    // Dismiss + return both need a reason (the manager is told why); completion
    // is only recorded after the offboard actually ran.
    if ((decision === 'dismissed' || decision === 'returned') && !note) {
      return NextResponse.json(
        { error: decision === 'dismissed' ? 'A dismissal reason is required' : 'A reason for returning is required' },
        { status: 400 },
      );
    }
    if (
      row.status === 'completed' ||
      row.status === 'dismissed' ||
      row.status === 'returned' ||
      row.status === 'cancelled'
    ) {
      return NextResponse.json({ error: `Request is already ${row.status}` }, { status: 409 });
    }
    // A manager-raised offboard always rides the DELETE pathway — completing
    // one as a Temporary Pause (a suspension) is never valid bookkeeping.
    const completedReason = body.offboard_reason?.trim();
    if (decision === 'completed' && completedReason && !isQueueableOffboardReason(completedReason)) {
      return NextResponse.json(
        {
          error:
            completedReason === 'temporary_pause'
              ? 'A queued offboard cannot complete as Temporary Pause — that is the Suspend flow, not an offboard.'
              : `Invalid offboard reason: ${completedReason}`,
        },
        { status: 400 },
      );
    }

    const { updated, error: decideErr } = await decideOffboardingQueueEntry({
      id,
      status: decision,
      processed_by: sessionEmail,
      processed_note: note,
      offboard_reason: decision === 'completed' ? (body.offboard_reason?.trim() || row.reason) : null,
    });
    if (decideErr) return NextResponse.json({ error: decideErr }, { status: 500 });
    // A concurrent request already decided this row (atomic guard touched 0 rows).
    if (updated === 0) {
      return NextResponse.json({ error: 'Request was already processed by someone else' }, { status: 409 });
    }

    // Notify the requesting manager of the outcome.
    const supabase = createSupabaseServiceRoleClient();
    if (supabase && row.requested_by) {
      const who = row.employee_name ?? row.employee_email;
      const notif =
        decision === 'completed'
          ? {
              type: 'offboarding.request_completed',
              title: 'Offboarding Completed',
              message: `${who} has been offboarded by HR${
                body.offboard_reason ? ` (${offboardReasonLabel(body.offboard_reason)})` : ''
              }.`,
            }
          : decision === 'returned'
            ? {
                type: 'offboarding.request_returned',
                title: 'Offboarding Request Returned',
                message: `HR sent your request to offboard ${who} back for another look${note ? `: "${note}"` : '.'}`,
              }
            : {
                type: 'offboarding.request_dismissed',
                title: 'Offboarding Request Dismissed',
                message: `Your request to offboard ${who} was dismissed by HR${note ? `: "${note}"` : '.'}`,
              };
      await supabase.from('employee_notifications').insert({
        recipient_email: row.requested_by,
        type: notif.type,
        tone: 'neutral',
        title: notif.title,
        message: notif.message,
        details: {
          request_id: id,
          employee_email: row.employee_email,
          employee_name: row.employee_name,
          processed_by: sessionEmail,
          note,
        },
      });
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: roles.includes('admin') ? 'Admin' : 'HR',
      action:
        decision === 'completed'
          ? 'offboarding.request_completed'
          : decision === 'returned'
            ? 'offboarding.request_returned'
            : 'offboarding.request_dismissed',
      resource: 'offboarding_queue',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        requested_by: row.requested_by,
        offboard_reason: decision === 'completed' ? (body.offboard_reason?.trim() || row.reason) : null,
        note,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE — permanently remove a queue row (HR cleanup of stale/mistaken
 * entries, any status). Gated on HR/admin offboarding edit rights and audited.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const session = (await getServerSession(authOptions)) as SessionLike;
    const sessionEmail = normEmail(session?.user?.email ?? '') ?? '';
    if (!sessionEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const roles = (session?.user?.roles ?? []) as string[];

    const authz = await requireFeatureEdit('hr', 'offboarding');
    if (!authz.ok) return deniedResponse(authz);

    const { row, error: fetchErr } = await getOffboardingQueueById(id);
    if (fetchErr) return NextResponse.json({ error: fetchErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    const { deleted, error } = await deleteOffboardingQueueEntry(id);
    if (error) return NextResponse.json({ error }, { status: 500 });
    // A concurrent delete already removed the row — don't log a phantom action.
    if (deleted === 0) {
      return NextResponse.json({ error: 'Request was already removed' }, { status: 409 });
    }

    void insertAuditLog({
      user_name: sessionEmail,
      user_role: roles.includes('admin') ? 'Admin' : 'HR',
      action: 'offboarding.request_deleted',
      resource: 'offboarding_queue',
      resource_id: id,
      details: {
        employee_email: row.employee_email,
        employee_name: row.employee_name,
        requested_by: row.requested_by,
        status: row.status,
      },
      ip_address: clientIp(request),
    });

    return NextResponse.json({ success: true, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
