// THE date rule for app-written MESA weekly deposits.
//
// This module exists because the rule was previously expressed TWICE — once
// where deposits are written and once where they are reversed — as two separate
// occurrences of the same variable. They agreed only by coincidence, and the
// day either one moved, the other kept looking in the wrong place.
//
// That failure is SILENT, which is what makes it dangerous. The reversal is a
// filtered DELETE: if the filter matches nothing it deletes nothing, reports
// `deleted: 0`, and raises no error. A cancelled pay week would leave every
// member's ₱400 sitting in their balance forever — roughly ₱97,000 per week
// across the current 243 open accounts — and nothing would surface it until
// someone questioned a statement months later. The same class of bug already
// cost 240 orphaned deposits on 2026-07-25, before the reversal existed at all
// (memory/mesa-week-delete-cascade).
//
// So the rule lives in exactly one place and both sides import it. Writer and
// reverser can no longer disagree, because there is nothing left to disagree
// about.
//
// Kane's spec, 2026-08-27: "the deposit dates for this will be the same week
// but on a FRIDAY."

/** Friday, in JS `getUTCDay()` terms (Sunday = 0 … Saturday = 6). */
export const MESA_DEPOSIT_WEEKDAY = 5;

/** How far back the dedupe/reversal window reaches from a week end — the
 *  Sun→Sat span. Kept here so the window and the date it must contain are
 *  defined together. */
export const MESA_WEEK_SPAN_DAYS = 6;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIso(iso: string, label: string): void {
  if (!ISO_DATE.test(iso)) {
    throw new Error(`${label} must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
}

/** ISO date `days` before `iso`. UTC math — these are calendar dates, and
 *  local-time arithmetic drifts them a day west of UTC. */
function isoMinusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Day of week for an ISO date, Sunday = 0 … Saturday = 6. */
export function isoDayOfWeek(iso: string): number {
  assertIso(iso, 'date');
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * The date an app-written weekly deposit carries for the pay week ending
 * `weekEnd`: the **last Friday on or before** that week end.
 *
 * Defined by weekday rather than as `weekEnd - 1` on purpose. A week end is
 * normally the Saturday of a Sun–Sat week, and for that case the two are the
 * same — but the filename span this is derived from is *deliberately unchecked*
 * and production carries both 7- and 8-day ranges
 * (memory/hubstaff-double-ingest-duplicate-batch). A blind `- 1` on an 8-day
 * Sun→Sun range yields a Saturday, silently reintroducing the exact
 * wrong-day-in-the-drawer bug this module exists to prevent. Anchoring to the
 * weekday cannot do that: the result is a Friday for every possible input.
 *
 * The offset is always 0–6 days, so the result is always inside the
 * `[weekEnd - MESA_WEEK_SPAN_DAYS, weekEnd]` dedupe window. That is load-bearing
 * — the idempotency check scans that window, and a deposit dated outside it
 * would be invisible to the check and get written again on every re-upload.
 * Locked by test.
 */
export function mesaDepositDateFor(weekEnd: string): string {
  assertIso(weekEnd, 'weekEnd');
  const back = (isoDayOfWeek(weekEnd) - MESA_DEPOSIT_WEEKDAY + 7) % 7;
  return isoMinusDays(weekEnd, back);
}

/**
 * Every date an app-written deposit for this week could be carrying, for the
 * reversal to match on.
 *
 * This is `mesaDepositDateFor(weekEnd)` plus one transition allowance: deposits
 * written **before** this module existed were dated on the week end itself. A
 * reversal that only looked for the new Friday would orphan those, which is the
 * very failure being fixed — so it matches both. Both are EXACT dates, never a
 * range: widening this to the whole Sun–Sat window would also sweep up the
 * historical deposits laid down by the CSV backfill, which carry an identical
 * shape (₱100/₱300, no tracker provenance) and are not this week's to remove.
 *
 * Safe to drop the legacy entry once no `mesa_ledger` row written by the app
 * predates the Friday cutover — after a full backfill rebuild, that is true by
 * construction. Until then, removing it re-opens the bug for any week deposited
 * before the cutover.
 */
export function mesaDepositDatesToReverse(weekEnd: string): string[] {
  const current = mesaDepositDateFor(weekEnd);
  return current === weekEnd ? [current] : [current, weekEnd];
}

/** Inclusive start of the Sun→Sat window used for dedupe and coverage checks. */
export function mesaWeekStartFor(weekEnd: string): string {
  assertIso(weekEnd, 'weekEnd');
  return isoMinusDays(weekEnd, MESA_WEEK_SPAN_DAYS);
}

/**
 * One MESA contribution suspension window (Accounting → MESA → Active Members →
 * Suspend, 2026-10-06). `resumedOn` null = still suspended. Defined HERE, beside
 * the one gate that reads it, so the gate has no import to drift from.
 */
export interface MesaSuspensionWindow {
  /** YYYY-MM-DD — weeks whose Friday deposit date is on/after this are suspended. */
  suspendedFrom: string;
  /** YYYY-MM-DD — weeks whose Friday deposit date is on/after this contribute again. */
  resumedOn: string | null;
}

/** No suspensions — for a caller that has already established there are none. */
export const NO_MESA_SUSPENSIONS: readonly MesaSuspensionWindow[] = Object.freeze([]);

/**
 * Whether any window covers the deposit date `depositDate` (a Friday):
 * `suspendedFrom <= depositDate < resumedOn`. Half-open on purpose — the
 * resume date is the first day contributing again, exactly like an enrollment
 * date, so `resumedOn === suspendedFrom` is an EMPTY window (a cancelled
 * suspension skips no week). Overlapping windows simply union.
 */
export function mesaSuspendedOn(
  windows: readonly MesaSuspensionWindow[],
  depositDate: string,
): boolean {
  for (const w of windows) {
    if (w.suspendedFrom <= depositDate && (w.resumedOn === null || depositDate < w.resumedOn)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a member enrolled effective `since` contributes for the pay week
 * ending `weekEnd` — charged the ₱100 AND credited the ₱100 + ₱300 deposit.
 *
 * Kane's ruling, 2026-09-15: "Friday should be the deposit dates." The week's
 * deposit is dated its Friday (`mesaDepositDateFor`), and a deposit can only be
 * seen by an account whose `opened_on` is on or before it — every balance is
 * the ledger sliced to events >= opened_on, so a deposit dated before the
 * opening is money charged and never shown. A member therefore contributes
 * for a week exactly when their enrollment date is ON OR BEFORE that week's
 * Friday; a Saturday (or later) enrollment starts with the FOLLOWING week.
 *
 * This replaces `since <= weekEnd`, which charged the join week and then wrote
 * a deposit the account could not see (the 2026-08-28 backfill already used
 * "first Friday on or after the open" — this makes the live rule agree).
 *
 * `since` null/undefined = legacy member (enrolled before the date was
 * tracked) → always contributing. `weekEnd` null = the caller has no week yet
 * → contributing, the Wizard's pre-existing fallback; the ledger writer always
 * has a week.
 *
 * ONE definition, imported by the Wizard (every deduction site), the employee
 * live estimate, the monthly estimate and the ledger writer, so the ₱100 and
 * the ₱400 can never disagree about which week is a member's first.
 *
 * `suspensions` (2026-10-06, Kane: "suspend the mesa contribution without
 * having to opt-out to remove the -100") — the member's suspension windows on
 * their OPEN account. A week whose Friday falls inside one is neither charged
 * nor deposited: the match is three times the contribution, so a week with no
 * ₱100 has nothing to match, and a deposit without a deduction is money the
 * fund never collected (the dales@ defect, docs/features/mesa.md:288).
 *
 * The argument is REQUIRED, not optional. Every caller must say which windows
 * it looked up — or pass `NO_MESA_SUSPENSIONS` and own that it has none — so
 * a new ₱100 site cannot compile while silently ignoring a suspension.
 *
 * `weekEnd` null keeps the pre-existing "contributing" fallback and ignores
 * suspensions, since there is no Friday to judge them against; every money
 * path (final-pay compute, both engines, the writer) always has a week.
 */
export function mesaContributesForWeek(
  since: string | null | undefined,
  weekEnd: string | null | undefined,
  suspensions: readonly MesaSuspensionWindow[],
): boolean {
  if (!weekEnd) return true;
  // Legacy member with nothing suspended: exactly the pre-suspension path,
  // which never parsed `weekEnd` for them.
  if (!since && suspensions.length === 0) return true;
  const deposit = mesaDepositDateFor(weekEnd);
  if (since && since > deposit) return false;
  return !mesaSuspendedOn(suspensions, deposit);
}
