import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  insertPaymentDispatch,
  listPaymentDispatches,
  type InsertPaymentDispatchInput,
} from "@/lib/supabase/payment-dispatches";
import {
  refreshPaystubQueuePayload,
  markPaystubSent,
  markPaystubSendError,
} from "@/lib/supabase/paystub-dispatch-queue";
import { getFreshPaystubEntry } from "@/lib/payroll/paystub-fresh";
import { forwardPaystubDispatch } from "@/lib/payroll/paystub-dispatch";
import { mapPayloadToPayStub } from "@/lib/payroll/paystub-view";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/server";
import { insertAuditLog } from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { requireFeatureEdit, requireRateVisibilityOrFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { pulsePaymentsLive } from "@/lib/supabase/app-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PostBody extends Omit<InsertPaymentDispatchInput, "created_by"> {}

export async function GET(req: NextRequest) {
  // Dispatch rows carry snapshotted recipient banking + amounts. Reading them
  // requires rate visibility (admin / accounting / ceo) OR an admin-granted Edit
  // on Payment Dispatch — the SAME gate as the other dispatch-queue reads
  // (current-pay, current-cycle), so a feature-edit user who can load the queue
  // can also see who's already paid (otherwise paid rows would reappear as
  // pending and risk a double-pay).
  const authz = await requireRateVisibilityOrFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);

  const cycleIdRaw = req.nextUrl.searchParams.get("cycle_id");
  const cycleId = cycleIdRaw === "" ? undefined : cycleIdRaw ?? undefined;
  const emailRaw = req.nextUrl.searchParams.get("email");
  const recipientEmail = emailRaw?.trim() ? emailRaw.trim() : undefined;
  const { rows, error } = await listPaymentDispatches({ cycleId, recipientEmail });
  return NextResponse.json({ rows, error });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit("accounting", "payment_dispatch");
  if (!authz.ok) return deniedResponse(authz);
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ row: null, error: "Invalid JSON body" }, { status: 400 });
  }

  // Required field guards.
  const required: Array<keyof PostBody> = [
    "recipient_email",
    "processor",
    "transaction_id",
    "bank_used",
    "sent_date",
  ];
  for (const k of required) {
    if (!body[k] || (typeof body[k] === "string" && !String(body[k]).trim())) {
      return NextResponse.json(
        { row: null, error: `Missing required field: ${k}` },
        { status: 400 },
      );
    }
  }

  // ── Contractor payee validation ────────────────────────────────────────────
  // A contractor dispatch settles exactly one approved invoice, so it must name
  // it. Neither field joins the `required` list above — an employee payment must
  // keep working with a body that has never heard of them.
  const payeeType = body.payee_type === 'contractor' ? 'contractor' : 'employee';
  const contractorInvoiceId =
    typeof body.contractor_invoice_id === 'string' && body.contractor_invoice_id.trim()
      ? body.contractor_invoice_id.trim()
      : null;
  if (payeeType === 'contractor' && !contractorInvoiceId) {
    return NextResponse.json(
      { row: null, error: 'contractor_invoice_id is required when payee_type is contractor' },
      { status: 400 },
    );
  }
  if (payeeType === 'employee' && contractorInvoiceId) {
    return NextResponse.json(
      { row: null, error: 'contractor_invoice_id requires payee_type "contractor"' },
      { status: 400 },
    );
  }

  // Identify the operator for audit trail.
  let createdBy: string | null = null;
  let createdByRole = 'user';
  try {
    const sessionActor = await getSessionActor();
    createdBy = sessionActor.user_name !== 'anonymous' ? sessionActor.user_name : null;
    createdByRole = sessionActor.user_role;
  } catch {
    /* ignore — audit trail is best-effort */
  }

  // ── CLAIM BEFORE MONEY ─────────────────────────────────────────────────────
  // Stamp dispatch_claimed_at first, conditional on the invoice still being
  // approved AND unclaimed. Two clerks clicking Mark Paid at once therefore
  // produce one 200 and one 409, and no dispatch row is written for the loser.
  // Mirrors the retract race guard in /api/contractor/invoices.
  //
  // Only a 'paid' outcome claims: a 'problem' / 'not_paid' / 'threshold' attempt
  // is a log entry, not a settlement, so the invoice must stay payable for the
  // retry. (The partial unique index is scoped to status='paid' for the same
  // reason.)
  const claimsInvoice = payeeType === 'contractor' && (body.status ?? 'paid') === 'paid';
  let invoiceNumberForNote: string | null = null;
  if (claimsInvoice && contractorInvoiceId) {
    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ row: null, error: 'Supabase client unavailable' }, { status: 500 });
    }
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('contractor_invoices')
      .update({ dispatch_claimed_at: nowIso, last_dispatched_at: nowIso })
      .eq('id', contractorInvoiceId)
      .eq('status', 'approved')
      .is('dispatch_id', null)
      .is('dispatch_claimed_at', null)
      .select('id, invoice_number');
    if (claimErr) {
      return NextResponse.json({ row: null, error: `Could not claim invoice: ${claimErr.message}` }, { status: 500 });
    }
    if (!claimed || claimed.length === 0) {
      return NextResponse.json(
        {
          row: null,
          error:
            'This invoice was already dispatched (or is no longer approved). Refresh the queue — no payment was logged.',
        },
        { status: 409 },
      );
    }
    invoiceNumberForNote = (claimed[0] as { invoice_number?: string | null }).invoice_number ?? null;
  } else if (payeeType === 'contractor' && contractorInvoiceId) {
    // Non-settling attempt (problem / not_paid / threshold): the id is deliberately
    // NOT persisted on the row, so the note is the only trace of which invoice this
    // attempt was for. Best-effort.
    const supabase = createSupabaseServiceRoleClient();
    const { data } = (await supabase
      ?.from('contractor_invoices')
      .select('invoice_number')
      .eq('id', contractorInvoiceId)
      .maybeSingle()) ?? { data: null };
    invoiceNumberForNote = (data as { invoice_number?: string | null } | null)?.invoice_number ?? null;
  }

  const noteWithInvoice = invoiceNumberForNote
    ? [body.note?.trim() || null, `Contractor invoice: ${invoiceNumberForNote}`].filter(Boolean).join(' · ')
    : body.note;

  const { row, error } = await insertPaymentDispatch({
    ...body,
    note: noteWithInvoice ?? null,
    payee_type: payeeType,
    // Only the row that actually CLAIMED the invoice stores its id. A
    // 'problem'/'not_paid'/'threshold' attempt deliberately leaves the invoice
    // payable, so if it also carried the id, deleting that retry marker later
    // would trip the release trigger's fallback branch and un-settle an invoice
    // the successful retry had already paid. The invoice number stays in `note`
    // for traceability on those attempts.
    contractor_invoice_id: claimsInvoice ? contractorInvoiceId : null,
    created_by: createdBy,
  });
  if (error || !row) {
    // Release the claim — no money was recorded, so the invoice must stay payable.
    if (claimsInvoice && contractorInvoiceId) {
      const supabase = createSupabaseServiceRoleClient();
      await supabase
        ?.from('contractor_invoices')
        .update({ dispatch_claimed_at: null })
        .eq('id', contractorInvoiceId);
    }
    return NextResponse.json({ row: null, error: error ?? "Insert failed" }, { status: 500 });
  }

  // Settle: link the invoice to the dispatch row that paid it. The AFTER DELETE
  // trigger clears both this and dispatch_claimed_at if the payment is undone.
  if (claimsInvoice && contractorInvoiceId) {
    const supabase = createSupabaseServiceRoleClient();
    const { error: linkErr } = (await supabase
      ?.from('contractor_invoices')
      .update({ dispatch_id: row.id })
      .eq('id', contractorInvoiceId)) ?? { error: null };
    if (linkErr) {
      // The money IS recorded, so never fail the request here — but the invoice
      // would stay claimed-but-unlinked, which the queue already treats as not
      // payable. Log loudly so it can be reconciled.
      console.error('[payment-dispatches] invoice settled but dispatch_id link failed', {
        contractorInvoiceId,
        dispatchId: row.id,
        error: linkErr.message,
      });
    }
  }

  // Nudge the CEO live "payments to send" counter to refetch (via app_settings
  // Realtime — reliably reaches the browser, unlike payment_dispatches).
  void pulsePaymentsLive();

  void insertAuditLog({
    user_name: createdBy ?? "unknown",
    user_role: createdByRole,
    action: "payment.dispatched",
    resource: "payment_dispatches",
    resource_id: row.id,
    details: {
      recipient_email: row.recipient_email,
      recipient_name: row.recipient_name,
      processor: row.processor,
      amount_usd: row.amount_usd,
      amount_php: row.amount_php,
      amount_cop: row.amount_cop,
      transaction_id: row.transaction_id,
      bank_used: row.bank_used,
      sent_date: row.sent_date,
      status: row.status,
      payee_type: payeeType,
      contractor_invoice_id: contractorInvoiceId,
      invoice_number: invoiceNumberForNote,
      cycle: {
        cycle_id: row.cycle_id,
        source_file: row.cycle_source_file ?? null,
        period_start: row.cycle_period_start ?? null,
        period_end: row.cycle_period_end ?? null,
        fx_rate:
          row.amount_php && row.amount_usd
            ? Number((Number(row.amount_php) / Number(row.amount_usd)).toFixed(4))
            : null,
      },
    },
  });

  // ── Per-employee paystub send ──────────────────────────────────────────────
  // When this dispatch lands as 'paid' and the Payroll Wizard staged an
  // authoritative paystub for this (cycle, employee), fire the n8n paystub
  // webhook for JUST this person. Best-effort: a failed send never fails the
  // payment record (the money already moved) — it's stamped on the queue row so
  // it can be re-sent from the Excluded tab. MESA disbursements + orphanage
  // budgets go through their own routes, so they never reach this send path.
  const paystub: {
    staged: boolean;
    sent: boolean;
    error: string | null;
    /** Set when the emailed stub's total does not match the recorded payment
     *  amount (and the staged payload didn't match either) — surfaced to the
     *  dispatch UI as a warning and stamped into the audit log. */
    amount_mismatch?: { paid: number; stub: number };
  } = {
    staged: false,
    sent: false,
    error: null,
  };
  // Contractor rows are excluded: an invoice payment has no staged paystub, and
  // pushing one would email an employee-shaped statement, fire a false "Salary
  // Paid" notification, and raise a bogus amount-mismatch warning against the
  // ₱0 staged rows that Claire/Carla carry from their employee identities.
  if (row.status === "paid" && row.cycle_source_file && payeeType !== 'contractor') {
    try {
      // Freshest truth for this (cycle, employee): the staged payload with any
      // NEWER wizard-snapshot figures merged over it. The wizard keeps
      // recomputing after the lock (an additions edit in another session, a rate
      // change) and Payment Dispatch prices from that snapshot — so the stub we
      // email must come from the same source, or it can contradict the money
      // this very row just recorded (2026-07-21: two understated stubs).
      const fresh = await getFreshPaystubEntry(row.cycle_source_file, row.recipient_email);
      const staged = fresh.staged;
      if (staged && fresh.payload) {
        paystub.staged = true;

        // ── Reconcile the stub against the MONEY this request just recorded ──
        // The paid amount was priced when the dispatcher's queue loaded; the
        // merged payload reflects the wizard snapshot at pay time. When they
        // disagree (a wizard edit raced this payment), the statement must
        // describe the money that actually moved: fall back to the staged
        // payload if THAT is what was paid, and flag the row when neither
        // figure matches so accounting can investigate before any re-send.
        const paidAmount = row.amount_php != null ? Number(row.amount_php) : null;
        let stubPayload = fresh.payload;
        let stubPeriod = fresh.payPeriod;
        let view = mapPayloadToPayStub(stubPayload, stubPeriod);
        let doRefresh = fresh.refreshed;
        // Runs whether or not the merge changed anything: even a no-op merge can
        // sit beside a payment priced from a failed/stale queue load, and that
        // discrepancy must be flagged too.
        if (
          paidAmount != null &&
          Number.isFinite(paidAmount) &&
          Math.abs(view.totalPayPhp - paidAmount) >= 0.01
        ) {
          const stagedView = mapPayloadToPayStub(staged.payload, staged.pay_period);
          if (Math.abs(stagedView.totalPayPhp - paidAmount) < 0.01) {
            stubPayload = staged.payload!;
            stubPeriod = staged.pay_period;
            view = stagedView;
            doRefresh = false;
          } else {
            // Neither the merged nor the staged total matches the payment —
            // send the freshest figures but surface the discrepancy.
            paystub.amount_mismatch = { paid: paidAmount, stub: view.totalPayPhp };
          }
        }

        // Persist the chosen figures onto the queue row FIRST, so the accounting
        // stub viewer, the employee Pay Stubs tab, and any later re-send all read
        // exactly what this payment used. Best-effort: a failed write never
        // blocks the email (the payload in hand is still the fresh one).
        if (doRefresh) {
          await refreshPaystubQueuePayload({
            sourceFile: row.cycle_source_file,
            recipientEmail: row.recipient_email,
            payload: stubPayload,
            payPeriod: stubPeriod,
            amountPhp: view.totalPayPhp,
            amountUsd: view.totalPayUsd,
          });
        }

        // Notify the employee their pay landed. The card's "Open Pay Stub"
        // button opens the exact statement we email, so we only fire this when a
        // renderable paystub is staged. Best-effort + de-duped on
        // (recipient, source_file) so an undo→re-pay doesn't double-notify; a
        // failed notification never fails the payment.
        void (async () => {
          try {
            const sb = createSupabaseServiceRoleClient();
            if (!sb) return;
            const { data: existing } = await sb
              .from("employee_notifications")
              .select("id")
              .eq("recipient_email", row.recipient_email)
              .eq("type", "payroll.paid")
              .eq("details->>source_file", row.cycle_source_file as string)
              .limit(1);
            if (existing && existing.length > 0) return;

            const amountLabel =
              row.amount_php != null
                ? `₱${Number(row.amount_php).toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`
                : null;
            const weekPhrase = view.weekHuman ? ` for ${view.weekHuman}` : "";
            await sb.from("employee_notifications").insert({
              recipient_email: row.recipient_email,
              type: "payroll.paid",
              tone: "positive",
              title: "Salary Paid",
              message: amountLabel
                ? `Your pay${weekPhrase} has been sent — ${amountLabel}. Open your pay stub for the full breakdown.`
                : `Your pay${weekPhrase} has been sent. Open your pay stub for the full breakdown.`,
              details: {
                source_file: row.cycle_source_file,
                amount_php: row.amount_php,
                amount_usd: row.amount_usd,
                sent_date: row.sent_date,
                week: view.weekStart && view.weekEnd
                  ? { start: view.weekStart, end: view.weekEnd }
                  : null,
              },
            });
          } catch {
            /* best-effort — never block the payment record */
          }
        })();

        const result = await forwardPaystubDispatch({
          pay_period: stubPeriod,
          employees: [stubPayload],
          cycle: {
            source_file: row.cycle_source_file,
            period_start: row.cycle_period_start ?? null,
            period_end: row.cycle_period_end ?? null,
            cycle_id: row.cycle_id ?? null,
          },
        });
        // HTTP 200 alone is NOT delivery: the n8n workflow folds Gmail failures
        // into its summary response (error branch → Log Failed Sends → loop
        // continues → Respond 200 with { succeeded, failed, failed_emails }).
        // For this single-recipient send, a failed > 0 summary means the email
        // did NOT go out (e.g. Gmail 429 rate-limiting) — record it as a failed
        // send so the row keeps last_error and can be re-sent. Summaries from
        // older workflow versions without these fields fall back to HTTP ok.
        const summary =
          result.parsed && typeof result.parsed === "object"
            ? (result.parsed as { succeeded?: unknown; failed?: unknown; failed_emails?: unknown })
            : null;
        const summaryFailed = typeof summary?.failed === "number" ? summary.failed : 0;
        const delivered = result.ok && summaryFailed === 0;
        if (delivered) {
          paystub.sent = true;
          await markPaystubSent({
            sourceFile: row.cycle_source_file,
            recipientEmail: row.recipient_email,
            sentBy: createdBy,
            sendCount: (staged.send_count ?? 0) + 1,
          });
        } else {
          let failDetail = result.detail ?? "Paystub send failed";
          if (result.ok) {
            // Pull the Gmail error message out of the summary's failed_emails.
            failDetail = "Email send failed inside the paystub workflow";
            try {
              const raw = summary?.failed_emails;
              const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
              const first = Array.isArray(arr) ? (arr[0] as { error?: unknown } | undefined) : undefined;
              if (first?.error) failDetail = String(first.error);
            } catch {
              /* keep the generic detail */
            }
          }
          paystub.error = failDetail;
          await markPaystubSendError({
            sourceFile: row.cycle_source_file,
            recipientEmail: row.recipient_email,
            error: paystub.error,
          });
        }
        void insertAuditLog({
          user_name: createdBy ?? "unknown",
          user_role: createdByRole,
          action: delivered ? "paystub.sent" : "paystub.send_failed",
          resource: "paystub_dispatch_queue",
          resource_id: row.id,
          details: {
            recipient_email: row.recipient_email,
            source_file: row.cycle_source_file,
            http_status: result.status,
            error: delivered ? undefined : paystub.error,
            // Reconciliation trail: what the stub said vs what the payment row
            // recorded, and whether the queue row was refreshed from the
            // wizard snapshot before sending.
            stub_total_php: view.totalPayPhp,
            amount_php_paid: paidAmount ?? undefined,
            refreshed_from_snapshot: doRefresh || undefined,
            amount_mismatch: paystub.amount_mismatch ? true : undefined,
          },
        });
      } else if (staged) {
        // Staged but no resolvable personal email → nothing to mail.
        paystub.staged = true;
      }
    } catch (e) {
      paystub.error = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({ row, error: null, paystub });
}
