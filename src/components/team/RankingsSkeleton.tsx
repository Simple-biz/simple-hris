'use client';

/**
 * The loading state for every My Team Rankings view — SP (`RankingsPane`), the
 * appointment leaderboard and the KPI leaderboard (`AppointmentLeaderboardPane`) — and
 * for the hold while a department's Rankings reads are still in flight.
 *
 * Kane, 2026-09-27: *"Lets also add a Skeleton on this please so we are expecting it"*.
 * It is shaped like what arrives: the header bar (week or window + toggles), the
 * top-3 podium, then the rows, on the same card styles, so the real view lands in
 * place instead of pushing the list down when the podium appears. One component, so
 * the three views cannot drift into three different skeletons.
 */

const CARD =
  'rounded-lg border border-zinc-200/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]';

export function RankingsSkeleton({
  podium = true,
  rows = 6,
}: {
  /** The top-3 podium placeholder (off for the Employee tab, which has no podium). */
  podium?: boolean;
  rows?: number;
}) {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading rankings…</span>

      {/* Header bar: title + range on the left, the toggles on the right. */}
      <div className={`${CARD} flex flex-wrap items-center justify-between gap-3 px-3 py-2`}>
        <div className="min-w-0 space-y-1.5">
          <div className="skeleton-shimmer h-3.5 w-44 rounded" />
          <div className="skeleton-shimmer h-2.5 w-28 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="skeleton-shimmer h-[26px] w-36 rounded-md" />
          <div className="skeleton-shimmer h-[26px] w-44 rounded-md" />
        </div>
      </div>

      {podium && (
        <div className="grid gap-2 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className={`${CARD} flex items-center gap-3 p-3`}>
              <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-md" />
              <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="skeleton-shimmer h-3 w-3/4 rounded" />
                <div className="skeleton-shimmer h-2.5 w-1/2 rounded" />
              </div>
              <div className="shrink-0 space-y-1">
                <div className="skeleton-shimmer ml-auto h-5 w-9 rounded" />
                <div className="skeleton-shimmer ml-auto h-2 w-12 rounded" />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`${CARD} flex items-center gap-3 p-3`}>
            <div className="skeleton-shimmer h-6 w-6 shrink-0 rounded-md" />
            <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-full" />
            <div className="skeleton-shimmer h-3.5 flex-1 rounded" style={{ maxWidth: `${70 - (i % 3) * 12}%` }} />
            <div className="ml-auto skeleton-shimmer h-4 w-12 shrink-0 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
