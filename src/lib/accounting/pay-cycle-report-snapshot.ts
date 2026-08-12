/**
 * The shared paid-dispatch tally — Payment Dispatch's one rule for "who
 * actually got paid this cycle".
 *
 * This file once also held the published pay-cycle report snapshot and its
 * publish gate (cycleCompleteness / isPublishableCycle /
 * buildPayCycleReportSnapshot); that surface — Accounting → Documents →
 * Reports — was removed on 2026-08-12 and the gate went with it. What
 * remains is the tally that outlived it: the cycle close-out
 * (src/lib/payroll/cycle-closeout.ts) freezes its paid headline with this
 * exact function, so the number the clerk approves in Payment Dispatch's
 * Stop dialog is by construction the number that gets stored.
 *
 * Deliberately pure: no Supabase, no `server-only` — unit-testable with
 * plain objects.
 */

/**
 * The columns the tally reads from a `payment_dispatches` row. Deliberately
 * structural and all-optional so BOTH a full `PaymentDispatchRow` and a
 * narrow projection satisfy it — a caller has no business selecting `*`
 * over the whole table just to count.
 */
export interface PayCycleDispatchLike {
  status?: string | null;
  payee_type?: string | null;
  recipient_email?: string | null;
  amount_usd?: number | string | null;
  amount_php?: number | string | null;
}

/** The figures a cycle's paid dispatch rows add up to. */
export interface PayCycleDispatchTally {
  /** Distinct employee emails + one per contractor invoice — Payment Dispatch's
   *  own headline rule (distinctPaidCount in PayrollDispatch.tsx). */
  payeeCount: number;
  employeeCount: number;
  contractorCount: number;
  /** Raw paid row count (≥ payeeCount when someone was paid twice). */
  dispatchCount: number;
  paidUSD: number;
  paidPHP: number;
  /**
   * Non-paid rows (not_paid / threshold / problem) that were NOT superseded by a
   * later payment to the same payee. Payment Dispatch leaves a marker row in
   * place when a payment is retried, so a raw "status !== paid" count would
   * treat a settled retry as money still owed — see `tallyPaidDispatches`.
   */
  unsettledCount: number;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function isContractorRow(d: PayCycleDispatchLike): boolean {
  return (d.payee_type ?? 'employee') === 'contractor';
}

function emailKey(d: PayCycleDispatchLike): string {
  return (d.recipient_email ?? '').trim().toLowerCase();
}

/**
 * THE single tally. Every surface freezing or displaying a cycle's paid
 * figures (today: the cycle close-out record, and Payment Dispatch's own
 * on-screen counts mirror the same rule) calls this one function over the
 * same rows. Reimplementing it anywhere else re-opens the drift gap.
 *
 * ── Superseded marker rows ──────────────────────────────────────────────────
 * A non-paid row does NOT always mean money is still owed. Payment Dispatch
 * leaves the marker in place when a payment is retried: mark Not Paid (bank
 * glitch), retry, Mark Paid, and the cycle now holds BOTH rows forever. Counting
 * the marker would make that cycle read as permanently unsettled while Payment
 * Dispatch itself reads 100% and fires its confetti.
 *
 * So a non-paid row counts toward `unsettledCount` only when no PAID row of the
 * SAME payee kind exists for the same email — mirroring PD's own `settled` rule
 * (PayrollDispatch.tsx: `paidRows.filter(payee_type !== 'contractor')`), which
 * likewise skips a flagged-then-paid person.
 *
 * Payee kind is part of the key on purpose. Contractors like Claire also hold an
 * employee identity, so one shared email set would let a paid salary silence a
 * flagged invoice (or the reverse). Contractor rows are per-INVOICE, but a
 * non-paid contractor marker deliberately carries no `contractor_invoice_id` —
 * the API only claims the invoice on 'paid' — so email is the only key the two
 * rows share, and it is what we use. PD sidesteps this by ignoring contractor
 * markers entirely and letting the still-payable invoice sit in `pending`; a
 * tally over dispatch rows cannot see `pending`, so email-keying is strictly
 * better here: it still counts a flagged-and-never-paid invoice as unsettled.
 * Its one blind spot — Claire flagged on invoice X while invoice Y is paid —
 * is visible only in PD's pending queue.
 */
export function tallyPaidDispatches(
  rows: readonly PayCycleDispatchLike[],
): PayCycleDispatchTally {
  // Pass 1 — who has actually been paid, keyed by (payee kind, email).
  const paidEmployeeEmails = new Set<string>();
  const paidContractorEmails = new Set<string>();
  for (const d of rows) {
    if (d.status !== 'paid') continue;
    if (isContractorRow(d)) paidContractorEmails.add(emailKey(d));
    else paidEmployeeEmails.add(emailKey(d));
  }

  // Pass 2 — tally, skipping markers that pass 1 proved were settled.
  let contractorCount = 0;
  let dispatchCount = 0;
  let unsettledCount = 0;
  let paidUSD = 0;
  let paidPHP = 0;

  for (const d of rows) {
    const contractor = isContractorRow(d);
    if (d.status !== 'paid') {
      const settled = contractor
        ? paidContractorEmails.has(emailKey(d))
        : paidEmployeeEmails.has(emailKey(d));
      if (!settled) unsettledCount += 1;
      continue;
    }
    dispatchCount += 1;
    if (contractor) contractorCount += 1;
    paidUSD += num(d.amount_usd);
    paidPHP += num(d.amount_php);
  }

  return {
    payeeCount: paidEmployeeEmails.size + contractorCount,
    employeeCount: paidEmployeeEmails.size,
    contractorCount,
    dispatchCount,
    paidUSD,
    paidPHP,
    unsettledCount,
  };
}
