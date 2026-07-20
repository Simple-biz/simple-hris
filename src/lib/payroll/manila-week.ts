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

/** Sunday (ISO date) of the week containing the given ISO date. */
export function sundayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay()); // getUTCDay(): 0 = Sunday
  return dt.toISOString().slice(0, 10);
}

/**
 * The pay-period week the Payroll Notes board is working on right now: the
 * just-completed **Sunday–Saturday** week, read in Asia/Manila. Payroll runs a
 * week in arrears — while it's the week of the 19th–25th, accounting processes
 * the 12th–18th — so this is one calendar week BEFORE the current one.
 *
 * Distinct from {@link manilaWeekStart} (the Monday of *this* week), which the
 * HR master-list snapshots still use; the notes board wants the period being
 * paid, Sunday-anchored, not the calendar week the clerk happens to be in.
 */
export function payrollNotesWeekStart(now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
  // Sunday of the current week, then back up 7 days to the week being paid.
  const [y, m, d] = sundayOf(today).split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! - 7));
  return dt.toISOString().slice(0, 10);
}

/** "7/17"-style stamp for today in Manila — how dates are written on the
 *  Payroll Notes board (matching the old spreadsheet). */
export function manilaMonthDayStamp(now: Date = new Date()): string {
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

/** ISO date `weeks` weeks after `start` (negative steps backward). Preserves
 *  the anchor day, so stepping a Sunday stays on Sundays. */
export function addWeeks(startIso: string, weeks: number): string {
  const [y, m, d] = startIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + weeks * 7));
  return dt.toISOString().slice(0, 10);
}

/** ISO date six days after `start` — the week's last day: Sunday for a
 *  Monday-anchored week, Saturday for a Sunday-anchored one. */
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
