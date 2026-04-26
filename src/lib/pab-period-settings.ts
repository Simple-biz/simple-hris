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

export const PAB_PERIOD_MANUAL_KEY = 'pab_period_manual';
export const PAB_PERIOD_START_KEY = 'pab_period_start';
export const PAB_PERIOD_END_KEY = 'pab_period_end';
export const PAB_PERIOD_OVERRIDES_KEY = 'pab_period_overrides';
export const PAB_PERIOD_ACTIVE_MONTH_KEY = 'pab_period_active_month';

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

export type PabPeriodFetchResult = {
  /** @deprecated kept for legacy consumers (employee dashboard). True when the legacy single-range toggle was on. */
  manual: boolean;
  /** @deprecated legacy single-range start. See `overrides` for per-month memory. */
  start: Date | null;
  /** @deprecated legacy single-range end. See `overrides` for per-month memory. */
  end: Date | null;
  /** Per-month PAB window overrides. Empty map when none saved. */
  overrides: PabOverridesMap;
  /** Which month the wizard is currently viewing (null → defaults to today's PAB month at resolution time). */
  activeMonth: { year: number; month: number } | null;
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
      map.set(k, { start, end });
    }
  } catch {
    // malformed JSON → empty map
  }
  return map;
}

export async function fetchPabPeriodSettings(): Promise<PabPeriodFetchResult> {
  const keys = [
    PAB_PERIOD_MANUAL_KEY,
    PAB_PERIOD_START_KEY,
    PAB_PERIOD_END_KEY,
    PAB_PERIOD_OVERRIDES_KEY,
    PAB_PERIOD_ACTIVE_MONTH_KEY,
  ] as const;

  const [mj, sj, ej, ov, am] = await Promise.all(
    keys.map((key) =>
      fetch(`/api/app-settings?key=${encodeURIComponent(key)}`, { cache: 'no-store' }).then(
        (res) => res.json() as Promise<{ value: string | null }>,
      ),
    ),
  );

  const overrides = parsePabPeriodOverrides(ov.value);

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
    activeMonth: parseYearMonthKey(am.value),
  };
}
