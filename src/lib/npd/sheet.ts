/**
 * NPD sheet model — pure, isomorphic, unit-tested (sheet.test.ts).
 *
 * A sheet is an ordered list of rows; a row is a stable id plus one string per
 * column of its tab (columns.ts). The grid edits this model, the route
 * validates it, and the database stores it, so the three agree on one shape.
 *
 * Invariants the rest of NPD leans on:
 *  - A cell is a string, verbatim. Nothing here parses, rounds or reformats a
 *    figure. `''` is an empty cell; it is stored as NULL and read back as `''`.
 *  - A row's id is stable across saves (the client mints it once). That is what
 *    lets the route say WHICH rows a save removes, and audit their contents
 *    before they are gone.
 *  - Trailing blank rows are UI spares, never saved. A blank row BETWEEN filled
 *    rows is kept: the sheet this replaces uses them as separators.
 */

import { sundayOf } from '@/lib/payroll/manila-week';
import { NPD_COLUMNS, isNpdSheetKind, normalizeHeaderText, type NpdColumn, type NpdSheetKind } from './columns';

export type NpdRow = { readonly id: string; readonly values: readonly string[] };
export type CellPos = { readonly row: number; readonly col: number };
/** Inclusive, normalised (r0 ≤ r1, c0 ≤ c1). */
export type CellRange = { readonly r0: number; readonly c0: number; readonly r1: number; readonly c1: number };

/** A pay week is ~300 people; 2,000 leaves room without letting a runaway paste through. */
export const NPD_MAX_ROWS = 2000;
export const NPD_MAX_CELL_LENGTH = 5000;
/** Blank rows kept below the last filled row, so there is always somewhere to paste. */
export const NPD_SPARE_ROWS = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Rows ────────────────────────────────────────────────────────────────────

export function blankRow(id: string, width: number): NpdRow {
  return { id, values: Array.from({ length: width }, () => '') };
}

/** Whitespace-only cells count as empty: a row of spaces is not data. */
export function isBlankRow(row: NpdRow): boolean {
  return row.values.every((v) => v.trim() === '');
}

export function trimTrailingBlankRows(rows: readonly NpdRow[]): NpdRow[] {
  let end = rows.length;
  while (end > 0 && isBlankRow(rows[end - 1]!)) end -= 1;
  return rows.slice(0, end);
}

/** Exactly `spare` blank rows after the last filled row (more are trimmed, fewer are added). */
export function ensureSpareRows(
  rows: readonly NpdRow[],
  width: number,
  newId: () => string,
  spare: number = NPD_SPARE_ROWS,
): NpdRow[] {
  const filled = trimTrailingBlankRows(rows);
  const trailing = rows.slice(filled.length, filled.length + spare);
  const out = [...filled, ...trailing];
  while (out.length < filled.length + spare) out.push(blankRow(newId(), width));
  return out;
}

export function normalizeRange(a: CellPos, b: CellPos): CellRange {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

function withValues(row: NpdRow, values: string[]): NpdRow {
  return { id: row.id, values };
}

export function setCell(rows: readonly NpdRow[], pos: CellPos, value: string): NpdRow[] {
  const row = rows[pos.row];
  if (!row || pos.col < 0 || pos.col >= row.values.length) return [...rows];
  const clean = cleanCell(value).value;
  if (row.values[pos.col] === clean) return [...rows];
  const values = [...row.values];
  values[pos.col] = clean;
  const out = [...rows];
  out[pos.row] = withValues(row, values);
  return out;
}

export function clearRange(rows: readonly NpdRow[], range: CellRange): NpdRow[] {
  const out = [...rows];
  for (let r = range.r0; r <= range.r1 && r < out.length; r += 1) {
    const row = out[r]!;
    let changed = false;
    const values = [...row.values];
    for (let c = range.c0; c <= range.c1 && c < values.length; c += 1) {
      if (values[c] !== '') {
        values[c] = '';
        changed = true;
      }
    }
    if (changed) out[r] = withValues(row, values);
  }
  return out;
}

export function insertRows(
  rows: readonly NpdRow[],
  at: number,
  count: number,
  width: number,
  newId: () => string,
): NpdRow[] {
  const index = Math.max(0, Math.min(at, rows.length));
  const fresh = Array.from({ length: Math.max(0, count) }, () => blankRow(newId(), width));
  return [...rows.slice(0, index), ...fresh, ...rows.slice(index)];
}

export function deleteRows(rows: readonly NpdRow[], r0: number, r1: number): NpdRow[] {
  const lo = Math.max(0, Math.min(r0, r1));
  const hi = Math.max(r0, r1);
  return rows.filter((_, i) => i < lo || i > hi);
}

/** The cells of a range, for Copy. */
export function rangeToMatrix(rows: readonly NpdRow[], range: CellRange): string[][] {
  const out: string[][] = [];
  for (let r = range.r0; r <= range.r1 && r < rows.length; r += 1) {
    out.push(rows[r]!.values.slice(range.c0, range.c1 + 1));
  }
  return out;
}

// ─── Cells ───────────────────────────────────────────────────────────────────

/**
 * Postgres `text` cannot hold U+0000, and a cell longer than the cap is refused
 * by the route. A paste never carries either from Google Sheets, so cleaning
 * here is for the stray case, and the caller is told how many cells it touched.
 */
export function cleanCell(value: string): { value: string; clipped: boolean } {
  let v = value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  let clipped = false;
  if (v.length > NPD_MAX_CELL_LENGTH) {
    v = v.slice(0, NPD_MAX_CELL_LENGTH);
    clipped = true;
  }
  return { value: v, clipped };
}

// ─── Paste ───────────────────────────────────────────────────────────────────

/**
 * Is this pasted line the sheet's header row? Kane's NPD sheets are copied with
 * their header more often than not, and a header pasted as data would put
 * "Work Email" in a person's row. Yes when at least two non-empty cells, and at
 * least 60% of them, are this tab's headers (or their known misspellings). A
 * data row never reads like that; one stray "HRIS" cell is not enough.
 */
export function looksLikeHeaderRow(cells: readonly string[], columns: readonly NpdColumn[]): boolean {
  const known = new Set<string>();
  for (const col of columns) {
    known.add(normalizeHeaderText(col.header));
    for (const alias of col.headerAliases ?? []) known.add(normalizeHeaderText(alias));
  }
  const filled = cells.map((c) => normalizeHeaderText(c)).filter((c) => c !== '');
  if (filled.length < 2) return false;
  const hits = filled.filter((c) => known.has(c)).length;
  return hits >= 2 && hits * 10 >= filled.length * 6;
}

export type PasteOutcome = {
  rows: NpdRow[];
  /** The cells the paste wrote, for selecting them afterwards. */
  range: CellRange;
  headerSkipped: boolean;
  /** Most cells any one line had past the last column; they are not pasted. */
  droppedColumns: number;
  /** Lines past NPD_MAX_ROWS; they are not pasted. */
  droppedRows: number;
  addedRows: number;
  clippedCells: number;
};

/**
 * Paste `matrix` with its top-left cell at `at`, filling right and down and
 * adding rows as needed. A single copied cell pasted onto a selection fills the
 * whole selection (the spreadsheet behaviour). Returns null when there is
 * nothing to paste.
 */
export function applyPaste(
  rows: readonly NpdRow[],
  at: CellPos,
  matrix: readonly (readonly string[])[],
  columns: readonly NpdColumn[],
  newId: () => string,
  selection?: CellRange | null,
): PasteOutcome | null {
  let lines = matrix;
  let headerSkipped = false;
  if (lines.length > 0 && looksLikeHeaderRow(lines[0]!, columns)) {
    lines = lines.slice(1);
    headerSkipped = true;
  }
  const width = columns.length;
  const startRow = Math.max(0, at.row);
  const startCol = Math.max(0, Math.min(at.col, width - 1));

  if (lines.length === 0) {
    return headerSkipped
      ? {
          rows: [...rows],
          range: { r0: startRow, c0: startCol, r1: startRow, c1: startCol },
          headerSkipped,
          droppedColumns: 0,
          droppedRows: 0,
          addedRows: 0,
          clippedCells: 0,
        }
      : null;
  }

  const single = lines.length === 1 && lines[0]!.length === 1;
  if (single && selection && (selection.r1 > selection.r0 || selection.c1 > selection.c0)) {
    const fill = lines[0]![0]!;
    const filled: string[][] = [];
    for (let r = selection.r0; r <= selection.r1; r += 1) {
      filled.push(Array.from({ length: selection.c1 - selection.c0 + 1 }, () => fill));
    }
    return applyPaste(rows, { row: selection.r0, col: selection.c0 }, filled, columns, newId, null);
  }

  const room = Math.max(0, NPD_MAX_ROWS - startRow);
  const droppedRows = Math.max(0, lines.length - room);
  const kept = lines.slice(0, room);

  const out = [...rows];
  let addedRows = 0;
  while (out.length < startRow + kept.length) {
    out.push(blankRow(newId(), width));
    addedRows += 1;
  }

  let droppedColumns = 0;
  let clippedCells = 0;
  let maxCol = startCol;
  kept.forEach((line, i) => {
    const r = startRow + i;
    const row = out[r]!;
    const values = [...row.values];
    line.forEach((raw, j) => {
      const c = startCol + j;
      if (c >= width) return;
      const { value, clipped } = cleanCell(raw);
      if (clipped) clippedCells += 1;
      values[c] = value;
      if (c > maxCol) maxCol = c;
    });
    droppedColumns = Math.max(droppedColumns, startCol + line.length - width);
    out[r] = withValues(row, values);
  });

  return {
    rows: out,
    range: { r0: startRow, c0: startCol, r1: startRow + Math.max(0, kept.length - 1), c1: maxCol },
    headerSkipped,
    droppedColumns: Math.max(0, droppedColumns),
    droppedRows,
    addedRows,
    clippedCells,
  };
}

// ─── Weeks ───────────────────────────────────────────────────────────────────

export function isSundayIso(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d && dt.getUTCDay() === 0
  );
}

export function shiftWeek(weekStart: string, weeks: number): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + weeks * 7));
  return dt.toISOString().slice(0, 10);
}

/**
 * The week NPD opens on when a tab has no sheet yet: the last COMPLETED Sun–Sat
 * week, i.e. the one payroll is being run for. `todayIso` is a Manila date.
 */
export function defaultNpdWeek(todayIso: string): string {
  return shiftWeek(sundayOf(todayIso), -1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 20 – Sep 26, 2026"; the year is printed twice only when the week spans New Year. */
export function weekLabel(weekStart: string): string {
  const [sy, sm, sd] = weekStart.split('-').map(Number);
  const sat = new Date(Date.UTC(sy!, sm! - 1, sd! + 6));
  const ey = sat.getUTCFullYear();
  const left = `${MONTHS[sm! - 1]} ${sd}`;
  const right = `${MONTHS[sat.getUTCMonth()]} ${sat.getUTCDate()}, ${ey}`;
  return sy === ey ? `${left} – ${right}` : `${left}, ${sy} – ${right}`;
}

// ─── Save contract (route side) ──────────────────────────────────────────────

export type NpdSaveBody = {
  sheet: NpdSheetKind;
  week: string;
  expectedVersion: number;
  /** Trailing blank rows already trimmed. */
  rows: NpdRow[];
};

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** The PUT body, checked field by field. Nothing is coerced: a wrong shape is refused. */
export function validateSaveBody(raw: unknown): Validation<NpdSaveBody> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  if (!isNpdSheetKind(b.sheet)) return { ok: false, error: 'sheet must be all_departments or hsl' };
  if (!isSundayIso(b.week)) return { ok: false, error: 'week must be a Sunday (YYYY-MM-DD)' };
  if (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 0) {
    return { ok: false, error: 'expectedVersion must be a whole number ≥ 0' };
  }
  if (!Array.isArray(b.rows)) return { ok: false, error: 'rows must be an array' };

  const width = NPD_COLUMNS[b.sheet].length;
  const seen = new Set<string>();
  const rows: NpdRow[] = [];
  for (let i = 0; i < b.rows.length; i += 1) {
    const r = b.rows[i] as Record<string, unknown> | null;
    const at = `Row ${i + 1}`;
    if (!r || typeof r !== 'object') return { ok: false, error: `${at} is not an object` };
    if (typeof r.id !== 'string' || !UUID_RE.test(r.id)) return { ok: false, error: `${at} has no valid id` };
    const id = r.id.toLowerCase();
    if (seen.has(id)) return { ok: false, error: `${at} repeats another row's id` };
    seen.add(id);
    if (!Array.isArray(r.values) || r.values.length !== width) {
      return { ok: false, error: `${at} must have exactly ${width} cells` };
    }
    for (let c = 0; c < width; c += 1) {
      const v = r.values[c];
      if (typeof v !== 'string') return { ok: false, error: `${at}, column ${c + 1} is not text` };
      if (v.includes('\u0000')) return { ok: false, error: `${at}, column ${c + 1} holds a NUL character` };
      if (v.length > NPD_MAX_CELL_LENGTH) {
        return { ok: false, error: `${at}, column ${c + 1} is over ${NPD_MAX_CELL_LENGTH} characters` };
      }
    }
    rows.push({ id, values: r.values as string[] });
  }
  const trimmed = trimTrailingBlankRows(rows);
  if (trimmed.length > NPD_MAX_ROWS) {
    return { ok: false, error: `A sheet holds at most ${NPD_MAX_ROWS} rows (this one has ${trimmed.length})` };
  }
  return { ok: true, value: { sheet: b.sheet, week: b.week, expectedVersion: b.expectedVersion, rows: trimmed } };
}

// ─── Lock in (route side) ────────────────────────────────────────────────────

/** An unlock says why. Long enough for a sentence, short enough for an audit row. */
export const NPD_UNLOCK_REASON_MAX = 500;

export type NpdLockBody =
  | { action: 'lock'; sheet: NpdSheetKind; week: string; expectedVersion: number }
  | { action: 'unlock'; sheet: NpdSheetKind; week: string; reason: string };

/**
 * The PATCH body. Lock carries the version the editor is looking at (a lock
 * only freezes what was seen). Unlock carries a reason — required, trimmed,
 * never blank — because unlocking lets locked-in values change again.
 */
export function validateLockBody(raw: unknown): Validation<NpdLockBody> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  if (b.action !== 'lock' && b.action !== 'unlock') return { ok: false, error: 'action must be lock or unlock' };
  if (!isNpdSheetKind(b.sheet)) return { ok: false, error: 'sheet must be all_departments or hsl' };
  if (!isSundayIso(b.week)) return { ok: false, error: 'week must be a Sunday (YYYY-MM-DD)' };
  if (b.action === 'lock') {
    if (typeof b.expectedVersion !== 'number' || !Number.isInteger(b.expectedVersion) || b.expectedVersion < 1) {
      return { ok: false, error: 'expectedVersion must be the saved version you are looking at (a whole number ≥ 1)' };
    }
    return { ok: true, value: { action: 'lock', sheet: b.sheet, week: b.week, expectedVersion: b.expectedVersion } };
  }
  if (typeof b.reason !== 'string') return { ok: false, error: 'An unlock needs a reason' };
  const reason = b.reason.trim();
  if (reason === '') return { ok: false, error: 'An unlock needs a reason' };
  if (reason.length > NPD_UNLOCK_REASON_MAX) {
    return { ok: false, error: `A reason is limited to ${NPD_UNLOCK_REASON_MAX} characters` };
  }
  return { ok: true, value: { action: 'unlock', sheet: b.sheet, week: b.week, reason } };
}

/** Rows the save will remove, by id. Blank rows are not worth a record. */
export function removedRows(before: readonly NpdRow[], after: readonly NpdRow[]): NpdRow[] {
  const kept = new Set(after.map((r) => r.id.toLowerCase()));
  return before.filter((r) => !kept.has(r.id.toLowerCase()) && !isBlankRow(r));
}

// ─── Database records ────────────────────────────────────────────────────────

export type NpdDbRecord = { id: string; row_no: number } & Record<string, string | number | null>;

/** Rows → the objects npd_save_sheet takes. `''` → NULL; row_no is the position, 1-based. */
export function toDbRecords(sheet: NpdSheetKind, rows: readonly NpdRow[]): NpdDbRecord[] {
  const cols = NPD_COLUMNS[sheet];
  return rows.map((row, i) => {
    const rec: NpdDbRecord = { id: row.id, row_no: i + 1 };
    cols.forEach((col, c) => {
      const v = row.values[c] ?? '';
      rec[col.key] = v === '' ? null : v;
    });
    return rec;
  });
}

export function fromDbRecord(sheet: NpdSheetKind, rec: Record<string, unknown>): NpdRow {
  const cols = NPD_COLUMNS[sheet];
  return {
    id: String(rec.id),
    values: cols.map((col) => {
      const v = rec[col.key];
      return typeof v === 'string' ? v : '';
    }),
  };
}

/** A row as an audit entry carries it: only the filled cells, by column key. */
export function rowForAudit(sheet: NpdSheetKind, row: NpdRow): Record<string, string> {
  const cols = NPD_COLUMNS[sheet];
  const out: Record<string, string> = {};
  cols.forEach((col, c) => {
    const v = row.values[c] ?? '';
    if (v !== '') out[col.key] = v;
  });
  return out;
}
