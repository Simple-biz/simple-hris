/**
 * Manager → My Team → Rankings → **View**: one person's KPI and ranking history, week
 * by week, for the modal the leaderboard opens after Tenure. Doc:
 * `docs/features/manager-rankings-history.md`.
 *
 * PURE and CLIENT-SAFE. It ranks whatever number it is handed in a row's
 * `appointments` field:
 *
 * - **Lead Gen / Callback** hand it appointments, which ARE that board's order.
 * - **KPI boards** (PM Team, Edit, …) hand it KPI item COUNTS for what is shown. Their
 *   order is the bonus pesos, so the client NEVER ranks those weeks: the server runs
 *   {@link rankWeek} over pesos (`deliverable-money-order.ts`, `buildWeekOrder`) and
 *   sends positions only, and {@link buildPersonHistory} takes them through
 *   `rankBy: { kind: 'server' }`. Ranking the counts there would contradict the board
 *   (`manager-pm-rankings.md` § *The order is the bonus*).
 *
 * The rules are the leaderboard's, reused rather than restated:
 * - the weeks are {@link countedWindowWeeks}: settled weeks only, the newest N;
 * - people are {@link indexRosterPeople}: the roster decides who is ranked, leavers
 *   never are, and a person scored under two emails in one week is summed;
 * - **no entry ≠ 0**: a week without a row for the person is `null` and the line
 *   breaks there. A saved 0 is an entry.
 */
import { normEmail } from '@/lib/email/norm-email';
import { countedWindowWeeks, type AverageWindow } from '@/lib/manager/appointment-averages';
import {
  indexRosterPeople,
  type AppointmentWeek,
  type ApptRosterMember,
  type RosterPerson,
} from '@/lib/manager/appointment-rankings';

/** A person's place in one week. */
export interface WeekRank {
  /** Competition rank that week (ties share); null when they have no entry that week. */
  position: number | null;
  /** Roster people with an entry that week — the "of N". */
  ranked: number;
}

/**
 * Where a week's rank comes from.
 * - `values`: rank the values handed in (Lead Gen: the appointments ARE the order).
 * - `server`: the positions the server computed (KPI boards: the order is pesos).
 *   `lookup(periodStart)` answers for the person being viewed, or null for a week the
 *   server did not rank. `lookup` itself is null while the order has not arrived (a
 *   payload cached before it existed): positions then stay null and `rankPending` is
 *   set. They are never computed here.
 */
export type WeekRankSource =
  | { kind: 'values' }
  | { kind: 'server'; lookup: ((periodStart: string) => WeekRank | null) | null };

/** Values are compared at cents, so a float sum of pesos never splits a real tie. */
function tieKey(n: number): number {
  return Math.round(n * 100);
}

/**
 * One week's rows grouped by roster person: every email a person owns summed, parts
 * summed alongside. An email matching nobody on the roster (a leaver, a transfer) is
 * dropped: the roster decides who is ranked.
 */
export function groupWeekByPerson<M extends ApptRosterMember>(
  week: AppointmentWeek,
  personByEmail: ReadonlyMap<string, RosterPerson<M>>,
): Map<RosterPerson<M>, { value: number; parts: Record<string, number> | null }> {
  const out = new Map<RosterPerson<M>, { value: number; parts: Record<string, number> | null }>();
  for (const r of week.rows) {
    const p = personByEmail.get(r.email);
    if (!p) continue;
    const cur = out.get(p) ?? { value: 0, parts: null };
    cur.value += r.appointments;
    if (r.parts) {
      cur.parts ??= {};
      for (const [k, n] of Object.entries(r.parts)) cur.parts[k] = (cur.parts[k] ?? 0) + n;
    }
    out.set(p, cur);
  }
  return out;
}

/**
 * Competition positions, highest value first; equal values (at cents) share a
 * position and the next one skips (1, 2, 2, 4).
 */
export function competitionPositions<K>(values: ReadonlyMap<K, number>): Map<K, number> {
  const sorted = [...values.entries()].sort((a, b) => b[1] - a[1]);
  const out = new Map<K, number>();
  sorted.forEach(([k, v], i) => {
    const prev = sorted[i - 1];
    out.set(k, prev && tieKey(prev[1]) === tieKey(v) ? out.get(prev[0])! : i + 1);
  });
  return out;
}

/**
 * Rank one week over the roster: people with an entry that week, by their summed
 * value, ties sharing. Returns each ranked person's position and the count ranked.
 */
export function rankWeek<M extends ApptRosterMember>(
  week: AppointmentWeek,
  personByEmail: ReadonlyMap<string, RosterPerson<M>>,
): { ranked: number; positions: Map<RosterPerson<M>, number> } {
  const grouped = groupWeekByPerson(week, personByEmail);
  const values = new Map<RosterPerson<M>, number>();
  for (const [p, g] of grouped) values.set(p, g.value);
  return { ranked: values.size, positions: competitionPositions(values) };
}

/** The roster person a board row's member is, by any email that member carries. */
export function personForMember<M extends ApptRosterMember>(
  member: ApptRosterMember,
  personByEmail: ReadonlyMap<string, RosterPerson<M>>,
): RosterPerson<M> | null {
  for (const raw of [member.personal_email, member.work_email, member.alternate_work_email, member.alternate_work_email_2]) {
    const e = normEmail(raw ?? null);
    const p = e ? personByEmail.get(e) : undefined;
    if (p) return p;
  }
  return null;
}

export interface HistoryPoint {
  /** Sunday, YYYY-MM-DD. */
  periodStart: string;
  /** The person's value that week, or null: no entry, so the line breaks (never 0). */
  value: number | null;
  /** What `value` is made of (a KPI board's "All bonuses"), or null. */
  parts: Record<string, number> | null;
  /** The average over roster people with an entry that week; null when nobody had one. */
  teamAverage: number | null;
  /** The person's position that week; null with no entry, or while the order is pending. */
  position: number | null;
  /** Roster people ranked that week; 0 while the order is pending. */
  ranked: number;
}

export interface PersonHistory {
  /** One point per counted week in the window, OLDEST first (left to right). */
  points: HistoryPoint[];
  /** The window's weeks that were left out (drafts, couldn't check), newest first. */
  leftOut: AppointmentWeek[];
  /** True while a server-ranked board's weekly order has not arrived. */
  rankPending: boolean;
  /** Weeks in the window the person has an entry for. */
  weeksScored: number;
  /** Their value ÷ weeks scored: the board's per-week figure over the same weeks. Null with none. */
  averagePerWeek: number | null;
  /** The highest value and its week (the newest on a tie); null with no entry. */
  bestWeek: { periodStart: string; value: number } | null;
  /** The best (lowest) position, and how many weeks they held it; null with no position. */
  bestRank: { position: number; weeks: number } | null;
}

/**
 * One person's week-by-week history over a window.
 *
 * The weeks, the people and the "no entry ≠ 0" rule are the leaderboard's (see the
 * module note), so the modal's average per week equals the board's for the same window.
 */
export function buildPersonHistory<M extends ApptRosterMember>(input: {
  weeks: readonly AppointmentWeek[];
  members: readonly M[];
  member: ApptRosterMember;
  window: AverageWindow;
  rankBy: WeekRankSource;
}): PersonHistory {
  const { windowWeeks, leftOut } = countedWindowWeeks(input.weeks, input.window);
  const { personByEmail } = indexRosterPeople(input.members);
  const me = personForMember(input.member, personByEmail);
  const server = input.rankBy.kind === 'server' ? input.rankBy : null;
  const rankPending = server !== null && server.lookup === null;

  const points: HistoryPoint[] = [...windowWeeks].reverse().map((w) => {
    const grouped = groupWeekByPerson(w, personByEmail);
    let sum = 0;
    for (const g of grouped.values()) sum += g.value;
    const mine = me ? grouped.get(me) : undefined;
    let position: number | null = null;
    let ranked = 0;
    if (server) {
      const r = server.lookup ? server.lookup(w.periodStart) : null;
      // A position only where the person HAS an entry: the server's order and these
      // counts come from the same rows, so this never hides a real position.
      position = mine ? (r?.position ?? null) : null;
      ranked = r?.ranked ?? 0;
    } else {
      const r = rankWeek(w, personByEmail);
      position = me ? (r.positions.get(me) ?? null) : null;
      ranked = r.ranked;
    }
    return {
      periodStart: w.periodStart,
      value: mine ? mine.value : null,
      parts: mine?.parts ?? null,
      teamAverage: grouped.size > 0 ? sum / grouped.size : null,
      position,
      ranked,
    };
  });

  const scored = points.filter((p) => p.value !== null);
  const total = scored.reduce((n, p) => n + p.value!, 0);
  let bestWeek: PersonHistory['bestWeek'] = null;
  for (const p of scored) if (!bestWeek || p.value! >= bestWeek.value) bestWeek = { periodStart: p.periodStart, value: p.value! };
  const positions = points.map((p) => p.position).filter((n): n is number => n !== null);
  const top = positions.length > 0 ? Math.min(...positions) : null;

  return {
    points,
    leftOut,
    rankPending,
    weeksScored: scored.length,
    averagePerWeek: scored.length > 0 ? total / scored.length : null,
    bestWeek,
    bestRank: top === null ? null : { position: top, weeks: positions.filter((n) => n === top).length },
  };
}
