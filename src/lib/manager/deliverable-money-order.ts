/**
 * The SERVER half of My Team's KPI Rankings (PM Team, and every other department on a
 * per-person KPI bonus): the bonus pesos, and the order they decide.
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
 * - {@link classifyBonuses} decides, from the catalog, which rows are one person's own
 *   KPI and which values are COUNTS. The formulas it reads carry the pay RATES, so they
 *   stay here too.
 *
 * PURE (no I/O) so `node:test` walks it, but **server-only by contract**: a source-scan
 * test fails if any file under `src/components` or `app/` (outside `app/api`) imports it.
 */
import { normEmail } from '@/lib/email/norm-email';
import { weekEndFromStart } from '@/lib/payroll/manila-week';
import {
  computeLeaderboard,
  countedWindowWeeks,
  type AverageWindow,
  type DaysWorkedRow,
} from '@/lib/manager/appointment-averages';
import {
  appointmentsFromVars,
  badgeWeeks,
  indexRosterPeople,
  type AppointmentWeek,
  type AppointmentWeekBadge,
  type ApptRosterMember,
  type ApptStatusRow,
  type LockSettingRow,
  type RosterPerson,
} from '@/lib/manager/appointment-rankings';
import { isSpRankingRow } from '@/lib/manager/sp-ranking-row';
import { rankWeek } from '@/lib/manager/ranking-history';
import {
  ALL_METRIC,
  kpiItemFromVars,
  type DeliverableMetricInfo,
  type DeliverableRankingsPayload,
  type DeliverableWeek,
  type MoneyOrder,
  type WeekPositions,
} from '@/lib/manager/deliverable-rankings';

/** An applied row as the server reads it — WITH the pesos. Never serialized. */
export type AppliedMoneyRow = {
  period_start: string;
  period_end: string | null;
  employee_email: string | null;
  bonus_id: string | null;
  bonus_name: string | null;
  vars: Record<string, unknown> | null;
  amount: number | string | null;
};

interface MoneyWeekRow {
  email: string;
  /** EVERY KPI's value, shown or not — server-only until `toClientPayload` splits it. */
  counts: Record<string, number>;
  /** Pesos per KPI. Server-only. */
  money: Record<string, number>;
}

/** A catalog bonus definition, as the classifier needs it. Server-only: `formula` holds the rates. */
export interface BonusDefRow {
  id: string;
  kind: string | null;
  formula: string | null;
}

/** A catalog assignment, as the classifier needs it. */
export interface BonusAssignmentRow {
  bonus_id: string;
  scope: string | null;
  department_key: string | null;
  shared_team: boolean | null;
}

/** Why a department has no KPI leaderboard even though it has rows. */
export type ServedElsewhere = 'appointments' | 'sp' | null;

export interface MoneyWeek {
  periodStart: string;
  periodEnd: string;
  badge: AppointmentWeekBadge;
  rows: MoneyWeekRow[];
}

export interface KpiData {
  available: boolean;
  /** Set when the department already has its own Rankings view; then `available` is false. */
  servedBy: ServedElsewhere;
  /** Counts only — the part the client receives. */
  weeks: DeliverableWeek[];
  /** The same weeks with pesos. SERVER-ONLY: never serialized. */
  moneyWeeks: MoneyWeek[];
  metrics: DeliverableMetricInfo[];
  skippedRows: number;
}

const WINDOWS: readonly AverageWindow[] = ['last4w', 'last3m', 'all'];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `formula` multiplies `variable` by a constant other than 1
 * (`=Tickets_Completed*50`, `AMP*1250`, `=sum(Site_Star_Ranking*1000)`,
 * `IF(Appts_Set>=10, Appts_Set*500, …)`), i.e. the variable is a COUNT and the pesos
 * are derived from it. That is the ONLY kind of value the board may show.
 *
 * Client VA's formula is `=Appt_Bonus` (measured 2026-09-27: amount = value on all 95
 * non-zero rows), so its variable IS the pesos and fails here. Fails closed on a
 * missing or unreadable formula. Names match whole: `Units` never matches `Units_Sold`.
 */
export function isCountVariable(formula: string | null | undefined, variable: string): boolean {
  if (!formula || !variable) return false;
  const v = escapeRegExp(variable);
  const num = '(\\d+(?:\\.\\d+)?)';
  const after = new RegExp(`(?<![A-Za-z0-9_])${v}\\s*\\*\\s*${num}`, 'g');
  const before = new RegExp(`${num}\\s*\\*\\s*${v}(?![A-Za-z0-9_])`, 'g');
  for (const re of [after, before]) {
    for (const m of formula.matchAll(re)) if (Number(m[1]) !== 1) return true;
  }
  return false;
}

/**
 * Per bonus: are its rows one person's own KPI in `deptKey`, and which of its
 * variables are counts.
 *
 * **Personal** is decided on EVIDENCE. A bonus is left out only when this department's
 * assignments exist and none of them is a department-scoped, non-shared one:
 * - a `shared_team` split (HR `New_Hires*1000/HR_Team_Members`, QC, Accounting's
 *   Dancing Queen) pays every member the same share, so ranking it says nothing about
 *   who performed;
 * - an `employee`-scoped bonus is one person's own (Scott Cameron's manager bonus on
 *   PM Team, Lead Receptionist, Jackie), not the team's KPI.
 * A bonus with NO assignment for the department still counts: a retired or re-keyed
 * bonus keeps its paid history.
 */
export function classifyBonuses(input: {
  deptKey: string;
  defs: readonly BonusDefRow[];
  assignments: readonly BonusAssignmentRow[];
}): Map<string, { personal: boolean; formula: string | null; fixed: boolean }> {
  const out = new Map<string, { personal: boolean; formula: string | null; fixed: boolean }>();
  const ids = new Set<string>([...input.defs.map((d) => d.id), ...input.assignments.map((a) => a.bonus_id)]);
  for (const id of ids) {
    const def = input.defs.find((d) => d.id === id) ?? null;
    const mine = input.assignments.filter((a) => a.bonus_id === id && (a.department_key ?? '').trim() === input.deptKey);
    const personal = mine.length === 0 || mine.some((a) => a.scope === 'department' && !a.shared_team);
    out.set(id, { personal, formula: def?.formula ?? null, fixed: def?.kind === 'fixed' });
  }
  return out;
}

function pesos(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Raw rows → badged weeks of counts and pesos, through the shared `badgeWeeks` (same
 * badge order and fill-forward as the appointment views).
 *
 * - **Served elsewhere → unavailable.** A department with an appointment variable
 *   (`Appts_Set` / `Appts`: Lead Gen, Callback) or an SP-ranking row (AI/API) already has
 *   its own Rankings view under the one pill, behind its own gate. A second, money-ranked
 *   pane there would widen who reads it (the SP doors are Kane's ruling).
 * - A row counts only when it is one person's own KPI: one variable (`kpiItemFromVars`)
 *   AND a personal bonus ({@link classifyBonuses}). Every other row is skipped and counted.
 * - Available when at least one row counts. EVERY such bonus is a KPI (adaptable).
 * - A KPI is **shown** only when every bonus scoring its variable is a count bonus
 *   ({@link isCountVariable}) and none is a fixed amount; otherwise it is order-only.
 * - A KPI's label is the bonus name of its NEWEST row, so a renamed bonus reads as renamed.
 * - Two rows for one person, week and KPI are summed (both were credited). None exist today.
 */
export function buildKpiData(input: {
  applied: readonly AppliedMoneyRow[];
  statuses: readonly ApptStatusRow[] | null;
  locks: readonly LockSettingRow[] | null;
  currentWeekStart: string;
  deptKey: string;
  defs: readonly BonusDefRow[];
  assignments: readonly BonusAssignmentRow[];
}): KpiData {
  const empty = (servedBy: ServedElsewhere, skippedRows: number): KpiData => ({
    available: false,
    servedBy,
    weeks: [],
    moneyWeeks: [],
    metrics: [],
    skippedRows,
  });
  if (input.applied.some((r) => appointmentsFromVars(r.vars) !== null)) return empty('appointments', 0);
  if (input.applied.some((r) => isSpRankingRow(r.vars))) return empty('sp', 0);

  const bonuses = classifyBonuses(input);
  const byWeek = new Map<string, { periodEnd: string; byEmail: Map<string, MoneyWeekRow> }>();
  const labels = new Map<string, { label: string; week: string }>();
  const orderOnly = new Set<string>();
  let skippedRows = 0;
  for (const r of input.applied) {
    const read = kpiItemFromVars(r.vars);
    const bonus = r.bonus_id ? bonuses.get(r.bonus_id) : undefined;
    if (read.kind === 'skip' || (bonus && !bonus.personal)) {
      skippedRows += 1;
      continue;
    }
    // Fail closed: an unknown bonus, a fixed amount, or a formula that does not
    // multiply the variable by a rate makes the KPI order-only.
    if (!bonus || bonus.fixed || !isCountVariable(bonus.formula, read.key)) orderOnly.add(read.key);
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

  if (labels.size === 0) return empty(null, skippedRows);

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
    rows: w.rows.map((r) => splitShown(r, orderOnly)),
  }));
  const metrics = [...labels.entries()]
    .map(([key, { label }]) => ({ key, label, shown: !orderOnly.has(key) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
  return { available: true, servedBy: null, weeks, moneyWeeks, metrics, skippedRows };
}

/**
 * A row as the client may see it: shown KPIs keep their counts, order-only KPIs become
 * bare presence in `hidden` — the value (which for those IS the pesos) never leaves.
 */
function splitShown(r: MoneyWeekRow, orderOnly: ReadonlySet<string>): { email: string; counts: Record<string, number>; hidden?: string[] } {
  const counts: Record<string, number> = {};
  const hidden: string[] = [];
  for (const [k, n] of Object.entries(r.counts)) {
    if (orderOnly.has(k)) hidden.push(k);
    else counts[k] = n;
  }
  return hidden.length > 0 ? { email: r.email, counts, hidden: hidden.sort() } : { email: r.email, counts };
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
 * needs `days`). The weekly order also carries each settled week's OWN order
 * (`weeks`, {@link buildWeekOrder}) for the Rankings View modal — positions only, like
 * the rest. The roster is the department's, resolved on the server the same way
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
  const order: MoneyOrder = { people: keep.map((i) => [...emails[i]!].sort()), positions };
  if (input.basis === 'weekly') {
    order.weeks = buildWeekOrder({
      moneyWeeks: input.moneyWeeks,
      metricKeys,
      personByEmail,
      keptPeople: keep.map((i) => people[i]!),
    });
  }
  return order;
}

/**
 * Each settled week's own bonus order, for the Rankings View modal's "Ranking
 * performance" line (`docs/features/manager-rankings-history.md`) — positions only.
 *
 * Per metric, the SAME money projection the board ranks (`projectMoney`) and the SAME
 * settled weeks (`countedWindowWeeks`, all time), each ranked on its pesos by the
 * client-safe `rankWeek`: roster people with an entry that week, every email summed,
 * ties sharing. The client never ranks a KPI week from the counts, because the order
 * is the bonus and the counts would contradict the board.
 */
function buildWeekOrder<M extends ApptRosterMember>(input: {
  moneyWeeks: readonly MoneyWeek[];
  metricKeys: readonly string[];
  personByEmail: ReadonlyMap<string, RosterPerson<M>>;
  /** Aligned with `MoneyOrder.people`. */
  keptPeople: readonly RosterPerson<M>[];
}): WeekPositions[] {
  const byWeek = new Map<string, WeekPositions>();
  for (const metric of input.metricKeys) {
    const { windowWeeks } = countedWindowWeeks(projectMoney(input.moneyWeeks, metric), 'all');
    for (const w of windowWeeks) {
      const { ranked, positions } = rankWeek(w, input.personByEmail);
      if (ranked === 0) continue;
      const entry = byWeek.get(w.periodStart) ?? { periodStart: w.periodStart, ranked: {}, positions: {} };
      entry.ranked[metric] = ranked;
      const mine = input.keptPeople.map((p) => positions.get(p) ?? null);
      if (mine.some((p) => p !== null)) entry.positions[metric] = mine;
      byWeek.set(w.periodStart, entry);
    }
  }
  return [...byWeek.values()].sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
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
      rows: w.rows.map((r) =>
        r.hidden && r.hidden.length > 0
          ? { email: r.email, counts: { ...r.counts }, hidden: [...r.hidden] }
          : { email: r.email, counts: { ...r.counts } },
      ),
    })),
    metrics: data.metrics.map((m) => ({ key: m.key, label: m.label, shown: m.shown })),
    skippedRows: data.skippedRows,
    order,
    error: null,
  };
}
