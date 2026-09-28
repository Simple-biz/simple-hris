'use client';

/**
 * Manager → My Team → <department> → Rankings, for a department that scores
 * appointments: the current roster ranked by AVERAGE appointments set — per day
 * worked, per week, per month — over a chosen window.
 *
 * Every rule lives in the pure `src/lib/manager/appointment-averages.ts`; this
 * component paints what it is handed. Doc:
 * `docs/features/manager-appointment-leaderboard.md`.
 *
 * - **No money values** (Kane, 2026-09-26). Counts and averages of counts only.
 * - Basis and window are owned by the PARENT — My Team panes unmount on every
 *   view switch, and the manager should come back to what they were looking at.
 * - **Two callers, one pane.** PM Team's KPI-item leaderboard
 *   (`DeliverableLeaderboardPane.tsx`, doc `manager-pm-rankings.md`) renders THIS
 *   component with its own `unit`, a KPI picker in `controls` and a per-KPI
 *   breakdown via `partLabels` — extracted, not copied, so "no money values" is
 *   enforced in one place. Every such prop defaults to the appointment wording.
 * - **View** (Kane, 2026-09-28) after Tenure opens `RankingHistoryModal`: the person's
 *   count and position each settled week, from these same weeks. PM Team's weekly
 *   positions come from the server (`weekRankFor`); Lead Gen's are its counts.
 *   Doc: `docs/features/manager-rankings-history.md`.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ChartLine, ChevronDown, Crown, Info, Medal, UserMinus, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TeamAvatar } from '@/components/team/team-ui';
import { RankingsSkeleton } from '@/components/team/RankingsSkeleton';
import { RankingsNoMatch, RankingsSearch } from '@/components/team/RankingsSearch';
import { RankingHistoryModal } from '@/components/manager/RankingHistoryModal';
import { Segmented, addDaysIso, dateLabel, fmtCount } from '@/components/manager/leaderboard-ui';
import { normalizeRankingQuery, rankingRowMatches, workEmailsOf } from '@/lib/manager/rankings-search';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import {
  BASIS_DECIMALS,
  MIN_SCORED_WEEKS,
  computeLeaderboard,
  type AverageBasis,
  type AverageWindow,
  type DaysWorkedRow,
  type LeaderboardRow,
} from '@/lib/manager/appointment-averages';
import type { ApptRosterMember, AppointmentWeek } from '@/lib/manager/appointment-rankings';
import type { WeekRankSource } from '@/lib/manager/ranking-history';

const EASE = [0.22, 1, 0.36, 1] as const;
const PAGE = 25;

export interface LeaderboardView {
  basis: AverageBasis;
  window: AverageWindow;
}

const BASIS_LABEL: Record<AverageBasis, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
const BASIS_UNIT: Record<AverageBasis, string> = { daily: 'per day', weekly: 'per week', monthly: 'per month' };
const WINDOW_LABEL: Record<AverageWindow, string> = {
  last4w: 'Last 4 weeks',
  last3m: 'Last 3 months',
  all: 'All time',
};

/** Gold / silver / bronze for the podium — rank, not money. */
const PODIUM = [
  'from-amber-400 to-amber-600',
  'from-zinc-300 to-zinc-500',
  'from-orange-400 to-orange-700',
] as const;

function fmt(n: number | null, basis: AverageBasis): string {
  return n === null ? '—' : n.toFixed(BASIS_DECIMALS[basis]);
}

/** What the counted thing is called, in the header, podium, tooltips and footnote. */
export interface LeaderboardUnit {
  one: string;
  many: string;
}

const APPOINTMENTS: LeaderboardUnit = { one: 'appointment', many: 'appointments' };

/** Every leaderboard row's rank history is ranked on its values unless a caller says otherwise. */
const RANK_BY_VALUES: WeekRankSource = { kind: 'values' };

export function AppointmentLeaderboardPane<M extends ApptRosterMember>({
  weeks,
  weeksLoading,
  weeksError,
  days,
  daysError,
  members,
  deptName,
  view,
  onViewChange,
  onOpenMember,
  unit = APPOINTMENTS,
  controls,
  partLabels,
  notes,
  animationKey,
  reorder,
  rankNote,
  showValues = true,
  weekRankFor,
  weekRankedBy,
  historyNote,
}: {
  weeks: AppointmentWeek[];
  weeksLoading: boolean;
  weeksError: string | null;
  /** Null until loaded (the pane shows it as pending), or when the read failed (`daysError`). */
  days: DaysWorkedRow[] | null;
  daysError: string | null;
  members: readonly M[];
  deptName: string;
  view: LeaderboardView;
  onViewChange: (next: LeaderboardView) => void;
  onOpenMember?: (member: M) => void;
  /** Defaults to appointments. */
  unit?: LeaderboardUnit;
  /** Extra controls, rendered before the basis / window toggles (PM Team's KPI picker). */
  controls?: ReactNode;
  /** Labels for a row's `parts`, in display order — shows the breakdown under each name. */
  partLabels?: Readonly<Record<string, string>>;
  /** Extra footnote lines, above the method note. */
  notes?: ReactNode;
  /** Replays the entrance when it changes (PM Team: the chosen KPI). */
  animationKey?: string;
  /**
   * Re-orders the computed rows — PM Team puts them in the server's BONUS order
   * (positions only; the pesos never reach the browser). The shown figures do not
   * change. Must be referentially stable. Returns how many rows it could not place.
   */
  reorder?: (
    rows: LeaderboardRow<M>[],
    ctx: { basis: AverageBasis; window: AverageWindow },
  ) => { rows: LeaderboardRow<M>[]; unplaced: number };
  /** What the order is based on, when it is not the shown average (PM Team: bonus earned). */
  rankNote?: string;
  /**
   * False = ORDER-ONLY: no per-day / per-week / per-month figure, total or day count is
   * rendered anywhere — rank, name, weeks and tenure only. For a KPI whose variable IS
   * the pesos (Client VA's `=Appt_Bonus`), where every "count" would be pay.
   */
  showValues?: boolean;
  /**
   * Where the View modal's weekly ranks come from, per person. Default: rank each week
   * on its values (Lead Gen: the appointments ARE the order). PM Team passes the
   * server's weekly BONUS order, because ranking its counts would contradict the board.
   * Must be referentially stable.
   */
  weekRankFor?: (member: M) => WeekRankSource;
  /** The View modal's sentence for what each week is ranked by. */
  weekRankedBy?: string;
  /**
   * The View modal's KPI note, in place of its default order-only sentence. The KPI
   * board passes one for a team split (every member carries the team's figure).
   */
  historyNote?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  // The View modal (Kane, 2026-09-28). The row is KEPT after close so the exit
  // animation plays on the person's data rather than on an empty popup; only
  // `historyOpen` flips. The modal's window starts from the board's, each time.
  const [historyRow, setHistoryRow] = useState<LeaderboardRow<M> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyWindow, setHistoryWindow] = useState<AverageWindow>(view.window);
  const historyRankBy = useMemo<WeekRankSource>(
    () => (historyRow && weekRankFor ? weekRankFor(historyRow.member) : RANK_BY_VALUES),
    [historyRow, weekRankFor],
  );
  const openHistory = (r: LeaderboardRow<M>) => {
    setHistoryRow(r);
    setHistoryWindow(view.window);
    setHistoryOpen(true);
  };
  // Search (Kane, 2026-09-27): names + WORK emails only; it hides rows, never re-ranks.
  // Local on purpose — a department switch remounts the pane and starts a fresh search.
  const [query, setQuery] = useState('');
  const today = manilaTodayIso();
  const daysUsable = days !== null && !daysError;
  const daysFailed = !!daysError;
  // Daily needs days to decide the ORDER. Until they arrive it shows a loading
  // state, never a half-computed order; only a FAILED read falls back to weekly,
  // and the toggle then shows Weekly so the header never names the wrong basis.
  const basis: AverageBasis = view.basis === 'daily' && daysFailed ? 'weekly' : view.basis;
  const board = useMemo(() => {
    const computed = computeLeaderboard({
      weeks,
      days: daysUsable ? days : null,
      members,
      window: view.window,
      basis,
      todayIso: today,
    });
    if (!reorder) return { ...computed, unplaced: 0 };
    const ordered = reorder(computed.rows, { basis, window: view.window });
    return { ...computed, rows: ordered.rows, unplaced: ordered.unplaced };
  }, [weeks, days, daysUsable, members, view.window, basis, today, reorder]);
  const q = normalizeRankingQuery(query);
  const visibleRows = useMemo(
    () => (q ? board.rows.filter((r) => rankingRowMatches(q, { name: r.name, workEmails: workEmailsOf(r.member) })) : board.rows),
    [board.rows, q],
  );

  if (weeksLoading && weeks.length === 0) {
    // Shaped like the board (header, podium, rows) so it lands in place.
    return <RankingsSkeleton podium />;
  }

  if (weeksError) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-14 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
        <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Couldn&rsquo;t load rankings.</p>
        <p className="max-w-sm text-xs text-zinc-500">{cleanErrorMessage(weeksError)}</p>
      </div>
    );
  }

  const newest = board.windowWeeks[0];
  const oldest = board.windowWeeks[board.windowWeeks.length - 1];
  const range =
    newest && oldest
      ? `${dateLabel(oldest.periodStart, false)} – ${dateLabel(addDaysIso(newest.periodStart, 6), true)} · ${board.windowWeeks.length} ${board.windowWeeks.length === 1 ? 'week' : 'weeks'}`
      : 'No settled weeks yet';
  const daysPending = !daysUsable && !daysFailed;
  const dailyPending = basis === 'daily' && daysPending;
  const history = board.notRanked.filter((r) => r.reason === 'history');
  const noDays = board.notRanked.filter((r) => r.reason === 'no_days');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100/80 bg-white px-3 py-2 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {showValues
              ? `Top performers · average ${unit.many} ${BASIS_UNIT[basis]}`
              : `Top performers · by bonus earned ${BASIS_UNIT[basis]}`}
          </p>
          <p className="truncate text-[11px] text-zinc-500">
            {rankNote && <span className="font-medium text-zinc-600 dark:text-zinc-300">{rankNote} · </span>}
            {range}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RankingsSearch value={query} onChange={setQuery} className="w-full sm:w-48" />
          {controls}
          <Segmented
            label="Average"
            value={basis}
            onChange={(b) => onViewChange({ ...view, basis: b })}
            options={(['daily', 'weekly', 'monthly'] as const).map((b) => ({
              value: b,
              label: BASIS_LABEL[b],
              disabled: b === 'daily' && !!daysError,
              title: b === 'daily' && daysError ? "Days worked couldn't be loaded" : undefined,
            }))}
          />
          <Segmented
            label="Window"
            value={view.window}
            onChange={(w) => onViewChange({ ...view, window: w })}
            options={(['last4w', 'last3m', 'all'] as const).map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
          />
        </div>
      </div>

      {daysError && (
        <p className="flex items-center gap-1.5 px-1 text-[11.5px] text-zinc-600 dark:text-zinc-400">
          <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Days worked couldn&rsquo;t be loaded, so daily averages aren&rsquo;t available. Weekly and monthly are
          unaffected.
        </p>
      )}

      {dailyPending ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-12 text-sm text-zinc-500 dark:border-blue-950/60 dark:bg-[#0d1117]">
          <span className="skeleton-shimmer h-3 w-3 rounded-full" aria-hidden />
          Loading days worked from Hubstaff…
        </div>
      ) : board.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-zinc-300 bg-white py-12 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Nobody on the {deptName} roster can be ranked yet.</p>
          <p className="text-xs text-zinc-500">
            A person needs at least {MIN_SCORED_WEEKS} scored weeks in the window.
          </p>
        </div>
      ) : (
        <motion.div
          key={`${animationKey ?? ''}:${view.window}:${basis}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0.1 : 0.2, ease: EASE }}
          className="space-y-3"
        >
          {/* The podium is the team's top three; while searching it would hold whoever
              matched (a #7 in a gold slot), so it steps aside. Positions stay real. */}
          {!q && (
            <Podium
              rows={board.rows.slice(0, 3)}
              basis={basis}
              unit={unit}
              showValues={showValues}
              onOpenMember={onOpenMember}
            />
          )}
          {q && visibleRows.length === 0 ? (
            <RankingsNoMatch query={query} />
          ) : (
          <LeaderTable
            rows={visibleRows}
            basis={basis}
            unit={unit}
            showValues={showValues}
            partLabels={partLabels}
            daysLoading={daysPending}
            onOpenMember={onOpenMember}
            onView={openHistory}
          />
          )}
        </motion.div>
      )}

      <RankingHistoryModal
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        row={historyRow}
        weeks={weeks}
        members={members}
        window={historyWindow}
        onWindowChange={setHistoryWindow}
        rankBy={historyRankBy}
        unit={unit}
        showValues={showValues}
        partLabels={partLabels}
        board={{ basis, window: view.window }}
        rankedBy={weekRankedBy ?? `Each week is ranked by ${unit.many} that week, among the roster with an entry.`}
        note={historyNote}
      />

      <div className="space-y-1 px-1 text-[11.5px] text-zinc-500 dark:text-zinc-400">
        {board.leftOut.length > 0 && (
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Not counted yet:{' '}
              {board.leftOut
                .map(
                  (w) =>
                    `${dateLabel(w.periodStart, false)} – ${dateLabel(addDaysIso(w.periodStart, 6), false)} (${w.badge === 'unknown' ? "couldn't check status" : 'draft, not sent to Accounting'})`,
                )
                .join(' · ')}
              .
            </span>
          </p>
        )}
        {history.length > 0 && (
          <NotRankedLine
            label={`${history.length} ${history.length === 1 ? 'person has' : 'people have'} fewer than ${MIN_SCORED_WEEKS} scored weeks in this window and ${history.length === 1 ? "isn't" : "aren't"} ranked yet.`}
            names={history.map((r) => `${r.name} (${r.weeksScored} wk)`)}
          />
        )}
        {basis === 'daily' && noDays.length > 0 && (
          <NotRankedLine
            label={`${noDays.length} ${noDays.length === 1 ? 'person has' : 'people have'} no Hubstaff days in these weeks, so no daily average.`}
            names={noDays.map((r) => r.name)}
          />
        )}
        {board.unplaced > 0 && (
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {board.unplaced} {board.unplaced === 1 ? 'person' : 'people'} couldn&rsquo;t be placed in the ranking
              order and {board.unplaced === 1 ? 'is' : 'are'} listed last.
            </span>
          </p>
        )}
        {board.notOnRoster > 0 && (
          <p className="flex items-center gap-1.5">
            <UserMinus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {board.notOnRoster} {board.notOnRoster === 1 ? 'person' : 'people'} scored in this window{' '}
            {board.notOnRoster === 1 ? 'is' : 'are'} no longer on the {deptName} roster and not ranked.
          </p>
        )}
        {notes}
        <p className="pt-1 text-[11px] leading-relaxed">
          {showValues ? (
            <>
              Only weeks Accounting has received or finalized are averaged. Per day = {unit.many} ÷ days with
              Hubstaff time. Per week = {unit.many} ÷ weeks scored. Per month = per week × 52 ÷ 12.
            </>
          ) : (
            <>
              Only weeks Accounting has received or finalized are counted. The order is the bonus earned{' '}
              {BASIS_UNIT[basis]}; the amounts are never shown.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function NotRankedLine({ label, names }: { label: string; names: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-200"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open ? 'rotate-0' : '-rotate-90')} aria-hidden />
        {label}
      </button>
      {open && <p className="mt-1 pl-5 text-zinc-600 dark:text-zinc-400">{names.join(' · ')}</p>}
    </div>
  );
}

function valueOf<M extends ApptRosterMember>(r: LeaderboardRow<M>, basis: AverageBasis): number | null {
  return basis === 'daily' ? r.avgDaily : basis === 'weekly' ? r.avgWeekly : r.avgMonthly;
}

function Podium<M extends ApptRosterMember>({
  rows,
  basis,
  unit,
  showValues,
  onOpenMember,
}: {
  rows: LeaderboardRow<M>[];
  basis: AverageBasis;
  unit: LeaderboardUnit;
  showValues: boolean;
  onOpenMember?: (member: M) => void;
}) {
  return (
    <ol className="grid gap-2 sm:grid-cols-3">
      {rows.map((r) => {
        const email = r.member.work_email ?? r.member.personal_email ?? null;
        const tone = PODIUM[Math.min(r.position, 3) - 1] ?? PODIUM[2];
        return (
          <li key={`${r.position}:${email ?? r.name}`}>
            <button
              type="button"
              onClick={onOpenMember ? () => onOpenMember(r.member) : undefined}
              disabled={!onOpenMember}
              className="flex w-full items-center gap-3 rounded-lg border border-zinc-200/80 bg-white p-3 text-left shadow-sm transition-colors hover:border-blue-200 disabled:pointer-events-none dark:border-blue-950/60 dark:bg-[#0d1117] dark:hover:border-blue-900"
            >
              <span
                className={cn(
                  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br text-[12px] font-bold text-white shadow-sm',
                  tone,
                )}
                aria-label={`Rank ${r.position}`}
              >
                {r.position === 1 ? <Crown className="h-3.5 w-3.5" aria-hidden /> : <Medal className="h-3.5 w-3.5" aria-hidden />}
              </span>
              <TeamAvatar name={r.name} email={email} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{r.name}</span>
                <span className="block text-[11px] text-zinc-500">
                  {showValues
                    ? `${fmtCount(r.totalAppointments)} ${r.totalAppointments === 1 ? unit.one : unit.many} · ${r.tenure}`
                    : `${r.weeksScored} ${r.weeksScored === 1 ? 'week' : 'weeks'} scored · ${r.tenure}`}
                </span>
              </span>
              {showValues && (
                <span className="shrink-0 text-right">
                  <span className="block text-lg font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100">
                    {fmt(valueOf(r, basis), basis)}
                  </span>
                  <span className="block text-[10px] uppercase tracking-wide text-zinc-500">{BASIS_UNIT[basis]}</span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** "Sales & Referrals 4.5 · TransUnion 3" — non-zero parts only, in label order. */
function partsLine(parts: Readonly<Record<string, number>> | undefined, labels: Readonly<Record<string, string>>): string {
  if (!parts) return '';
  return Object.keys(labels)
    .filter((k) => (parts[k] ?? 0) > 0)
    .map((k) => `${labels[k]} ${fmtCount(parts[k]!)}`)
    .join(' · ');
}

function LeaderTable<M extends ApptRosterMember>({
  rows,
  basis,
  unit,
  showValues,
  partLabels,
  daysLoading,
  onOpenMember,
  onView,
}: {
  rows: LeaderboardRow<M>[];
  basis: AverageBasis;
  unit: LeaderboardUnit;
  showValues: boolean;
  partLabels?: Readonly<Record<string, string>>;
  daysLoading: boolean;
  onOpenMember?: (member: M) => void;
  /** Opens the person's KPI and ranking history (the action after Tenure). */
  onView: (row: LeaderboardRow<M>) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const col = (b: AverageBasis) =>
    cn('px-3 py-2 text-right tabular-nums', b === basis ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-zinc-600 dark:text-zinc-400');

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
      <div className="overflow-x-auto">
        <table className={cn('w-full text-left text-[13px]', showValues ? 'min-w-[720px]' : 'min-w-[440px]')}>
          <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
            <tr>
              <th scope="col" className="w-12 px-3 py-2 font-semibold">#</th>
              <th scope="col" className="px-3 py-2 font-semibold">Name</th>
              {showValues &&
                (['daily', 'weekly', 'monthly'] as const).map((b) => (
                  <th
                    key={b}
                    scope="col"
                    className={cn('px-3 py-2 text-right font-semibold', b === basis && 'text-blue-700 dark:text-blue-300')}
                  >
                    {BASIS_UNIT[b].replace('per ', 'Per ')}
                  </th>
                ))}
              {showValues && <th scope="col" className="px-3 py-2 text-right font-semibold">Total</th>}
              {showValues && <th scope="col" className="px-3 py-2 text-right font-semibold">Days</th>}
              <th scope="col" className="px-3 py-2 text-right font-semibold">Weeks</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Tenure</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {rows.slice(0, shown).map((r) => {
              const email = r.member.work_email ?? r.member.personal_email ?? null;
              return (
                <tr
                  key={`${r.position}:${email ?? r.name}`}
                  className={cn(onOpenMember && 'cursor-pointer hover:bg-blue-50/40 dark:hover:bg-blue-950/20')}
                  onClick={onOpenMember ? () => onOpenMember(r.member) : undefined}
                >
                  <td className="px-3 py-2">
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-zinc-100 px-1 text-[11.5px] font-bold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                      {r.position}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <TeamAvatar name={r.name} email={email} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                        {partLabels && (
                          <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                            {partsLine(r.parts, partLabels) || `No ${unit.many} in this window`}
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  {showValues && (
                    <>
                      <td
                        className={col('daily')}
                        title={
                          r.weeksWithoutDays > 0
                            ? `${r.weeksWithoutDays} week(s) had ${unit.many} but no Hubstaff days and are left out of the daily average`
                            : undefined
                        }
                      >
                        {daysLoading ? '…' : fmt(r.avgDaily, 'daily')}
                        {!daysLoading && r.weeksWithoutDays > 0 && <span aria-hidden>*</span>}
                      </td>
                      <td className={col('weekly')}>{fmt(r.avgWeekly, 'weekly')}</td>
                      <td className={col('monthly')}>{fmt(r.avgMonthly, 'monthly')}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {fmtCount(r.totalAppointments)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                        {daysLoading ? '…' : r.daysWorked}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.weeksScored}</td>
                  <td
                    className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400"
                    title={r.startDate ? `Started ${r.startDate}` : 'No readable Start Date on the roster'}
                  >
                    {r.tenure}
                  </td>
                  <td data-label="Actions" className="px-3 py-1.5 text-right">
                    {/* The row itself opens the profile; this opens the performance
                        history, so the click must not reach the row as well. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        onView(r);
                      }}
                      className="h-7 gap-1 border-blue-200 bg-blue-50/60 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-700/50 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/60"
                      title={`View ${r.name}'s KPI and ranking performance`}
                    >
                      <ChartLine className="h-3 w-3" aria-hidden />
                      View
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <div className="border-t border-zinc-100 px-3 py-2 text-center dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
          >
            Show {Math.min(PAGE, rows.length - shown)} more · {rows.length - shown} left
          </button>
        </div>
      )}
    </div>
  );
}
