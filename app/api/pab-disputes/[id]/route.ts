import { NextResponse } from 'next/server';
import {
  decideDispute,
  decideOrphanageManagerDispute,
  editDisputeDecision,
  returnOrphanageDisputeToManagerQueue,
  withdrawDispute,
} from '@/lib/supabase/pab-day-disputes';
import { normEmail } from '@/lib/email/norm-email';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';

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
      body.action !== 'orphanage_manager_approve' &&
      body.action !== 'orphanage_manager_deny' &&
      body.action !== 'return_to_orphanage'
    ) {
      return NextResponse.json({
        error: 'action must be approve, deny, edit, orphanage_manager_approve, orphanage_manager_deny, or return_to_orphanage',
      }, { status: 400 });
    }

    const decided_by = body.decided_by?.trim();
    if (!decided_by) {
      return NextResponse.json({ error: 'decided_by is required' }, { status: 400 });
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

    return NextResponse.json({ success: true, stage: stage ?? null, error: null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

    const { searchParams } = new URL(request.url);
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
