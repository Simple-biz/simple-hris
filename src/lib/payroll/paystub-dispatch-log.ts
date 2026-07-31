import type { PaymentDispatchRow, PaymentDispatchStatus } from "@/lib/supabase/payment-dispatches";

/**
 * One dispatch attempt logged against a (person, pay week), flattened for the
 * wire. Built from `payment_dispatches` rows by `buildPaystubDispatchLog` and
 * rendered under the statement in the accounting-side Pay Stub modal.
 *
 * This is ACCOUNTING-ONLY. The clerk's note is an internal remark ("bank
 * rejected, retrying Thursday", "under the payout minimum, rolls to next week"),
 * so `/api/employee/paystub` deliberately never returns it — only
 * `/api/accounting/paystub` does, and the modal renders the panel purely on
 * presence, so the employee self-serve view can't leak it.
 */
export interface PayStubDispatchEntry {
  id: string;
  status: PaymentDispatchStatus;
  /** Free-text remark the clerk attached in the Mark Paid dialog. */
  note: string | null;
  /** Date the clerk logged the money as sent (or would have). */
  sentDate: string | null;
  transactionId: string | null;
  bankUsed: string | null;
  processor: string | null;
  amountUsd: number | null;
  amountPhp: number | null;
  /** Clerk who logged it. */
  createdBy: string | null;
  createdAt: string | null;
}

/** Newest-first sort key: when the row was logged, else the date claimed on it. */
function loggedAt(row: PaymentDispatchRow): string {
  return row.created_at || row.sent_date || "";
}

/**
 * Every dispatch logged for one employee in one pay week, newest first.
 *
 * Scoped by `cycle_source_file` — the Hubstaff pay-week file the statement is
 * for — so an urgent one-off (which rides an `urgent_`-prefixed source file) and
 * neighbouring weeks can never bleed into this week's log.
 *
 * All four outcomes are kept, not just `paid`: accounting opens a stub precisely
 * to answer "why hasn't this gone out?", and Not Paid / Threshold / Problem are
 * exactly where that answer lives. Rows with no note are kept too — the status,
 * date and reference are the record even when the clerk typed nothing.
 *
 * `rows` may span every cycle for this person (the caller reads by email), so
 * filtering here rather than in the query keeps one round trip.
 */
export function buildPaystubDispatchLog(
  rows: PaymentDispatchRow[],
  sourceFile: string,
): PayStubDispatchEntry[] {
  return rows
    .filter((r) => r.cycle_source_file === sourceFile)
    .slice()
    .sort((a, b) => loggedAt(b).localeCompare(loggedAt(a)))
    .map((r) => ({
      id: r.id,
      status: r.status,
      note: r.note?.trim() || null,
      sentDate: r.sent_date ?? null,
      transactionId: r.transaction_id?.trim() || null,
      bankUsed: r.bank_used?.trim() || null,
      processor: r.processor ?? null,
      amountUsd: r.amount_usd ?? null,
      amountPhp: r.amount_php ?? null,
      createdBy: r.created_by ?? null,
      createdAt: r.created_at ?? null,
    }));
}

/**
 * The pay date to print on the statement: the `sent_date` of the dispatch that
 * actually moved money. Only a `paid` row counts — a Threshold / Not Paid /
 * Problem marker carries a date too, and reading it as the pay date would make
 * an unsent statement claim it was paid.
 */
export function paidSentDateFromLog(entries: PayStubDispatchEntry[]): string | null {
  return entries.find((e) => e.status === "paid")?.sentDate ?? null;
}
