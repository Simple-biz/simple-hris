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
 */
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ChevronDown, Crown, Info, Medal, UserMinus, WifiOff } from 'lucide-react';
import { TeamAvatar } from '@/components/team/team-ui';
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

function dateLabel(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return dt.toISOString().slice(0, 10);
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40',
            value === o.value
              ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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
}) {
  const reduce = useReducedMotion() ?? false;
  const today = manilaTodayIso();
  const daysUsable = days !== null && !daysError;
  const daysFailed = !!daysError;
  // Daily needs days to decide the ORDER. Until they arrive it shows a loading
  // state, never a half-computed order; only a FAILED read falls back to weekly,
  // and the toggle then shows Weekly so the header never names the wrong basis.
  const basis: AverageBasis = view.basis === 'daily' && daysFailed ? 'weekly' : view.basis;
  const board = useMemo(
    () =>
      computeLeaderboard({
        weeks,
        days: daysUsable ? days : null,
        members,
        window: view.window,
        basis,
        todayIso: today,
      }),
    [weeks, days, daysUsable, members, view.window, basis, today],
  );

  if (weeksLoading && weeks.length === 0) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading rankings…</span>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-lg border border-zinc-200/80 bg-white p-3 dark:border-blue-950/60 dark:bg-[#0d1117]"
          >
            <div className="skeleton-shimmer h-6 w-6 shrink-0 rounded-md" />
            <div className="skeleton-shimmer h-7 w-7 shrink-0 rounded-full" />
            <div className="skeleton-shimmer h-3.5 flex-1 rounded" />
            <div className="skeleton-shimmer h-4 w-12 shrink-0 rounded" />
          </div>
        ))}
      </div>
    );
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
            Top performers · average appointments {BASIS_UNIT[basis]}
          </p>
          <p className="truncate text-[11px] text-zinc-500">{range}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          key={`${view.window}:${basis}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0.1 : 0.2, ease: EASE }}
          className="space-y-3"
        >
          <Podium rows={board.rows.slice(0, 3)} basis={basis} onOpenMember={onOpenMember} />
          <LeaderTable rows={board.rows} basis={basis} daysLoading={daysPending} onOpenMember={onOpenMember} />
        </motion.div>
      )}

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
        {board.notOnRoster > 0 && (
          <p className="flex items-center gap-1.5">
            <UserMinus className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {board.notOnRoster} {board.notOnRoster === 1 ? 'person' : 'people'} scored in this window{' '}
            {board.notOnRoster === 1 ? 'is' : 'are'} no longer on the {deptName} roster and not ranked.
          </p>
        )}
        <p className="pt-1 text-[11px] leading-relaxed">
          Only weeks Accounting has received or finalized are averaged. Per day = appointments ÷ days with Hubstaff
          time. Per week = appointments ÷ weeks scored. Per month = per week × 52 ÷ 12.
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
  onOpenMember,
}: {
  rows: LeaderboardRow<M>[];
  basis: AverageBasis;
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
                  {r.totalAppointments} appointments · {r.tenure}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-lg font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100">
                  {fmt(valueOf(r, basis), basis)}
                </span>
                <span className="block text-[10px] uppercase tracking-wide text-zinc-500">{BASIS_UNIT[basis]}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function LeaderTable<M extends ApptRosterMember>({
  rows,
  basis,
  daysLoading,
  onOpenMember,
}: {
  rows: LeaderboardRow<M>[];
  basis: AverageBasis;
  daysLoading: boolean;
  onOpenMember?: (member: M) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const col = (b: AverageBasis) =>
    cn('px-3 py-2 text-right tabular-nums', b === basis ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-zinc-600 dark:text-zinc-400');

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[10px] uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
            <tr>
              <th scope="col" className="w-12 px-3 py-2 font-semibold">#</th>
              <th scope="col" className="px-3 py-2 font-semibold">Name</th>
              {(['daily', 'weekly', 'monthly'] as const).map((b) => (
                <th
                  key={b}
                  scope="col"
                  className={cn('px-3 py-2 text-right font-semibold', b === basis && 'text-blue-700 dark:text-blue-300')}
                >
                  {BASIS_UNIT[b].replace('per ', 'Per ')}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-semibold">Total</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Days</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Weeks</th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">Tenure</th>
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
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                    </div>
                  </td>
                  <td
                    className={col('daily')}
                    title={
                      r.weeksWithoutDays > 0
                        ? `${r.weeksWithoutDays} week(s) had appointments but no Hubstaff days and are left out of the daily average`
                        : undefined
                    }
                  >
                    {daysLoading ? '…' : fmt(r.avgDaily, 'daily')}
                    {!daysLoading && r.weeksWithoutDays > 0 && <span aria-hidden>*</span>}
                  </td>
                  <td className={col('weekly')}>{fmt(r.avgWeekly, 'weekly')}</td>
                  <td className={col('monthly')}>{fmt(r.avgMonthly, 'monthly')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.totalAppointments}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                    {daysLoading ? '…' : r.daysWorked}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">{r.weeksScored}</td>
                  <td
                    className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400"
                    title={r.startDate ? `Started ${r.startDate}` : 'No readable Start Date on the roster'}
                  >
                    {r.tenure}
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
