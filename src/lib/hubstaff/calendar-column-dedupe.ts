/**
 * Deduplicates Hubstaff / Supabase day columns that describe the same calendar day
 * (e.g. ISO "2026-03-24" + "Mon 3/24", or "monday" + ISO for that Monday).
 * Used by PayrollWizard (PA) and EmployeeDashboard (daily chart).
 */

const DAY_PREFIX_MAP: Record<string, { label: string; order: number; weekday: boolean }> = {
  mon: { label: 'Mon', order: 1, weekday: true },
  tue: { label: 'Tue', order: 2, weekday: true },
  wed: { label: 'Wed', order: 3, weekday: true },
  thu: { label: 'Thu', order: 4, weekday: true },
  fri: { label: 'Fri', order: 5, weekday: true },
  sat: { label: 'Sat', order: 6, weekday: false },
  sun: { label: 'Sun', order: 0, weekday: false },
};

/** JS getDay(): Sun=0 … Sat=6 */
const CANONICAL_NAME_TO_DOW: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function parseColDate(col: string): Date | null {
  const s = col.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const hub =
    /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i.exec(
      s,
    );
  if (hub) {
    const month = parseInt(hub[1], 10) - 1;
    const day = parseInt(hub[2], 10);
    let year = hub[3] ? parseInt(hub[3], 10) : new Date().getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function colDayPrefix(col: string): { label: string; order: number; weekday: boolean } | null {
  const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(col.trim());
  return m ? DAY_PREFIX_MAP[m[1].toLowerCase()] ?? null : null;
}

function inferIsoYearFromColumns(cols: string[]): number | undefined {
  for (const c of cols) {
    const s = c.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
    const d = parseColDate(s);
    if (d) return d.getFullYear();
  }
  return undefined;
}

export function parseColDateForDedupe(col: string, isoYearHint: number | undefined): Date | null {
  const s = col.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const hub =
    /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/i.exec(
      s,
    );
  if (hub) {
    const month = parseInt(hub[1], 10) - 1;
    const day = parseInt(hub[2], 10);
    let year = hub[3] ? parseInt(hub[3], 10) : (isoYearHint ?? new Date().getFullYear());
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Stable key for grouping columns that represent the same calendar day.
 * Handles ISO + Hubstaff labels + DB columns named monday…sunday aligned with ISO dates in the same report.
 */
export function calendarDayKeyForHubstaffColumn(col: string, allCols: string[]): string {
  const trimmed = col.trim();
  const lower = trimmed.toLowerCase();
  const isoYearHint = inferIsoYearFromColumns(allCols);

  const d0 = parseColDateForDedupe(trimmed, isoYearHint);
  if (d0) {
    return `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
  }

  const dow = CANONICAL_NAME_TO_DOW[lower];
  if (dow !== undefined) {
    const isoCols = allCols
      .filter((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.trim()))
      .sort((a, b) => a.trim().localeCompare(b.trim()));
    for (const iso of isoCols) {
      const di = parseColDate(iso.trim());
      if (di && di.getDay() === dow) {
        return `${di.getFullYear()}-${String(di.getMonth() + 1).padStart(2, '0')}-${String(di.getDate()).padStart(2, '0')}`;
      }
    }
    return `slot:${lower}`;
  }

  return `raw:${trimmed}`;
}

export function pickPreferredHubstaffColumn(group: string[]): string {
  if (group.length <= 1) return group[0];
  const withPrefix = group.filter((c) => colDayPrefix(c.trim()) !== null);
  if (withPrefix.length > 0) return withPrefix[0];
  const canonical = group.filter((c) => CANONICAL_NAME_TO_DOW[c.trim().toLowerCase()] !== undefined);
  if (canonical.length > 0) return canonical[0];
  return group[0];
}

/** Sun=0 … Sat=6 for sorting (chart order Sun → Sat). */
export function colDayOrder(col: string): number {
  const prefix = colDayPrefix(col.trim());
  if (prefix) return prefix.order;
  const date = parseColDate(col.trim());
  if (date) return date.getDay();
  const lower = col.trim().toLowerCase();
  const slot = CANONICAL_NAME_TO_DOW[lower];
  if (slot !== undefined) return slot;
  return 9;
}

/**
 * Groups date column names (ISO, Hubstaff, or monday…sunday) that refer to the same calendar day.
 */
export function groupDateColumnsByCalendarDay(dateCols: string[], allColumns: string[]): string[][] {
  const map = new Map<string, string[]>();
  for (const col of dateCols) {
    const key = calendarDayKeyForHubstaffColumn(col, allColumns);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(col);
  }
  return Array.from(map.values()).sort((a, b) => colDayOrder(a[0]) - colDayOrder(b[0]));
}

/* ------------------------------------------------------------------ */
/*  PAB month-boundary helpers                                         */
/* ------------------------------------------------------------------ */

/**
 * Compute the PAB (Perfect Attendance Bonus) date range for a given calendar month.
 *
 * Only **Monday–Friday** dates in `[start, end]` are evaluated (weekends excluded). Eligibility
 * requires each such weekday to have ≥ 7 hours logged.
 *
 *  - **Start**
 *      - If the 1st is a **Monday**, PAB starts on that day.
 *      - Otherwise the first calendar week is treated as incomplete: PAB starts on the **second**
 *        Monday of the month (first Monday on or after the 1st, plus 7 days).
 *  - **End**: Friday of the week that contains the **last Monday** still inside the calendar month
 *    (may fall in the following calendar month).
 *
 * Example (March 2026, March 1 = Sunday):
 *   Start = March 9 (second Monday) — not March 2, because the month did not begin on Monday.
 *   Last Monday in March = March 30 → End = April 3 (Friday).
 */
export function getPabMonthRange(year: number, month: number): { start: Date; end: Date } {
  const first = new Date(year, month, 1);
  const firstDow = first.getDay(); // 0=Sun … 6=Sat

  let start: Date;
  if (firstDow === 1) {
    start = new Date(year, month, 1);
  } else {
    const daysToMon = firstDow <= 1 ? 1 - firstDow : 8 - firstDow;
    const firstMonday = new Date(year, month, 1 + daysToMon);
    start = new Date(
      firstMonday.getFullYear(),
      firstMonday.getMonth(),
      firstMonday.getDate() + 7,
    );
  }

  // Last Monday that still falls within the calendar month
  const lastDay = new Date(year, month + 1, 0); // last day of month
  const lastDow = lastDay.getDay();
  const daysBack = lastDow === 0 ? 6 : lastDow - 1; // distance back to Monday
  const lastMonday = new Date(year, month, lastDay.getDate() - daysBack);
  // Friday of that week (may spill into the next calendar month)
  const end = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() + 4);

  return { start, end };
}

/** Count Monday–Friday calendar days inclusive between two dates (local calendar). */
export function countMonFriInclusiveInRange(start: Date, end: Date): number {
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endT = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  let n = 0;
  while (cur.getTime() <= endT) {
    const w = cur.getDay();
    if (w >= 1 && w <= 5) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

/**
 * Infer the target PAB month from column headers by picking the month that
 * appears most frequently among parseable date columns.
 */
export function inferPabMonthFromColumns(cols: string[]): { year: number; month: number } | null {
  const isoYearHint = inferIsoYearFromColumns(cols);
  const counts = new Map<string, { year: number; month: number; count: number }>();

  for (const col of cols) {
    const d = parseColDateForDedupe(col, isoYearHint);
    if (!d) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { year: d.getFullYear(), month: d.getMonth(), count: 1 });
  }

  let best: { year: number; month: number; count: number } | null = null;
  for (const v of counts.values()) {
    if (!best || v.count > best.count) best = v;
  }
  return best ? { year: best.year, month: best.month } : null;
}

/**
 * Filter column groups to only those whose calendar date falls within
 * the PAB month range [start, end].
 */
export function filterColumnGroupsByPabRange(
  groups: string[][],
  allCols: string[],
  pabStart: Date,
  pabEnd: Date,
): string[][] {
  const isoYearHint = inferIsoYearFromColumns(allCols);
  const startTime = pabStart.getTime();
  const endTime = pabEnd.getTime();

  return groups.filter(group => {
    for (const col of group) {
      const d = parseColDateForDedupe(col, isoYearHint);
      if (d) {
        const t = d.getTime();
        return t >= startTime && t <= endTime;
      }
    }
    // No parseable date — keep the group (best-effort fallback)
    return true;
  });
}
