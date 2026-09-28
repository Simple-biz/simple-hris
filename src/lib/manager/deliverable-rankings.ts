/**
 * KPI rankings — Manager → My Team → <department> → Rankings, for PM Team and every
 * other department scored on a per-person KPI bonus (Kane, 2026-09-27: *"Lets create
 * a rankings tab for OTHER Departments as long as they were assigned a KPI Bonus"*).
 * Ranks the current roster by the BONUS they earned (Kane, 2026-09-26: *"this should
 * be based on their Bonus … hook the money like the highest money value without
 * displaying it"*), and shows only KPI item COUNTS — or, for a KPI whose variable IS
 * the pesos, the order alone. Doc: `docs/features/manager-pm-rankings.md`.
 *
 * This module is the CLIENT-SAFE half. It never sees a peso:
 *
 * - the server (`deliverable-money-order.ts`, via `supabase/deliverable-rankings.ts`)
 *   reads `amount`, ranks on it with the SAME `computeLeaderboard` Lead Gen uses, and
 *   sends back POSITIONS only ({@link MoneyOrder});
 * - the pane runs `computeLeaderboard` on the counts below (what is displayed), then
 *   {@link applyMoneyOrder} puts the rows in the server's order.
 *
 * ## Adaptable: the KPIs come from the data
 *
 * Every row that is one person's own KPI (the server decides: one variable, a
 * department-scoped bonus, not a shared-team split — `deliverable-money-order.ts`) is
 * a KPI item, keyed by its variable and labelled with its newest bonus name. A new
 * bonus joins the picker and "All bonuses" with no code change, and a rate change
 * reaches the order through `amount`.
 *
 * ## Shown, or order-only
 *
 * A KPI's number reaches this module only when the bonus formula multiplies the
 * variable by a rate (`=Tickets_Completed*50`): then it is a COUNT. Client VA's bonus
 * is `=Appt_Bonus`, so its variable IS the pesos: the server keeps the value, sends the
 * metric as `shown: false` and the row's presence as `hidden`, and the board shows the
 * order alone. {@link metricShowsValues} is the one place that decides it.
 */
import { normEmail } from '@/lib/email/norm-email';
import type { AverageWindow, DaysWorkedRow, LeaderboardRow } from '@/lib/manager/appointment-averages';
import type {
  AppointmentWeek,
  AppointmentWeekBadge,
  ApptRosterMember,
} from '@/lib/manager/appointment-rankings';

/** The metric key for every KPI summed. Any other metric key is a variable name. */
export const ALL_METRIC = 'all';

export interface DeliverableMetricInfo {
  /** The bonus variable, e.g. `TrustPilot`. */
  key: string;
  /** The newest bonus name that scored it, e.g. "Total Sales and Referral". */
  label: string;
  /**
   * True when its values are COUNTS and may be shown. False when the variable is the
   * peso amount itself (Client VA's `=Appt_Bonus`): ranked on, never shown.
   */
  shown: boolean;
}

export interface DeliverableWeekRow {
  /** Lower-cased, as stored (personal-email-first canonical). */
  email: string;
  /** Only the SHOWN KPIs this person HAS a row for that week — a missing key is no entry, not 0. */
  counts: Record<string, number>;
  /** Order-only KPIs this person has a row for — presence, never a value. Absent when none. */
  hidden?: string[];
}

export interface DeliverableWeek {
  /** Sunday, YYYY-MM-DD — the KPI period key. */
  periodStart: string;
  periodEnd: string;
  badge: AppointmentWeekBadge;
  rows: DeliverableWeekRow[];
}

/**
 * The bonus order, as positions only. `positions[window][metric][i]` is person i's
 * competition rank on bonus pesos (ties share), or null when not ranked. The weekly
 * order also serves Monthly (monthly = weekly × 52/12, the same order).
 */
export interface MoneyOrder {
  /** Every email each ranked roster person owns, lower-cased. */
  people: string[][];
  positions: Record<AverageWindow, Record<string, (number | null)[]>>;
  /**
   * Each settled week's own bonus order, newest first — the Rankings View modal's
   * "Ranking performance" line (`docs/features/manager-rankings-history.md`). Weekly
   * payload only. Absent on the daily payload, and on a payload cached before it
   * existed: the modal then waits for the revalidation and never ranks counts itself.
   */
  weeks?: WeekPositions[];
}

/**
 * One settled week's bonus order, as positions only.
 *
 * - `ranked[metric]`: roster people with an entry for that metric that week (the "of N").
 *   A metric nobody on the roster scored that week is absent.
 * - `positions[metric][i]`: `people[i]`'s competition rank that week on that metric's
 *   pesos (ties share), or null when they have no entry. Absent when none of `people`
 *   has one (only unranked people scored).
 */
export interface WeekPositions {
  /** Sunday, YYYY-MM-DD. */
  periodStart: string;
  ranked: Record<string, number>;
  positions: Record<string, (number | null)[]>;
}

export interface DeliverableRankingsPayload {
  /**
   * False when the department has no per-person KPI row, or is already served by its
   * own Rankings view (appointments, or SP): no leaderboard.
   */
  available: boolean;
  /** Sunday of the week containing today, in Manila. */
  currentWeekStart: string;
  /** Newest first. Counts only. */
  weeks: DeliverableWeek[];
  /** The KPIs present in the data, ordered by label. */
  metrics: DeliverableMetricInfo[];
  /** Rows that are not one person's own KPI (a team split, a personal bonus, several KPIs in one row) — not counted. */
  skippedRows: number;
  /** The weekly/monthly bonus order. Null only alongside an error. */
  order: MoneyOrder | null;
  error: string | null;
}

/** `?basis=daily`: the days worked (for the shown averages) and the per-day bonus order. */
export interface DeliverableDailyPayload {
  days: DaysWorkedRow[];
  order: MoneyOrder | null;
  error: string | null;
}

export type KpiRead = { kind: 'item'; key: string; count: number } | { kind: 'skip' };

/**
 * One applied row's KPI item, or `skip` when it is not exactly one variable. A count
 * is never negative, and an unreadable cell counts as nothing entered (0), matching
 * `appointmentsFromVars`. Fractions stand: Units carries half credits (65 of 207
 * non-zero rows, measured 2026-09-26).
 */
export function kpiItemFromVars(vars: Record<string, unknown> | null | undefined): KpiRead {
  const keys = vars ? Object.keys(vars) : [];
  if (keys.length !== 1) return { kind: 'skip' };
  const key = keys[0]!;
  const raw = vars![key];
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0;
  return { kind: 'item', key, count: Number.isFinite(n) && n > 0 ? n : 0 };
}

/**
 * Whether the board may show NUMBERS for `metric`: "All" when any KPI is a count,
 * one KPI when it is. Order-only otherwise. An unknown metric is order-only (fail closed).
 */
export function metricShowsValues(metric: string, metrics: readonly DeliverableMetricInfo[]): boolean {
  if (metric === ALL_METRIC) return metrics.some((m) => m.shown);
  return metrics.find((m) => m.key === metric)?.shown ?? false;
}

/**
 * A KPI variable in plain words — `Tickets_Completed` → "Tickets completed". Used when a
 * department has ONE KPI, whose bonus name is usually just the department's ("Edit").
 */
export function kpiVariableLabel(variable: string): string {
  const words = variable.replace(/_/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : variable;
}

/** A person-week's items across every SHOWN KPI they have a row for. */
export function totalItems(counts: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

/**
 * The weeks the shared leaderboard computes its SHOWN figures from, for one metric.
 * `appointments` is the leaderboard's count field; here it carries KPI items.
 *
 * - `all` → every person-week with any KPI row, as the unweighted item sum of the
 *   SHOWN KPIs, with their split carried as `parts` (the row's breakdown).
 * - one KPI → only person-weeks that HAVE that KPI's row. No entry ≠ zero, the rule
 *   the appointment views keep: Site Star exists only from 2026-05-17.
 * - an order-only KPI → the same presence, with a count of 0 that the pane never
 *   shows (`metricShowsValues`); it exists so the window and history match the order.
 *
 * The server's money projection keeps the same rows (`deliverable-money-order.ts`),
 * so both sides average over the same weeks and rank the same people.
 */
export function projectDeliverableWeeks(
  weeks: readonly DeliverableWeek[],
  metric: string,
): AppointmentWeek[] {
  return weeks.map((w) => ({
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    badge: w.badge,
    rows: w.rows.flatMap((r) => {
      if (metric === ALL_METRIC) return [{ email: r.email, appointments: totalItems(r.counts), parts: { ...r.counts } }];
      const n = r.counts[metric];
      if (n !== undefined) return [{ email: r.email, appointments: n }];
      return r.hidden?.includes(metric) ? [{ email: r.email, appointments: 0 }] : [];
    }),
  }));
}

/**
 * Put the leaderboard's rows in the server's BONUS order.
 *
 * A row's position is the best position among the emails its roster row carries.
 * Rows with ties keep the count order between them (stable sort). A row the server
 * did not place (the two rosters disagree, or the order is missing) goes LAST and is
 * counted in `unplaced`, which the pane states — never silently ranked by counts.
 */
/** email → index into `order.people`. The first person to claim an email keeps it. */
function peopleIndex(order: MoneyOrder | null): Map<string, number> {
  const indexOf = new Map<string, number>();
  order?.people.forEach((emails, i) => {
    for (const e of emails) if (!indexOf.has(e)) indexOf.set(e, i);
  });
  return indexOf;
}

/**
 * A roster row's best (lowest) position in `positions`, across every email it carries
 * — the one matching rule both the board's order and the View modal's weekly order use.
 */
function bestPositionOf(
  m: ApptRosterMember,
  indexOf: ReadonlyMap<string, number>,
  positions: readonly (number | null)[],
): number | null {
  let best: number | null = null;
  for (const raw of [m.personal_email, m.work_email, m.alternate_work_email, m.alternate_work_email_2]) {
    const e = normEmail(raw ?? null);
    const i = e ? indexOf.get(e) : undefined;
    const p = i === undefined ? null : (positions[i] ?? null);
    if (p !== null && (best === null || p < best)) best = p;
  }
  return best;
}

/**
 * The View modal's weekly rank for one person on one metric, read from the server's
 * bonus order (`MoneyOrder.weeks`). Null while that order has not arrived: the modal
 * then says the order is loading, and never ranks the counts itself.
 */
export function weekRankLookup(
  order: MoneyOrder | null,
  member: ApptRosterMember,
  metric: string,
): ((periodStart: string) => { position: number | null; ranked: number } | null) | null {
  const weeks = order?.weeks;
  if (!weeks) return null;
  const indexOf = peopleIndex(order);
  const byWeek = new Map(weeks.map((w) => [w.periodStart, w]));
  return (periodStart) => {
    const w = byWeek.get(periodStart);
    if (!w) return null;
    const positions = w.positions[metric];
    return {
      position: positions ? bestPositionOf(member, indexOf, positions) : null,
      ranked: w.ranked[metric] ?? 0,
    };
  };
}

export function applyMoneyOrder<M extends ApptRosterMember>(
  rows: readonly LeaderboardRow<M>[],
  order: MoneyOrder | null,
  window: AverageWindow,
  metric: string,
): { rows: LeaderboardRow<M>[]; unplaced: number } {
  const positions = order?.positions[window]?.[metric] ?? null;
  const indexOf = peopleIndex(order);
  const positionOf = (m: M): number | null => (positions ? bestPositionOf(m, indexOf, positions) : null);

  const placed: LeaderboardRow<M>[] = [];
  const unplaced: LeaderboardRow<M>[] = [];
  for (const r of rows) {
    const p = positionOf(r.member);
    if (p === null) unplaced.push(r);
    else placed.push({ ...r, position: p });
  }
  placed.sort((a, b) => a.position - b.position);
  const after = placed.reduce((max, r) => Math.max(max, r.position), 0);
  return {
    rows: [...placed, ...unplaced.map((r, i) => ({ ...r, position: after + i + 1 }))],
    unplaced: unplaced.length,
  };
}
