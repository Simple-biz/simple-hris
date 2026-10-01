/**
 * Accounting Scoreboard backfill: reading Carla's Google Sheet into the board's own shapes.
 * Governing doc: docs/features/accounting-scoreboard-backfill.md.
 *
 * Three tabs are read. Each has its own rule, because each was kept differently by hand:
 *
 *   - "Collection Count" (one line per collected account) → the collections log. Clean rows; the
 *     only judgement is which lines are not collections (a "Holiday" placeholder) and amounts that
 *     are not dollars (two are typed in CAD).
 *   - "History" (each week's grid, pasted in by hand) → board entries. The paste drifts: a week's
 *     numbers sit one or two columns away from their date header in some weeks (measured
 *     2026-10-01). So a week is imported only when the header's own alignment reproduces the
 *     weekly total the sheet pasted beside each row, for most rows. Otherwise the week is skipped
 *     and reported. Nothing here ever re-aligns a week by guessing.
 *   - "Totals - History" (team totals, 2021–2024) → the archive, cell for cell AS TYPED. No board
 *     section holds these numbers and nobody has said what each column counts.
 *
 * Pure: no I/O. The script (scripts/backfill-accounting-scoreboard-from-sheet.mts) fetches and writes.
 */

import { isIsoDate, weekStartOf, weekdayOf } from './week';
import type { SectionKey, Slot } from './sections';

/** One cell as the Sheets API returns it (FORMATTED_VALUE → strings; UNFORMATTED_VALUE → numbers too). */
export type Cell = string | number | boolean | null | undefined;
export type Grid = readonly (readonly Cell[])[];

/** Every row, entry and log line the backfill writes is stamped with this, never a person's email. */
export const IMPORT_STAMP = 'sheet-import';

const text = (c: Cell): string => (c === null || c === undefined ? '' : String(c)).trim();

/** "9/28/2026", "09/28/2026" or (with `twoDigitYear`) "9/28/26" → "2026-09-28". Anything else → null. */
export function parseUsDate(value: Cell, twoDigitYear = false): string | null {
  const m = (twoDigitYear ? /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/ : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/).exec(text(value));
  if (!m) return null;
  const year = twoDigitYear ? `20${m[3]}` : m[3];
  const iso = `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** A plain number cell: a number, or a string of digits with an optional decimal part. */
export function numberCell(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const isWeekday = (iso: string): boolean => !['sun', 'sat'].includes(weekdayOf(iso));

// ---------------------------------------------------------------------------
// Collection Count → accounting_scoreboard_collections
// ---------------------------------------------------------------------------

export interface SheetCollection {
  /** 1-based row in the tab, so every report line can be found in the sheet. */
  sheetRow: number;
  date: string;
  /** The rep exactly as typed (trimmed). Mapped to a board row by `resolveRowLabel`. */
  rep: string;
  businessName: string;
  points: number;
  amountUsd: number | null;
}

export interface SkippedLine {
  sheetRow: number;
  reason: string;
}

/** An amount that was kept off the line (the line itself is imported with no amount). */
export interface AmountNote {
  sheetRow: number;
  typed: string;
  reason: string;
}

export interface CollectionLogParse {
  headerRow: number;
  lines: SheetCollection[];
  skipped: SkippedLine[];
  amountNotes: AmountNote[];
}

const MAX_BUSINESS = 200;
const MAX_POINTS = 100;
const MAX_AMOUNT = 10_000_000;

/**
 * Parses the "Collection Count" tab (FORMATTED_VALUE grid). The header is found by its titles,
 * not by position: the tab keeps two summary rows above it.
 *
 * - Points are WHOLE numbers 0–100, as the board takes them (validate.ts). Anything else is skipped.
 * - A "Holiday" line with 0 points is a placeholder, not a collection, and is skipped: imported, it
 *   would count as a collected account.
 * - An amount that is not plain dollars (a "CAD" amount) is dropped from its line, never converted.
 * - A weekend date is skipped: the board keeps Monday to Friday only.
 */
export function parseCollectionLog(grid: Grid): CollectionLogParse {
  const headerIdx = grid.findIndex((row) => {
    const h = row.map((c) => text(c).toLowerCase());
    return h[0] === 'date' && h[1] === 'rep' && h[2] === 'business name' && h[3] === 'points';
  });
  if (headerIdx < 0) throw new Error('Collection Count: no "Date | Rep | Business Name | Points" header row');

  const lines: SheetCollection[] = [];
  const skipped: SkippedLine[] = [];
  const amountNotes: AmountNote[] = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    const sheetRow = i + 1;
    const [dateCell, repCell, bizCell, pointsCell, amountCell] = [0, 1, 2, 3, 4].map((j) => text(row[j]));
    if (!dateCell && !repCell && !bizCell && !pointsCell && !amountCell) continue;
    if (!repCell && !bizCell && !pointsCell && !amountCell) {
      skipped.push({ sheetRow, reason: 'a date with nothing else on the line' });
      continue;
    }
    const date = parseUsDate(dateCell);
    if (!date) {
      skipped.push({ sheetRow, reason: `the date "${dateCell}" is not a calendar date` });
      continue;
    }
    if (!isWeekday(date)) {
      skipped.push({ sheetRow, reason: 'a weekend date; the board keeps Monday to Friday' });
      continue;
    }
    if (!repCell) {
      skipped.push({ sheetRow, reason: 'no rep' });
      continue;
    }
    if (!bizCell) {
      skipped.push({ sheetRow, reason: 'no business name' });
      continue;
    }
    if (bizCell.length > MAX_BUSINESS) {
      skipped.push({ sheetRow, reason: `a business name over ${MAX_BUSINESS} characters` });
      continue;
    }
    if (!/^\d+$/.test(pointsCell) || Number(pointsCell) > MAX_POINTS) {
      skipped.push({ sheetRow, reason: `points "${pointsCell}" are not a whole number 0–${MAX_POINTS}` });
      continue;
    }
    const points = Number(pointsCell);
    if (points === 0 && /^holiday$/i.test(bizCell)) {
      skipped.push({ sheetRow, reason: 'a "Holiday" placeholder, not a collection' });
      continue;
    }

    let amountUsd: number | null = null;
    if (amountCell) {
      const m = /^\$?\s*([\d,]+(?:\.\d{1,2})?)$/.exec(amountCell);
      const n = m ? Number(m[1].replace(/,/g, '')) : NaN;
      if (m && Number.isFinite(n) && n <= MAX_AMOUNT) amountUsd = n;
      else amountNotes.push({ sheetRow, typed: amountCell, reason: 'not a US dollar amount; imported with no amount' });
    }

    lines.push({ sheetRow, date, rep: repCell, businessName: bizCell, points, amountUsd });
  }
  return { headerRow: headerIdx + 1, lines, skipped, amountNotes };
}

// ---------------------------------------------------------------------------
// Sheet labels → board rows
// ---------------------------------------------------------------------------

export interface LabelledRow {
  id: string;
  label: string;
  archived: boolean;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The board row a sheet label belongs to, among one section's rows.
 *
 * 1. Exact label (trimmed, case and inner spacing ignored), a live row before an archived one.
 * 2. Otherwise a live row whose label joins names with "&" and lists this one, e.g. a log line by
 *    "Others" belongs to the row "<Name> & Others". Only when exactly one row qualifies.
 * 3. Otherwise none: the caller creates an ARCHIVED row for it. Names are never merged on
 *    similarity ("Kev" is not "Kevin"): that would be guessing who someone is.
 */
export function resolveRowLabel(sheetLabel: string, rows: readonly LabelledRow[]): LabelledRow | null {
  const want = norm(sheetLabel);
  if (!want) return null;
  const exact = rows.filter((r) => norm(r.label) === want);
  const live = exact.find((r) => !r.archived);
  if (live) return live;
  if (exact.length) return exact[0];
  const joined = rows.filter((r) => !r.archived && r.label.includes('&') && r.label.split('&').some((p) => norm(p) === want));
  return joined.length === 1 ? joined[0] : null;
}

// ---------------------------------------------------------------------------
// History → accounting_scoreboard_entries
// ---------------------------------------------------------------------------

export type HistoryCheck = 'comp' | 'avg_pm' | 'sum' | 'avg';

export interface HistoryBlockSpec {
  section: SectionKey;
  /** The block's title in column A of the History tab. */
  title: string;
  kind: 'am_pm' | 'daily';
  /**
   * The weekly figure the sheet pasted beside each row, recomputed to prove the week's alignment:
   * comp = Σ(AM − PM) with a blank as 0 (buckets) · avg_pm = AVERAGE of the PM counts (inbox) ·
   * sum = the week's total (onboarding) · avg = the week's average (PM buckets).
   */
  check: HistoryCheck;
}

export const HISTORY_BLOCKS: readonly HistoryBlockSpec[] = [
  { section: 'buckets', title: 'Accounting Buckets', kind: 'am_pm', check: 'comp' },
  { section: 'inbox', title: 'Email Inbox', kind: 'am_pm', check: 'avg_pm' },
  { section: 'pm_buckets', title: 'PM Buckets', kind: 'daily', check: 'avg' },
  { section: 'onboarding', title: 'Customer Sales Onboarding', kind: 'daily', check: 'sum' },
];

/** Every block title on the History tab, including the ones not imported, so a block ends at the next. */
export const HISTORY_TITLES: readonly string[] = [
  'Collection Rep',
  'Chargebacks',
  'Payroll Accuracy',
  'Customer Sales Onboarding',
  'Email Inbox',
  'PM Buckets',
  'Accounting Buckets',
];

/** A week is imported when at least this share of its informative rows reproduce the sheet's figure. */
export const WEEK_VERIFY_SHARE = 0.75;
/** …out of at least this many informative rows. Fewer cannot prove an alignment. */
export const WEEK_MIN_INFORMATIVE = 5;

export interface HistoryCell {
  section: SectionKey;
  label: string;
  date: string;
  slot: Extract<Slot, 'am' | 'pm' | 'day'>;
  value: number;
}

export interface HistoryWeek {
  section: SectionKey;
  /** The Sunday key. */
  weekStart: string;
  dates: string[];
  imported: boolean;
  /** Rows with enough numbers to test the alignment, and how many reproduced the sheet's figure. */
  informative: number;
  verified: number;
  /** Imported rows whose own pasted figure disagreed (the sheet's formula bugs), counted, not dropped. */
  disagreeing: string[];
  reason?: string;
}

export interface SkippedCell {
  section: SectionKey;
  label: string;
  date: string;
  typed: string;
  reason: string;
}

export interface HistoryBlockParse {
  spec: HistoryBlockSpec;
  cells: HistoryCell[];
  weeks: HistoryWeek[];
  skippedCells: SkippedCell[];
  /** Rows with numbers but no label in column A: nothing to file them under. */
  unlabelledRows: number[];
}

interface WeekLayout {
  dates: string[];
  /** am_pm: the AM and PM column of each date. daily: the first column of each date's pair. */
  am: number[];
  pm: number[];
  day: number[];
  /** The week's Total / WTD column: the first column that is not part of its data. */
  totalCol: number;
  problem?: string;
}

/** Tolerance for comparing a recomputed figure with the one the sheet shows. */
function tolerance(isFormula: boolean, shown: number): number {
  if (isFormula) return 0.006;
  // Pasted as a value, the figure kept the sheet's display rounding (0 or 1 decimal).
  if (Number.isInteger(shown)) return 0.5;
  if (Math.abs(shown * 10 - Math.round(shown * 10)) < 1e-9) return 0.051;
  return 0.006;
}

function computeCheck(check: HistoryCheck, am: (number | null)[], pm: (number | null)[], day: (number | null)[]): number | null {
  const present = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  const average = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  switch (check) {
    case 'comp':
      return present(am).reduce((a, b) => a + b, 0) - present(pm).reduce((a, b) => a + b, 0);
    case 'avg_pm':
      return average(present(pm));
    case 'sum':
      return present(day).reduce((a, b) => a + b, 0);
    case 'avg':
      return average(present(day));
  }
}

function findWeeks(header: readonly Cell[], ampm: readonly Cell[] | null, kind: HistoryBlockSpec['kind']): WeekLayout[] {
  const weeks: WeekLayout[] = [];
  let cols: Array<{ col: number; date: string }> = [];
  const close = (totalCol: number) => {
    if (!cols.length) return;
    const dates = [...new Set(cols.map((c) => c.date))];
    const w: WeekLayout = { dates, am: [], pm: [], day: [], totalCol };
    if (kind === 'am_pm') {
      for (const d of dates) {
        const mine = cols.filter((c) => c.date === d);
        const am = mine.filter((c) => text(ampm?.[c.col]).toUpperCase() === 'AM');
        const pm = mine.filter((c) => text(ampm?.[c.col]).toUpperCase() === 'PM');
        if (mine.length !== 2 || am.length !== 1 || pm.length !== 1) w.problem = `${d} does not have one AM and one PM column`;
        w.am.push(am[0]?.col ?? -1);
        w.pm.push(pm[0]?.col ?? -1);
      }
    } else {
      for (const d of dates) {
        const mine = cols.filter((c) => c.date === d);
        if (mine.length !== 1) w.problem = `${d} heads more than one column`;
        w.day.push(mine[0].col);
      }
    }
    const ws = new Set(dates.map(weekStartOf));
    const sorted = [...dates].sort();
    if (ws.size !== 1) w.problem = 'the header dates span more than one week';
    else if (dates.some((d) => !isWeekday(d))) w.problem = 'a header date falls on a weekend';
    else if (sorted.join() !== dates.join()) w.problem = 'the header dates are out of order';
    weeks.push(w);
    cols = [];
  };
  for (let j = 1; j < header.length; j++) {
    const t = text(header[j]);
    const date = parseUsDate(t, true);
    if (date) cols.push({ col: j, date });
    else if (t && !/^mtg$/i.test(t)) close(j);
  }
  close(header.length);
  return weeks;
}

/**
 * Parses one block of the History tab.
 *
 * `values` is the UNFORMATTED_VALUE grid (exact numbers; dates still as text), `formulas` the
 * FORMULA grid of the same range, used only to tell a live formula from a pasted value.
 *
 * Alignment rule. Each week is read at the header's own columns: for AM/PM blocks the AM and PM
 * column of each date; for one-number blocks the date's two-column pair, where the number sits in
 * either half. Only the week's data columns are read, never its Total. The week is imported when at
 * least WEEK_VERIFY_SHARE of its informative rows (≥ 2 numbers that are not all equal, a figure
 * shown beside them, and for one-number blocks a number every day) reproduce the figure the sheet
 * shows beside the row. Then every number of the week is imported as typed, including rows whose own
 * figure disagreed, because a week is one paste: if most rows sit on their dates, all do.
 */
export function parseHistoryBlock(values: Grid, formulas: Grid, spec: HistoryBlockSpec): HistoryBlockParse {
  const titleIdx = values.findIndex((r) => text(r?.[0]) === spec.title);
  if (titleIdx < 0) throw new Error(`History: no "${spec.title}" block`);

  const dateCount = (r: readonly Cell[] | undefined) => (r ?? []).filter((c) => parseUsDate(c, true) !== null).length;
  let dateIdx = titleIdx;
  while (dateIdx < values.length && dateCount(values[dateIdx]) < 5) dateIdx++;
  if (dateIdx >= values.length) throw new Error(`History: the "${spec.title}" block has no date row`);

  let ampm: readonly Cell[] | null = null;
  if (spec.kind === 'am_pm') {
    for (let i = titleIdx; i < dateIdx; i++) {
      if ((values[i] ?? []).filter((c) => text(c).toUpperCase() === 'AM').length >= 2) ampm = values[i];
    }
    if (!ampm) throw new Error(`History: the "${spec.title}" block has no AM/PM row`);
  }

  // Data rows: after the block's own day-total row, up to the next block title.
  const titles = new Set(HISTORY_TITLES);
  const rowIdx: number[] = [];
  const unlabelledRows: number[] = [];
  for (let i = dateIdx + 2; i < values.length; i++) {
    const label = text(values[i]?.[0]);
    if (titles.has(label)) break;
    if (label) rowIdx.push(i);
    else if ((values[i] ?? []).slice(1).some((c) => numberCell(c) !== null)) unlabelledRows.push(i + 1);
  }

  const header = values[dateIdx] ?? [];
  const layouts = findWeeks(header, ampm, spec.kind);

  // A date the header lists twice (a week pasted twice, or a typo) belongs to neither copy.
  const seen = new Map<string, number>();
  for (const w of layouts) for (const d of w.dates) seen.set(d, (seen.get(d) ?? 0) + 1);

  const cells: HistoryCell[] = [];
  const weeks: HistoryWeek[] = [];
  const skippedCells: SkippedCell[] = [];

  for (const w of layouts) {
    const report: HistoryWeek = {
      section: spec.section,
      weekStart: weekStartOf(w.dates[0]),
      dates: w.dates,
      imported: false,
      informative: 0,
      verified: 0,
      disagreeing: [],
    };
    weeks.push(report);
    if (w.problem) {
      report.reason = w.problem;
      continue;
    }
    if (w.dates.some((d) => (seen.get(d) ?? 0) > 1)) {
      report.reason = 'the History tab lists these dates twice';
      continue;
    }

    const lastData = w.totalCol - 1;
    const rowRead = rowIdx.map((i) => {
      const row = values[i] ?? [];
      const label = text(row[0]);
      const read: Array<{ date: string; slot: HistoryCell['slot']; value: number | null; typed: string; ambiguous: boolean }> = [];
      if (spec.kind === 'am_pm') {
        w.dates.forEach((date, k) => {
          for (const [slot, col] of [['am', w.am[k]], ['pm', w.pm[k]]] as const) {
            read.push({ date, slot, value: numberCell(row[col]), typed: text(row[col]), ambiguous: false });
          }
        });
      } else {
        w.dates.forEach((date, k) => {
          const a = w.day[k];
          const b = a + 1 <= lastData && parseUsDate(header[a + 1], true) === null ? a + 1 : -1;
          const va = numberCell(row[a]);
          const vb = b >= 0 ? numberCell(row[b]) : null;
          const ambiguous = va !== null && vb !== null;
          const typed = [text(row[a]), b >= 0 ? text(row[b]) : ''].filter(Boolean).join(' | ');
          read.push({ date, slot: 'day', value: ambiguous ? null : va ?? vb, typed, ambiguous });
        });
      }
      const am = read.filter((r) => r.slot === 'am').map((r) => r.value);
      const pm = read.filter((r) => r.slot === 'pm').map((r) => r.value);
      const day = read.filter((r) => r.slot === 'day').map((r) => r.value);
      const nums = read.map((r) => r.value).filter((v): v is number => v !== null);
      const shown = numberCell(row[w.totalCol]);
      const isFormula = text(formulas[i]?.[w.totalCol]).startsWith('=');
      const complete = spec.kind === 'am_pm' || day.every((v) => v !== null);
      const informative = complete && nums.length >= 2 && new Set(nums).size > 1 && shown !== null;
      const computed = computeCheck(spec.check, am, pm, day);
      const ok = informative && computed !== null && Math.abs(computed - (shown as number)) <= tolerance(isFormula, shown as number);
      return { label, read, informative, ok };
    });

    report.informative = rowRead.filter((r) => r.informative).length;
    report.verified = rowRead.filter((r) => r.ok).length;
    const hasNumbers = rowRead.some((r) => r.read.some((c) => c.value !== null));
    if (!hasNumbers) {
      report.reason = 'no numbers that week';
      continue;
    }
    if (report.informative < WEEK_MIN_INFORMATIVE) {
      report.reason = `only ${report.informative} row(s) can be checked against the sheet's own figure (need ${WEEK_MIN_INFORMATIVE})`;
      continue;
    }
    if (report.verified / report.informative < WEEK_VERIFY_SHARE) {
      report.reason = `only ${report.verified} of ${report.informative} rows reproduce the sheet's own figure at the header's columns`;
      continue;
    }

    report.imported = true;
    for (const r of rowRead) {
      if (r.informative && !r.ok) report.disagreeing.push(r.label);
      for (const c of r.read) {
        if (c.ambiguous) {
          skippedCells.push({ section: spec.section, label: r.label, date: c.date, typed: c.typed, reason: 'two numbers for one day' });
          continue;
        }
        if (c.value === null) {
          if (c.typed) skippedCells.push({ section: spec.section, label: r.label, date: c.date, typed: c.typed, reason: 'not a number' });
          continue;
        }
        if (c.value < 0 || c.value > 100_000 || Math.round(c.value * 100) !== c.value * 100) {
          skippedCells.push({ section: spec.section, label: r.label, date: c.date, typed: c.typed, reason: 'outside 0–100,000 with at most 2 decimals' });
          continue;
        }
        cells.push({ section: spec.section, label: r.label, date: c.date, slot: c.slot, value: c.value });
      }
    }
  }

  return { spec, cells, weeks, skippedCells, unlabelledRows };
}

// ---------------------------------------------------------------------------
// Totals - History (and any tab kept whole) → accounting_scoreboard_archive
// ---------------------------------------------------------------------------

export interface ArchiveRow {
  sheetRow: number;
  /** The row's cells as the sheet displays them, column A first, trailing blanks dropped. */
  cells: string[];
  /** Column A as a date when it is one (MM/DD/YYYY), else null (header, weekly totals, notes). */
  entryDate: string | null;
}

/** Every non-blank row of a tab, as typed. Nothing is interpreted beyond reading column A as a date. */
export function parseArchiveTab(grid: Grid): ArchiveRow[] {
  const out: ArchiveRow[] = [];
  grid.forEach((row, i) => {
    const cells = (row ?? []).map((c) => (c === null || c === undefined ? '' : String(c)));
    while (cells.length && !cells[cells.length - 1].trim()) cells.pop();
    if (!cells.length) return;
    out.push({ sheetRow: i + 1, cells, entryDate: parseUsDate(cells[0]) });
  });
  return out;
}
