'use client';

/**
 * Manager → My Team → <department> → Rankings (PM Team, and every other department on a
 * per-person KPI bonus): the roster ranked by the BONUS they earned
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
  kpiVariableLabel,
  metricShowsValues,
  projectDeliverableWeeks,
  weekRankLookup,
  type DeliverableMetricInfo,
  type DeliverableWeek,
  type MoneyOrder,
} from '@/lib/manager/deliverable-rankings';
import type { WeekRankSource } from '@/lib/manager/ranking-history';

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
  // One KPI → no picker, and the board speaks that KPI's own words ("Tickets completed")
  // rather than its bonus name, which is often just the department's ("Edit").
  const single = metrics.length === 1 ? metrics[0]! : null;
  // A KPI the data no longer carries (a retired bonus, another department) falls back
  // to All rather than rendering an empty board under a stale label.
  const metric = single
    ? single.key
    : view.metric === ALL_METRIC || metrics.some((m) => m.key === view.metric)
      ? view.metric
      : ALL_METRIC;
  const projected = useMemo(() => projectDeliverableWeeks(weeks, metric), [weeks, metric]);
  const labels = useMemo(() => Object.fromEntries(metrics.map((m) => [m.key, m.label])), [metrics]);
  // The breakdown under each name lists SHOWN KPIs only — an order-only KPI has no count.
  const shownLabels = useMemo(
    () => Object.fromEntries(metrics.filter((m) => m.shown).map((m) => [m.key, m.label])),
    [metrics],
  );
  const reorder = useCallback(
    (rows: LeaderboardRow<M>[], ctx: { basis: AverageBasis; window: AverageWindow }) =>
      applyMoneyOrder(rows, ctx.basis === 'daily' ? dailyOrder : order, ctx.window, metric),
    [order, dailyOrder, metric],
  );
  // The View modal's weekly ranks: the server's bonus order for each week, positions
  // only. A payload cached before it existed has no `weeks`, so the lookup is null and
  // the modal says the order is loading until the revalidation lands. The counts are
  // never ranked here: that would contradict the board's bonus order.
  const weekRankFor = useCallback(
    (member: M): WeekRankSource => ({ kind: 'server', lookup: weekRankLookup(order, member, metric) }),
    [order, metric],
  );
  const showValues = metricShowsValues(metric, metrics);
  const unitLabel = single ? kpiVariableLabel(single.key) : metric === ALL_METRIC ? null : (labels[metric] ?? metric);
  const pickedLabel = !single && metric !== ALL_METRIC ? (labels[metric] ?? metric) : null;
  const orderOnlyAmongAll = metric === ALL_METRIC && showValues ? metrics.filter((m) => !m.shown) : [];
  // Team splits (HR / QC / Accounting; Kane 2026-09-28, ruling (b)): every member carries
  // the team's figure, so the board says why its people tie. A team KPI hidden by the
  // count rule is hidden because its formula pays no flat rate per item — never because
  // it is "an amount", which is Client VA's reason and would be false here.
  const picked = single ?? (metric === ALL_METRIC ? null : (metrics.find((m) => m.key === metric) ?? null));
  const inView = picked ? [picked] : metrics;
  const teamInView = inView.filter((m) => m.team);
  const hiddenAreTeam = inView.length > 0 && inView.every((m) => m.team);
  const historyNote =
    teamInView.length > 0 && teamInView.length === inView.length
      ? showValues
        ? `${names(teamInView)} ${teamInView.length === 1 ? 'is a team bonus' : 'are team bonuses'}: every member carries the team's figure, so this line sits on the team average and everyone who scored a week ties.`
        : `${names(teamInView)} ${teamInView.length === 1 ? 'is a team bonus that doesn’t' : 'are team bonuses that don’t'} pay one flat rate per item, so only the ranking is shown — and everyone who scored a week ties.`
      : undefined;
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
      unit={unitLabel ? { one: unitLabel, many: unitLabel } : { one: 'KPI item', many: 'KPI items' }}
      partLabels={!single && metric === ALL_METRIC && showValues ? shownLabels : undefined}
      animationKey={metric}
      reorder={reorder}
      weekRankFor={weekRankFor}
      weekRankedBy={`Each week is ranked by the ${pickedLabel ? `${pickedLabel} ` : ''}bonus earned that week; the amounts are never shown.`}
      historyNote={historyNote}
      showValues={showValues}
      rankNote={
        pickedLabel ? `Ranked by ${pickedLabel} bonus earned · amounts hidden` : 'Ranked by bonus earned · amounts hidden'
      }
      controls={
        metrics.length > 1 ? (
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
        ) : undefined
      }
      notes={
        <>
          {!showValues &&
            (hiddenAreTeam ? (
              <p className="text-[11.5px]">
                {single || pickedLabel ? `${pickedLabel ?? single!.label} doesn’t` : 'These bonuses don’t'} pay one
                flat rate per item, so this board shows the order alone &mdash; never a figure.
              </p>
            ) : (
              <p className="text-[11.5px]">
                {single || pickedLabel ? `${pickedLabel ?? single!.label} is` : 'These bonuses are'} entered as an
                amount, not a count, so this board shows who earned the most &mdash; never how much.
              </p>
            ))}
          {orderOnlyAmongAll.filter((m) => !m.team).length > 0 && (
            <OrderOnlyAmongAll
              ms={orderOnlyAmongAll.filter((m) => !m.team)}
              why={['entered as an amount', 'entered as an amount']}
            />
          )}
          {orderOnlyAmongAll.filter((m) => m.team).length > 0 && (
            <OrderOnlyAmongAll
              ms={orderOnlyAmongAll.filter((m) => m.team)}
              why={['a team bonus with no flat rate per item', 'team bonuses with no flat rate per item']}
            />
          )}
          {teamInView.length > 0 && (
            <p className="text-[11.5px]">
              {names(teamInView)} {teamInView.length === 1 ? 'is a team bonus' : 'are team bonuses'}: every member
              carries the team&rsquo;s figure each week, so the people who worked the same weeks tie.
            </p>
          )}
          {skippedRows > 0 && (
            <p className="text-[11.5px]">
              {skippedRows} bonus {skippedRows === 1 ? 'row isn’t' : 'rows aren’t'} counted: one named
              person&rsquo;s own bonus, or several KPIs in one row.
            </p>
          )}
        </>
      }
    />
  );
}

function names(ms: readonly DeliverableMetricInfo[]): string {
  return ms.map((m) => m.label).join(', ');
}

/** On "All bonuses": the order-only KPIs left out of the items shown, and why. */
function OrderOnlyAmongAll({ ms, why }: { ms: readonly DeliverableMetricInfo[]; why: readonly [string, string] }) {
  const one = ms.length === 1;
  return (
    <p className="text-[11.5px]">
      {names(ms)} {one ? 'is' : 'are'} {one ? why[0] : why[1]}, so {one ? "it isn't" : "they aren't"} in the items
      shown; the order still counts {one ? 'it' : 'them'}.
    </p>
  );
}
