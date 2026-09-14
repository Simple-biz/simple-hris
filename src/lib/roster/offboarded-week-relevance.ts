/**
 * Scopes the recently-offboarded list (src/lib/roster/recently-offboarded.ts)
 * to ONE scored KPI week — the pay period a calculator is viewing.
 *
 * Payroll runs one week in arrears, so a leaver's FINAL check is the run that
 * pays the last week they worked. They belong in a week's KPI calculator only
 * while that week is still their final pay cycle.
 *
 * Carla, 2026-09-14: *"If I was offboarded today, I should be on the list next
 * week, but then after that I am gone. This is because they won't be having
 * hours after that."*
 *
 * ## Two ways in, both POSITIVE evidence
 *
 * 1. **A stamp inside the window** — `weekStart <= off <= weekEnd + 7 days`.
 *    The lower bound is "then I am gone": stamped before the week began, they
 *    were already gone and their final cheque went out in an earlier run. The
 *    upper bound is exactly one payroll cycle, because week `W` is scored and
 *    paid during week `W+1`: someone stamped in `W+1` still has `W` in play,
 *    and someone stamped in `W+2` does not — `W` was settled before they left.
 * 2. **Hours in the scored week itself** — a late or early stamp never hides
 *    somebody who demonstrably worked the week being paid.
 *
 * ## What changed on 2026-09-14, and why
 *
 * This predicate used to say yes in two more cases, and both were unbounded:
 *
 * - **`off >= weekStart` with no upper bound.** Someone stamped in September
 *   was offered for every week back to June. Carla's sentence is a bound at
 *   BOTH ends; only one end was implemented.
 * - **Two fail-open branches.** A person with no date signal at all was kept
 *   on EVERY week forever, and any week older than the hours-evidence floor
 *   returned the whole 90-day list. The comment justifying them said hiding
 *   someone owed a final check "is the one failure this list exists to
 *   prevent" — but the effect was a list that never emptied, which is the
 *   failure Carla actually reported. The recovery path is real and she names
 *   it herself: *"we just have to add them externally"* — the Add External
 *   Member picker, which searches the full list unscoped.
 *
 * The hours test also changed shape. It compared the NEWEST week a person had
 * hours in with `>=`, so hours in week W+1 vouched for week W — something the
 * timesheet never said. It is now exact membership in
 * `hours_week_starts` (src/lib/roster/recently-offboarded.ts).
 *
 * Consumers: both KPI calculators, the Payroll Notes → Offboarded tab (which
 * ANDs its own hours-in-this-cycle gate on top), and two verifier scripts.
 *
 * Plain module on purpose: imported by 'use client' components AND by the
 * CLI verifiers.
 */

/**
 * Days past a week's end that an offboard stamp may still fall on and owe that
 * week's scores: exactly ONE payroll cycle, because payroll runs a week in
 * arrears — week `W` is scored and paid during week `W+1`.
 *
 * Not two. A test caught the difference: with a fortnight's slack, somebody
 * stamped 2026-09-14 was still offered the week of 2026-08-30, which had been
 * paid out days before they left.
 *
 * Deliberately NOT the same number as `CHURN_GRACE_DAYS` in
 * src/lib/qc/roster-as-of-week.ts. That one bounds how late a DEAL may run and
 * still notice a departure; this one bounds how long a WEEK'S PAY stays in
 * play. Similar shape, different questions — do not collapse them.
 */
const FINAL_PAY_GRACE_DAYS = 7;

export interface OffboardedWeekEvidence {
  /** `YYYY-MM-DD` they left; null when they only fell off the sheet. */
  off_boarded_at: string | null;
  /** Every week-start day their hours appear in, within the evidence window. */
  hours_week_starts?: readonly string[] | null;
}

/** A real calendar day at the start of `v`, or null. Shape alone is not enough:
 *  an impossible date still sorts, and sorts high — franm@'s `2027-04-20` rode
 *  every lower-bound window in this pipeline for months on exactly that. */
function day(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((v ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `YYYY-MM-DD` plus `n` days, in UTC so no DST boundary can shift it. */
function addDays(isoDay: string, n: number): string {
  const dt = new Date(Date.UTC(+isoDay.slice(0, 4), +isoDay.slice(5, 7) - 1, +isoDay.slice(8, 10) + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * Whether an offboarded person still belongs in the calculator for the pay week
 * starting `weekStart` (`YYYY-MM-DD`, a Sunday).
 *
 * An empty or unparseable `weekStart` disables scoping and keeps everyone —
 * the calculators pass `weekResolved ? weekStart : ''` so the Monday local-clock
 * seed can never filter against the wrong week.
 */
export function offboardedRelevantToWeek(c: OffboardedWeekEvidence, weekStart: string): boolean {
  const start = day(weekStart);
  if (!start) return true;

  // Worked the week being scored. Exact membership — not "worked some week at
  // or after this one", which is a different claim.
  const hours = c.hours_week_starts ?? null;
  if (hours && hours.includes(start)) return true;

  // Still employed into this week, and this week's pay is still in play.
  const off = day(c.off_boarded_at);
  if (!off) return false;
  const lastOwedDay = addDays(addDays(start, 6), FINAL_PAY_GRACE_DAYS);
  return off >= start && off <= lastOwedDay;
}
