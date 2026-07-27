/**
 * Scopes the recently-offboarded list (src/lib/roster/recently-offboarded.ts)
 * to ONE scored KPI week — the pay period a calculator is viewing.
 *
 * Payroll runs one week in arrears, so a leaver's FINAL check is the run that
 * pays the last week they worked. They belong in a week's KPI calculator only
 * while that week is still their final pay cycle:
 *
 *   - they left DURING or AFTER the scored week (they worked into it), or
 *   - their hours appear in the scored week's timesheet (a late/early stamp
 *     never hides someone who actually worked the week being paid).
 *
 * Anyone who left before the scored week started got their last check in an
 * earlier run — surfacing them again is pure noise and invites double-scoring.
 * On the LIVE week (the just-completed Sun–Sat pay week) this reads as: people
 * offboarded last week or this week show; two weeks ago and older don't.
 *
 * Plain module on purpose: imported by 'use client' components AND by the
 * CLI verifier (scripts/verify-offboarded-people.mts).
 */

export interface OffboardedWeekEvidence {
  /** `YYYY-MM-DD` they left; null when they only fell off the sheet. */
  off_boarded_at: string | null;
  /** Week-start day of the newest timesheet containing their hours. */
  last_hours_week_start?: string | null;
}

/**
 * Whether an offboarded person still belongs in the calculator for the week
 * starting `weekStart` (`YYYY-MM-DD`, day-string comparison — both sides are
 * local calendar days keyed the same way).
 *
 * `hoursWeekFloor` is the server's `hours_week_floor`: the older week of its
 * two-week Hubstaff evidence window. Pass an empty `weekStart` (or omit the
 * floor) to disable the respective check.
 */
export function offboardedRelevantToWeek(
  c: OffboardedWeekEvidence,
  weekStart: string,
  hoursWeekFloor?: string | null,
): boolean {
  if (!weekStart) return true;
  // Viewing a week OLDER than the hours-evidence window: the "did they work
  // the scored week" condition can't be evaluated at all, so week-scoping
  // would silently hide an early-stamped person who DID work that week.
  // Degrade to the unfiltered list — exactly the pre-scoping behavior — for
  // those (locked-by-now) historical weeks.
  if (hoursWeekFloor && weekStart < hoursWeekFloor) return true;
  const off = c.off_boarded_at ?? null;
  const hours = c.last_hours_week_start ?? null;
  if (off && off >= weekStart) return true;
  if (hours && hours >= weekStart) return true;
  // No date signal at all (fell off the sheet AND the hub bridge stayed
  // ambiguous): keep them. They were detected via the last two timesheets so
  // they're at most two weeks stale, and hiding someone who may be owed their
  // final check is the one failure this list exists to prevent.
  return !off && !hours;
}
