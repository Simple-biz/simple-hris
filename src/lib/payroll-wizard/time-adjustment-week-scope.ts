import type { ReportTimeAdjustmentDay } from './report-rows';

// Which approved time-adjustment days a pay run may PAY.
//
// The wizard folds Σ(approved day hours − raw tracked hours) × the regular rate
// into Initial Pay. Every doc that describes that fold scopes it to the PAY
// WEEK — "over in-period adjustment dates"
// (docs/features/time-adjustment-requests.md § Pay wiring), "Σ(approved − raw)
// over in-period dates × the regular rate"
// (docs/features/payroll-wizard-final-pay.md § 2026-09-10), and "Time
// Adjustments are week-gated … other weeks' requests no longer bleed into every
// run" (same doc).
//
// The memo did not. It scoped on `allDaysColumnGroups`, whose own definition
// reads "all date-column groups within the PAB RANGE" — a MONTH. So one
// approved day was credited to EVERY pay week inside its PAB month, at each
// week's own regular rate, forever. Measured 2026-09-22: juliar@'s 2026-09-10
// adjustment (₱23.33, paid on the 09-06→09-12 week and dispatched 09-15) was
// folded into the live 09-13→09-19 week a second time. A stored-total row
// (`approved_hours`, rule 1) leaks a WHOLE DAY the same way — adriant@'s 7.0 h
// would have re-paid ₱1,960 a week at a ₱280 rate.
//
// The Additions review panel next door was already correct
// (`activeBatchDateRange`, PayrollWizard.tsx) — so the panel could show "no
// adjustments this week" while the money memo paid one. One definition now,
// and it is this module.

/** Inclusive ISO (YYYY-MM-DD) bounds of the pay week being computed — the range
 *  parsed from the active Hubstaff batch's filename, the same one the dispatch
 *  payload declares as `pay_period.week`. */
export interface PayWeekKeys {
  startKey: string;
  endKey: string;
}

/** The fold, per employee: signed hours and the per-day breakdown the payload,
 *  the final-pay snapshot and the Reports columns all disclose. */
export interface TimeAdjustmentDelta {
  hours: number;
  days: ReportTimeAdjustmentDay[];
}

export interface TimeAdjustmentDeltaInput {
  /** email → (ISO date → the hours that day BECOMES), already resolved through
   *  `approvedAdjustmentDayHours` (stored total wins; else tracked + requested). */
  approvedByEmail: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** email → (ISO date → raw tracked hours). A date with no entry is 0 tracked. */
  rawByEmail: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** The pay week. `null` means it could not be resolved — see below. */
  payWeek: PayWeekKeys | null;
}

/**
 * Pay deltas for one pay week's approved time adjustments.
 *
 * Three rules, and the third is the one that was missing:
 *
 * 1. A date OUTSIDE the pay week is never credited. It belongs to that week's
 *    own run, which has already paid it or is yet to.
 * 2. An employee with ≥1 in-week approved day gets an entry even when the net
 *    delta is 0, so the payload and the export can still disclose the dates.
 * 3. **An unresolvable pay week credits NOTHING.** The old code did the
 *    opposite — `periodDates.size > 0 && !periodDates.has(date)` skipped the
 *    whole filter when no date parsed, so the failure mode of "I cannot tell
 *    which week this is" was "pay every approved adjustment on record". On a
 *    money path the two errors are not symmetric: an uncredited adjustment is
 *    visible (the employee says so, and a re-lock fixes it), while an
 *    over-credit is silent and leaves the building.
 */
export function buildTimeAdjustmentDeltas({
  approvedByEmail,
  rawByEmail,
  payWeek,
}: TimeAdjustmentDeltaInput): Map<string, TimeAdjustmentDelta> {
  const out = new Map<string, TimeAdjustmentDelta>();
  // Rule 3 — fail closed. Never "filter when we happen to know the week".
  if (!payWeek) return out;
  const { startKey, endKey } = payWeek;
  for (const [email, dates] of approvedByEmail) {
    const raw = rawByEmail.get(email);
    let hours = 0;
    const days: ReportTimeAdjustmentDay[] = [];
    for (const [date, dayHours] of dates) {
      // Rule 1 — string compare is exact on ISO YYYY-MM-DD and needs no Date
      // parsing (no timezone can move a key that was never a timestamp).
      if (date < startKey || date > endKey) continue;
      const trackedHours = raw?.get(date) ?? 0;
      const dayDelta = dayHours - trackedHours;
      hours += dayDelta;
      days.push({ date, hours: Math.round(dayDelta * 100) / 100 });
    }
    // Rule 2.
    if (days.length > 0) out.set(email, { hours, days });
  }
  return out;
}

/** True when `date` (ISO) is inside the pay week. Shared with any surface that
 *  needs the same question answered — never re-spell the comparison. */
export function isInPayWeek(date: string, payWeek: PayWeekKeys | null): boolean {
  if (!payWeek) return false;
  return date >= payWeek.startKey && date <= payWeek.endKey;
}
