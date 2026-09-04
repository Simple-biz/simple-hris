/**
 * The "payment cycle complete" celebration — ONE trigger, since 2026-09-04.
 *
 * History, so nobody re-adds the second arm from the git log: from 2026-07-30 the
 * Payment Dispatch progress strip reaching 100% fired the email (`fully_paid`),
 * and from 2026-08-14 closing the cycle fired it too (`cycle_closed`). The strip's
 * arm fired FALSELY twice in production — 2026-08-18 (jakec@, "1 of 1 paid" while
 * 1,026 were staged) and 2026-09-02 (lenny@, "20 of 20 paid" while the week held
 * 1,053 rows, no lock flip involved). Both times the browser reported its own
 * denominator and the server believed it. Kane, 2026-09-04: "this automation
 * only triggers one way — stop processing + close payroll cycle from the UI."
 *
 * So now:
 *   - the ONLY trigger is the close-out route filing a FRESH record
 *     (`app/api/payment-dispatches/cycle-closeout/route.ts`, POST, `already:false`);
 *   - every number in the email comes from that stored record
 *     (`cycleCompleteStatsFromRecord`), never from a request body;
 *   - there is no client endpoint left that accepts a count — the old
 *     `/api/payment-dispatches/cycle-complete` route is deleted.
 *
 * `isCycleFullyPaid` / `payableUnpaidCount` / `cycleStartedCount` remain: the
 * progress strip and the close-out's unpaid list still use them. They no longer
 * decide whether anything is sent.
 *
 * No I/O, no framework.
 */

import type { CycleCloseoutRecord } from '@/lib/payroll/cycle-closeout';

/** The four buckets every payee in a cycle falls into, as counts. Sourced from
 *  the SAME memo that feeds the progress strip, so this can never disagree with
 *  the number on screen. */
export interface CycleSettlement {
  /** Still in the pending queue — never dispatched. */
  pendingCount: number;
  /** Logged Problem: out of the queue, money stuck. */
  blockedCount: number;
  /** Logged Threshold: deliberately held under the payout minimum. */
  heldCount: number;
  /** Distinct payees actually paid (superseded markers already collapsed). */
  paidCount: number;
}

/** People this cycle owes money to. The close-out record's `unpaid` list is the
 *  named version of exactly this set. */
export function payableUnpaidCount(s: CycleSettlement): number {
  return s.pendingCount + s.blockedCount + s.heldCount;
}

/** What the week began with: everyone paid plus everyone still owed. */
export function cycleStartedCount(s: CycleSettlement): number {
  return s.paidCount + payableUnpaidCount(s);
}

/** True only for a week that owes nothing and actually paid somebody. Drives the
 *  strip's 100% state ONLY — it sends nothing (see the header). */
export function isCycleFullyPaid(s: CycleSettlement): boolean {
  return payableUnpaidCount(s) === 0 && s.paidCount > 0;
}

/**
 * The single event that may produce a celebration. Kept as a labelled type
 * rather than dropped so the payload still SAYS what fired it, and so a future
 * second arm has to be added here — on purpose, with the history above in view.
 */
export type CycleCompleteTrigger = 'cycle_closed';

export const CYCLE_COMPLETE_TRIGGER: CycleCompleteTrigger = 'cycle_closed';

/** Anything but the one trigger is REFUSED (null), never coerced to it. */
export function asCycleCompleteTrigger(v: unknown): CycleCompleteTrigger | null {
  return v === 'cycle_closed' ? 'cycle_closed' : null;
}

/** The figures the email carries, read off the FILED record — the one place
 *  the paid side is server-computed and the unpaid side is the clerk's declared
 *  list. `total_count` is paid + owed by construction, and the headline unpaid
 *  count adds what the storage cap dropped, exactly as the CSV does. */
export function cycleCompleteStatsFromRecord(record: CycleCloseoutRecord): {
  paid_count: number;
  total_count: number;
  unpaid_count: number;
  total_paid_usd: number;
  total_paid_php: number;
} {
  const paid = record.paid.payeeCount;
  const unpaid = record.unpaid.count + record.unpaid.truncated;
  return {
    paid_count: paid,
    total_count: paid + unpaid,
    unpaid_count: unpaid,
    total_paid_usd: record.paid.paidUSD,
    total_paid_php: record.paid.paidPHP,
  };
}

/**
 * The boundary check before anything is sent. A close may carry a shortfall
 * (Kane, 2026-08-14: "if it's closed it's closed") — but a congratulations naming
 * NOBODY paid is a bug, not a policy, and more paid than the cycle held is a
 * broken record.
 */
export function isReportableCycleComplete(input: {
  paidCount: number;
  totalCount: number;
}): boolean {
  const { paidCount, totalCount } = input;
  if (!Number.isFinite(paidCount) || !Number.isFinite(totalCount)) return false;
  return paidCount > 0 && totalCount >= paidCount;
}

/**
 * The once-per-cycle-EVER celebration claim. `app_settings.key` is the primary
 * key, so the sender INSERTs this before mailing and any later attempt hitting
 * `23505` stays silent. Released ONLY when the webhook delivery itself failed.
 *
 * Shared deliberately: the close fires it, and `reopenCycle` BURNS it (inserts it
 * unsent) so a reopened week can never celebrate again.
 */
export const CYCLE_COMPLETE_NOTIFIED_PREFIX = 'dispatch.cycle_complete_notified.';

export function cycleCompleteNotifiedKey(sourceFile: string): string {
  return `${CYCLE_COMPLETE_NOTIFIED_PREFIX}${sourceFile}`;
}

/**
 * The reports claim (2026-09-04). The close-out reports (CSV/XLSX/PDF) ride the
 * celebration email — but a reopened-then-re-closed week has a burned celebration
 * and a NEW record whose reports still have to reach Accounting. So the reports
 * have their own once-key: inserted on every send that carried attachments,
 * DELETED by `reopenCycle` so the re-close mails again (with `celebrate: false`).
 * Disjoint from every other `dispatch.` prefix — a test pins it.
 */
export const CYCLE_REPORT_SENT_PREFIX = 'dispatch.cycle_report_sent.';

export function cycleReportSentKey(sourceFile: string): string {
  return `${CYCLE_REPORT_SENT_PREFIX}${sourceFile}`;
}
