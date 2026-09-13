/**
 * The pipe-table half of a Penny reply: parsing, and the column analysis that
 * decides how a table is laid out.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * It used to live inside `ceo-chat-message.tsx`, where the test runner
 * (`node --import tsx --test "src/**\/*.test.ts"`) cannot reach it. Same split
 * and same reason as `chat-markdown.ts`: the parser is pure and React-free so it
 * can be tested against the ways a chat table actually breaks, and the renderer
 * only maps data onto elements.
 *
 * ── What the analysis is for ─────────────────────────────────────────────────
 * The model writes these tables, and it is inconsistent in two specific ways
 * that no amount of prompt wording fixes:
 *
 *  1. It forgets the alignment colon. `|---:|` is easy to omit, and a column of
 *     pesos rendered flush-left is unreadable. So a column whose values are ALL
 *     figures is right-aligned unless the separator row said otherwise —
 *     declared alignment always wins, inference never overrides an instruction.
 *  2. It emits columns of wildly different widths — an action name or a note
 *     beside a date and an amount. Every cell used to be `whitespace-nowrap`,
 *     which turned one long note into a table nothing could read without
 *     scrolling sideways. Only the columns that actually need to wrap get to.
 *
 * The third fix here is not cosmetic: a row with MORE cells than the header used
 * to have the extras dropped silently, because the renderer iterated the header.
 * `buildTable` pads every row and the header to one width, so an unexpected cell
 * shows up as an extra column instead of disappearing out of an audit table.
 */

export type Align = 'left' | 'right' | 'center';

export interface TableColumn {
  align: Align;
  /** `declared` = the separator row said so. `inferred` = read off the data. */
  alignSource: 'declared' | 'inferred';
  /** Every value is a figure — render with tabular numerals so digits line up. */
  numeric: boolean;
  /** Values are long enough that forbidding a line break would hurt more. */
  wrap: boolean;
}

export interface ParsedTable {
  headers: string[];
  columns: TableColumn[];
  rows: string[][];
}

/** Split a markdown table row into trimmed cells (tolerates missing outer pipes). */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

const SEP_CELL = /^:?-{1,}:?$/;

export function isSeparator(line: string): boolean {
  if (!line.includes('|') && !line.includes('-')) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c.replace(/\s/g, '')));
}

/**
 * Cells that carry no value. They neither make a column non-numeric nor count
 * toward its width — "-" is Penny's own empty marker, and one dash in a column
 * of pesos must not flip it back to left-aligned.
 */
const PLACEHOLDERS = new Set(['', '-', '–', '—', 'n/a', 'N/A', 'null', 'none', '—-']);

function isPlaceholder(cell: string): boolean {
  return PLACEHOLDERS.has(cell.trim());
}

/**
 * Does this cell read as a figure? Money, counts, percentages, and the
 * accounting negative — the shapes that actually appear in payroll answers.
 * A date does NOT count: `2026-09-12` is not a quantity and right-aligning a
 * date column against an amount column reads as a mistake.
 */
export function isFigure(cell: string): boolean {
  const s = cell.trim();
  if (!s) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false; // ISO date, not a quantity
  const bare = s
    .replace(/^\((.*)\)$/, '-$1') // (1,234.00) → -1234.00
    .replace(/[₱$€£¥]/g, '')
    .replace(/%$/, '')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .trim();
  return /^[+-]?\d+(\.\d+)?$/.test(bare);
}

/**
 * Longest a column's values may get before it is allowed to wrap. Below this a
 * column stays on one line, which is what keeps dates, emails and amounts from
 * breaking mid-value.
 */
export const WRAP_THRESHOLD = 24;

/**
 * Assemble one table from its raw lines, normalising the grid and analysing
 * each column. `separator` may be null only when the caller has already
 * established the table some other way; normally it is the `|---|---|` line.
 */
export function buildTable(header: string, separator: string, bodyLines: string[]): ParsedTable {
  const headerCells = splitRow(header);
  const sepCells = splitRow(separator);
  const bodyRows = bodyLines.map(splitRow);

  // One width for the whole grid. Taking the MAX (not the header's length) is
  // what stops a row with an extra cell — an unescaped `|` inside a note, say —
  // from having its tail silently swallowed.
  const width = Math.max(
    headerCells.length,
    sepCells.length,
    ...bodyRows.map((r) => r.length),
    1,
  );

  const pad = (cells: string[]) =>
    cells.length === width ? cells : [...cells, ...Array(width - cells.length).fill('')];

  const headers = pad(headerCells);
  const rows = bodyRows.map(pad);

  const columns: TableColumn[] = [];
  for (let c = 0; c < width; c++) {
    const sep = (sepCells[c] ?? '').trim();
    const left = sep.startsWith(':');
    const right = sep.endsWith(':');
    const declared: Align | null = left && right ? 'center' : right ? 'right' : left ? 'left' : null;

    const values = rows.map((r) => r[c] ?? '');
    const meaningful = values.filter((v) => !isPlaceholder(v));
    const numeric = meaningful.length > 0 && meaningful.every(isFigure);

    // The header is part of the column's width — a long header wraps too — but
    // it never decides whether the column is numeric.
    const longest = Math.max(
      headers[c]?.length ?? 0,
      ...values.map((v) => v.length),
      0,
    );

    columns.push({
      align: declared ?? (numeric ? 'right' : 'left'),
      alignSource: declared ? 'declared' : 'inferred',
      numeric,
      // A numeric column never wraps: breaking a figure across two lines is
      // worse than the horizontal scroll it would save.
      wrap: !numeric && longest > WRAP_THRESHOLD,
    });
  }

  return { headers, columns, rows };
}
