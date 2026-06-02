import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertPaymentDispatch } from '@/lib/supabase/payment-dispatches';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/mesa-requests/[id]/dispatch
// Accounting/payroll-clerk: mark an approved MESA disbursement as dispatched
// and create a payment_dispatches record with cycle_id='urgent'.
// Body mirrors the payment-dispatches POST body minus cycle fields.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as {
      recipient_email?: string;
      recipient_name?: string | null;
      amount_php?: number | null;
      transaction_id?: string;
      bank_used?: string;
      sent_date?: string;
      arrival_date?: string | null;
      recipient_preferred_bank?: string | null;
      recipient_account_number?: string | null;
      recipient_account_holder?: string | null;
      recipient_swift_code?: string | null;
      status?: string;
      note?: string | null;
    };

    for (const f of ['recipient_email', 'transaction_id', 'bank_used', 'sent_date'] as const) {
      if (!body[f]) {
        return NextResponse.json({ error: `Missing required field: ${f}` }, { status: 400 });
      }
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    // Verify the request is an approved, not-yet-dispatched disbursement
    const { data: mesa, error: fetchErr } = await supabase
      .from('mesa_requests')
      .select('id, request_type, status, dispatched_at')
      .eq('id', id)
      .single();

    if (fetchErr || !mesa) {
      return NextResponse.json({ error: 'MESA request not found' }, { status: 404 });
    }
    if (mesa.request_type !== 'disbursement') {
      return NextResponse.json({ error: 'Only disbursement requests can be dispatched' }, { status: 400 });
    }
    if (mesa.status !== 'approved') {
      return NextResponse.json({ error: 'Request must be approved before dispatching' }, { status: 400 });
    }
    if (mesa.dispatched_at) {
      return NextResponse.json({ error: 'Request already dispatched' }, { status: 409 });
    }

    const actor = await getSessionActor();

    // Create the payment_dispatches record
    const { row: dispatch, error: dispatchErr } = await insertPaymentDispatch({
      cycle_id: 'urgent',
      cycle_source_file: 'mesa_urgent',
      recipient_email: body.recipient_email!,
      recipient_name: body.recipient_name ?? null,
      processor: 'wise',
      amount_usd: null,
      amount_php: body.amount_php ?? null,
      transaction_id: body.transaction_id!,
      bank_used: body.bank_used!,
      sent_date: body.sent_date!,
      arrival_date: body.arrival_date ?? null,
      recipient_preferred_bank: body.recipient_preferred_bank ?? null,
      recipient_account_number: body.recipient_account_number ?? null,
      recipient_account_holder: body.recipient_account_holder ?? null,
      recipient_swift_code: body.recipient_swift_code ?? null,
      status: (body.status ?? 'paid') as 'paid' | 'not_paid' | 'threshold' | 'problem',
      note: body.note ?? null,
      created_by: actor.user_name !== 'anonymous' ? actor.user_name : null,
    });

    if (dispatchErr || !dispatch) {
      return NextResponse.json({ error: dispatchErr ?? 'Failed to create dispatch record' }, { status: 500 });
    }

    // Stamp dispatched_at on the mesa_request
    const { error: stampErr } = await supabase
      .from('mesa_requests')
      .update({ dispatched_at: new Date().toISOString() })
      .eq('id', id);

    if (stampErr) {
      // Dispatch record is already committed; log the stamp failure but don't
      // fail the whole request — Lenny can still see the payment in History.
      void insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: 'mesa.dispatch.stamp_failed',
        resource: 'mesa_requests',
        resource_id: id,
        details: { error: stampErr.message, dispatch_id: dispatch.id },
      });
    }

    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'mesa.disbursement.dispatched',
      resource: 'payment_dispatches',
      resource_id: dispatch.id,
      details: {
        mesa_request_id: id,
        recipient_email: body.recipient_email,
        amount_php: body.amount_php ?? null,
        transaction_id: body.transaction_id,
        bank_used: body.bank_used,
        sent_date: body.sent_date,
        status: body.status ?? 'paid',
      },
    });

    return NextResponse.json({ dispatch, error: null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
