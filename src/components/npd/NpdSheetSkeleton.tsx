'use client';

import { cn } from '@/lib/utils';
import { NPD_SHEET_LABELS, type NpdColumn, type NpdSheetKind } from '@/lib/npd/columns';
import { columnLetter } from '@/lib/npd/formulas';
import { ROW_HEAD_W, SHEET_FONT } from './NpdSheetGrid';

/**
 * NPD's loading state: the grid's own skeleton (Kane, 2026-10-02: "Change the table to
 * be skeleton loading please"). It is the real table's frame: the same toolbar and
 * active-cell bar heights, the same columns, widths, column letters and headers (all
 * known before any data arrives), real row numbers and h-8 rows. Only the cells are
 * placeholders, sized like the data that lands in them, so nothing jumps when the
 * sheet arrives. One calm pulse over the body; none under reduced motion.
 * Governing doc: docs/features/npd-dashboard.md § The grid.
 */

const SKELETON_ROWS = 14;
/** The last rows fade out: there is more sheet below, not a short one. */
const FADE_FROM = 9;

/** A stable 0–99 per cell, so the bars read like data rather than stripes. */
function noise(r: number, c: number): number {
  return (Math.imul(r * 31 + c * 17 + 7, 2654435761) >>> 0) % 100;
}

/** How wide the bar in a cell is (% of the cell), or 0 for a cell left empty. */
function barWidth(col: NpdColumn, r: number, c: number): number {
  const n = noise(r, c);
  if (col.key === 'work_email') return 62 + (n % 28);
  if (col.key === 'name') return 48 + (n % 32);
  if (col.key.startsWith('notes_')) return n < 22 ? 40 + (n % 30) : 0;
  if (col.align === 'right') return n < 18 ? 0 : 34 + (n % 26);
  return n < 12 ? 0 : 38 + (n % 34);
}

export default function NpdSheetSkeleton({ sheet, columns }: { sheet: NpdSheetKind; columns: readonly NpdColumn[] }) {
  const totalWidth = ROW_HEAD_W + columns.reduce((s, c) => s + c.width, 0);
  const label = `Loading the ${NPD_SHEET_LABELS[sheet]} sheet…`;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" role="status" aria-live="polite" aria-busy="true" data-testid="npd-sheet-skeleton">
      <span className="sr-only">{label}</span>

      {/* Toolbar: the same height and rhythm as the real one (its labels hide on a phone, so do these). */}
      <div className="flex items-center gap-1.5" aria-hidden>
        <span className="h-7 w-7 rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
        <span className="h-7 w-7 rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" />
        <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="h-7 w-7 rounded-md border border-zinc-200 bg-white sm:w-24 dark:border-zinc-800 dark:bg-zinc-950" />
        ))}
        <span className="ml-auto h-2.5 w-20 rounded-full bg-zinc-100 dark:bg-zinc-900" />
      </div>

      {/* Active-cell bar. */}
      <div className="flex min-h-9 items-stretch overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-hidden>
        <div className="flex w-36 shrink-0 items-center border-r border-zinc-200 bg-zinc-50 px-2.5 dark:border-zinc-800 dark:bg-zinc-900">
          <span className="h-2.5 w-20 rounded-full bg-zinc-200 dark:bg-zinc-800" />
        </div>
      </div>

      {/* The grid's frame, with the real header rows. */}
      <div
        className="relative min-h-[18rem] flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-[#0d1117]"
        aria-hidden
      >
        <table className={cn('table-keep table-fixed border-separate border-spacing-0', SHEET_FONT)} style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: ROW_HEAD_W }} />
            {columns.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="h-[22px] border-b border-r border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" />
              {columns.map((c, i) => (
                <th
                  key={c.key}
                  className="h-[22px] border-b border-r border-zinc-200 bg-zinc-100 px-1 text-center text-[10.5px] font-medium tabular-nums text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500"
                >
                  {columnLetter(i)}
                </th>
              ))}
            </tr>
            <tr>
              <th className="border-b border-r border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" />
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="whitespace-pre-line border-b border-r border-zinc-200 bg-zinc-100 px-2 py-1.5 text-center align-bottom text-[11px] font-semibold leading-tight text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="animate-pulse motion-reduce:animate-none">
            {Array.from({ length: SKELETON_ROWS }, (_, r) => (
              <tr key={r} style={r >= FADE_FROM ? { opacity: 1 - (r - FADE_FROM + 1) / (SKELETON_ROWS - FADE_FROM + 1) } : undefined}>
                <th className="h-8 border-b border-r border-zinc-200 bg-zinc-50 px-1.5 text-right text-[11px] font-medium tabular-nums text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-600">
                  {r + 1}
                </th>
                {columns.map((col, c) => {
                  const w = barWidth(col, r, c);
                  return (
                    <td key={col.key} className="h-8 border-b border-r border-zinc-200 px-2 dark:border-zinc-800">
                      {w > 0 && (
                        <span
                          className={cn('block h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800', col.align === 'right' && 'ml-auto')}
                          style={{ width: `${w}%` }}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
