/**
 * The Sunday→Saturday day ladder on Current Paycycle.
 *
 * PURE, so `node:test` can prove it against the real column shapes production
 * carries. It was inline in the route when it shipped on 2026-09-22 and it was
 * wrong in three separate ways that a test would have caught immediately — see
 * `paycycle-days.test.ts`, which pins all three.
 *
 * The algorithm mirrors `fetchHoursByEmployee`
 * (`src/lib/hubstaff/fetch-hours-by-employee.ts:133-150`), which is the shipped,
 * correct reader of this table. Do not simplify it back to `row[iso]`:
 *
 *  1. **Canonical columns resolve to ISO dates first.** Production writes the
 *     day columns as `monday`…`sunday`, NOT as dates.
 *  2. **A calendar day can span SEVERAL columns**, so they are grouped with
 *     `groupDateColumnsByCalendarDay` and the group's MAX is taken. Never the
 *     sum — `INDEX.md:41`: *"readers dedupe, they do not sum."*
 *  3. **Cells are duration strings**, parsed with
 *     `parseHubstaffDurationSeconds`. `Number("8:20:29")` is `NaN`.
 */
import {
  columnsAreAllCanonical,
  groupDateColumnsByCalendarDay,
  parseColDate,
  parseDateRangeFromFilename,
  resolveCanonicalColumnsToIso,
} from '@/lib/hubstaff/calendar-column-dedupe';
import {
  isHubstaffDayColumn,
  parseHubstaffDurationSeconds,
} from '@/lib/hubstaff/duration';

export interface PaycycleDay {
  iso: string;
  label: string;
  /**
   * Hours worked, or NULL when the upload carries no cell for this day at all.
   *
   * The distinction is load-bearing and is the reason this is not `number`:
   * `employee-current-paycycle.md` §2 — absent is not zero. A day the person
   * worked 0:00:00 renders `0.00`; a day the file has no column for renders
   * "—". Collapsing them would tell someone their Saturday was zero when the
   * file never mentioned Saturday.
   */
  hours: number | null;
}

const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Seconds per ISO day for one employee's stored Hubstaff row.
 *
 * Exported for the test and for any future caller that wants the map rather
 * than the ladder. A day absent from the map had no column; a day present with
 * 0 had a column reading zero.
 */
export function daySecondsFromRow(
  row: Record<string, unknown>,
  sourceFile: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const cols = Object.keys(row);

  // Canonical (`monday`…) → ISO. `columnsAreAllCanonical` returns false the
  // moment any column parses as a real date, so a date-column file is left
  // alone and read directly.
  const needsResolve = columnsAreAllCanonical(cols);
  const resolved = needsResolve
    ? (resolveCanonicalColumnsToIso(row, sourceFile) as Record<string, unknown>)
    : row;
  const resolvedCols = Object.keys(resolved);

  const dayCols = resolvedCols.filter(isHubstaffDayColumn);
  for (const group of groupDateColumnsByCalendarDay(dayCols, resolvedCols)) {
    let date: Date | null = null;
    for (const c of group) {
      date = parseColDate(c);
      if (date) break;
    }
    if (!date) continue;
    // MAX across the group, never the sum: two columns for one calendar day are
    // a duplicate reading of that day, not two days' work.
    let max = 0;
    for (const c of group) {
      if (!Object.prototype.hasOwnProperty.call(resolved, c)) continue;
      max = Math.max(max, parseHubstaffDurationSeconds(resolved[c]));
    }
    out.set(toIso(date), max);
  }
  return out;
}

/**
 * The seven days of the pay week, Sunday first.
 *
 * Built from the FILENAME range, not from the row's columns — a week whose
 * upload is missing its Saturday column must still show Saturday, as a blank.
 *
 * `rows` is every stored row for this file and employee (see
 * `collapseToSingleUploadBatch` at the call site, which collapses a double
 * ingest first). Where more than one survives, the MAX per day wins, for the
 * same reason as within a day: duplicate readings, not extra work.
 *
 * NOTE — the grid is deliberately Sun→Sat (Kane, 2026-09-22). Production also
 * carries 8-day Sun→Sun ranges, whose trailing Sunday `resolveCanonicalColumns
 * ToIso` lets win; and an HSL pay week is Mon→Sun, for which
 * `resolveCanonicalColumnsToPayWeek` exists. Neither is handled here, on
 * purpose: this pane shows a calendar Sun→Sat week of tracked time, not the
 * department's pay window.
 */
export function buildPaycycleDays(
  sourceFile: string,
  rows: Record<string, unknown>[],
): PaycycleDay[] {
  const range = parseDateRangeFromFilename(sourceFile);
  if (!range) return [];

  const merged = new Map<string, number>();
  for (const row of rows) {
    for (const [iso, secs] of daySecondsFromRow(row, sourceFile)) {
      merged.set(iso, Math.max(merged.get(iso) ?? 0, secs));
    }
  }

  const days: PaycycleDay[] = [];
  const cursor = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  for (let i = 0; i < 7; i += 1) {
    const iso = toIso(cursor);
    const secs = merged.get(iso);
    days.push({
      iso,
      label: DAY_LABELS[cursor.getDay()] ?? '',
      hours: secs === undefined ? null : Math.round((secs / 3600) * 100) / 100,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}
