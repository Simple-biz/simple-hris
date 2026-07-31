import test from "node:test";
import assert from "node:assert/strict";
import { buildPaystubDispatchLog, paidSentDateFromLog } from "./paystub-dispatch-log";
import type { PaymentDispatchRow, PaymentDispatchStatus } from "@/lib/supabase/payment-dispatches";

const WEEK = "Hubstaff_2026-07-19.csv";

function row(over: Partial<PaymentDispatchRow> & { id: string }): PaymentDispatchRow {
  return {
    cycle_id: "cycle-1",
    cycle_period_start: "2026-07-13",
    cycle_period_end: "2026-07-19",
    cycle_source_file: WEEK,
    recipient_email: "juan@simple.biz",
    recipient_name: "Juan Cruz",
    processor: "hurupay",
    bank_preferred_raw: null,
    recipient_preferred_bank: null,
    recipient_account_number: null,
    recipient_account_holder: null,
    recipient_swift_code: null,
    amount_usd: 120,
    amount_php: 6800,
    amount_cop: null,
    transaction_id: "",
    bank_used: "",
    sent_date: "2026-07-21",
    arrival_date: null,
    status: "paid" as PaymentDispatchStatus,
    note: null,
    payee_type: "employee",
    contractor_invoice_id: null,
    created_by: "lennyt@simple.biz",
    created_at: "2026-07-21T02:00:00.000Z",
    ...over,
  };
}

test("keeps every outcome for the week, newest first, with the clerk note", () => {
  const log = buildPaystubDispatchLog(
    [
      row({
        id: "a",
        status: "threshold",
        note: "  under the ₱7k minimum — rolls to next week  ",
        created_at: "2026-07-21T02:00:00.000Z",
      }),
      row({
        id: "b",
        status: "not_paid",
        note: "bank rejected",
        created_at: "2026-07-22T09:00:00.000Z",
      }),
    ],
    WEEK,
  );

  assert.deepEqual(
    log.map((e) => e.id),
    ["b", "a"],
  );
  assert.equal(log[0].status, "not_paid");
  // Trimmed, never dropped.
  assert.equal(log[1].note, "under the ₱7k minimum — rolls to next week");
});

test("scopes to the requested pay week — other cycles and urgent one-offs stay out", () => {
  const log = buildPaystubDispatchLog(
    [
      row({ id: "this-week" }),
      row({ id: "last-week", cycle_source_file: "Hubstaff_2026-07-12.csv" }),
      row({ id: "urgent", cycle_source_file: `urgent_${WEEK}`, cycle_id: null }),
      row({ id: "no-cycle", cycle_source_file: null }),
    ],
    WEEK,
  );

  assert.deepEqual(
    log.map((e) => e.id),
    ["this-week"],
  );
});

test("blank reference / bank collapse to null so the modal can skip the meta line", () => {
  const [entry] = buildPaystubDispatchLog(
    [row({ id: "a", transaction_id: "   ", bank_used: "", note: "   " })],
    WEEK,
  );
  assert.equal(entry.transactionId, null);
  assert.equal(entry.bankUsed, null);
  assert.equal(entry.note, null);
});

test("pay date comes only from a paid row — a Threshold marker's date never counts", () => {
  const held = buildPaystubDispatchLog(
    [row({ id: "a", status: "threshold", sent_date: "2026-07-21" })],
    WEEK,
  );
  assert.equal(paidSentDateFromLog(held), null);

  const paid = buildPaystubDispatchLog(
    [
      row({ id: "a", status: "threshold", sent_date: "2026-07-21", created_at: "2026-07-21T02:00:00.000Z" }),
      row({ id: "b", status: "paid", sent_date: "2026-07-23", created_at: "2026-07-23T02:00:00.000Z" }),
    ],
    WEEK,
  );
  assert.equal(paidSentDateFromLog(paid), "2026-07-23");
});

test("empty log for a week with no dispatches", () => {
  assert.deepEqual(buildPaystubDispatchLog([], WEEK), []);
});
