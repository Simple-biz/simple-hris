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
 * A week "belongs to" the month that contains its **Monday**.
 *
 *  - **Start**: first Monday on or after the 1st of the month.
 *    If the 1st is not a Monday the preceding days (Tue–Sun) belong to the
 *    previous month's last week, so the PAB period begins on the next Monday.
 *
 *  - **End**: Friday of the last week whose Monday still falls within the
 *    calendar month. This Friday **may fall in the next calendar month**
 *    (e.g. April 3 for March 2026) — the whole Mon–Fri week is "owned" by
 *    the month that contains the Monday.
 *
 * Example (March 2026, March 1 = Sunday):
 *   Start = March 2  (first Monday on or after the 1st)
 *   End   = April 3  (last Monday in March = Mar 30 → Fri = Apr 3)
 *   → 5 full weeks
 */
export function getPabMonthRange(year: number, month: number): { start: Date; end: Date } {
  /* ---------- START ---------- */
  const first = new Date(year, month, 1);
  const firstDow = first.getDay(); // 0=Sun … 6=Sat
  // Days to add to reach Monday: Sun(0)→1, Mon(1)→0, Tue(2)→6, Wed(3)→5, …
  const daysToMon = firstDow <= 1 ? (1 - firstDow) : (8 - firstDow);
  const start = new Date(year, month, 1 + daysToMon);

  /* ---------- END ---------- */
  const lastDay = new Date(year, month + 1, 0); // last calendar day
  const lastDow = lastDay.getDay();
  // Days to go back from lastDay to reach the last Monday in the month
  const daysBack = lastDow === 0 ? 6 : lastDow - 1;
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
 * Current PAB period based on today's local date.
 * A Mon–Fri week is "owned" by the month containing its Monday — so the PAB
 * month for today is the month containing the Monday of today's week.
 */
export function getCurrentPabMonth(today: Date = new Date()): { year: number; month: number } {
  const dow = today.getDay(); // 0=Sun..6=Sat
  const daysBackToMon = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBackToMon);
  return { year: monday.getFullYear(), month: monday.getMonth() };
}

/**
 * Find the latest parseable date across a set of columns and derive the PAB
 * month it falls into. Returns `null` if no parseable date columns exist.
 */
export function getLatestPabMonthFromColumns(
  cols: string[],
): { year: number; month: number; latest: Date } | null {
  const isoYearHint = inferIsoYearFromColumns(cols);
  let latest: Date | null = null;
  for (const col of cols) {
    const d = parseColDateForDedupe(col, isoYearHint);
    if (!d) continue;
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  if (!latest) return null;
  const pm = getCurrentPabMonth(latest);
  return { ...pm, latest };
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

/* ------------------------------------------------------------------ */
/*  PAB calendar grid                                                  */
/* ------------------------------------------------------------------ */

export interface PabCalendarDay {
  date: Date;
  /** Short date string, e.g. "3/9" */
  dateStr: string;
  /** Day label, e.g. "Mon" */
  dayLabel: string;
  /** Seconds worked */
  seconds: number;
  /** Whether ≥ 7 h */
  passes: boolean;
  /** Whether we found data for this date */
  hasData: boolean;
}

/**
 * Generate the full PAB calendar grid: one row per Mon–Fri work week within
 * the PAB range. Each cell maps to actual hours data when available.
 *
 * @param pabStart  First Monday of the PAB period
 * @param pabEnd    Last Friday of the PAB period
 * @param hoursByDateKey  Map of `"YYYY-M-D"` → seconds worked (use {@link pabDateKey})
 */
export function buildPabCalendarWeeks(
  pabStart: Date,
  pabEnd: Date,
  hoursByDateKey: Map<string, number>,
): PabCalendarDay[][] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weeks: PabCalendarDay[][] = [];
  let currentWeek: PabCalendarDay[] = [];
  const cur = new Date(pabStart.getFullYear(), pabStart.getMonth(), pabStart.getDate());
  const endTime = pabEnd.getTime();

  while (cur.getTime() <= endTime) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) {
      const key = pabDateKey(cur);
      const seconds = hoursByDateKey.get(key) ?? 0;
      currentWeek.push({
        date: new Date(cur),
        dateStr: `${cur.getMonth() + 1}/${cur.getDate()}`,
        dayLabel: dayNames[dow],
        seconds,
        passes: seconds >= 7 * 3600,
        hasData: hoursByDateKey.has(key),
      });
      if (dow === 5) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);
  return weeks;
}

/**
 * Calendar month grid Mon–Sun (7 columns), one row per week. Includes leading/trailing
 * days from adjacent months; those cells still show {@link hoursByDateKey} when present
 * so split weeks display real Hubstaff totals on every day (My Hours only).
 */
export function buildCalendarMonthWeeksIncludingWeekends(
  monthStart: Date,
  monthEnd: Date,
  hoursByDateKey: Map<string, number>,
): PabCalendarDay[][] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const ms = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate());
  const me = new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate());
  const msTime = ms.getTime();
  const meTime = me.getTime();

  const firstMonday = new Date(ms);
  {
    const dow = firstMonday.getDay();
    const back = dow === 0 ? 6 : dow - 1;
    firstMonday.setDate(firstMonday.getDate() - back);
  }

  const lastSunday = new Date(me);
  {
    const dow = lastSunday.getDay();
    const forward = dow === 0 ? 0 : 7 - dow;
    lastSunday.setDate(lastSunday.getDate() + forward);
  }

  const weeks: PabCalendarDay[][] = [];
  let currentWeek: PabCalendarDay[] = [];
  const cur = new Date(firstMonday.getFullYear(), firstMonday.getMonth(), firstMonday.getDate());
  const endT = lastSunday.getTime();

  while (cur.getTime() <= endT) {
    const t = cur.getTime();
    const inMonth = t >= msTime && t <= meTime;
    const dow = cur.getDay();
    const weekend = dow === 0 || dow === 6;
    const key = pabDateKey(cur);
    const seconds = hoursByDateKey.get(key) ?? 0;
    const hasData = hoursByDateKey.has(key);
    /* PAB-style strip: only in-month weekdays track the 7h rule. */
    const passes = !inMonth || weekend || seconds >= 7 * 3600;
    currentWeek.push({
      date: new Date(cur),
      dateStr: `${cur.getMonth() + 1}/${cur.getDate()}`,
      dayLabel: dayNames[dow],
      seconds,
      passes,
      hasData,
    });
    if (dow === 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);
  return weeks;
}

/** Stable key for a Date used in PAB lookup maps: `"YYYY-M-D"` (no zero-padding). */
export function pabDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * HSL-specific PAB eligibility check.
 *
 * Rules (HSL dept only — all other depts use the strict Mon–Fri every-day-passes logic):
 *
 *  1. PAB week runs Monday → Sunday (7 days, not the standard Mon–Fri window).
 *
 *  2. Within each Mon–Sun week in [pabStart, pabEnd], at least 5 of those 7 days
 *     must reach ≥ 7 h effective. Sat and Sun are full participants — each adds 1
 *     to the count independently when it hits ≥ 7 h.
 *
 *  3. Overnight shifts — when Hubstaff splits a continuous shift across midnight:
 *       • Forward check (D is the overnight start): D_hours + D₊₁_hours ≥ 7 h → D passes.
 *       • Backward check (D is the overnight tail): D₋₁_hours + D_hours ≥ 7 h → D passes.
 *     Both D and D₊₁ (or D₋₁ and D) can independently qualify from the same overnight
 *     pair — so a worker clocking in at 11 PM on Monday and out at 6 AM Tuesday earns
 *     a passing day credit for BOTH Monday and Tuesday.
 *     The backward check is skipped when the previous day was already at ≥ 7 h on its
 *     own (i.e. it was forgiven/holiday) to avoid inflating counts.
 *
 *  4. Partial weeks at the period boundary use the same ≥ 5-day threshold.
 *
 *  5. Returns true only if every Mon–Sun week in the period passes; false otherwise.
 */
export function checkHslPabEligibility(
  pabStart: Date,
  pabEnd: Date,
  hoursByDateKey: Map<string, number>,
): boolean {
  const endTime = new Date(pabEnd.getFullYear(), pabEnd.getMonth(), pabEnd.getDate()).getTime();

  // Advance to the first Monday on or after pabStart
  const cur = new Date(pabStart.getFullYear(), pabStart.getMonth(), pabStart.getDate());
  const dow = cur.getDay(); // Sun=0 … Sat=6
  const daysToMon = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  cur.setDate(cur.getDate() + daysToMon);

  if (cur.getTime() > endTime) return true; // nothing to evaluate

  while (cur.getTime() <= endTime) {
    let qualifyingDays = 0;
    // Walk all 7 days of this Mon–Sun week (stops early if period ends mid-week)
    for (let d = 0; d < 7; d++) {
      if (cur.getTime() > endTime) break;
      const todaySec = hoursByDateKey.get(pabDateKey(cur)) ?? 0;
      let effectiveSec = todaySec;
      if (todaySec > 0 && todaySec < 7 * 3600) {
        // Forward: today's shift extends into tomorrow (today is the overnight start)
        const nextDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
        const nextDaySec = hoursByDateKey.get(pabDateKey(nextDay)) ?? 0;
        if (todaySec + nextDaySec >= 7 * 3600) {
          effectiveSec = todaySec + nextDaySec;
        } else {
          // Backward: today is the tail of yesterday's overnight shift
          const prevDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - 1);
          const prevDaySec = hoursByDateKey.get(pabDateKey(prevDay)) ?? 0;
          if (prevDaySec > 0 && prevDaySec < 7 * 3600 && prevDaySec + todaySec >= 7 * 3600) {
            effectiveSec = prevDaySec + todaySec;
          }
        }
      }
      if (effectiveSec >= 7 * 3600) qualifyingDays++;
      cur.setDate(cur.getDate() + 1);
    }
    if (qualifyingDays < 5) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/*  Canonical-column → ISO-date resolution for source files            */
/* ------------------------------------------------------------------ */

const CANONICAL_DOW_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/**
 * Parse the date range embedded in a Hubstaff source filename.
 * E.g. `"simple-biz_daily_report_2026-03-01_to_2026-03-07.csv"` → { start, end }.
 */
export function parseDateRangeFromFilename(filename: string): { start: Date; end: Date } | null {
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(filename);
  if (!m) return null;
  const start = new Date(+m[1], +m[2] - 1, +m[3]);
  const end = new Date(+m[4], +m[5] - 1, +m[6]);
  return isNaN(start.getTime()) || isNaN(end.getTime()) ? null : { start, end };
}

/**
 * Given a row whose day columns are canonical names (`monday`, `tuesday`, …) and a
 * source filename that contains a date range, return a new row where each canonical
 * column is replaced by its ISO date (`2026-03-02`).
 *
 * Non-day columns (Email, Total worked, etc.) are kept as-is.
 */
export function resolveCanonicalColumnsToIso(
  row: Record<string, unknown>,
  filename: string,
): Record<string, unknown> {
  const range = parseDateRangeFromFilename(filename);
  if (!range) return row;

  // Map day-of-week → ISO date string for the file's week
  const datesByDow: Record<number, string> = {};
  const cur = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  const endT = range.end.getTime();
  while (cur.getTime() <= endT) {
    datesByDow[cur.getDay()] = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    cur.setDate(cur.getDate() + 1);
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const dow = CANONICAL_DOW_MAP[key.toLowerCase()];
    if (dow !== undefined) {
      const iso = datesByDow[dow];
      if (iso) { mapped[iso] = value; continue; }
    }
    mapped[key] = value;
  }
  return mapped;
}

/**
 * Returns true when every day column in the columns array is a canonical weekday
 * name (`monday`, `tuesday`, …) with no parseable dates.
 */
export function columnsAreAllCanonical(cols: string[]): boolean {
  let hasDayCol = false;
  for (const c of cols) {
    const lower = c.trim().toLowerCase();
    if (CANONICAL_DOW_MAP[lower] !== undefined) { hasDayCol = true; continue; }
    if (parseColDate(c) !== null) return false; // has a real date → not all canonical
  }
  return hasDayCol;
}
