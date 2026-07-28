import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertPaymentDispatch } from '@/lib/supabase/payment-dispatches';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KNOWN_PROCESSORS = new Set(['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires']);

/**
 * Bucket a sent date into its Sunday→Saturday payroll week. Urgent payments
 * reconcile weekly alongside the regular Hubstaff cycles (which also run
 * Sun→Sat, e.g. 2026-04-12_to_2026-04-18), so we group by the same boundaries.
 */
function sundayWeekRange(isoDate: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back up to Sunday
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6); // Saturday
  const fmt = (x: Date) =>
    `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
  return { start: fmt(start), end: fmt(end) };
}

// POST /api/mesa-requests/[id]/dispatch
// Accounting/payroll-clerk: mark an approved MESA disbursement as dispatched
// and create a payment_dispatches record with cycle_id='urgent'. The dispatch
// is bucketed into the Sun→Sat week it was sent (cycle_source_file =
// `urgent_<weekStart>_to_<weekEnd>`) so it surfaces as a weekly report.
// Body mirrors the payment-dispatches POST body minus cycle fields.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as {
      recipient_email?: string;
      recipient_name?: string | null;
      amount_php?: number | null;
      processor?: string | null;
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

    // Hurupay and Higlobe return no usable confirmation reference, so a transaction
    // ID cannot be required for them — the clerk would have to invent one. This
    // queue uses the SHARED MarkPaidDialog with a clerk-picked processor, so the
    // rule has to match the dialog's (`txnOptional`) or a legitimately blank field
    // would be accepted by the UI and then 400 here.
    const txnOptional = ['hurupay', 'higlobe'].includes(
      String(body.processor ?? '').trim().toLowerCase(),
    );
    const requiredFields = (
      txnOptional
        ? ['recipient_email', 'bank_used', 'sent_date']
        : ['recipient_email', 'transaction_id', 'bank_used', 'sent_date']
    ) as Array<'recipient_email' | 'transaction_id' | 'bank_used' | 'sent_date'>;
    for (const f of requiredFields) {
      if (!body[f]) {
        return NextResponse.json({ error: `Missing required field: ${f}` }, { status: 400 });
      }
    }
    // transaction_id is NOT NULL in the database — store a blank, never null.
    if (txnOptional) body.transaction_id = String(body.transaction_id ?? '').trim();

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

    // Processor the clerk chose to pay through (defaults to Wise — MESA payouts
    // are primarily Wise, but the Urgent queue lets them pick per recipient).
    const processor = KNOWN_PROCESSORS.has((body.processor ?? '').toLowerCase())
      ? (body.processor as string).toLowerCase()
      : 'wise';

    // Bucket into the Sun→Sat week it's being sent so it reconciles weekly.
    const week = sundayWeekRange(body.sent_date!);
    const cycleSourceFile = week ? `urgent_${week.start}_to_${week.end}` : 'mesa_urgent';

    // Convert the PHP disbursement to USD via the active FX rate so the weekly
    // report totals (which are USD-centric) include it.
    let amountUsd: number | null = null;
    if (body.amount_php != null) {
      const { data: fxData } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'usd_to_php_rate')
        .maybeSingle();
      const fx = parseFloat((fxData as { value?: string } | null)?.value ?? '0') || 0;
      if (fx > 0) amountUsd = Math.round((body.amount_php / fx) * 100) / 100;
    }

    // Create the payment_dispatches record
    const { row: dispatch, error: dispatchErr } = await insertPaymentDispatch({
      cycle_id: 'urgent',
      cycle_source_file: cycleSourceFile,
      cycle_period_start: week?.start ?? null,
      cycle_period_end: week?.end ?? null,
      recipient_email: body.recipient_email!,
      recipient_name: body.recipient_name ?? null,
      processor,
      amount_usd: amountUsd,
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
        amount_usd: amountUsd,
        processor,
        cycle_source_file: cycleSourceFile,
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
