/**
 * Pay Cycle Report — the frozen record Accounting publishes when a payment
 * cycle is finished, plus the rule that decides when it MAY be published.
 *
 * Deliberately pure: no Supabase, no `server-only`. The persistence layer
 * (pay-cycle-reports.ts) feeds it rows and stores what it returns; the export
 * layer (pay-cycle-report-export.ts) renders what it returned. That keeps the
 * one piece of real judgment in this feature — "is this cycle actually done?" —
 * unit-testable with plain objects.
 */

import { isUrgentSourceFile } from '@/lib/payroll/urgent-cycle';
import type {
  DisbursementReportSummary,
  DisbursementReportTotals,
} from '@/lib/payroll/disbursement-reports';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/** Bumped only if the stored shape changes incompatibly. Readers tolerate
 *  unknown versions (missing fields fall back) rather than throwing. */
export const PAY_CYCLE_REPORT_VERSION = 1;

/** One paid dispatch, frozen. One row per payment — NOT per person — so every
 *  transaction ID stays individually traceable to the bank statement. */
export interface PayCycleReportPayee {
  name: string | null;
  email: string;
  payeeType: 'employee' | 'contractor';
  processor: string;
  amountUSD: number;
  amountPHP: number;
  transactionId: string | null;
  bankUsed: string | null;
  dateSent: string | null;
  arrivalDate: string | null;
}

export interface PayCycleReportTotals {
  /** Distinct employees + one per contractor invoice — Payment Dispatch's own
   *  headline rule (see distinctPaidCount in PayrollDispatch.tsx), so the two
   *  screens can never disagree on "how many got paid". */
  payeeCount: number;
  employeeCount: number;
  contractorCount: number;
  /** Raw paid-dispatch row count (≥ payeeCount when someone was paid twice). */
  dispatchCount: number;
  paidUSD: number;
  paidPHP: number;
}

export interface PayCycleReportSnapshot {
  version: number;
  published_at: string;
  published_by: string;
  published_by_email: string;
  source_file: string;
  cycle_id: string;
  label: string;
  period_start: string | null;
  period_end: string | null;
  totals: PayCycleReportTotals;
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
  payees: PayCycleReportPayee[];
}

/** A published report without its payee rows — what the list view needs. */
export type PayCycleReportSummary = Omit<PayCycleReportSnapshot, 'payees'>;

export interface CycleCompleteness {
  /** All three publish conditions hold. Urgent-ness is checked separately
   *  (isPublishableCycle) because it is an identity question, not a progress one. */
  complete: boolean;
  /** Condition 1 — every `disbursement_records` row for the cycle is paid, and
   *  at least one is. Catches employees who are owed but never dispatched. */
  recordsComplete: boolean;
  /** Condition 2 — no `payment_dispatches` row is left not_paid / threshold /
   *  problem. This is what an unpaid CONTRACTOR INVOICE trips: invoices create
   *  no disbursement_records row at all, so condition 1 cannot see them. */
  dispatchesComplete: boolean;
  /** Condition 3 — at least one PAID dispatch row exists, i.e. there is
   *  actually something to freeze. A cycle whose records were bulk-marked paid
   *  by Payment Dispatch's "Mark all paid" (a direct UPDATE that creates no
   *  dispatch rows) fails here: it holds no per-payee payment data. */
  hasPaidDispatches: boolean;
  paidCount: number;
  /** Still owed and still payable: not_paid + threshold + never-dispatched. */
  pendingCount: number;
  /** Flagged Problem — out of the queue, money still stuck. */
  blockedCount: number;
  /** Paid `payment_dispatches` rows found for the cycle. */
  paidDispatchCount: number;
  /** Dispatch rows for the cycle that are NOT paid. */
  unpaidDispatchCount: number;
}

/**
 * The columns the gate and the tally read from a `payment_dispatches` row.
 * Deliberately structural and all-optional so BOTH a full `PaymentDispatchRow`
 * and the gate's narrow six-column projection satisfy it — the gate has no
 * business selecting `*` over the whole table.
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
  /** Rows whose status is not 'paid' — not_paid, threshold or problem. */
  unpaidCount: number;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/**
 * THE single tally. Both the publish gate (via cycleCompleteness) and the frozen
 * snapshot's `totals` call this one function over the same rows, so the number
 * the clerk approves in the confirm dialog is by construction the number that
 * gets stored. Reimplementing it anywhere else re-opens that gap.
 */
export function tallyPaidDispatches(
  rows: readonly PayCycleDispatchLike[],
): PayCycleDispatchTally {
  const employeeEmails = new Set<string>();
  let contractorCount = 0;
  let dispatchCount = 0;
  let unpaidCount = 0;
  let paidUSD = 0;
  let paidPHP = 0;

  for (const d of rows) {
    if (d.status !== 'paid') {
      unpaidCount += 1;
      continue;
    }
    dispatchCount += 1;
    if ((d.payee_type ?? 'employee') === 'contractor') contractorCount += 1;
    else employeeEmails.add((d.recipient_email ?? '').trim().toLowerCase());
    paidUSD += num(d.amount_usd);
    paidPHP += num(d.amount_php);
  }

  return {
    payeeCount: employeeEmails.size + contractorCount,
    employeeCount: employeeEmails.size,
    contractorCount,
    dispatchCount,
    paidUSD,
    paidPHP,
    unpaidCount,
  };
}

/**
 * The publish gate — three conditions, read from BOTH tables the feature
 * touches, because each catches something the other cannot see:
 *
 *   1. every `disbursement_records` row is paid (Payment Dispatch's own 100%
 *      rule, restated against report totals so no queue hydration is needed) —
 *      catches an employee who is owed money and was never dispatched;
 *   2. every `payment_dispatches` row is paid — catches an unpaid CONTRACTOR
 *      INVOICE, which produces no disbursement_records row at all and is
 *      therefore invisible to (1);
 *   3. at least one PAID dispatch row exists — refuses a cycle whose records
 *      were bulk-marked paid without dispatch rows, because there is no
 *      per-payee payment data to freeze and the report would be a permanent
 *      $0.00 with an empty payee table.
 *
 * `dispatches` MUST be every dispatch row for the cycle, not just the paid
 * ones, or condition 2 can never fail.
 */
export function cycleCompleteness(
  totals: DisbursementReportTotals,
  dispatches: readonly PayCycleDispatchLike[],
): CycleCompleteness {
  const pendingCount =
    totals.notPaidCount + totals.thresholdCount + totals.outstandingCount;
  const blockedCount = totals.problemCount;
  const tally = tallyPaidDispatches(dispatches);

  const recordsComplete = totals.paidCount > 0 && pendingCount === 0 && blockedCount === 0;
  const dispatchesComplete = tally.unpaidCount === 0;
  const hasPaidDispatches = tally.dispatchCount > 0;

  return {
    complete: recordsComplete && dispatchesComplete && hasPaidDispatches,
    recordsComplete,
    dispatchesComplete,
    hasPaidDispatches,
    paidCount: totals.paidCount,
    pendingCount,
    blockedCount,
    paidDispatchCount: tally.dispatchCount,
    unpaidDispatchCount: tally.unpaidCount,
  };
}

/** Complete AND a real pay cycle. Urgent (MESA/one-off) weeks are excluded —
 *  they are payouts, not cycles, and are reported in Payment Dispatch only. */
export function isPublishableCycle(
  summary: Pick<DisbursementReportSummary, 'sourceFile' | 'totals'>,
  dispatches: readonly PayCycleDispatchLike[],
): boolean {
  if (!summary.sourceFile) return false;
  if (isUrgentSourceFile(summary.sourceFile)) return false;
  return cycleCompleteness(summary.totals, dispatches).complete;
}

/**
 * Freeze a cycle. Only `status === 'paid'` dispatches make it in — the report
 * answers "who got paid", so a not_paid/threshold/problem row has no place in
 * it (and by the time we publish, `isPublishableCycle` guarantees there are
 * none anyway).
 *
 * `totals` comes from `tallyPaidDispatches` — the SAME function the gate and the
 * pre-publish card figures use — so the stored numbers cannot drift from the
 * ones the clerk was shown.
 */
export function buildPayCycleReportSnapshot(input: {
  summary: DisbursementReportSummary;
  dispatches: PaymentDispatchRow[];
  publishedBy: string;
  publishedByEmail: string;
  publishedAt: string;
}): PayCycleReportSnapshot {
  const paid = input.dispatches.filter((d) => d.status === 'paid');

  const payees: PayCycleReportPayee[] = paid.map((d) => ({
    name: trimOrNull(d.recipient_name),
    email: (d.recipient_email ?? '').trim(),
    payeeType: (d.payee_type ?? 'employee') === 'contractor' ? 'contractor' : 'employee',
    processor: (d.processor ?? '').trim() || 'unknown',
    amountUSD: num(d.amount_usd),
    amountPHP: num(d.amount_php),
    transactionId: trimOrNull(d.transaction_id),
    bankUsed: trimOrNull(d.bank_used),
    dateSent: trimOrNull(d.sent_date),
    arrivalDate: trimOrNull(d.arrival_date),
  }));

  // Named people first (A→Z), unnamed rows last so they read as a tail rather
  // than sorting under whatever their email happens to start with.
  payees.sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    const an = (a.name ?? a.email).toLocaleLowerCase();
    const bn = (b.name ?? b.email).toLocaleLowerCase();
    const byName = an.localeCompare(bn);
    return byName !== 0 ? byName : a.email.localeCompare(b.email);
  });

  // Counts and money: the shared tally, over the raw rows. byProcessor stays
  // local — the gate has no use for it, so there is nothing to drift from.
  const tally = tallyPaidDispatches(input.dispatches);

  const byProcessor: Record<string, { count: number; usd: number; php: number }> = {};
  for (const p of payees) {
    const acc = byProcessor[p.processor] ?? { count: 0, usd: 0, php: 0 };
    acc.count += 1;
    acc.usd += p.amountUSD;
    acc.php += p.amountPHP;
    byProcessor[p.processor] = acc;
  }

  return {
    version: PAY_CYCLE_REPORT_VERSION,
    published_at: input.publishedAt,
    published_by: input.publishedBy,
    published_by_email: input.publishedByEmail,
    source_file: input.summary.sourceFile ?? '',
    cycle_id: input.summary.cycleId,
    label: input.summary.reportName,
    period_start: input.summary.periodStart,
    period_end: input.summary.periodEnd,
    totals: {
      payeeCount: tally.payeeCount,
      employeeCount: tally.employeeCount,
      contractorCount: tally.contractorCount,
      // === payees.length by construction: both count the paid rows.
      dispatchCount: tally.dispatchCount,
      paidUSD: tally.paidUSD,
      paidPHP: tally.paidPHP,
    },
    byProcessor,
    payees,
  };
}

/** Strip `payees[]` for the list payload. */
export function toPayCycleReportSummary(snap: PayCycleReportSnapshot): PayCycleReportSummary {
  const { payees: _payees, ...rest } = snap;
  return rest;
}
