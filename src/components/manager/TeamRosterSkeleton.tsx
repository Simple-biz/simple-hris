'use client';

/**
 * The cold-load placeholders for Manager → My Team.
 *
 * Kane, 2026-10-06: *"only the table is being skeletoned while the rest is already
 * loaded"*. The panel used to swap its whole frame (header, inner tabs, rail, toolbar)
 * for one "Loading roster…" spinner card. The frame does not depend on the roster, so
 * it now paints at once and only what the roster read fills in is a placeholder: the
 * rail's entries, the counts, and the rows. Each piece below is shaped like what
 * arrives in its place, on the same classes, so the real roster lands where the
 * skeleton was instead of pushing the page around.
 *
 * Shown only while there is nothing to paint (`teamGate.kind === 'loading'`, i.e. no
 * cached roster and no answer yet). A revalidation over a cached roster never shows
 * these (`manager-dashboard-cache.md` § Loading flags).
 */

const BAR = 'skeleton-shimmer rounded';

/** The roster LIST: the real header row, then rows shaped like a member row. */
export function TeamRosterTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="overflow-x-auto" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading roster…</span>
      <table className="w-full text-left text-xs" aria-hidden>
        <thead className="border-b border-blue-100/80 bg-blue-50/40 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
          <tr>
            <th className="w-8 px-3 py-2.5">
              <div className="h-4 w-4 rounded-[4px] border border-blue-200 bg-white/70 dark:border-blue-900/60 dark:bg-zinc-950/40" />
            </th>
            <th className="px-4 py-2.5">Name</th>
            <th className="px-4 py-2.5">Department</th>
            <th className="hidden px-4 py-2.5 sm:table-cell">Title</th>
            <th className="px-4 py-2.5 text-right">Status</th>
            <th className="px-4 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-blue-100/60 dark:divide-blue-900/40">
          {Array.from({ length: rows }).map((_, i) => (
            <tr key={i} className="align-middle">
              <td className="px-3 py-3">
                <div className={`${BAR} h-4 w-4`} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="skeleton-shimmer h-11 w-11 shrink-0 rounded-full" />
                  <div className="min-w-0 space-y-1.5">
                    <div className={`${BAR} h-3`} style={{ width: `${112 + ((i * 37) % 64)}px` }} />
                    <div className={`${BAR} h-2.5`} style={{ width: `${136 + ((i * 53) % 48)}px` }} />
                  </div>
                </div>
              </td>
              <td className="px-4 py-3">
                <div className={`${BAR} h-3 w-24`} />
              </td>
              <td className="hidden px-4 py-3 sm:table-cell">
                <div className={`${BAR} h-3`} style={{ width: `${72 + ((i * 29) % 56)}px` }} />
              </td>
              <td className="px-4 py-3">
                <div className={`${BAR} ml-auto h-3 w-6`} />
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1.5">
                  <div className="skeleton-shimmer h-7 w-14 rounded-md" />
                  <div className="skeleton-shimmer h-7 w-[74px] rounded-md" />
                  <div className="skeleton-shimmer h-7 w-24 rounded-md" />
                  <div className="skeleton-shimmer h-7 w-[76px] rounded-md" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center border-t border-blue-100/80 bg-white/60 px-4 py-2.5 dark:border-blue-900/40 dark:bg-zinc-950/40">
        <div className={`${BAR} h-3 w-28`} />
      </div>
    </div>
  );
}

/** The roster CARDS: the real grid, with card outlines at the card's own height. */
export function TeamRosterCardsSkeleton({ cards = 8 }: { cards?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading roster…</span>
      <div
        className="grid grid-cols-1 gap-4 p-3 sm:grid-cols-2 sm:p-4 lg:grid-cols-3 xl:grid-cols-4"
        aria-hidden
      >
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            className="flex min-h-[232px] flex-col overflow-hidden rounded-2xl border border-blue-100/70 bg-white shadow-sm ring-1 ring-blue-500/5 dark:border-blue-950/50 dark:bg-zinc-950/80 dark:ring-blue-400/10"
          >
            <div className="flex-1 space-y-4 p-4">
              <div className="flex items-start gap-3">
                <div className="skeleton-shimmer h-11 w-11 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                  <div className={`${BAR} h-3.5 w-3/4`} />
                  <div className={`${BAR} h-2.5 w-1/2`} />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className={`${BAR} h-2.5 w-full`} />
                <div className={`${BAR} h-2.5 w-5/6`} />
              </div>
            </div>
            <div className="px-4 pb-1">
              <div className={`${BAR} h-2.5 w-36`} />
            </div>
            <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800/60">
              <div className="skeleton-shimmer h-7 w-14 rounded-md" />
              <div className="skeleton-shimmer h-7 w-[74px] rounded-md" />
              <div className="skeleton-shimmer h-7 w-24 rounded-md" />
              <div className="skeleton-shimmer h-7 w-[76px] rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The department rail's entries, inside the rail's real frame. */
export function TeamRailSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 py-1.5 pl-7 pr-2">
          <div
            className={`${BAR} h-3 min-w-0`}
            style={{ width: `${48 + ((i * 41) % 40)}%` }}
          />
          <div className={`${BAR} ml-auto h-3 w-5 shrink-0`} />
        </div>
      ))}
    </div>
  );
}

/**
 * The New Hire Check List / Orientation hold while the roster is still out.
 *
 * Those panes scope their rows through the rail (`scopeRowsToDept`), and an EMPTY rail
 * scopes nothing away, so mounting them before the roster answers would paint every
 * department's hires for a moment. They wait, and this stands in.
 */
export function TeamPaneSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="rounded-lg border border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>
      <div className="flex items-center justify-between gap-3 border-b border-blue-100/70 px-4 py-3 dark:border-blue-950/50" aria-hidden>
        <div className="space-y-1.5">
          <div className={`${BAR} h-3.5 w-40`} />
          <div className={`${BAR} h-2.5 w-24`} />
        </div>
        <div className="skeleton-shimmer h-7 w-24 rounded-md" />
      </div>
      <div className="divide-y divide-blue-100/60 dark:divide-blue-900/40" aria-hidden>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="skeleton-shimmer h-8 w-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className={`${BAR} h-3`} style={{ width: `${30 + ((i * 17) % 25)}%` }} />
              <div className={`${BAR} h-2.5`} style={{ width: `${20 + ((i * 23) % 20)}%` }} />
            </div>
            <div className={`${BAR} h-5 w-16 shrink-0`} />
          </div>
        ))}
      </div>
    </div>
  );
}
