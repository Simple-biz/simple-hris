/**
 * The ONE parser for a Hubstaff duration cell.
 *
 * Hubstaff's CSV writes a worked day as a DURATION STRING — `"8:20:29"`,
 * sometimes `"8:20"`, occasionally a bare decimal — never a number. Measured on
 * production 2026-09-22: the newest upload's day columns are the canonical
 * `monday`…`sunday` names and every value is `H:MM:SS` (the five weekday cells
 * of a sample row sum exactly to its `Total worked` of `42:27:06`).
 *
 * **`Number("8:20:29")` is `NaN`.** That is not a hypothetical: it is precisely
 * how the Current Paycycle day ladder shipped blank on 2026-09-22 — every day
 * parsed to `NaN`, fell to "no cell", and rendered "—" while the employee had a
 * full week of tracked time. A reader that treats these cells as numbers does
 * not under-report, it reports NOTHING, and it does so silently.
 *
 * This module exists because the same eleven lines had been copied SIX times
 * (`fetch-hours-by-employee.ts`, `EmployeeMyHours.tsx`, `EmployeeDashboard.tsx`,
 * `EmployeePabCalendar.tsx`, `ManagerMemberHoursMini.tsx`,
 * `member-monthly-pay.ts`) and the seventh reader wrote `Number()` instead,
 * because there was nothing to import. The semantics below are byte-for-byte
 * the six copies' shared behaviour; changing them changes what people are shown
 * they worked, so they are pinned by `duration.test.ts`.
 */

/**
 * Seconds from a Hubstaff duration cell.
 *
 * `"8:20:29"` → 30029 · `"8:20"` → 30000 · `"7.5"` → 27000 · `""`/null → 0.
 *
 * **Returns 0 for anything unparseable, and that is deliberate** — it matches
 * the six existing readers exactly. It also means 0 cannot distinguish "worked
 * nothing" from "we could not read this cell", so a caller that needs that
 * distinction must decide it from the CELL'S PRESENCE, not from this return
 * value. {@link hubstaffDayHours} is the helper that does.
 */
export function parseHubstaffDurationSeconds(v: unknown): number {
  if (v == null) return 0;
  const s = String(v).trim();
  if (!s) return 0;
  const hms = /^(\d+):(\d{2}):(\d{2})$/.exec(s);
  if (hms) return parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10);
  const hm = /^(\d+):(\d{2})$/.exec(s);
  if (hm) return parseInt(hm[1], 10) * 3600 + parseInt(hm[2], 10) * 60;
  const dec = parseFloat(s);
  return Number.isFinite(dec) ? Math.round(dec * 3600) : 0;
}

/** Decimal hours from a Hubstaff duration cell, rounded to 2dp. */
export function parseHubstaffDurationHours(v: unknown): number {
  return Math.round((parseHubstaffDurationSeconds(v) / 3600) * 100) / 100;
}

/**
 * Columns that are metadata, never a day. Lower-cased comparison.
 *
 * Kept beside the parser because the two are always used together: classify the
 * column, then parse the cell. `Total worked` is the dangerous one — it is a
 * perfectly valid duration string, so a predicate that forgets it turns a
 * 42-hour weekly total into a 42-hour Monday.
 */
const NON_DAY_COLUMNS = new Set([
  'id', 'email', 'member', 'total worked', 'activity', 'organization',
  'time zone', 'job type', 'job title', 'work email', 'personal email',
  'employee id', 'tax info', 'location', 'date added', 'spent total', 'currency',
  'source_file', 'upload_id',
]);

const CANONICAL_WEEKDAYS = new Set([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);

/**
 * Is this column a day of tracked time?
 *
 * Mirrors the `isDateCol` predicate duplicated in `fetch-hours-by-employee.ts`
 * and `EmployeeMyHours.tsx`, with `source_file`/`upload_id` added — those are
 * real columns on the stored row (they are not in the CSV, so the CSV-facing
 * copies never needed them) and both are strings that must never be read as a
 * duration.
 */
export function isHubstaffDayColumn(col: string): boolean {
  const lower = col.trim().toLowerCase();
  if (NON_DAY_COLUMNS.has(lower)) return false;
  if (CANONICAL_WEEKDAYS.has(lower)) return true;
  if (/^(mon|tue|wed|thu|fri|sat|sun)/i.test(col.trim())) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(col.trim());
}
