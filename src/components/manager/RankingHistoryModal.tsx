'use client';

/**
 * My Team → Rankings → **View** (Kane, 2026-09-28: *"an action button after tenure
 * labeled "View" where we can see a histogram via line graph on KPI Performance and
 * Ranking Performance … make sure its smooth open and close with the data inside it"*).
 * Doc: `docs/features/manager-rankings-history.md`.
 *
 * One person's settled weeks: their count each week against the team's average, and
 * their position each week. Every number comes from data the leaderboard ALREADY holds
 * (the same weeks, roster and window rule, via `buildPersonHistory`), so the modal
 * never fetches and opens straight onto its data. A KPI board's positions are the
 * server's bonus order (`rankBy: 'server'`); nothing here ranks KPI counts.
 *
 * **Smooth open AND close.** The dialog primitive animates both ways, but a close
 * animation plays on whatever the popup still renders. The pane therefore keeps the
 * row after `open` goes false, and this component never blanks while closing.
 *
 * The shell carries the four dialog fixes (`docs/design/responsive-design.md`
 * § "Dialogs and modals"): `gap-0`, a height cap, a `shrink-0` header and a
 * `min-h-0 flex-1 overflow-y-auto` body. Without them a tall history clips at both ends.
 */
import * as React from 'react';
import { Info } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { TeamAvatar } from '@/components/team/team-ui';
import type { AverageBasis, AverageWindow, LeaderboardRow } from '@/lib/manager/appointment-averages';
import type { AppointmentWeek, ApptRosterMember } from '@/lib/manager/appointment-rankings';
import { buildPersonHistory, type HistoryPoint, type WeekRankSource } from '@/lib/manager/ranking-history';
import { RankingHistoryChart, weekRangeLabel } from '@/components/manager/RankingHistoryChart';
import { Segmented, addDaysIso, dateLabel, fmtCount } from '@/components/manager/leaderboard-ui';
import type { LeaderboardUnit } from '@/components/manager/AppointmentLeaderboardPane';

const WINDOW_LABEL: Record<AverageWindow, string> = {
  last4w: 'Last 4 weeks',
  last3m: 'Last 3 months',
  all: 'All time',
};
const BASIS_LABEL: Record<AverageBasis, string> = {
  daily: 'daily average',
  weekly: 'weekly average',
  monthly: 'monthly average',
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function RankingHistoryModal<M extends ApptRosterMember>({
  open,
  onOpenChange,
  row,
  weeks,
  members,
  window,
  onWindowChange,
  rankBy,
  unit,
  showValues,
  partLabels,
  board,
  rankedBy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The board row that was opened. Kept after close so the exit animation has content. */
  row: LeaderboardRow<M> | null;
  /** The board's own weeks (for a KPI board: the chosen KPI's count projection). */
  weeks: readonly AppointmentWeek[];
  members: readonly M[];
  window: AverageWindow;
  onWindowChange: (w: AverageWindow) => void;
  rankBy: WeekRankSource;
  unit: LeaderboardUnit;
  /** False = order-only (the KPI's value IS the pesos): no count is drawn or listed. */
  showValues: boolean;
  partLabels?: Readonly<Record<string, string>>;
  /** The board the row was opened from, for the "#3 on the board" line. */
  board: { basis: AverageBasis; window: AverageWindow };
  /** What each week is ranked by, in words. */
  rankedBy: string;
}) {
  const history = React.useMemo(
    () => (row ? buildPersonHistory({ weeks, members, member: row.member, window, rankBy }) : null),
    [row, weeks, members, window, rankBy],
  );
  if (!row || !history) return null;

  const email = row.member.work_email ?? row.member.personal_email ?? null;
  const person = firstName(row.name);
  const { points } = history;
  const newest = points[points.length - 1];
  const oldest = points[0];
  const latestRanked = [...points].reverse().find((p) => p.position !== null) ?? null;
  const rankValue = (v: string) => (history.rankPending ? '…' : v);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-h-[92dvh] sm:max-w-3xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-zinc-200 px-4 py-3 pr-12 dark:border-zinc-800">
          <TeamAvatar name={row.name} email={email} size="sm" />
          <div className="min-w-0">
            <DialogTitle className="truncate text-[14px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {row.name}
            </DialogTitle>
            <DialogDescription className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-500 dark:text-zinc-400">
              #{row.position} on the board ({BASIS_LABEL[board.basis]}, {WINDOW_LABEL[board.window].toLowerCase()}) ·{' '}
              {row.tenure} tenure
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
              {oldest && newest
                ? `${dateLabel(oldest.periodStart, false)} – ${dateLabel(addDaysIso(newest.periodStart, 6), true)} · ${points.length} settled ${points.length === 1 ? 'week' : 'weeks'}`
                : 'No settled weeks in this window yet'}
            </p>
            <Segmented
              label="Window"
              value={window}
              onChange={onWindowChange}
              options={(['last4w', 'last3m', 'all'] as const).map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
            />
          </div>

          <div className={showValues ? 'grid grid-cols-2 gap-2 sm:grid-cols-4' : 'grid grid-cols-3 gap-2'}>
            {showValues ? (
              <>
                <Tile
                  label="Average per week"
                  value={history.averagePerWeek === null ? '—' : history.averagePerWeek.toFixed(1)}
                  sub={`across ${history.weeksScored} ${history.weeksScored === 1 ? 'week' : 'weeks'} scored`}
                  title={`${unit.many} per week scored, over ${history.weeksScored} of ${points.length} settled weeks`}
                />
                <Tile
                  label="Best week"
                  value={history.bestWeek ? fmtCount(history.bestWeek.value) : '—'}
                  sub={history.bestWeek ? `week of ${dateLabel(history.bestWeek.periodStart, false)}` : 'no entries'}
                />
              </>
            ) : (
              <Tile label="Weeks scored" value={String(history.weeksScored)} sub={`of ${points.length} settled weeks`} />
            )}
            <Tile
              label="Best weekly rank"
              value={rankValue(history.bestRank ? `#${history.bestRank.position}` : '—')}
              sub={
                history.rankPending
                  ? 'loading'
                  : history.bestRank
                    ? `${history.bestRank.weeks} ${history.bestRank.weeks === 1 ? 'week' : 'weeks'} there`
                    : 'not ranked'
              }
            />
            <Tile
              label="Latest rank"
              value={rankValue(latestRanked ? `#${latestRanked.position}` : '—')}
              sub={
                history.rankPending
                  ? 'loading'
                  : latestRanked
                    ? `of ${latestRanked.ranked} · week of ${dateLabel(latestRanked.periodStart, false)}`
                    : 'not ranked'
              }
            />
          </div>

          {points.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 bg-white py-10 text-center text-sm text-zinc-500 dark:border-blue-950/60 dark:bg-[#0d1117]">
              No settled weeks in this window yet.
            </div>
          ) : (
            // Keyed on the window, so switching it draws the lines on again.
            <RankingHistoryChart
              key={window}
              points={points}
              showValues={showValues}
              rankPending={history.rankPending}
              personLabel={person}
              unitLabel={unit.many}
              partLabels={partLabels}
            />
          )}

          <div className="space-y-1 px-1 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            {history.weeksScored === 0 && points.length > 0 && (
              <Note>No entries for {person} in these weeks.</Note>
            )}
            {!showValues && (
              <Note>
                This KPI is entered as an amount, not a count, so only the ranking is shown &mdash; never how much.
              </Note>
            )}
            {history.leftOut.length > 0 && (
              <Note>
                Not counted yet:{' '}
                {history.leftOut
                  .map(
                    (w) =>
                      `${weekRangeLabel(w.periodStart)} (${w.badge === 'unknown' ? "couldn't check status" : 'draft, not sent to Accounting'})`,
                  )
                  .join(' · ')}
                .
              </Note>
            )}
            <p className="pt-1 text-[11px] leading-relaxed">
              Only weeks Accounting has received or finalized are shown. {rankedBy} A week with no entry breaks the
              line; it is never counted as 0.
            </p>
          </div>

          {points.length > 0 && (
            <WeekTable points={points} showValues={showValues} rankPending={history.rankPending} unit={unit} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, sub, title }: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div
      title={title}
      className="min-w-0 rounded-lg border border-zinc-200/80 bg-white px-3 py-2.5 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]"
    >
      <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold leading-tight text-zinc-900 dark:text-zinc-100">{value}</p>
      <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/**
 * The chart's table twin: every value the chart draws, readable without hovering.
 * `table-keep` because four short columns fit a phone, and the site-wide rule would
 * otherwise restack it into cards.
 */
function WeekTable({
  points,
  showValues,
  rankPending,
  unit,
}: {
  points: readonly HistoryPoint[];
  showValues: boolean;
  rankPending: boolean;
  unit: LeaderboardUnit;
}) {
  const newestFirst = [...points].reverse();
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
      <div className="overflow-x-auto">
        <table className="table-keep w-full text-left text-[12px]">
          <caption className="sr-only">Week by week</caption>
          <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
            <tr>
              <th scope="col" className="px-3 py-2 font-semibold">Week</th>
              {showValues && (
                <>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{capitalize(unit.many)}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Team average</th>
                </>
              )}
              <th scope="col" className="px-3 py-2 text-right font-semibold">Rank</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {newestFirst.map((p) => (
              <tr key={p.periodStart}>
                <td className="whitespace-nowrap px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{weekRangeLabel(p.periodStart)}</td>
                {showValues && (
                  <>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                      {p.value === null ? <span className="text-zinc-400 dark:text-zinc-500">No entry</span> : fmtCount(p.value)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {p.teamAverage === null ? '—' : p.teamAverage.toFixed(1)}
                    </td>
                  </>
                )}
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-zinc-900 dark:text-zinc-100">
                  {rankPending ? (
                    <span className="text-zinc-400 dark:text-zinc-500">…</span>
                  ) : p.position !== null ? (
                    <>
                      #{p.position} <span className="text-zinc-500 dark:text-zinc-400">of {p.ranked}</span>
                    </>
                  ) : (
                    <span className="text-zinc-400 dark:text-zinc-500">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
