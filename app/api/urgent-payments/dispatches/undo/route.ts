import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { deletePaymentDispatches, type PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { pulsePaymentsLive } from '@/lib/supabase/app-settings';
import { isUrgentSourceFile } from '@/lib/payroll/urgent-cycle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Which pending queue an undone urgent payout returns to. */
type UndoSource = 'oneoff' | 'mesa' | 'orphanage_budget' | 'unknown';

/**
 * POST /api/urgent-payments/dispatches/undo — body { id }.
 *
 * Undo ONE urgent payout from the bucket's dispatch-log views: remove the
 * money log and send the request back to the pending queue. The regular
 * /api/payment-dispatches/undo can't be reused here because urgent pending
 * items live in SOURCE REQUEST TABLES, not in a recomputed cycle queue —
 * deleting the dispatch row alone would leave the request stamped dispatched
 * forever, i.e. money neither paid nor payable anywhere. Per source:
 *
 *   • One-off  — `urgent_payment_requests.dispatch_id` links straight back;
 *     flip the request pending again, then delete the dispatch row.
 *   • MESA     — `mesa_requests` has no dispatch link column, so the request is
 *     found via the `mesa.disbursement.dispatched` audit event (written with the
 *     dispatch id at Send time), falling back to an exact
 *     email+amount+dispatched match. Then clear `dispatched_at` and delete.
 *   • Orphanage budget — the "dispatch" IS the `orphanage_dispatches` row
 *     (the urgent view synthesizes it); pending is derived as "approved budget
 *     request with no dispatch row", so deleting the row revives it by itself.
 *
 * Order matters: the request is revived BEFORE the dispatch row is deleted, and
 * the revive is a conditional no-op on retry — so if the delete fails, the row
 * is still visible in the log views and clicking Undo again just retries the
 * delete. The reverse order would strand an invisible not-pending-not-paid
 * payment, this codebase's favorite landmine.
 *
 * Mirrors /api/payment-dispatches/undo's audit contract: the deleted row's full
 * payload goes into a `payment.undone` event (built from the DELETE's own
 * RETURNING row), awaited before responding.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let id = '';
  try {
    const body = (await req.json()) as { id?: unknown };
    if (typeof body.id === 'string') id = body.id.trim();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    const sessionActor = await getSessionActor();
    actor = { user_name: sessionActor.user_name, user_role: sessionActor.user_role };
  } catch {
    /* audit trail is best-effort */
  }

  try {
    // ── Real payment_dispatches row? (MESA disbursement or one-off) ──────────
    const { data: pd } = await supabase
      .from('payment_dispatches')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (pd) {
      const row = pd as PaymentDispatchRow;
      if (!isUrgentSourceFile(row.cycle_source_file)) {
        // A weekly-cycle payment — its pending queue is recomputed, so it must
        // go through the regular undo (Done tab / processor Paid view).
        return NextResponse.json(
          { error: 'Not an urgent payment — undo it from its processor queue instead' },
          { status: 400 },
        );
      }

      // 1. Identify + revive the source request (idempotent).
      let source: UndoSource = 'unknown';
      let revived = false;
      let warning: string | null = null;

      const { data: oneOff } = await supabase
        .from('urgent_payment_requests')
        .select('id, status')
        .eq('dispatch_id', id)
        .maybeSingle();

      if (oneOff) {
        source = 'oneoff';
        // dispatch_id is kept as a breadcrumb so a retried Undo (after a failed
        // delete below) can still find this request; the next Send overwrites it.
        const { error: reviveErr } = await supabase
          .from('urgent_payment_requests')
          .update({ status: 'pending', dispatched_at: null })
          .eq('id', (oneOff as { id: string }).id)
          .eq('status', 'dispatched');
        if (reviveErr) {
          return NextResponse.json(
            { error: `Could not return the request to pending: ${reviveErr.message}` },
            { status: 500 },
          );
        }
        revived = true;
      } else {
        // MESA: the Send route stamps only dispatched_at, so recover the request
        // id from the audit event written alongside the dispatch insert…
        let mesaRequestId: string | null = null;
        const { data: auditRows } = await supabase
          .from('audit_log')
          .select('details')
          .eq('action', 'mesa.disbursement.dispatched')
          .eq('resource_id', id)
          .limit(1);
        const auditDetails = auditRows?.[0]?.details as { mesa_request_id?: string } | undefined;
        if (auditDetails?.mesa_request_id) {
          mesaRequestId = auditDetails.mesa_request_id;
        } else if (row.amount_php != null) {
          // …falling back to an exact match — accepted ONLY when unambiguous.
          const { data: matches } = await supabase
            .from('mesa_requests')
            .select('id')
            .eq('request_type', 'disbursement')
            .eq('status', 'approved')
            .eq('work_email', row.recipient_email)
            .eq('amount_needed', row.amount_php)
            .not('dispatched_at', 'is', null);
          if (matches && matches.length === 1) mesaRequestId = (matches[0] as { id: string }).id;
        }

        if (mesaRequestId) {
          source = 'mesa';
          const { error: reviveErr } = await supabase
            .from('mesa_requests')
            .update({ dispatched_at: null })
            .eq('id', mesaRequestId);
          if (reviveErr) {
            return NextResponse.json(
              { error: `Could not return the MESA request to pending: ${reviveErr.message}` },
              { status: 500 },
            );
          }
          revived = true;
        } else {
          // No linked request found (legacy row, or the audit write was lost AND
          // the fallback was ambiguous). Still remove the money log — that's the
          // undo's primary meaning — but say plainly that nothing was revived.
          warning =
            'Payment log removed, but no matching pending request was found to restore — re-file it if it should still be paid.';
        }
      }

      // 2. Delete the money log. RETURNING feeds the audit payload.
      const { deletedRows, error: delErr } = await deletePaymentDispatches([id]);
      if (delErr) {
        return NextResponse.json(
          {
            error: revived
              ? `Request returned to pending, but the payment log could not be removed (${delErr}). Click Undo again to retry.`
              : delErr,
          },
          { status: 500 },
        );
      }
      const deleted = deletedRows[0] ?? row;

      // Awaited: this event is the sole surviving record of the deleted row.
      await insertAuditLog({
        user_name: actor.user_name,
        user_role: actor.user_role,
        action: 'payment.undone',
        resource: 'payment_dispatches',
        resource_id: id,
        details: {
          recipient_email: deleted.recipient_email,
          recipient_name: deleted.recipient_name,
          processor: deleted.processor,
          amount_usd: deleted.amount_usd,
          amount_php: deleted.amount_php,
          amount_cop: deleted.amount_cop,
          transaction_id: deleted.transaction_id,
          bank_used: deleted.bank_used,
          sent_date: deleted.sent_date,
          original_status: deleted.status,
          note: deleted.note,
          originally_paid_by: deleted.created_by,
          originally_paid_at: deleted.created_at,
          urgent_undo: { source, revived, warning },
          cycle: {
            cycle_id: deleted.cycle_id,
            source_file: deleted.cycle_source_file ?? null,
            period_start: deleted.cycle_period_start ?? null,
            period_end: deleted.cycle_period_end ?? null,
            fx_rate:
              deleted.amount_php && deleted.amount_usd
                ? Number((Number(deleted.amount_php) / Number(deleted.amount_usd)).toFixed(4))
                : null,
          },
        },
      });

      void pulsePaymentsLive();
      return NextResponse.json({ undone: true, source, revived, warning, error: null });
    }

    // ── Synthetic orphanage-budget row: the dispatch IS orphanage_dispatches ──
    // Pending is derived (approved budget request with no dispatch row), so the
    // delete alone puts the request back in the queue.
    const { data: orphDeleted, error: orphErr } = await supabase
      .from('orphanage_dispatches')
      .delete()
      .eq('id', id)
      .eq('dispatch_type', 'budget_request')
      .select('id, label, submitter_email, amount_php, status, transaction_id, bank_used, sent_date, note, paid_by, created_at');

    if (orphErr) return NextResponse.json({ error: orphErr.message }, { status: 500 });
    if (!orphDeleted || orphDeleted.length === 0) {
      return NextResponse.json({ error: 'Payment not found — it may already be undone' }, { status: 404 });
    }

    const orph = orphDeleted[0] as {
      id: string;
      label: string | null;
      submitter_email: string;
      amount_php: number | string | null;
      status: string;
      transaction_id: string | null;
      bank_used: string | null;
      sent_date: string | null;
      note: string | null;
      paid_by: string | null;
      created_at: string;
    };
    await insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'payment.undone',
      resource: 'orphanage_dispatches',
      resource_id: id,
      details: {
        label: orph.label,
        submitter_email: orph.submitter_email,
        amount_php: orph.amount_php,
        transaction_id: orph.transaction_id,
        bank_used: orph.bank_used,
        sent_date: orph.sent_date,
        original_status: orph.status,
        note: orph.note,
        originally_paid_by: orph.paid_by,
        urgent_undo: { source: 'orphanage_budget' satisfies UndoSource, revived: true, warning: null },
      },
    });

    void pulsePaymentsLive();
    return NextResponse.json({ undone: true, source: 'orphanage_budget', revived: true, warning: null, error: null });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
