/**
 * Accounting Scoreboard weeks and days.
 *
 * A week is keyed by its SUNDAY (YYYY-MM-DD). That is HRIS's pay week (Sun–Sat), the
 * `period_start` the KPI calculator and `bonus_catalog_applied` use, so a scoreboard week and the
 * Dancing Queen week it feeds share one key. The board shows Mon–Fri, and Payroll Timing also shows
 * Sunday.
 *
 * Days are US EASTERN calendar dates. The scoreboard is a US business-day sheet: its collections
 * log, chargebacks and payroll days are all US dates, though half the team works from Manila. A
 * Manila evening shift entering Monday's numbers is still on Monday, Eastern time.
 *
 * Pure: dates are handled as YYYY-MM-DD strings with UTC arithmetic, so no host time zone leaks in.
 */

import { WEEKDAYS, type Weekday } from './sections';

export const SCOREBOARD_TIME_ZONE = 'America/New_York';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD ("2026-02-30" is false). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

function toUtc(date: string): Date {
  if (!isIsoDate(date)) throw new Error(`Not a YYYY-MM-DD date: ${String(date)}`);
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** 'sun' … 'sat' for a date. */
export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[toUtc(date).getUTCDay()];
}

/** The Sunday on or before `date`, which is the week's key. */
export function weekStartOf(date: string): string {
  return addDays(date, -toUtc(date).getUTCDay());
}

export function isWeekStart(value: unknown): value is string {
  return isIsoDate(value) && toUtc(value).getUTCDay() === 0;
}

/** The date of each weekday in the week that starts on `weekStart` (a Sunday). */
export function weekDates(weekStart: string): Record<Weekday, string> {
  if (!isWeekStart(weekStart)) throw new Error(`Not a Sunday week key: ${weekStart}`);
  const out = {} as Record<Weekday, string>;
  WEEKDAYS.forEach((day, i) => {
    out[day] = addDays(weekStart, i);
  });
  return out;
}

/** The dates of `days` in that week, in the order given. */
export function datesFor(weekStart: string, days: readonly Weekday[]): string[] {
  const all = weekDates(weekStart);
  return days.map((d) => all[d]);
}

/** Today's date in US Eastern time. */
export function todayEastern(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCOREBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The UTC instant of a US Eastern wall-clock time on `date`, e.g. Tuesday 12:00 PM ET (DST aware).
 * Reads the Eastern clock at a first guess and corrects by the difference; exact away from the
 * 2 AM switch hour, which no deadline here uses.
 */
export function easternToUtc(date: string, hour: number, minute = 0): Date {
  const d = toUtc(date);
  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCOREBOARD_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (wall - guess));
}

/** "9/29 11:01 AM" in US Eastern, the way the sheet prints a cycle time. */
export function formatEasternDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SCOREBOARD_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(iso))
    .replace(',', '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 28 – Oct 2, 2026": the week's Monday to Friday, as the sheet labels it. */
export function weekLabel(weekStart: string): string {
  const mon = toUtc(addDays(weekStart, 1));
  const fri = toUtc(addDays(weekStart, 5));
  const left = `${MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()}`;
  const right =
    mon.getUTCMonth() === fri.getUTCMonth()
      ? `${fri.getUTCDate()}`
      : `${MONTHS[fri.getUTCMonth()]} ${fri.getUTCDate()}`;
  return `${left} – ${right}, ${fri.getUTCFullYear()}`;
}

/** "Sep 20 – 26" (or "Sep 27 – Oct 3") for an inclusive date range, e.g. the work week a cycle pays. */
export function rangeLabel(start: string, end: string): string {
  const a = toUtc(start);
  const b = toUtc(end);
  const left = `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()}`;
  const right = a.getUTCMonth() === b.getUTCMonth() ? `${b.getUTCDate()}` : `${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}`;
  return `${left} – ${right}`;
}

/** "Mon 9/28" for a column header. */
export function dayHeader(date: string): { weekday: string; short: string } {
  const d = toUtc(date);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return { weekday, short: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` };
}
