'use client';

/**
 * Manager → My Team → <department> → Appointments.
 *
 * Who on the selected department's current roster set the most appointments,
 * week by week or month by month, with their tenure. Every rule lives in the pure
 * `src/lib/manager/appointment-rankings.ts`; this component paints what it is
 * handed. Doc: `docs/features/manager-appointment-rankings.md`.
 *
 * - **Counts, never pesos.** Appointments × ₱250 is the Lead Gen pay; nothing
 *   here renders a peso figure (`manager-my-team.md:13-17`).
 * - **Every week shows, each with a badge** (Kane, Q3) — a draft the manager is
 *   still scoring included, because the count can still change and the badge says so.
 * - **No daily view.** Every appointment count in the HRIS is weekly (Q2 → a).
 * - View state (mode, period, sort) is owned by the PARENT: My Team's panes
 *   unmount on every view switch, and the manager should come back to where they were.
 */
import { useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowDown,
  CalendarCheck2,
  ChevronLeft,
  ChevronRight,
  Crown,
  UserMinus,
  WifiOff,
} from 'lucide-react';
import { TeamAvatar } from '@/components/team/team-ui';
import { cn } from '@/lib/utils';
import { cleanErrorMessage } from '@/lib/clean-error-message';
import { manilaTodayIso } from '@/lib/payroll/manila-week';
import {
  groupMonths,
  rankAppointments,
  type ApptRosterMember,
  type AppointmentWeek,
  type AppointmentWeekBadge,
  type RankedAppointmentRow,
} from '@/lib/manager/appointment-rankings';

const EASE = [0.22, 1, 0.36, 1] as const;
const PAGE = 25;

export type AppointmentRankMode = 'week' | 'month';
export type AppointmentRankSort = 'appointments' | 'tenure';
export interface AppointmentRankView {
  mode: AppointmentRankMode;
  /** 0 = newest period. */
  index: number;
  sort: AppointmentRankSort;
}

/** Amber stays warning and emerald stays done — the SCORING_CHIP semantics
 *  (`ManagerApp.tsx`), so a colour never means two things on one surface. */
const BADGE: Record<AppointmentWeekBadge, { label: string; cls: string }> = {
  not_scored: {
    label: 'Not scored yet',
    cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  },
  draft: {
    label: 'Draft · not sent to Accounting',
    cls: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  },
  with_accounting: {
    label: 'With Accounting · not finalized',
    cls: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300',
  },
  finalized: {
    label: 'Finalized by Accounting',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
  no_record: {
    label: 'No payroll record',
    cls: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-400',
  },
  unknown: {
    label: "Couldn't check status",
    cls: 'border-zinc-300 bg-white text-zinc-700 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-300',
  },
};

const NOT_FINAL_CLS = BADGE.draft.cls;

function isoDate(iso: string): Date | null {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
}

function weekLabel(start: string, end: string): string {
  const fmt = (iso: string, withYear: boolean) =>
    isoDate(iso)?.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(withYear ? { year: 'numeric' } : {}),
    }) ?? iso;
  return `${fmt(start, false)} – ${fmt(end, true)}`;
}

function monthLabel(key: string): string {
  return isoDate(`${key}-01`)?.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) ?? key;
}

interface Period {
  key: string;
  label: string;
  weeks: AppointmentWeek[];
  badge: { label: string; cls: string; final: boolean };
}

export function AppointmentRankingsPane<M extends ApptRosterMember>({
  weeks,
  loading,
  error,
  members,
  deptName,
  view,
  onViewChange,
  onOpenMember,
}: {
  weeks: AppointmentWeek[];
  loading: boolean;
  error: string | null;
  /** The People view's roster for the selected rail entry — who may be ranked. */
  members: readonly M[];
  deptName: string;
  view: AppointmentRankView;
  onViewChange: (next: AppointmentRankView) => void;
  onOpenMember?: (member: M) => void;
}) {
  const reduce = useReducedMotion() ?? false;

  const periods = useMemo<Period[]>(() => {
    if (view.mode === 'week') {
      return weeks.map((w) => ({
        key: w.periodStart,
        label: weekLabel(w.periodStart, w.periodEnd),
        weeks: [w],
        badge: { ...BADGE[w.badge], final: w.badge === 'finalized' || w.badge === 'no_record' },
      }));
    }
    return groupMonths(weeks).map((m) => {
      const allNoRecord = m.weeks.every((w) => w.badge === 'no_record');
      const badge =
        m.notFinal > 0
          ? {
              label: `${m.notFinal} of ${m.weeks.length} weeks not finalized`,
              cls: NOT_FINAL_CLS,
              final: false,
            }
          : allNoRecord
            ? { ...BADGE.no_record, final: true }
            : { label: 'All weeks finalized', cls: BADGE.finalized.cls, final: true };
      return { key: m.key, label: monthLabel(m.key), weeks: m.weeks, badge };
    });
  }, [weeks, view.mode]);

  const index = Math.min(view.index, Math.max(0, periods.length - 1));
  const period = periods[index];
  const today = manilaTodayIso();
  const ranked = useMemo(
    () => (period ? rankAppointments(period.weeks, members, today) : null),
    [period, members, today],
  );

  if (loading && weeks.length === 0) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading appointments…</span>
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

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-14 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
        <WifiOff className="h-7 w-7 text-zinc-300 dark:text-zinc-700" />
        <p className="text-sm text-zinc-600 dark:text-zinc-400">Couldn&rsquo;t load appointments.</p>
        <p className="max-w-sm text-xs text-zinc-500">{cleanErrorMessage(error)}</p>
      </div>
    );
  }

  if (!period || !ranked) return null;

  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next > periods.length - 1) return;
    onViewChange({ ...view, index: next });
  };
  const setMode = (mode: AppointmentRankMode) => {
    if (mode === view.mode) return;
    // Land on the period that CONTAINS the week on screen, never on "index 0 of
    // the other list" — flipping Weekly → Monthly must not jump months.
    const anchor = period.weeks[0]?.periodStart;
    const target =
      mode === 'week'
        ? weeks.findIndex((w) => w.periodStart === anchor)
        : groupMonths(weeks).findIndex((m) => m.weeks.some((w) => w.periodStart === anchor));
    onViewChange({ ...view, mode, index: Math.max(0, target) });
  };

  // Newest week with anything in it — the empty current week offers a jump there.
  const latestScored = view.mode === 'week' ? weeks.findIndex((w) => w.rows.length > 0) : -1;
  const periodHasRows = period.weeks.some((w) => w.rows.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100/80 bg-white px-3 py-2 shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => go(1)}
            disabled={index >= periods.length - 1}
            aria-label={view.mode === 'week' ? 'Older week' : 'Older month'}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              {period.label}
            </p>
            <p className="truncate text-[11px] text-zinc-500">
              {ranked.rows.length} ranked
              {view.mode === 'month' &&
                ` · ${period.weeks.length} ${period.weeks.length === 1 ? 'week' : 'weeks'}`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={index <= 0}
            aria-label={view.mode === 'week' ? 'Newer week' : 'Newer month'}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <span
            className={cn(
              'ml-1 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold',
              period.badge.cls,
            )}
          >
            {period.badge.final ? (
              <CalendarCheck2 className="h-3 w-3" aria-hidden />
            ) : (
              <AlertTriangle className="h-3 w-3" aria-hidden />
            )}
            {period.badge.label}
          </span>
        </div>

        <div
          role="tablist"
          aria-label="Ranking period"
          className="flex items-center gap-0.5 rounded-md border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-800 dark:bg-zinc-900"
        >
          {(['week', 'month'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={view.mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition-colors',
                view.mode === m
                  ? 'bg-white text-blue-700 shadow-sm dark:bg-zinc-950 dark:text-blue-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
              )}
            >
              {m === 'week' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      {!period.badge.final && periodHasRows && (
        <p className="px-1 text-[11.5px] text-amber-800 dark:text-amber-300">
          Counts for {view.mode === 'week' ? 'this week' : 'this month'} can still change until
          Accounting finalizes payroll.
        </p>
      )}

      {ranked.rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-white py-12 text-center dark:border-blue-950/60 dark:bg-[#0d1117]">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {periodHasRows
              ? `Nobody on the ${deptName} roster was scored ${view.mode === 'week' ? 'this week' : 'this month'}.`
              : `No appointments entered for ${view.mode === 'week' ? 'this week' : 'this month'} yet.`}
          </p>
          {!periodHasRows && latestScored > 0 && (
            <button
              type="button"
              onClick={() => onViewChange({ ...view, index: latestScored })}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-blue-200 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-blue-900/50 dark:bg-zinc-950 dark:text-blue-300 dark:hover:bg-blue-950/40"
            >
              Go to {weekLabel(weeks[latestScored]!.periodStart, weeks[latestScored]!.periodEnd)}
            </button>
          )}
        </div>
      ) : (
        <motion.div
          key={`${view.mode}:${period.key}:${view.sort}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduce ? 0.1 : 0.2, ease: EASE }}
        >
          <RankTable
            rows={ranked.rows}
            showWeeks={view.mode === 'month'}
            sort={view.sort}
            onSort={(sort) => onViewChange({ ...view, sort })}
            onOpenMember={onOpenMember}
          />
        </motion.div>
      )}

      {(ranked.notOnRoster > 0 || ranked.unscoredOnRoster > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {ranked.notOnRoster > 0 && (
            <span className="inline-flex items-center gap-1">
              <UserMinus className="h-3.5 w-3.5" aria-hidden />
              {ranked.notOnRoster} {ranked.notOnRoster === 1 ? 'person' : 'people'} scored in this
              period {ranked.notOnRoster === 1 ? 'is' : 'are'} no longer on the {deptName} roster and
              not ranked.
            </span>
          )}
          {ranked.unscoredOnRoster > 0 && periodHasRows && (
            <span>
              {ranked.unscoredOnRoster} on the roster {ranked.unscoredOnRoster === 1 ? 'has' : 'have'} no
              entry for this period.
            </span>
          )}
        </div>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-zinc-500">
        Appointments are what the KPI Calculator saved for each week. A week counts toward the month
        its Monday falls in. Tenure runs from the current Start Date on the roster.
      </p>
    </div>
  );
}

function RankTable<M extends ApptRosterMember>({
  rows,
  showWeeks,
  sort,
  onSort,
  onOpenMember,
}: {
  rows: RankedAppointmentRow<M>[];
  showWeeks: boolean;
  sort: AppointmentRankSort;
  onSort: (sort: AppointmentRankSort) => void;
  onOpenMember?: (member: M) => void;
}) {
  // Keyed by the parent on period + sort, so paging resets whenever either changes.
  const [shown, setShown] = useState(PAGE);
  const sorted = useMemo(() => {
    if (sort === 'appointments') return rows;
    // Longest tenure first; no readable Start Date sorts last. Position (#) stays
    // the appointments rank either way.
    return [...rows].sort((a, b) => {
      if (a.startDate && b.startDate && a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      if (a.startDate && !b.startDate) return -1;
      if (!a.startDate && b.startDate) return 1;
      return a.position - b.position;
    });
  }, [rows, sort]);
  const top = Math.max(1, rows[0]?.appointments ?? 1);

  const header = (key: AppointmentRankSort, label: string, align: 'left' | 'right') => (
    <th scope="col" className={cn('px-3 py-2 font-semibold', align === 'right' && 'text-right')}>
      <button
        type="button"
        onClick={() => onSort(key)}
        aria-pressed={sort === key}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide transition-colors',
          sort === key ? 'text-blue-700 dark:text-blue-300' : 'hover:text-zinc-700 dark:hover:text-zinc-200',
        )}
      >
        {label}
        <ArrowDown className={cn('h-3 w-3', sort === key ? 'opacity-100' : 'opacity-0')} aria-hidden />
      </button>
    </th>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200/80 bg-white shadow-sm dark:border-blue-950/60 dark:bg-[#0d1117]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-[13px]">
          <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
            <tr>
              <th scope="col" className="w-12 px-3 py-2 font-semibold uppercase tracking-wide">#</th>
              <th scope="col" className="px-3 py-2 font-semibold uppercase tracking-wide">Name</th>
              {header('appointments', 'Appointments', 'right')}
              {showWeeks && (
                <th scope="col" className="px-3 py-2 text-right font-semibold uppercase tracking-wide">Weeks</th>
              )}
              {header('tenure', 'Tenure', 'right')}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {sorted.slice(0, shown).map((r) => {
              const email = r.member.work_email ?? r.member.personal_email ?? null;
              return (
                <tr
                  key={`${r.position}:${email ?? r.name}`}
                  className={cn(onOpenMember && 'cursor-pointer hover:bg-blue-50/40 dark:hover:bg-blue-950/20')}
                  onClick={onOpenMember ? () => onOpenMember(r.member) : undefined}
                >
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-[11.5px] font-bold tabular-nums',
                        r.position === 1
                          ? 'bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-sm'
                          : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                      )}
                    >
                      {r.position === 1 ? <Crown className="h-3.5 w-3.5" aria-label="Rank 1" /> : r.position}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <TeamAvatar name={r.name} email={email} size="sm" />
                      {onOpenMember ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenMember(r.member);
                          }}
                          className="truncate text-left font-medium text-zinc-900 hover:text-blue-700 dark:text-zinc-100 dark:hover:text-blue-300"
                        >
                          {r.name}
                        </button>
                      ) : (
                        <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <span aria-hidden className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-zinc-100 sm:block dark:bg-zinc-800">
                        <span
                          className="block h-full rounded-full bg-blue-500/70 dark:bg-blue-400/60"
                          style={{ width: `${Math.round((r.appointments / top) * 100)}%` }}
                        />
                      </span>
                      <span className="w-8 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                        {r.appointments}
                      </span>
                    </div>
                  </td>
                  {showWeeks && (
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400">
                      {r.weeksScored}
                    </td>
                  )}
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
      {sorted.length > shown && (
        <div className="border-t border-zinc-100 px-3 py-2 text-center dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE)}
            className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
          >
            Show {Math.min(PAGE, sorted.length - shown)} more · {sorted.length - shown} left
          </button>
        </div>
      )}
    </div>
  );
}
