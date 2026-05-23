/**
 * US Holiday forgiveness for PAB (Perfect Attendance Bonus).
 *
 * When enabled, employees who don't log Hubstaff hours on a configured US holiday
 * still keep their PAB eligibility for that day. No dispute/approval row is created;
 * forgiveness is applied in-memory during eligibility calculation.
 *
 * Storage model:
 *  - `us_holidays_enabled`: boolean string ('true' / 'false'). Master toggle.
 *  - `us_holidays_list`:    JSON array of { date: "YYYY-MM-DD", name, enabled }.
 *                           Seeded with US federal holidays the first time the
 *                           Holidays panel loads with no saved value.
 */

export const US_HOLIDAYS_ENABLED_KEY = 'us_holidays_enabled';
export const US_HOLIDAYS_LIST_KEY = 'us_holidays_list';

export type UsHoliday = {
  /** YYYY-MM-DD (local calendar date) */
  date: string;
  /** Display name, e.g. "Memorial Day" */
  name: string;
  /** When false, the date is shown in the list but does not forgive PAB */
  enabled: boolean;
};

/* ------------------------------------------------------------------ */
/*  Federal holiday calculator                                         */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(year: number, monthIndex: number, day: number): string {
  return `${year}-${pad2(monthIndex + 1)}-${pad2(day)}`;
}

/** Nth weekday (1-indexed) of a month. dow: 0=Sun..6=Sat. */
function nthWeekdayOfMonth(year: number, monthIndex: number, dow: number, n: number): number {
  const first = new Date(year, monthIndex, 1).getDay();
  const offset = (dow - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

/** Last weekday of a month. dow: 0=Sun..6=Sat. */
function lastWeekdayOfMonth(year: number, monthIndex: number, dow: number): number {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const lastDow = new Date(year, monthIndex, lastDay).getDay();
  const back = (lastDow - dow + 7) % 7;
  return lastDay - back;
}

/**
 * The eleven US federal holidays for a given year, in chronological order.
 * Uses observed-day rules: a Saturday holiday is observed Friday; a Sunday
 * holiday is observed Monday.
 */
export function computeFederalHolidays(year: number): UsHoliday[] {
  const fixed: { name: string; month: number; day: number }[] = [
    { name: "New Year's Day",   month: 0,  day: 1 },
    { name: 'Juneteenth',       month: 5,  day: 19 },
    { name: 'Independence Day', month: 6,  day: 4 },
    { name: 'Veterans Day',     month: 10, day: 11 },
    { name: 'Christmas Day',    month: 11, day: 25 },
  ];

  const variable: { name: string; date: string }[] = [
    { name: 'Martin Luther King Jr. Day', date: iso(year, 0,  nthWeekdayOfMonth(year, 0,  1, 3)) }, // 3rd Mon Jan
    { name: "Presidents' Day",            date: iso(year, 1,  nthWeekdayOfMonth(year, 1,  1, 3)) }, // 3rd Mon Feb
    { name: 'Memorial Day',               date: iso(year, 4,  lastWeekdayOfMonth(year, 4, 1)) },     // Last Mon May
    { name: 'Labor Day',                  date: iso(year, 8,  nthWeekdayOfMonth(year, 8,  1, 1)) }, // 1st Mon Sep
    { name: 'Columbus Day',               date: iso(year, 9,  nthWeekdayOfMonth(year, 9,  1, 2)) }, // 2nd Mon Oct
    { name: 'Thanksgiving Day',           date: iso(year, 10, nthWeekdayOfMonth(year, 10, 4, 4)) }, // 4th Thu Nov
  ];

  const list: UsHoliday[] = [];
  for (const f of fixed) {
    const d = new Date(year, f.month, f.day);
    const dow = d.getDay();
    // Observed-day shift: Sat -> Fri, Sun -> Mon
    let day = f.day;
    let monthIndex = f.month;
    if (dow === 6) {
      const shifted = new Date(year, f.month, f.day - 1);
      day = shifted.getDate();
      monthIndex = shifted.getMonth();
    } else if (dow === 0) {
      const shifted = new Date(year, f.month, f.day + 1);
      day = shifted.getDate();
      monthIndex = shifted.getMonth();
    }
    list.push({ date: iso(year, monthIndex, day), name: f.name, enabled: true });
  }
  for (const v of variable) {
    list.push({ date: v.date, name: v.name, enabled: true });
  }
  list.sort((a, b) => a.date.localeCompare(b.date));
  return list;
}

/* ------------------------------------------------------------------ */
/*  Parse / serialize                                                  */
/* ------------------------------------------------------------------ */

/** Parse the `us_holidays_list` JSON. Drops malformed entries silently. */
export function parseUsHolidaysList(value: string | null | undefined): UsHoliday[] {
  if (value == null || String(value).trim() === '') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: UsHoliday[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { date?: unknown; name?: unknown; enabled?: unknown };
      if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
      if (typeof e.name !== 'string') continue;
      out.push({
        date: e.date,
        name: e.name.trim() || e.date,
        enabled: e.enabled !== false,
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  } catch {
    return [];
  }
}

export function serializeUsHolidaysList(list: UsHoliday[]): string {
  return JSON.stringify(list);
}

/**
 * Build a Map<ISO date -> holiday name> for the currently enabled holidays.
 * `enabled=false` entries and a falsey `masterEnabled` flag both return an empty map.
 */
export function getEnabledHolidayMap(
  list: UsHoliday[],
  masterEnabled: boolean,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!masterEnabled) return map;
  for (const h of list) {
    if (h.enabled) map.set(h.date, h.name);
  }
  return map;
}
