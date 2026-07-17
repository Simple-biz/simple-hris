import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  insertPaymentDispatch,
  listPaymentDispatches,
  type InsertPaymentDispatchInput,
} from "@/lib/supabase/payment-dispatches";
import {
  getPaystubDispatchEntry,
  markPaystubSent,
  markPaystubSendError,
} from "@/lib/supabase/paystub-dispatch-queue";
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

  const { row, error } = await insertPaymentDispatch({ ...body, created_by: createdBy });
  if (error || !row) {
    return NextResponse.json({ row: null, error: error ?? "Insert failed" }, { status: 500 });
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
  const paystub: { staged: boolean; sent: boolean; error: string | null } = {
    staged: false,
    sent: false,
    error: null,
  };
  if (row.status === "paid" && row.cycle_source_file) {
    try {
      const { row: staged } = await getPaystubDispatchEntry(
        row.cycle_source_file,
        row.recipient_email,
      );
      if (staged?.payload) {
        paystub.staged = true;

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

            const view = mapPayloadToPayStub(staged.payload, staged.pay_period);
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
          pay_period: staged.pay_period,
          employees: [staged.payload],
          cycle: {
            source_file: row.cycle_source_file,
            period_start: row.cycle_period_start ?? null,
            period_end: row.cycle_period_end ?? null,
            cycle_id: row.cycle_id ?? null,
          },
        });
        if (result.ok) {
          paystub.sent = true;
          await markPaystubSent({
            sourceFile: row.cycle_source_file,
            recipientEmail: row.recipient_email,
            sentBy: createdBy,
            sendCount: (staged.send_count ?? 0) + 1,
          });
        } else {
          paystub.error = result.detail ?? "Paystub send failed";
          await markPaystubSendError({
            sourceFile: row.cycle_source_file,
            recipientEmail: row.recipient_email,
            error: paystub.error,
          });
        }
        void insertAuditLog({
          user_name: createdBy ?? "unknown",
          user_role: createdByRole,
          action: result.ok ? "paystub.sent" : "paystub.send_failed",
          resource: "paystub_dispatch_queue",
          resource_id: row.id,
          details: {
            recipient_email: row.recipient_email,
            source_file: row.cycle_source_file,
            http_status: result.status,
            error: result.ok ? undefined : paystub.error,
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
