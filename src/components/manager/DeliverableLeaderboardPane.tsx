'use client';

/**
 * Manager → My Team → PM Team → Rankings: the roster ranked by the BONUS they earned
 * (Kane, 2026-09-26: *"based on their Bonus … without displaying it"*), showing only
 * KPI item counts — per day worked, per week, per month, over a chosen window.
 *
 * A thin wrapper over the SAME `AppointmentLeaderboardPane` Lead Gen uses, so the
 * averages, windows, podium, tenure and the "no money values" rule live in one place.
 * It adds three things:
 *
 * - a KPI picker — "All bonuses" plus every KPI the DATA carries (a bonus added to the
 *   catalog appears here with no code change);
 * - the count projection (`projectDeliverableWeeks`) the shown figures come from;
 * - the server's bonus ORDER (`applyMoneyOrder`): positions computed from `amount` on
 *   the server. No peso is in this component's props, state or payloads.
 *
 * Doc: `docs/features/manager-pm-rankings.md`. View state (basis, window, KPI) is owned
 * by ManagerApp — My Team panes unmount on every view switch.
 */
import { useCallback, useMemo } from 'react';
import { AppointmentLeaderboardPane, type LeaderboardView } from '@/components/manager/AppointmentLeaderboardPane';
import { SmoothSelect } from '@/components/ui/smooth-select';
import type { AverageBasis, AverageWindow, DaysWorkedRow, LeaderboardRow } from '@/lib/manager/appointment-averages';
import type { ApptRosterMember } from '@/lib/manager/appointment-rankings';
import {
  ALL_METRIC,
  applyMoneyOrder,
  projectDeliverableWeeks,
  type DeliverableMetricInfo,
  type DeliverableWeek,
  type MoneyOrder,
} from '@/lib/manager/deliverable-rankings';

export interface DeliverableLeaderboardView extends LeaderboardView {
  /** `all`, or a KPI variable from the payload's `metrics`. */
  metric: string;
}

export function DeliverableLeaderboardPane<M extends ApptRosterMember>({
  weeks,
  metrics,
  skippedRows,
  order,
  weeksLoading,
  weeksError,
  days,
  dailyOrder,
  daysError,
  members,
  deptName,
  view,
  onViewChange,
  onOpenMember,
}: {
  weeks: DeliverableWeek[];
  metrics: DeliverableMetricInfo[];
  skippedRows: number;
  /** The weekly (and monthly) bonus order — positions only. */
  order: MoneyOrder | null;
  weeksLoading: boolean;
  weeksError: string | null;
  /** Null until the daily read lands (Daily shows as pending), or when it failed (`daysError`). */
  days: DaysWorkedRow[] | null;
  /** The per-day bonus order, from the same read as `days`. */
  dailyOrder: MoneyOrder | null;
  daysError: string | null;
  members: readonly M[];
  deptName: string;
  view: DeliverableLeaderboardView;
  onViewChange: (next: DeliverableLeaderboardView) => void;
  onOpenMember?: (member: M) => void;
}) {
  // A KPI the data no longer carries (a retired bonus, another department) falls back
  // to All rather than rendering an empty board under a stale label.
  const metric =
    view.metric === ALL_METRIC || metrics.some((m) => m.key === view.metric) ? view.metric : ALL_METRIC;
  const projected = useMemo(() => projectDeliverableWeeks(weeks, metric), [weeks, metric]);
  const labels = useMemo(() => Object.fromEntries(metrics.map((m) => [m.key, m.label])), [metrics]);
  const reorder = useCallback(
    (rows: LeaderboardRow<M>[], ctx: { basis: AverageBasis; window: AverageWindow }) =>
      applyMoneyOrder(rows, ctx.basis === 'daily' ? dailyOrder : order, ctx.window, metric),
    [order, dailyOrder, metric],
  );
  const label = metric === ALL_METRIC ? null : (labels[metric] ?? metric);
  const metricOptions = useMemo(
    () => [{ value: ALL_METRIC, label: 'All bonuses' }, ...metrics.map((m) => ({ value: m.key, label: m.label }))],
    [metrics],
  );

  return (
    <AppointmentLeaderboardPane
      weeks={projected}
      weeksLoading={weeksLoading}
      weeksError={weeksError}
      days={days}
      daysError={daysError}
      members={members}
      deptName={deptName}
      view={{ basis: view.basis, window: view.window }}
      onViewChange={(next) => onViewChange({ ...view, ...next })}
      onOpenMember={onOpenMember}
      unit={label ? { one: label, many: label } : { one: 'KPI item', many: 'KPI items' }}
      partLabels={metric === ALL_METRIC ? labels : undefined}
      animationKey={metric}
      reorder={reorder}
      rankNote={label ? `Ranked by ${label} bonus earned · amounts hidden` : 'Ranked by bonus earned · amounts hidden'}
      controls={
        // The house dropdown, compact and blue so it reads as one set with the
        // Average / Window toggles beside it. Left-aligned so a long bonus name
        // opens toward the toggles, never off the left edge on a phone.
        <SmoothSelect
          aria-label="KPI"
          leading="KPI"
          size="sm"
          accent="blue"
          align="start"
          value={metric}
          onChange={(next) => onViewChange({ ...view, metric: next })}
          options={metricOptions}
          className="w-full sm:w-auto"
          triggerClassName="w-full min-w-[11.5rem] sm:w-[13.5rem]"
        />
      }
      notes={
        skippedRows > 0 ? (
          <p className="text-[11.5px]">
            {skippedRows} bonus {skippedRows === 1 ? 'row scores' : 'rows score'} several KPIs at once (a manager&rsquo;s
            team-total bonus) and {skippedRows === 1 ? "isn't" : "aren't"} counted as anyone&rsquo;s own.
          </p>
        ) : null
      }
    />
  );
}
