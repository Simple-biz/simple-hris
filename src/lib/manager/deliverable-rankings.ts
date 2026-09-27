/**
 * KPI rankings — Manager → My Team → PM Team → Rankings. Ranks the current roster
 * by the BONUS they earned (Kane, 2026-09-26: *"this should be based on their Bonus
 * … hook the money like the highest money value without displaying it"*), and
 * shows only KPI item COUNTS. Doc: `docs/features/manager-pm-rankings.md`.
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
 * PM Team is scored on one-variable bonuses (`=TrustPilot*1000`, `=Units*2500`, …;
 * eight of them on 2026-09-26). Every ONE-variable row in the department is a KPI item,
 * keyed by its variable and labelled with its newest bonus name, so a new bonus joins
 * the picker and "All bonuses" with no code change, and a rate change reaches the order
 * through `amount`. {@link PM_KPI_VARS} decides only WHETHER a department has this view
 * (availability, like Lead Gen's exact `Appts_Set`), never what is ranked inside it.
 *
 * ## Rows that are not one KPI count are left out, and counted
 *
 * "Scott Cameron" (`PM Team - Manager`) is ONE row a week with 15–17 keys of the whole
 * team's totals. Counting it would hand one person the team's work. A row counts only
 * when its `vars` hold exactly one key; every other row is skipped and counted
 * (`skippedRows`), so the pane says so instead of silently dropping it.
 */
import { normEmail } from '@/lib/email/norm-email';
import type { AverageWindow, DaysWorkedRow, LeaderboardRow } from '@/lib/manager/appointment-averages';
import type {
  AppointmentWeek,
  AppointmentWeekBadge,
  ApptRosterMember,
} from '@/lib/manager/appointment-rankings';

/**
 * PM Team's KPI variables as of 2026-09-26. AVAILABILITY ONLY: a department gets the
 * view when a one-variable row carries one of these (only `pm_team` does). What is
 * ranked is whatever one-variable bonuses the department actually has.
 */
export const PM_KPI_VARS = [
  'Units',
  'TransUnion',
  'TrustPilot',
  'BBB',
  'FB',
  'SmartCustomer',
  'AMP',
  'Site_Star_Ranking',
] as const;

/** The metric key for every KPI summed. Any other metric key is a variable name. */
export const ALL_METRIC = 'all';

export interface DeliverableMetricInfo {
  /** The bonus variable, e.g. `TrustPilot`. */
  key: string;
  /** The newest bonus name that scored it, e.g. "Total Sales and Referral". */
  label: string;
}

export interface DeliverableWeekRow {
  /** Lower-cased, as stored (personal-email-first canonical). */
  email: string;
  /** Only the KPIs this person HAS a row for that week — a missing key is no entry, not 0. */
  counts: Record<string, number>;
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
}

export interface DeliverableRankingsPayload {
  /** False when no one-variable row carries a PM KPI variable: no leaderboard. */
  available: boolean;
  /** Sunday of the week containing today, in Manila. */
  currentWeekStart: string;
  /** Newest first. Counts only. */
  weeks: DeliverableWeek[];
  /** The KPIs present in the data, ordered by label. */
  metrics: DeliverableMetricInfo[];
  /** Rows that are not one KPI count (a manager's team-total row) — not counted. */
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

/** A person-week's items across every KPI they have a row for. */
export function totalItems(counts: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const v of Object.values(counts)) n += v;
  return n;
}

/**
 * The weeks the shared leaderboard computes its SHOWN figures from, for one metric.
 * `appointments` is the leaderboard's count field; here it carries KPI items.
 *
 * - `all` → every person-week with any KPI row, as the unweighted item sum, with the
 *   per-KPI split carried as `parts` (the row's breakdown).
 * - one KPI → only person-weeks that HAVE that KPI's row. No entry ≠ zero, the rule
 *   the appointment views keep: Site Star exists only from 2026-05-17.
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
      return n === undefined ? [] : [{ email: r.email, appointments: n }];
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
export function applyMoneyOrder<M extends ApptRosterMember>(
  rows: readonly LeaderboardRow<M>[],
  order: MoneyOrder | null,
  window: AverageWindow,
  metric: string,
): { rows: LeaderboardRow<M>[]; unplaced: number } {
  const positions = order?.positions[window]?.[metric] ?? null;
  const indexOf = new Map<string, number>();
  order?.people.forEach((emails, i) => {
    for (const e of emails) if (!indexOf.has(e)) indexOf.set(e, i);
  });
  const positionOf = (m: M): number | null => {
    if (!positions) return null;
    let best: number | null = null;
    for (const raw of [m.personal_email, m.work_email, m.alternate_work_email, m.alternate_work_email_2]) {
      const e = normEmail(raw ?? null);
      const i = e ? indexOf.get(e) : undefined;
      const p = i === undefined ? null : (positions[i] ?? null);
      if (p !== null && (best === null || p < best)) best = p;
    }
    return best;
  };

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
