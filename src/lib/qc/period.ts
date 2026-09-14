/**
 * What may be used as a QC period key.
 *
 * `qc_score_assignments.period_start` is a pay-week Sunday. Nothing enforced
 * that, and `GET /api/qc/assignments` **writes** — `ensureQcAssignmentsForPeriod`
 * deals and upserts a whole week of slots for whatever key it is handed. So one
 * client passing a Monday did not read a wrong week, it MANUFACTURED one.
 *
 * Measured 2026-09-14: **10 of 29 periods were non-Sunday**, and eight pay weeks
 * existed twice over — `2026-09-06` (Sunday, 397 slots) beside `2026-09-07`
 * (Monday, 404 slots), sharing 385 of their members. The source was
 * `QCApp.tsx`'s `useState(() => isoWeekStart(new Date()))` seed: Monday-anchored,
 * read from the clock, and fetched on before `usePayWeeks` had resolved the real
 * week. The hazard was already written down a module away —
 * `use-pay-weeks.ts:48`: *"a KPI row written under a Monday key is invisible to
 * every reader forever … Sunday in, Sunday out."*
 *
 * The seed is gone (the shell now holds until the week resolves), and this is
 * the second lock: the boundary refuses a key that is not a Sunday rather than
 * trusting every caller to be careful. A phantom week cannot be un-dealt by
 * being careful next time.
 *
 * Pure and client-safe on purpose — the route validates with it, the shell can
 * assert with it, and `node:test` can exercise every branch.
 */

/**
 * The `YYYY-MM-DD` calendar day at the start of `v`, or null when it is not a
 * REAL day. `2026-02-31` and `2026-13-40` are rejected, not normalised.
 *
 * Shape-checking alone is not enough anywhere a day string is then compared
 * with `<` / `>`: an impossible date still sorts, and sorts high. That is how
 * franm@'s year-typo'd `2027-04-20` stamp rode every recency window in the
 * pipeline for months (`src/lib/roster/offboard-date-sanity.ts`), and a
 * `2026-13-40` transfer date would likewise read as "after every week".
 *
 * Accepts a longer string (a timestamp) and uses its day prefix, because the
 * date columns this is pointed at are not uniformly `date`-typed.
 */
export function calendarDay(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((v ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** `YYYY-MM-DD` and nothing else — a period key is exactly a day, never a
 *  timestamp that happens to start with one. */
function parseDay(v: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const day = calendarDay(v);
  if (!day) return null;
  const [y, mo, d] = day.split('-').map(Number);
  return { y: y!, m: mo!, d: d! };
}

/**
 * True when `v` is a well-formed `YYYY-MM-DD` that falls on a Sunday.
 *
 * A type predicate so callers narrow to `string` by checking rather than by
 * asserting — a `!` at the boundary would be the same trust this module exists
 * to withdraw.
 */
export function isQcPeriodStart(v: string | null | undefined): v is string {
  if (!v) return false;
  const p = parseDay(v);
  if (!p) return false;
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() === 0;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `null` when `v` is a usable period key, else the reason — phrased for an API
 * error body, naming the day it actually is so the caller can see the off-by-one
 * rather than guessing at a rejected string.
 */
export function qcPeriodStartError(v: string | null | undefined): string | null {
  if (!v || !v.trim()) return 'period_start required';
  const p = parseDay(v);
  if (!p) return `period_start must be YYYY-MM-DD (got ${JSON.stringify(v)})`;
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  if (dow !== 0) {
    return `period_start must be a pay-week Sunday — ${v} is a ${DAY_NAMES[dow]}`;
  }
  return null;
}
