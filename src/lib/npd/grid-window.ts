/**
 * Which rows the NPD grid draws (src/components/npd/NpdSheetGrid.tsx). Pure, tested
 * (grid-window.test.ts).
 *
 * Kane, 2026-10-02: "its extremly lag switching between tabs though". A 600-person
 * sheet drew all 18,600 cells on every tab or week switch: 1.8–2.1 s, the page frozen
 * up to 0.9 s at a time. The grid now draws only the rows in view, plus OVERSCAN either
 * side, plus PINNED rows that must always exist in the DOM wherever they are: the
 * active cell's row (keyboard moves scroll it into view), the row being edited (its
 * editor must not unmount mid-edit) and the row whose formula menu is open (the menu is
 * placed under that cell). Between drawn rows sit spacer rows exactly as tall as the
 * rows they stand for, so the scroll height and every row's position never change.
 */

export const GRID_OVERSCAN = 12;

/** The rows [start, end) that cover the visible part of the scroller, plus overscan. */
export function visibleRowWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  /** Height of the sticky header block above the first row. */
  headerHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}): { start: number; end: number } {
  const { scrollTop, viewportHeight, headerHeight, rowCount } = input;
  const rowHeight = input.rowHeight > 0 ? input.rowHeight : 1;
  const overscan = input.overscan ?? GRID_OVERSCAN;
  if (rowCount <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight);
  const last = Math.ceil(Math.max(0, scrollTop + viewportHeight - headerHeight) / rowHeight);
  const start = Math.min(rowCount, Math.max(0, first - overscan));
  const end = Math.min(rowCount, Math.max(start, last + overscan));
  return { start, end };
}

export type RowSegment = { kind: 'rows'; from: number; to: number } | { kind: 'gap'; at: number; rows: number };

/**
 * The drawing plan for `rowCount` rows: the window plus the pinned rows, in order,
 * with a gap segment (a spacer of `rows` rows' height) wherever rows are skipped.
 * Every row index 0…rowCount-1 is covered exactly once by a `rows` or `gap` segment.
 */
export function rowRenderPlan(rowCount: number, window: { start: number; end: number }, pinned: readonly number[]): RowSegment[] {
  if (rowCount <= 0) return [];
  const drawn = new Set<number>();
  for (let r = Math.max(0, window.start); r < Math.min(rowCount, window.end); r += 1) drawn.add(r);
  for (const p of pinned) if (Number.isInteger(p) && p >= 0 && p < rowCount) drawn.add(p);
  const order = [...drawn].sort((x, y) => x - y);
  const out: RowSegment[] = [];
  let next = 0;
  for (const r of order) {
    if (r > next) out.push({ kind: 'gap', at: next, rows: r - next });
    const last = out[out.length - 1];
    if (last && last.kind === 'rows' && last.to === r) last.to = r + 1;
    else out.push({ kind: 'rows', from: r, to: r + 1 });
    next = r + 1;
  }
  if (next < rowCount) out.push({ kind: 'gap', at: next, rows: rowCount - next });
  return out;
}
