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
  complete: boolean;
  paidCount: number;
  /** Still owed and still payable: not_paid + threshold + never-dispatched. */
  pendingCount: number;
  /** Flagged Problem — out of the queue, money still stuck. */
  blockedCount: number;
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
 * Payment Dispatch's 100% rule, expressed against report totals: nothing
 * pending, nobody blocked, at least one person paid. Working from totals rather
 * than the live queue means the Reports tab needs no wizard/queue hydration to
 * decide whether the button lights up.
 */
export function cycleCompleteness(totals: DisbursementReportTotals): CycleCompleteness {
  const pendingCount =
    totals.notPaidCount + totals.thresholdCount + totals.outstandingCount;
  const blockedCount = totals.problemCount;
  return {
    complete: totals.paidCount > 0 && pendingCount === 0 && blockedCount === 0,
    paidCount: totals.paidCount,
    pendingCount,
    blockedCount,
  };
}

/** Complete AND a real pay cycle. Urgent (MESA/one-off) weeks are excluded —
 *  they are payouts, not cycles, and are reported in Payment Dispatch only. */
export function isPublishableCycle(
  summary: Pick<DisbursementReportSummary, 'sourceFile' | 'totals'>,
): boolean {
  if (!summary.sourceFile) return false;
  if (isUrgentSourceFile(summary.sourceFile)) return false;
  return cycleCompleteness(summary.totals).complete;
}

/**
 * Freeze a cycle. Only `status === 'paid'` dispatches make it in — the report
 * answers "who got paid", so a not_paid/threshold/problem row has no place in
 * it (and by the time we publish, `isPublishableCycle` guarantees there are
 * none anyway).
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

  const employeeEmails = new Set<string>();
  let contractorCount = 0;
  let paidUSD = 0;
  let paidPHP = 0;
  const byProcessor: Record<string, { count: number; usd: number; php: number }> = {};

  for (const p of payees) {
    if (p.payeeType === 'contractor') contractorCount += 1;
    else employeeEmails.add(p.email.toLowerCase());
    paidUSD += p.amountUSD;
    paidPHP += p.amountPHP;
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
      payeeCount: employeeEmails.size + contractorCount,
      employeeCount: employeeEmails.size,
      contractorCount,
      dispatchCount: payees.length,
      paidUSD,
      paidPHP,
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
