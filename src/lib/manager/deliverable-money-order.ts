/**
 * The SERVER half of PM Team's Rankings: the bonus pesos, and the order they decide.
 * Doc: `docs/features/manager-pm-rankings.md`.
 *
 * Kane, 2026-09-26: *"this should be based on their Bonus … hook the money like the
 * highest money value without displaying it."* So the order is decided by
 * `bonus_catalog_applied.amount` — what the Payroll Wizard credited, which follows any
 * rate change on its own — while `manager-my-team.md:13-17` still holds: no peso ever
 * reaches My Team. Not on screen, and not **over the wire** either
 * (`employee-team-directory.md:177-179`: a payload ships pay "even with a clean render").
 *
 * - {@link buildKpiData} keeps counts and pesos side by side. Only `weeks` (counts) is
 *   ever serialized; `moneyWeeks` stays on the server.
 * - {@link buildMoneyOrder} ranks on pesos with the SAME `computeLeaderboard` the shown
 *   figures use (same settled weeks, same window, same minimum history, same roster
 *   matching), and returns POSITIONS only.
 * - {@link toClientPayload} is the only way out. `deliverable-money-order.test.ts`
 *   serializes its output from sentinel amounts and fails on any of them.
 *
 * PURE (no I/O) so `node:test` walks it, but **server-only by contract**: a source-scan
 * test fails if any file under `src/components` or `app/` (outside `app/api`) imports it.
 */
import { normEmail } from '@/lib/email/norm-email';
import { weekEndFromStart } from '@/lib/payroll/manila-week';
import {
  computeLeaderboard,
  type AverageWindow,
  type DaysWorkedRow,
} from '@/lib/manager/appointment-averages';
import {
  badgeWeeks,
  indexRosterPeople,
  type AppointmentWeek,
  type AppointmentWeekBadge,
  type ApptRosterMember,
  type ApptStatusRow,
  type LockSettingRow,
} from '@/lib/manager/appointment-rankings';
import {
  ALL_METRIC,
  PM_KPI_VARS,
  kpiItemFromVars,
  type DeliverableMetricInfo,
  type DeliverableRankingsPayload,
  type DeliverableWeek,
  type MoneyOrder,
} from '@/lib/manager/deliverable-rankings';

/** An applied row as the server reads it — WITH the pesos. Never serialized. */
export type AppliedMoneyRow = {
  period_start: string;
  period_end: string | null;
  employee_email: string | null;
  bonus_name: string | null;
  vars: Record<string, unknown> | null;
  amount: number | string | null;
};

interface MoneyWeekRow {
  email: string;
  counts: Record<string, number>;
  /** Pesos per KPI. Server-only. */
  money: Record<string, number>;
}

export interface MoneyWeek {
  periodStart: string;
  periodEnd: string;
  badge: AppointmentWeekBadge;
  rows: MoneyWeekRow[];
}

export interface KpiData {
  available: boolean;
  /** Counts only — the part the client receives. */
  weeks: DeliverableWeek[];
  /** The same weeks with pesos. SERVER-ONLY: never serialized. */
  moneyWeeks: MoneyWeek[];
  metrics: DeliverableMetricInfo[];
  skippedRows: number;
}

const WINDOWS: readonly AverageWindow[] = ['last4w', 'last3m', 'all'];
const PM_KPI_SET: ReadonlySet<string> = new Set(PM_KPI_VARS);

function pesos(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Raw rows → badged weeks of counts and pesos, through the shared `badgeWeeks` (same
 * badge order and fill-forward as the appointment views).
 *
 * - A row counts only when its `vars` hold exactly one key (`kpiItemFromVars`); every
 *   other row — the manager's team-total row — is skipped and counted.
 * - Available only when a counted row carries a {@link PM_KPI_VARS} variable. Inside
 *   that, EVERY one-variable bonus is a KPI (adaptable).
 * - A KPI's label is the bonus name of its NEWEST row, so a renamed bonus reads as renamed.
 * - Two rows for one person, week and KPI are summed (both were credited). None exist today.
 */
export function buildKpiData(input: {
  applied: readonly AppliedMoneyRow[];
  statuses: readonly ApptStatusRow[] | null;
  locks: readonly LockSettingRow[] | null;
  currentWeekStart: string;
}): KpiData {
  const byWeek = new Map<string, { periodEnd: string; byEmail: Map<string, MoneyWeekRow> }>();
  const labels = new Map<string, { label: string; week: string }>();
  let skippedRows = 0;
  for (const r of input.applied) {
    const read = kpiItemFromVars(r.vars);
    if (read.kind === 'skip') {
      skippedRows += 1;
      continue;
    }
    const email = normEmail(r.employee_email);
    if (!email) continue;
    let week = byWeek.get(r.period_start);
    if (!week) {
      week = { periodEnd: r.period_end || weekEndFromStart(r.period_start), byEmail: new Map() };
      byWeek.set(r.period_start, week);
    }
    const row = week.byEmail.get(email) ?? { email, counts: {}, money: {} };
    row.counts[read.key] = (row.counts[read.key] ?? 0) + read.count;
    row.money[read.key] = (row.money[read.key] ?? 0) + pesos(r.amount);
    week.byEmail.set(email, row);
    const name = r.bonus_name?.trim() || read.key;
    const prev = labels.get(read.key);
    if (!prev || r.period_start > prev.week) labels.set(read.key, { label: name, week: r.period_start });
  }

  const available = [...labels.keys()].some((k) => PM_KPI_SET.has(k));
  if (!available) return { available: false, weeks: [], moneyWeeks: [], metrics: [], skippedRows };

  const scored = new Map<string, { periodEnd: string; rows: MoneyWeekRow[] }>();
  for (const [periodStart, w] of byWeek) {
    scored.set(periodStart, {
      periodEnd: w.periodEnd,
      rows: [...w.byEmail.values()].sort((a, b) => a.email.localeCompare(b.email)),
    });
  }
  const moneyWeeks = badgeWeeks({ ...input, scored });
  const weeks: DeliverableWeek[] = moneyWeeks.map((w) => ({
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    badge: w.badge,
    rows: w.rows.map((r) => ({ email: r.email, counts: { ...r.counts } })),
  }));
  const metrics = [...labels.entries()]
    .map(([key, { label }]) => ({ key, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
  return { available: true, weeks, moneyWeeks, metrics, skippedRows };
}

/** Pesos in the leaderboard's count field — SERVER-ONLY, never returned. Same rows as the count projection. */
function projectMoney(weeks: readonly MoneyWeek[], metric: string): AppointmentWeek[] {
  return weeks.map((w) => ({
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    badge: w.badge,
    rows: w.rows.flatMap((r) => {
      if (metric === ALL_METRIC) {
        let total = 0;
        for (const v of Object.values(r.money)) total += v;
        return [{ email: r.email, appointments: total }];
      }
      return r.counts[metric] === undefined ? [] : [{ email: r.email, appointments: r.money[metric] ?? 0 }];
    }),
  }));
}

/**
 * Rank the roster on bonus pesos for every window × metric, and return positions only.
 *
 * `basis` is `weekly` (which also orders Monthly) or `daily` (pesos ÷ Hubstaff days;
 * needs `days`). The roster is the department's, resolved on the server the same way
 * My Team's roster route does, and people are matched by the shared
 * `indexRosterPeople`, so these positions line up with the pane's rows.
 */
export function buildMoneyOrder<M extends ApptRosterMember>(input: {
  moneyWeeks: readonly MoneyWeek[];
  metrics: readonly DeliverableMetricInfo[];
  members: readonly M[];
  days: readonly DaysWorkedRow[] | null;
  basis: 'weekly' | 'daily';
  todayIso: string;
}): MoneyOrder {
  const { people, personByEmail } = indexRosterPeople(input.members);
  const indexOfMember = new Map<M, number>();
  people.forEach((p, i) => indexOfMember.set(p.member, i));
  const emails: string[][] = people.map(() => []);
  for (const [email, p] of personByEmail) emails[indexOfMember.get(p.member)!]!.push(email);

  const metricKeys = [ALL_METRIC, ...input.metrics.map((m) => m.key)];
  const raw = {} as Record<AverageWindow, Record<string, (number | null)[]>>;
  const everRanked = new Set<number>();
  for (const window of WINDOWS) {
    raw[window] = {};
    for (const metric of metricKeys) {
      const lb = computeLeaderboard({
        weeks: projectMoney(input.moneyWeeks, metric),
        days: input.days,
        members: input.members,
        window,
        basis: input.basis,
        todayIso: input.todayIso,
      });
      const positions: (number | null)[] = people.map(() => null);
      for (const row of lb.rows) {
        const i = indexOfMember.get(row.member);
        if (i === undefined) continue;
        positions[i] = row.position;
        everRanked.add(i);
      }
      raw[window][metric] = positions;
    }
  }

  // Send only the people ranked somewhere — the rest would be emails for nothing.
  const keep = people.map((_, i) => i).filter((i) => everRanked.has(i));
  const positions = {} as MoneyOrder['positions'];
  for (const window of WINDOWS) {
    positions[window] = {};
    for (const metric of metricKeys) positions[window][metric] = keep.map((i) => raw[window][metric]![i]!);
  }
  return { people: keep.map((i) => [...emails[i]!].sort()), positions };
}

/**
 * The ONLY shape that leaves the server. Built field by field from the count weeks,
 * so no peso can ride along on a spread.
 */
export function toClientPayload(
  data: KpiData,
  order: MoneyOrder | null,
  currentWeekStart: string,
): DeliverableRankingsPayload {
  return {
    available: data.available,
    currentWeekStart,
    weeks: data.weeks.map((w) => ({
      periodStart: w.periodStart,
      periodEnd: w.periodEnd,
      badge: w.badge,
      rows: w.rows.map((r) => ({ email: r.email, counts: { ...r.counts } })),
    })),
    metrics: data.metrics.map((m) => ({ key: m.key, label: m.label })),
    skippedRows: data.skippedRows,
    order,
    error: null,
  };
}
