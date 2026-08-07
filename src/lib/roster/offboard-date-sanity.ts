/**
 * Sanity-check an `off_boarded_at` day-string before any window logic trusts it.
 *
 * An offboard stamp records a PAST event — "this person was offboarded" — so a
 * future date is definitionally garbage, and it is uniquely dangerous garbage:
 * every recency window in the pipeline is a lower-bound comparison, so a future
 * date sails through all of them at once. `off >= cutoff` (the 90-day listing
 * window) and `off >= weekStart` ("left during or after the scored week") are
 * both trivially true of 2027 for years. Live case: franm@simple.biz's
 * offboarded_sheet row is stamped 2027-04-20 — a year-typo for 2026, entered by
 * hand in the Google Sheet the table snapshots from — and that single cell kept
 * her on every offboarded surface for months after her real last hours (week
 * of 2026-04-19).
 *
 * Ancient dates are deliberately NOT nulled: they age out naturally through the
 * same windows a future date defeats, and turning a dated record into an
 * undated one can WIDEN its reach (undated candidates are kept by design in
 * week-relevance when no hours signal exists).
 *
 * One day of grace covers clock skew and timezone-crossing stamps. Genuine
 * stamps come from server-side `new Date().toISOString()`, which can never be
 * meaningfully ahead of the comparison clock.
 *
 * Pure — no I/O — so node:test can exercise every branch.
 */

/** Calendar-day prefix of an ISO-ish string, or null. */
function dayOf(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Returns the day-string unchanged when it is plausible, and `null` when it
 * claims a day more than one day after `now` — the caller must then treat the
 * record as UNDATED and fall back to evidence that cannot be typo'd (presence
 * in recent timesheets), rather than letting the garbage date vouch for it.
 */
export function sanitizeOffboardDay(day: string | null, now: Date = new Date()): string | null {
  if (!day) return null;
  const d = dayOf(day);
  if (!d) return null;
  const tomorrow = dayOf(new Date(now.getTime() + 86_400_000).toISOString())!;
  return d > tomorrow ? null : d;
}
