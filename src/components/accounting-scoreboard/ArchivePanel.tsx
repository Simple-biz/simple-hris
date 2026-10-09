/**
 * The Accounting Scoreboard archive page body: a sheet tab kept row for row, AS TYPED.
 * Governing doc: docs/features/accounting-scoreboard-backfill.md.
 *
 * Server-rendered and read-only: no state, no fetch. Every cell prints exactly what the sheet
 * showed ("34/26", "Holiday", "--"), because nobody has said what those columns count, and a
 * parsed number would claim a meaning the sheet never gave. A row whose first cell is not a date
 * (the sheet's weekly "Total" lines, a "HOLIDAY" note) is shaded so it reads as a subtotal.
 */

import { ChevronLeft } from 'lucide-react';
import type { ArchiveTabView } from '@/lib/accounting-scoreboard/archive-server';
import { SCOREBOARD_PAGE } from '@/lib/accounting-scoreboard/host';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (iso: string | null) => (iso ? `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '—');

export default function ArchivePanel({ tabs }: { tabs: ArchiveTabView[] }) {
  return (
    <div className="min-h-dvh w-full bg-zinc-50 dark:bg-[#0d1117]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 bg-white px-4 py-3 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950">
        <a
          href={SCOREBOARD_PAGE}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-zinc-600 underline-offset-4 hover:text-orange-700 hover:underline dark:text-zinc-400 dark:hover:text-orange-300"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Scoreboard
        </a>
        <div className="flex min-w-0 items-center gap-2.5">
          {/* shared.tsx BrandMark, inlined: this page is a server component. */}
          <span className="inline-flex shrink-0 items-center rounded-md border border-zinc-200 bg-white px-1 dark:border-zinc-700">
            <img src="/simple-logo.png" alt="Simple" draggable={false} className="h-7 w-auto" />
          </span>
          <h1 className="truncate text-base font-semibold leading-tight text-zinc-900 sm:text-lg dark:text-zinc-100">
            Scoreboard archive
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-4 py-5 sm:px-6">
        {tabs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
            Nothing has been archived yet.
          </p>
        ) : (
          tabs.map((t) => (
            <section key={t.tab} aria-labelledby={`archive-${t.tab}`} className="space-y-3">
              <div>
                <h2 id={`archive-${t.tab}`} className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {t.tab}
                </h2>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Daily team totals from {monthYear(t.firstDate)} to {monthYear(t.lastDate)}, copied from Carla&apos;s
                  sheet exactly as typed. No board section tracks these numbers, so nothing here is added up or
                  scored. Newest first, as on the sheet.
                </p>
              </div>
              <div className="max-h-[70dvh] overflow-auto rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
                <table className="table-keep w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-900">
                    <tr>
                      {t.header.map((h, i) => (
                        <th
                          key={i}
                          scope="col"
                          className={
                            i === 0
                              ? 'sticky left-0 z-10 whitespace-nowrap bg-zinc-50 px-3 py-2 text-left text-xs font-semibold text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                              : 'whitespace-nowrap px-3 py-2 text-right text-xs font-semibold text-zinc-700 dark:text-zinc-300'
                          }
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r) => {
                      const subtotal = r.entryDate === null;
                      return (
                        <tr
                          key={r.sheetRow}
                          className={
                            subtotal
                              ? 'border-t border-orange-200 bg-orange-50 font-medium dark:border-orange-900/50 dark:bg-[#22170f]'
                              : 'border-t border-zinc-100 dark:border-zinc-800/80'
                          }
                        >
                          {t.header.map((_, i) => {
                            const cell = r.cells[i] ?? '';
                            return i === 0 ? (
                              <th
                                key={i}
                                scope="row"
                                className={`sticky left-0 whitespace-pre-line px-3 py-1.5 text-left font-mono text-xs tabular-nums text-zinc-800 dark:text-zinc-200 ${
                                  subtotal ? 'bg-orange-50 dark:bg-[#22170f]' : 'bg-white dark:bg-zinc-950'
                                }`}
                              >
                                {cell}
                              </th>
                            ) : (
                              <td key={i} className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
                                {cell.trim() ? cell : <span className="text-zinc-300 dark:text-zinc-700">—</span>}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-500">
                {t.rows.length} rows, imported {t.importedAt ? t.importedAt.slice(0, 10) : '—'}. Dates are as typed, including
                the sheet&apos;s own slips (a few weekend dates, eight dates typed twice).
              </p>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
