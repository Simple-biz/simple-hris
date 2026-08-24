import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertPaymentDispatch } from '@/lib/supabase/payment-dispatches';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { sundayWeekRange, urgentCycleSourceFile } from '@/lib/payroll/urgent-cycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KNOWN_PROCESSORS = new Set(['hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires']);

// POST /api/urgent-payments/requests/[id]/dispatch
// Accounting/payroll-clerk: send a pending one-off payment. Creates a
// payment_dispatches record tagged as urgent via cycle_source_file, stamps the
// request 'dispatched', and notifies the employee. Mirrors
// app/api/mesa-requests/[id]/dispatch.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    // NOTE: amount_php is intentionally NOT read from the body — it's read
    // authoritatively from the stored request row below. The client only
    // displays the amount in Mark Paid; it can't change it.
    const body = (await request.json()) as {
      recipient_email?: string;
      recipient_name?: string | null;
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

    // Kolan and Higlobe return no usable confirmation reference, so a transaction
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

    const actor = await getSessionActor();

    // ── Atomically CLAIM the request before creating any money log ──────────
    // Flip status pending→dispatched conditionally on it still being pending.
    // PostgREST returns only the rows the WHERE matched, so exactly one of two
    // racing/duplicate requests gets a row back — the other gets none and is
    // rejected. This closes the check-then-act window that would otherwise let
    // a double-click / retry insert two payment_dispatches rows for one payment.
    // We stamp dispatched_at now and backfill dispatch_id after the insert.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('urgent_payment_requests')
      .update({ status: 'dispatched', dispatched_at: claimedAt })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id, work_email, full_name, amount_php')
      .maybeSingle();

    if (claimErr) {
      return NextResponse.json({ error: claimErr.message }, { status: 500 });
    }
    if (!claimed) {
      // Either the row doesn't exist, or it wasn't pending (already dispatched /
      // cancelled / claimed by a concurrent Send). Distinguish for a clean error.
      const { data: exists } = await supabase
        .from('urgent_payment_requests')
        .select('status')
        .eq('id', id)
        .maybeSingle();
      if (!exists) return NextResponse.json({ error: 'Payment request not found' }, { status: 404 });
      return NextResponse.json({ error: 'Request already dispatched' }, { status: 409 });
    }

    const processor = KNOWN_PROCESSORS.has((body.processor ?? '').toLowerCase())
      ? (body.processor as string).toLowerCase()
      : 'wise';

    // Bucket into the Sun→Sat week it's being sent so it reconciles weekly.
    const week = sundayWeekRange(body.sent_date!);
    const cycleSourceFile = urgentCycleSourceFile(body.sent_date);

    // Amount is authoritative from the STORED request (set + validated at
    // creation by POST /api/people/pay), never the client body — the Mark Paid
    // dialog only displays it, so trusting the body would let a tampered/buggy
    // client write a wrong money figure.
    const amountPhp = claimed.amount_php ?? null;

    // Convert the PHP amount to USD via the active FX rate so the weekly report
    // totals (USD-centric) include it.
    let amountUsd: number | null = null;
    if (amountPhp != null) {
      const { data: fxData } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'usd_to_php_rate')
        .maybeSingle();
      const fx = parseFloat((fxData as { value?: string } | null)?.value ?? '0') || 0;
      if (fx > 0) amountUsd = Math.round((amountPhp / fx) * 100) / 100;
    }

    const { row: dispatch, error: dispatchErr } = await insertPaymentDispatch({
      // NULL, never a sentinel: cycle_id is `uuid REFERENCES hubstaff_uploads(id)`
      // and a one-off payment has no Hubstaff upload. Writing 'urgent' here is what
      // made every Send fail with `invalid input syntax for type uuid: "urgent"`.
      // The urgent marker is cycle_source_file — see @/lib/payroll/urgent-cycle.
      cycle_id: null,
      cycle_source_file: cycleSourceFile,
      cycle_period_start: week?.start ?? null,
      cycle_period_end: week?.end ?? null,
      recipient_email: body.recipient_email!,
      recipient_name: body.recipient_name ?? claimed.full_name ?? null,
      processor,
      amount_usd: amountUsd,
      amount_php: amountPhp,
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
      // Insert failed after we claimed the row — release the claim so the item
      // returns to the queue and can be retried (no money log was created).
      await supabase
        .from('urgent_payment_requests')
        .update({ status: 'pending', dispatched_at: null })
        .eq('id', id)
        .eq('status', 'dispatched');
      return NextResponse.json({ error: dispatchErr ?? 'Failed to create dispatch record' }, { status: 500 });
    }

    // Backfill the dispatch_id link (best-effort — the claim already committed
    // status='dispatched', so a failure here only leaves the link null).
    const { error: linkErr } = await supabase
      .from('urgent_payment_requests')
      .update({ dispatch_id: dispatch.id })
      .eq('id', id);

    if (linkErr) {
      void insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: 'urgent_payment.link_failed',
        resource: 'urgent_payment_requests',
        resource_id: id,
        details: { error: linkErr.message, dispatch_id: dispatch.id },
      });
    }

    // ── Notify the employee their one-off payment was sent ──────────────────
    // Best-effort + de-duped on (recipient, request id) so a re-run never
    // double-notifies; a failed notification never fails the payment.
    if ((body.status ?? 'paid') === 'paid') {
      void (async () => {
        try {
          const { data: existing } = await supabase
            .from('employee_notifications')
            .select('id')
            .eq('recipient_email', body.recipient_email!.trim().toLowerCase())
            .eq('type', 'special_transfer.recorded')
            .eq('details->>request_id', id)
            .limit(1);
          if (existing && existing.length > 0) return;

          const amountLabel =
            amountPhp != null
              ? `₱${Number(amountPhp).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
              : null;
          await supabase.from('employee_notifications').insert({
            recipient_email: body.recipient_email!.trim().toLowerCase(),
            type: 'special_transfer.recorded',
            tone: 'positive',
            title: 'Payment Sent',
            message: amountLabel
              ? `A one-off payment of ${amountLabel} has been sent to you.`
              : 'A one-off payment has been sent to you.',
            details: {
              request_id: id,
              amount_php: amountPhp,
              amount_usd: amountUsd,
              sent_date: body.sent_date,
              processor,
            },
          });
        } catch {
          /* best-effort — never block the payment record */
        }
      })();
    }

    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'urgent_payment.dispatched',
      resource: 'payment_dispatches',
      resource_id: dispatch.id,
      details: {
        request_id: id,
        recipient_email: body.recipient_email,
        amount_php: amountPhp,
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
