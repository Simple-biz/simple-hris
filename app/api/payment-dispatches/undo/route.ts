import { NextRequest, NextResponse } from "next/server";
import { deletePaymentDispatches } from "@/lib/supabase/payment-dispatches";
import {
  insertAuditLog,
  insertAuditLogs,
  type NewAuditLog,
} from "@/lib/supabase/audit-log";
import { getSessionActor } from "@/lib/auth/session-actor";
import { requireFeatureEdit } from "@/lib/auth/authorize-feature";
import { deniedResponse } from "@/lib/auth/authorize-email";
import { pulsePaymentsLive } from "@/lib/supabase/app-settings";
import { broadcastFromServer } from "@/lib/supabase/realtime-broadcast";
import { DISPATCH_SYNC_QUEUE_CHANGED, DISPATCH_SYNC_TOPIC } from "@/lib/payroll/dispatch-paid-toast";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Body {
  ids?: unknown;
}

/**
 * "Send back to the pay processor" — undo one or more logged payments by
 * deleting their payment_dispatches rows. The recipient drops out of paid and
 * reappears in the pending queue; the disbursement_records sync trigger flips
 * the matching record back to pending.
 *
 * The delete destroys the only copy of who was paid and for how much, so one
 * `payment.undone` audit event is written per undone payment carrying the full
 * payload (recipient, amounts, processor, cycle, who originally paid) —
 * mirroring `payment.dispatched` granularity. The payload is built from the
 * DELETE's own RETURNING rows, so it can never race a separate snapshot read.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ deleted: 0, error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ deleted: 0, error: "No dispatch ids provided" }, { status: 400 });
  }

  let actor: string | null = null;
  let actorRole = "user";
  try {
    const sessionActor = await getSessionActor();
    actor = sessionActor.user_name !== "anonymous" ? sessionActor.user_name : null;
    actorRole = sessionActor.user_role;
  } catch {
    /* ignore - audit trail is best-effort */
  }

  let deleted = 0;
  let deletedRows: Awaited<ReturnType<typeof deletePaymentDispatches>>["deletedRows"] = [];
  let deleteError: string | null = null;
  try {
    const result = await deletePaymentDispatches(ids);
    deleted = result.deleted;
    deletedRows = result.deletedRows;
    deleteError = result.error;
    if (result.error) {
      console.error("[payment-dispatches/undo] delete returned error", result.error);
    }
  } catch (e) {
    deleteError = e instanceof Error ? e.message : String(e);
    console.error("[payment-dispatches/undo] unexpected error", e);
  }

  // ── Audit — one event per payment actually undone ──────────────────────────
  // Written even when a later batch failed: whatever WAS deleted must be on the
  // record. The `batch` block ties the per-row events of one multi-select
  // together; `original_status` (not `status`) so trail renderers don't read
  // the undone row's outcome as this event's outcome.
  //
  // AWAITED, unlike the usual fire-and-forget audit writes: these events are
  // the sole surviving record of the deleted rows, so the response must not
  // return (and on serverless, the function must not freeze) before they land.
  // A bulk failure falls back to per-row inserts so one bad entry can't lose
  // the whole batch.
  if (deletedRows.length > 0) {
    const entries: NewAuditLog[] = deletedRows.map((row) => ({
      user_name: actor ?? "unknown",
      user_role: actorRole,
      action: "payment.undone",
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
        original_status: row.status,
        note: row.note,
        payee_type: row.payee_type ?? "employee",
        contractor_invoice_id: row.contractor_invoice_id,
        originally_paid_by: row.created_by,
        originally_paid_at: row.created_at,
        batch: { requested: ids.length, deleted: deletedRows.length },
        // Same shape as payment.dispatched so the cycle audit trail
        // (details->cycle->>source_file) picks these events up too.
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
    }));
    const { error: auditErr } = await insertAuditLogs(entries);
    if (auditErr) {
      console.error(
        "[payment-dispatches/undo] bulk audit insert failed — retrying per row",
        auditErr,
      );
      for (const entry of entries) {
        const { error: rowErr } = await insertAuditLog(entry);
        if (rowErr) {
          console.error(
            "[payment-dispatches/undo] audit insert failed for dispatch",
            entry.resource_id,
            rowErr,
          );
        }
      }
    }

    // Nudge the CEO live "payments to send" counter to refetch (count goes back up).
    void pulsePaymentsLive();
    // Push the change to every open Payment Dispatch table now (server-side
    // Broadcast — the only push that reaches the anon browser). One message per
    // cycle touched; the queue ignores cycles it isn't showing. Never a toast:
    // an Undo is a delete, not a payment.
    const touched = new Set(deletedRows.map((r) => r.cycle_source_file ?? null));
    for (const sourceFile of touched) {
      void broadcastFromServer(DISPATCH_SYNC_TOPIC, DISPATCH_SYNC_QUEUE_CHANGED, {
        sourceFile,
        ts: Date.now(),
      });
    }
  } else if (!deleteError) {
    // No-op undo — the rows were already gone (concurrent clerk, stale UI,
    // replayed request). Still leave a trace of who attempted it and against
    // which ids, so a disputed disappearance shows every actor involved.
    const { error: auditErr } = await insertAuditLog({
      user_name: actor ?? "unknown",
      user_role: actorRole,
      action: "payment.undone",
      resource: "payment_dispatches",
      resource_id: ids.join(","),
      details: { count: 0, ids, no_rows_deleted: true },
    });
    if (auditErr) {
      console.error("[payment-dispatches/undo] no-op audit insert failed", auditErr);
    }
  }

  if (deleteError) {
    return NextResponse.json({ deleted, error: deleteError }, { status: 500 });
  }
  return NextResponse.json({ deleted, error: null });
}
