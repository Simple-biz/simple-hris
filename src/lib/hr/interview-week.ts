/**
 * Which interview dates belong to a New Hire Checklist week (Kane, 2026-10-08: "make sure to align the date of
 * interview to the week selector"). Governing docs: docs/features/new-hire-checklist.md § The New Hire modal and
 * docs/features/new-hire-source-sync.md (the week rule).
 *
 * ONE rule, read in both directions: a hire belongs on the checklist week AFTER their interview week (measured
 * 2026-10-08: 1,640 of 1,747 dated rows, 94%). The sync places by it (`targetWeekFor` in hires-source-map.ts, which
 * imports node:crypto and so cannot reach the browser); the New Hire modal opens its date picker on it. The two are
 * pinned equal, day by day, in interview-week.test.ts. Change the rule there, never here alone.
 *
 * Pure, browser-safe, calendar dates only ("YYYY-MM-DD", Sun–Sat weeks, no time zone: a typed date is a date).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** The Sunday that starts the Sun–Sat week containing `isoDate`. */
function sundayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return addDays(isoDate, -new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay());
}

/** The interview week of a checklist week: the Sun–Sat week BEFORE it. `periodStart` is the week's Sunday. */
export function interviewWeekFor(periodStart: string): { start: string; end: string } | null {
  if (!ISO_DATE.test(periodStart)) return null;
  const sunday = sundayOf(periodStart);
  return { start: addDays(sunday, -7), end: addDays(sunday, -1) };
}

/**
 * Does a typed interview date sit in the interview week of `periodStart`? `null` when there is nothing to judge (no
 * date, or not a date): absence is never "outside".
 */
export function interviewFitsWeek(interviewDate: string, periodStart: string): boolean | null {
  const week = interviewWeekFor(periodStart);
  const date = interviewDate.trim();
  if (!week || !ISO_DATE.test(date)) return null;
  return date >= week.start && date <= week.end;
}
