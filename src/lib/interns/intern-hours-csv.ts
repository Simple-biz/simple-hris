import { parseCsv } from '@/lib/csv/parse-csv';
import {
  parseDateRangeFromFilename,
  payrollWeekFilenameError,
  resolveCanonicalColumnsToIso,
} from '@/lib/hubstaff/calendar-column-dedupe';
import { mapHubstaffHoursRow, parseHoursToDecimal } from '@/lib/supabase/hubstaff-hours';
import { normEmail } from '@/lib/email/norm-email';
import { partitionInternRows } from './intern-hours-rows';
import type { InternDayInput } from './intern-week-pay';

/**
 * The interns' weekly Hubstaff report — SAME COLUMNS as the Payroll Wizard's
 * (Kane 2026-09-02), parsed with the same reader, but landing in its own table.
 * This module is the pure half of that upload: filename → week, CSV → rows,
 * rows → the two rails. The database half is orphanage-intern-hours-db.ts.
 */

export interface InternHoursParsedRow {
  rowIndex: number;
  /** Normalized (lower-cased) intern email. */
  email: string;
  name: string | null;
  /** The CSV row verbatim, header → cell. */
  row: Record<string, string>;
}

export interface InternHoursRefusedRow {
  rowIndex: number;
  email: string | null;
  name: string | null;
}

export type InternHoursParseResult =
  | {
      ok: true;
      sourceFile: string;
      weekStart: string;
      weekEnd: string;
      headers: string[];
      rows: InternHoursParsedRow[];
      /** Non-@pathway.ph rows — reported back, NEVER stored. */
      refused: InternHoursRefusedRow[];
    }
  | { ok: false; reason: string };

const isoOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The Sun–Sat week a filename addresses, or the operator-facing reason it cannot. */
export function internWeekFromFilename(
  sourceFile: string | null | undefined,
): { ok: true; weekStart: string; weekEnd: string } | { ok: false; reason: string } {
  const nameError = payrollWeekFilenameError(sourceFile);
  if (nameError) return { ok: false, reason: nameError };
  const range = parseDateRangeFromFilename((sourceFile ?? '').trim())!;
  const days = Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1;
  if (days !== 7 || range.end.getDay() !== 6) {
    return {
      ok: false,
      reason: `"${sourceFile}" covers ${days} days. The interns' report must be one Sunday-to-Saturday week, like the Payroll Wizard's.`,
    };
  }
  return { ok: true, weekStart: isoOf(range.start), weekEnd: isoOf(range.end) };
}

export function parseInternHoursCsv(csvText: string, sourceFile: string | null | undefined): InternHoursParseResult {
  const week = internWeekFromFilename(sourceFile);
  if (!week.ok) return week;

  const grid = parseCsv(csvText);
  if (grid.length < 2) return { ok: false, reason: 'CSV must include a header row and at least one data row.' };
  const headers = grid[0].map((h) => h.trim());
  if (!headers.some((h) => h.toLowerCase() === 'email')) {
    return { ok: false, reason: 'CSV has no "Email" column. Export the interns\' weekly report from Hubstaff the same way as the Payroll Wizard\'s.' };
  }

  const objects: Array<{ rowIndex: number; row: Record<string, string> }> = [];
  grid.slice(1).forEach((cells, i) => {
    if (!cells.some((c) => c.trim() !== '')) return;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      if (h) row[h] = (cells[j] ?? '').trim();
    });
    objects.push({ rowIndex: i, row });
  });

  const mapped = objects.map((o) => ({ ...o, payroll: mapHubstaffHoursRow(o.row), email: mapHubstaffHoursRow(o.row).email }));
  const { payroll, interns } = partitionInternRows(mapped);

  const rows: InternHoursParsedRow[] = interns.map((o) => ({
    rowIndex: o.rowIndex,
    email: normEmail(o.email)!,
    name: o.payroll.name,
    row: o.row,
  }));
  const refused: InternHoursRefusedRow[] = payroll.map((o) => ({
    rowIndex: o.rowIndex,
    email: o.email,
    name: o.payroll.name,
  }));

  return { ok: true, sourceFile: (sourceFile ?? '').trim(), weekStart: week.weekStart, weekEnd: week.weekEnd, headers, rows, refused };
}

/** All seven ISO dates of a Sun–Sat week, from its Sunday. */
export function weekDays(weekStart: string): string[] {
  const d = new Date(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() + i);
    return x.toISOString().slice(0, 10);
  });
}

/**
 * Per-day seconds for one intern row, resolved the way current-pay resolves a
 * Hubstaff row: canonical weekday columns (`monday`, …) become the week's ISO
 * dates via the filename; ISO-date columns are read as-is; anything else is not
 * a day. Returns null when the row carries NO day column at all — the caller
 * refuses that row rather than guessing a lump onto one day.
 */
export function internDaysFromRow(
  row: Record<string, unknown>,
  sourceFile: string,
  weekStart: string,
): InternDayInput[] | null {
  const resolved = resolveCanonicalColumnsToIso(row, sourceFile);
  const days = weekDays(weekStart);
  let sawDayColumn = false;
  const out: InternDayInput[] = days.map((iso) => {
    const present = Object.prototype.hasOwnProperty.call(resolved, iso);
    if (present) sawDayColumn = true;
    const v = present ? resolved[iso] : null;
    const hours = v == null || String(v).trim() === '' ? 0 : parseHoursToDecimal(v);
    return { iso, rawSec: Math.max(0, Math.round(hours * 3600)) };
  });
  return sawDayColumn ? out : null;
}
