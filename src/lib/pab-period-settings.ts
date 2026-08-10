/**
 * Global PAB (Perfect Attendance Bonus) evaluation window.
 *
 * Storage model (v2):
 *  - `pab_period_overrides`: JSON map `{ "YYYY-MM": { start, end } }`. Each month may carry an explicit
 *    override; months without an entry fall back to `getPabMonthRange(year, month)`.
 *  - `pab_period_active_month`: "YYYY-MM". Which month the wizard's Additions tab is currently viewing.
 *    Defaults to today's PAB month when absent.
 *
 * Legacy keys (`pab_period_manual`, `pab_period_start`, `pab_period_end`) are still honored on read
 * and auto-migrated into the overrides map + active_month on the first save of the new shape.
 */

import {
  getCurrentPabMonth,
  getLatestPabMonthFromColumns,
  getPabMonthRange,
} from '@/lib/hubstaff/calendar-column-dedupe';

export const PAB_PERIOD_MANUAL_KEY = 'pab_period_manual';
export const PAB_PERIOD_START_KEY = 'pab_period_start';
export const PAB_PERIOD_END_KEY = 'pab_period_end';
export const PAB_PERIOD_OVERRIDES_KEY = 'pab_period_overrides';
export const PAB_PERIOD_ACTIVE_MONTH_KEY = 'pab_period_active_month';
/** Per-month list of emails the accountant has excluded from that month's PAB. */
export const PAB_PERIOD_EXCLUSIONS_KEY = 'pab_period_exclusions';
/**
 * Mirror of dispatch-bonuses.TECH_BONUS_WEEK_OVERRIDES_KEY (string constant
 * only — importing it would create a module cycle, see the note on
 * `techWeekOverridesValue`). Guarded by a test in tech-bonus-week.test.ts.
 */
const TECH_BONUS_WEEK_OVERRIDES_SETTING_KEY = 'tech_bonus_week_overrides';

/** Parse YYYY-MM-DD as a local calendar date (no UTC shift). */
export function parseLocalDateFromIso(value: string | null | undefined): Date | null {
  if (value == null || typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a local date as YYYY-MM-DD. */
export function formatIsoFromLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Build a "YYYY-MM" key from a year+month (month is 0-indexed). */
export function yearMonthKey(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Parse a "YYYY-MM" key into {year, month} (month 0-indexed). */
export function parseYearMonthKey(key: string | null | undefined): { year: number; month: number } | null {
  if (!key || typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const year = +m[1];
  const month = +m[2] - 1;
  if (month < 0 || month > 11) return null;
  return { year, month };
}

export type PabOverrideEntry = { start: Date; end: Date };
export type PabOverridesMap = Map<string, PabOverrideEntry>;
/** Per-month set of lower-cased emails excluded from that month's PAB. */
export type PabExclusionsMap = Map<string, Set<string>>;

export type PabPeriodFetchResult = {
  /** @deprecated kept for legacy consumers (employee dashboard). True when the legacy single-range toggle was on. */
  manual: boolean;
  /** @deprecated legacy single-range start. See `overrides` for per-month memory. */
  start: Date | null;
  /** @deprecated legacy single-range end. See `overrides` for per-month memory. */
  end: Date | null;
  /** Per-month PAB window overrides. Empty map when none saved. */
  overrides: PabOverridesMap;
  /**
   * Per-month accountant exclusions: a "YYYY-MM" key → set of lower-cased emails
   * that get ₱0 PAB for that month regardless of attendance. Empty map when none.
   */
  exclusions: PabExclusionsMap;
  /** Which month the wizard is currently viewing (null → defaults to today's PAB month at resolution time). */
  activeMonth: { year: number; month: number } | null;
  /**
   * Raw `tech_bonus_week_overrides` JSON blob (per-month Tech Bonus payout-week
   * picks from the wizard's System Bonus modal). Kept unparsed here: the parser
   * lives in `dispatch-bonuses.ts` next to the gate it feeds, and this module is
   * imported BY dispatch-bonuses (date helpers) — parsing here would be a cycle.
   */
  techWeekOverridesValue: string | null;
};

/** Legacy validity check — kept so existing callers (dashboard) keep working. */
export function isValidManualPabRange(r: PabPeriodFetchResult): r is PabPeriodFetchResult & { start: Date; end: Date } {
  return !!(r.manual && r.start && r.end && r.start.getTime() <= r.end.getTime());
}

/**
 * Parse the `pab_period_overrides` JSON blob. Silently drops malformed entries.
 * Accepts the shape `{ "YYYY-MM": { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } }`.
 */
export function parsePabPeriodOverrides(value: string | null | undefined): PabOverridesMap {
  const map: PabOverridesMap = new Map();
  if (value == null || String(value).trim() === '') return map;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!parseYearMonthKey(k)) continue;
      if (!v || typeof v !== 'object') continue;
      const entry = v as { start?: unknown; end?: unknown };
      const start = typeof entry.start === 'string' ? parseLocalDateFromIso(entry.start) : null;
      const end = typeof entry.end === 'string' ? parseLocalDateFromIso(entry.end) : null;
      if (!start || !end) continue;
      if (start.getTime() > end.getTime()) continue;
      // The window must intersect the month it's keyed to. A PAB period can spill a
      // few days into the next month (the canonical Friday may land there), but an
      // override that lies ENTIRELY outside its month is invalid — e.g. June's
      // Jun 1–Jul 3 saved under the May key. Drop it so the month falls back to its
      // real default everywhere (wizard, My Hours, dashboard, overview).
      const ym = parseYearMonthKey(k)!;
      const mStart = new Date(ym.year, ym.month, 1);
      const mEnd = new Date(ym.year, ym.month + 1, 0);
      if (start.getTime() > mEnd.getTime() || end.getTime() < mStart.getTime()) continue;
      map.set(k, { start, end });
    }
  } catch {
    // malformed JSON → empty map
  }
  return map;
}

/**
 * Parse the `pab_period_exclusions` JSON blob into a month-keyed map of
 * lower-cased excluded emails. Accepts the shape
 * `{ "YYYY-MM": ["a@x.com", "b@y.com"] }`. Silently drops malformed entries
 * and months whose list ends up empty.
 */
export function parsePabPeriodExclusions(value: string | null | undefined): PabExclusionsMap {
  const map: PabExclusionsMap = new Map();
  if (value == null || String(value).trim() === '') return map;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!parseYearMonthKey(k)) continue;
      if (!Array.isArray(v)) continue;
      const emails = new Set<string>();
      for (const e of v) {
        if (typeof e !== 'string') continue;
        const norm = e.trim().toLowerCase();
        if (norm) emails.add(norm);
      }
      if (emails.size > 0) map.set(k, emails);
    }
  } catch {
    // malformed JSON → empty map
  }
  return map;
}

/**
 * Resolve which PAB month a calendar date belongs to, honoring saved overrides.
 *
 * A custom override window **claims** every date inside it for its month key —
 * so a date in June can belong to the "May" PAB month when May's override runs
 * into June (e.g. May → Jun 1–Jul 3). This is what keeps the wizard's custom
 * month "sticky" everywhere: any surface resolving a PAB month from a date/CSV
 * lands on the same month the wizard configured. Falls back to the canonical
 * Monday-based rule (`getCurrentPabMonth`) when no override window contains the
 * date.
 */
export function resolvePabMonthForDate(
  date: Date,
  overrides: PabOverridesMap,
): { year: number; month: number } {
  const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  for (const [key, range] of overrides) {
    const ym = parseYearMonthKey(key);
    if (!ym) continue;
    const s = new Date(
      range.start.getFullYear(),
      range.start.getMonth(),
      range.start.getDate(),
    ).getTime();
    const e = new Date(
      range.end.getFullYear(),
      range.end.getMonth(),
      range.end.getDate(),
    ).getTime();
    if (t >= s && t <= e) return ym;
  }
  return getCurrentPabMonth(date);
}

/**
 * Resolve the PAB month implied by a set of Hubstaff column headers — the latest
 * parseable date, run through {@link resolvePabMonthForDate} so override windows
 * are honored. Returns null when no date parses (caller should fall back).
 */
export function resolvePabMonthFromColumns(
  cols: string[],
  overrides: PabOverridesMap,
): { year: number; month: number } | null {
  const latest = getLatestPabMonthFromColumns(cols);
  if (!latest) return null;
  return resolvePabMonthForDate(latest.latest, overrides);
}

/**
 * The explicit PAB window for a month: the saved override if present, otherwise
 * the canonical Mon–Fri `getPabMonthRange()` window. `isOverride` flags which.
 * An override applies to every department (HSL and non-HSL alike) — it is the
 * single authoritative window once set, matching `member-monthly-pay.ts`.
 */
export function resolvePabRangeForMonth(
  year: number,
  month: number,
  overrides: PabOverridesMap,
): { start: Date; end: Date; isOverride: boolean } {
  const ov = overrides.get(yearMonthKey(year, month));
  if (ov) return { start: ov.start, end: ov.end, isOverride: true };
  const r = getPabMonthRange(year, month);
  return { start: r.start, end: r.end, isOverride: false };
}

export async function fetchPabPeriodSettings(): Promise<PabPeriodFetchResult> {
  const keys = [
    PAB_PERIOD_MANUAL_KEY,
    PAB_PERIOD_START_KEY,
    PAB_PERIOD_END_KEY,
    PAB_PERIOD_OVERRIDES_KEY,
    PAB_PERIOD_ACTIVE_MONTH_KEY,
    PAB_PERIOD_EXCLUSIONS_KEY,
    TECH_BONUS_WEEK_OVERRIDES_SETTING_KEY,
  ] as const;

  // Each key is fetched independently and degrades to `{ value: null }` on a
  // non-OK response OR a network error (Supabase down → "Failed to fetch"). This
  // keeps the function from ever rejecting: a whole-app outage yields default
  // settings instead of an unhandled rejection that pops the Next dev overlay and
  // blocks navigation. Callers get sensible defaults; real values return once the
  // API is reachable again.
  const [mj, sj, ej, ov, am, ex, tw] = await Promise.all(
    keys.map((key) =>
      fetch(`/api/app-settings?key=${encodeURIComponent(key)}`, { cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<{ value: string | null }>) : { value: null }))
        .catch(() => ({ value: null as string | null })),
    ),
  );

  const overrides = parsePabPeriodOverrides(ov.value);
  const exclusions = parsePabPeriodExclusions(ex.value);

  // Legacy migration: when the new overrides map is empty but the legacy manual
  // keys are populated, synthesize a single override for the legacy range so
  // the new UI surfaces the saved dates. `activeMonth` defaults to the month
  // containing the legacy start date.
  if (overrides.size === 0 && mj.value === 'true') {
    const legacyStart = parseLocalDateFromIso(sj.value);
    const legacyEnd = parseLocalDateFromIso(ej.value);
    if (legacyStart && legacyEnd && legacyStart.getTime() <= legacyEnd.getTime()) {
      const key = yearMonthKey(legacyStart.getFullYear(), legacyStart.getMonth());
      overrides.set(key, { start: legacyStart, end: legacyEnd });
    }
  }

  return {
    manual: mj.value === 'true',
    start: parseLocalDateFromIso(sj.value),
    end: parseLocalDateFromIso(ej.value),
    overrides,
    exclusions,
    activeMonth: parseYearMonthKey(am.value),
    techWeekOverridesValue: tw.value,
  };
}
