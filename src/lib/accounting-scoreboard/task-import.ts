/**
 * Reads one person tab of Carla's scoreboard sheet into tasks (plan Task 7, Open item 393). Pure, unit-tested; the
 * script `scripts/import-accounting-scoreboard-tasks.mts` does the reading and the writing.
 *
 * The layout, measured read-only on 2026-10-08 (31 person tabs):
 *   - One header row (row 1, or row 2 on a few tabs) names each frequency: "Daily", "Weekly", "Bi-Weekly", "Monthly",
 *     "Bi-Monthly", "Quarterly", "Annually", "As Needed". Not every tab has all eight.
 *   - A frequency's block runs from its header column to the column before the next header. Its first column holds the
 *     task titles; somewhere in the block a TRUE/FALSE checkbox sits on the same row.
 *   - The Florida tabs ("FL …") put a WEEKDAY column (Mon, Tue, Thurs…) inside the weekly block. It is kept by
 *     prefixing the title ("Mon: Send the report"), the way the other tabs already write it ("Tuesday: Send Higlobe").
 * A title with no checkbox on its row is a heading or a note ("Compliance Tasks", "Mark Tasks as Done on the OBS"): it
 * is reported as skipped, never imported. Columns are found by their header text, never by fixed letters.
 * Only tasks are read, never the ticks: the sheet's ticks are this week's state, not history.
 */

import type { TaskFrequency } from './tasks';

export type SheetGrid = ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>;

const HEADER_WORDS: ReadonlyArray<[RegExp, TaskFrequency]> = [
  [/^daily$/i, 'daily'],
  [/^weekly$/i, 'weekly'],
  [/^bi-?\s?weekly$/i, 'biweekly'],
  [/^monthly$/i, 'monthly'],
  [/^bi-?\s?monthly$/i, 'bimonthly'],
  [/^quarterly$/i, 'quarterly'],
  [/^(annually|annual|yearly)$/i, 'annually'],
  [/^as\s?needed$/i, 'as_needed'],
];

const WEEKDAY: ReadonlyArray<[RegExp, string]> = [
  [/^mon(day)?$/i, 'Mon'],
  [/^tue(s|sday)?$/i, 'Tue'],
  [/^wed(nesday)?$/i, 'Wed'],
  [/^thu(r|rs|rsday)?$/i, 'Thu'],
  [/^fri(day)?$/i, 'Fri'],
  [/^sat(urday)?$/i, 'Sat'],
  [/^sun(day)?$/i, 'Sun'],
];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
const isBool = (v: unknown): boolean => v === true || v === false || /^(TRUE|FALSE)$/i.test(text(v));

function frequencyOf(cell: unknown): TaskFrequency | null {
  const t = text(cell);
  for (const [re, f] of HEADER_WORDS) if (re.test(t)) return f;
  return null;
}

function weekdayOf(cell: unknown): string | null {
  const t = text(cell);
  for (const [re, d] of WEEKDAY) if (re.test(t)) return d;
  return null;
}

/** "A1" style address of a 0-based cell (columns past Z are not expected on these tabs). */
const cellName = (row: number, col: number) => `${String.fromCharCode(65 + col)}${row + 1}`;

export interface ImportedTask {
  frequency: TaskFrequency;
  title: string;
  /** Where it came from, for the report. */
  cell: string;
}
export interface SkippedCell {
  cell: string;
  text: string;
  reason: 'no_checkbox' | 'too_long';
}
export interface TabParse {
  /** null when the tab has no frequency header in its first three rows (not a task tab). */
  headerRow: number | null;
  frequencies: TaskFrequency[];
  tasks: ImportedTask[];
  skipped: SkippedCell[];
}

const MAX_TITLE = 300;

export function parseTaskTab(grid: SheetGrid): TabParse {
  // The header row is whichever of the first three rows names the most frequencies (the earliest on a tie).
  let headerRow: number | null = null;
  let headers: Array<{ col: number; frequency: TaskFrequency }> = [];
  for (let r = 0; r < Math.min(3, grid.length); r++) {
    const found = (grid[r] ?? []).flatMap((cell, col) => {
      const f = frequencyOf(cell);
      return f ? [{ col, frequency: f }] : [];
    });
    if (found.length > headers.length) {
      headerRow = r;
      headers = found;
    }
  }
  if (headerRow === null) return { headerRow: null, frequencies: [], tasks: [], skipped: [] };

  headers.sort((a, b) => a.col - b.col);
  const width = Math.max(...grid.map((row) => row?.length ?? 0));
  const tasks: ImportedTask[] = [];
  const skipped: SkippedCell[] = [];
  const seen = new Set<string>();

  headers.forEach(({ col, frequency }, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].col - 1 : Math.min(width - 1, col + 3);
    for (let r = headerRow! + 1; r < grid.length; r++) {
      const row = grid[r] ?? [];
      const raw = text(row[col]);
      if (!raw || isBool(raw)) continue;
      let hasBox = false;
      let day: string | null = null;
      for (let c = col + 1; c <= end; c++) {
        if (isBool(row[c])) hasBox = true;
        else if (!day) day = weekdayOf(row[c]);
      }
      if (!hasBox) {
        skipped.push({ cell: cellName(r, col), text: raw, reason: 'no_checkbox' });
        continue;
      }
      const title = day && !raw.toLowerCase().startsWith(day.toLowerCase()) ? `${day}: ${raw}` : raw;
      if (title.length > MAX_TITLE) {
        skipped.push({ cell: cellName(r, col), text: raw, reason: 'too_long' });
        continue;
      }
      const key = `${frequency}|${title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ frequency, title, cell: cellName(r, col) });
    }
  });
  return { headerRow, frequencies: headers.map((h) => h.frequency), tasks, skipped };
}
