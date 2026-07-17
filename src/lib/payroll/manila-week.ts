/**
 * Payroll-week math in the payroll timezone (Asia/Manila), shared by server
 * code and client components. A payroll week is Monday-anchored — the same
 * convention as the Hubstaff pay weeks (see lib/hubstaff/use-pay-weeks.ts) —
 * but computed from the calendar, not from uploads, so features like the
 * Payroll Notes board can stamp "this week" before any CSV exists for it.
 */

/** Monday (ISO date) of the week containing the given ISO date. */
export function mondayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

/** Monday (ISO date) of the CURRENT payroll week — "today" read in Manila. */
export function manilaWeekStart(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
  return mondayOf(today);
}

/** "7/17"-style stamp for today in Manila — how dates are written on the
 *  Payroll Notes board (matching the old spreadsheet). */
export function manilaMonthDayStamp(now: Date = new Date()): string {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

/** Sunday ISO date six days after a Monday `start`. */
export function weekEndFromStart(startIso: string): string {
  const [y, m, d] = startIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + 6));
  return dt.toISOString().slice(0, 10);
}

/** "Jul 14 – Jul 20" (with the year appended when it isn't the current one). */
export function weekRangeLabel(startIso: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d!));
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const end = weekEndFromStart(startIso);
  const year = Number(startIso.slice(0, 4));
  const suffix = year === new Date().getFullYear() ? "" : `, ${year}`;
  return `${fmt(startIso)} – ${fmt(end)}${suffix}`;
}
