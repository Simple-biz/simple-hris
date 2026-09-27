/**
 * Appointments ranking — Manager → My Team → <department> → Appointments.
 *
 * Who on the selected department's CURRENT roster set the most appointments,
 * week by week or month by month, with each person's tenure. Doc:
 * `docs/features/manager-appointment-rankings.md`.
 *
 * PURE — no I/O, no `server-only` — so `node:test` walks every rule. The server
 * read (`src/lib/supabase/appointment-rankings.ts`) only fetches; the route hands
 * this module plain rows; the pane only paints what comes out.
 *
 * ## Where the count comes from
 *
 * `bonus_catalog_applied.vars` — the figure the manager's KPI Calculator saved,
 * i.e. what the Payroll Wizard pays from. Lead Gen's bonus (`bonus_mq9yxlmsyj7avdmc`)
 * scores `Appts_Set`; the COP variant (`bonus_mtddp1p5rf4hq1rw`) scores `Appts`
 * (`qc-scoring.md` § *The variable is resolved PER MEMBER*). **Exact names only** —
 * a `/appt/i` match would also pick up client_va's `Appt_Bonus` (1,254 rows on
 * 2026-09-26), which is not a count.
 *
 * Every count in the HRIS is WEEKLY. There is no daily figure anywhere, so there
 * is no daily view (Kane, Q2 → a): dividing a week by seven would invent numbers.
 *
 * ## Never pesos
 *
 * `manager-my-team.md:13-17` — managers never see pay on My Team. Appointments ×
 * ₱250 IS the pay, so this module carries counts only and the read that feeds it
 * does not select `amount` (its test pins the projection string).
 */
import { normEmail } from '@/lib/email/norm-email';
import { payrollWeekMonthOrdinal } from '@/lib/payroll/bonus-cadence';
import { parseDispatchLockValue } from '@/lib/payroll/wizard-setup-steps';
import { payWeekStartFromSourceFile } from '@/lib/payroll/adjustment-bridge';
import { addWeeks, weekEndFromStart } from '@/lib/payroll/manila-week';
import { parseMasterStartDate } from '@/lib/payroll/dispatch-bonuses';

/** The two variables that hold an appointment COUNT, in lookup order. */
export const APPOINTMENT_VARS = ['Appts_Set', 'Appts'] as const;

/** The app_settings prefix of the Payroll Wizard's per-file lock. */
export const DISPATCH_LOCK_PREFIX = 'payroll.dispatch_lock.';

/**
 * Where a week has got to. Strongest evidence wins; see {@link weekBadge}.
 *
 * - `not_scored` — nothing entered for the week yet.
 * - `draft` — entered, not sent to Accounting.
 * - `with_accounting` — sent (status ready/locked), the wizard not locked yet.
 * - `finalized` — the Payroll Wizard is locked for the week. The top state: there
 *   is no per-week "Paid" signal worth trusting (Kane, Q3b) — 06-14 → 07-05 are
 *   locked with 0 paid dispatch rows, and the unscored 09-20 week already had one.
 * - `no_record` — older than the first wizard-lock record. Those weeks were paid
 *   before the lock existed; calling them "Draft" would be false.
 * - `unknown` — the status or lock read failed. Never a guessed state.
 */
export type AppointmentWeekBadge =
  | 'not_scored'
  | 'draft'
  | 'with_accounting'
  | 'finalized'
  | 'no_record'
  | 'unknown';

/** Badges that mean the week's count may still change. */
export const NOT_FINAL_BADGES: ReadonlySet<AppointmentWeekBadge> = new Set([
  'not_scored',
  'draft',
  'with_accounting',
  'unknown',
]);

export interface AppointmentWeekRow {
  /** Lower-cased, as stored (personal-email-first canonical). */
  email: string;
  appointments: number;
  /**
   * What `appointments` is made of, when it is a sum — PM Team's "All KPIs" count
   * carries its per-KPI split here (`deliverable-rankings.ts`). Appointment rows
   * never set it. Counts only, never pesos.
   */
  parts?: Readonly<Record<string, number>>;
}

export interface AppointmentWeek {
  /** Sunday, YYYY-MM-DD — the KPI period key. */
  periodStart: string;
  periodEnd: string;
  badge: AppointmentWeekBadge;
  /** One row per email, summed across that email's appointment rows. */
  rows: AppointmentWeekRow[];
}

export interface AppointmentRankingsPayload {
  /** False when the department's rows carry no appointment variable: no pill. */
  available: boolean;
  /** Sunday of the week containing today, in Manila. */
  currentWeekStart: string;
  /** Newest first. */
  weeks: AppointmentWeek[];
  error: string | null;
}

export type AppliedApptRow = {
  period_start: string;
  period_end: string | null;
  employee_email: string | null;
  vars: Record<string, unknown> | null;
};

export type ApptStatusRow = { period_start: string; status: string };
export type LockSettingRow = { key: string; value: string | null };

/** The appointment count a row carries, or null when it is not an appointment row. */
export function appointmentsFromVars(vars: Record<string, unknown> | null | undefined): number | null {
  if (!vars) return null;
  for (const name of APPOINTMENT_VARS) {
    if (!(name in vars)) continue;
    const raw = vars[name];
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : 0;
    // A count is never negative; an unreadable cell counts as nothing entered.
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return null;
}

/**
 * The week badge. Order is the rule:
 *
 * 1. no rows → `not_scored` (the applied read succeeded, so this is certain);
 * 2. lock read failed → `unknown`;
 * 3. any file for the week locked → `finalized` — whatever the KPI status says,
 *    payroll was cut from that week (06-07 is a `draft` status row on a locked week);
 * 4. older than the first lock record → `no_record`;
 * 5. status read failed → `unknown`;
 * 6. status ready/locked → `with_accounting`;
 * 7. otherwise → `draft`.
 */
export function weekBadge(input: {
  hasRows: boolean;
  status: string | null;
  finalized: boolean;
  beforeLockRecord: boolean;
  statusReadFailed: boolean;
  lockReadFailed: boolean;
}): AppointmentWeekBadge {
  if (!input.hasRows) return 'not_scored';
  if (input.lockReadFailed) return 'unknown';
  if (input.finalized) return 'finalized';
  if (input.beforeLockRecord) return 'no_record';
  if (input.statusReadFailed) return 'unknown';
  if (input.status === 'ready' || input.status === 'locked') return 'with_accounting';
  return 'draft';
}

/**
 * Lock settings → the set of finalized week starts, and where the lock record
 * begins. Weeks join by the PARSED date range, never the filename: the live keys
 * include `..._2026-09-05 4.csv` and a second `api_sync` file for 07-19 (memory
 * `orphanage-source-file-drift-hides-a-week`). Any file for a week locked → the
 * week is finalized.
 */
export function finalizedWeeks(locks: readonly LockSettingRow[]): {
  finalized: Set<string>;
  earliestRecord: string | null;
} {
  const finalized = new Set<string>();
  let earliestRecord: string | null = null;
  for (const row of locks) {
    if (!row.key.startsWith(DISPATCH_LOCK_PREFIX)) continue;
    const week = payWeekStartFromSourceFile(row.key.slice(DISPATCH_LOCK_PREFIX.length));
    if (!week) continue;
    if (earliestRecord === null || week < earliestRecord) earliestRecord = week;
    if (parseDispatchLockValue(row.value).locked) finalized.add(week);
  }
  return { finalized, earliestRecord };
}

/**
 * Raw rows → badged weeks, newest first.
 *
 * `statuses` / `locks` are `null` when their read FAILED — distinct from an
 * empty list, which is a successful read of nothing.
 *
 * The stepper never skips a week between the newest scored week and the current
 * one: an unscored recent week shows as `not_scored` rather than vanishing. Older
 * gaps (nothing was ever scored — April 2026 for Lead Gen) are not listed.
 */
export function buildAppointmentWeeks(input: {
  applied: readonly AppliedApptRow[];
  statuses: readonly ApptStatusRow[] | null;
  locks: readonly LockSettingRow[] | null;
  currentWeekStart: string;
}): { available: boolean; weeks: AppointmentWeek[] } {
  const byWeek = new Map<string, { periodEnd: string; byEmail: Map<string, number> }>();
  for (const r of input.applied) {
    const n = appointmentsFromVars(r.vars);
    if (n === null) continue;
    const email = normEmail(r.employee_email);
    if (!email) continue;
    let week = byWeek.get(r.period_start);
    if (!week) {
      week = { periodEnd: r.period_end || weekEndFromStart(r.period_start), byEmail: new Map() };
      byWeek.set(r.period_start, week);
    }
    week.byEmail.set(email, (week.byEmail.get(email) ?? 0) + n);
  }
  if (byWeek.size === 0) return { available: false, weeks: [] };

  const scored = new Map<string, { periodEnd: string; rows: AppointmentWeekRow[] }>();
  for (const [periodStart, w] of byWeek) {
    scored.set(periodStart, {
      periodEnd: w.periodEnd,
      rows: [...w.byEmail.entries()]
        .map(([email, appointments]) => ({ email, appointments }))
        .sort((a, b) => b.appointments - a.appointments || a.email.localeCompare(b.email)),
    });
  }
  return { available: true, weeks: badgeWeeks({ ...input, scored }) };
}

/**
 * Scored weeks → badged weeks, newest first. Shared by every count view on My Team
 * (appointments, and PM Team's KPI items — `deliverable-rankings.ts`), so the badge
 * order and the fill-forward rule exist exactly once.
 *
 * `statuses` / `locks` are `null` when their read FAILED (see
 * {@link buildAppointmentWeeks}). Every week from the newest scored week up to
 * `currentWeekStart` is listed; an unscored one gets no rows and `not_scored`.
 */
export function badgeWeeks<R>(input: {
  scored: ReadonlyMap<string, { periodEnd: string; rows: R[] }>;
  statuses: readonly ApptStatusRow[] | null;
  locks: readonly LockSettingRow[] | null;
  currentWeekStart: string;
}): { periodStart: string; periodEnd: string; badge: AppointmentWeekBadge; rows: R[] }[] {
  const byWeek = new Map(input.scored);
  if (byWeek.size === 0) return [];

  // Fill forward from the newest scored week to the current week. Bounded so a
  // bad clock can never spin.
  const starts = [...byWeek.keys()].sort();
  let cursor = starts[starts.length - 1]!;
  for (let i = 0; i < 60 && cursor < input.currentWeekStart; i += 1) {
    cursor = addWeeks(cursor, 1);
    if (!byWeek.has(cursor)) byWeek.set(cursor, { periodEnd: weekEndFromStart(cursor), rows: [] });
  }

  const statusByWeek = new Map<string, string>();
  for (const s of input.statuses ?? []) statusByWeek.set(s.period_start, s.status);
  const lockInfo = input.locks ? finalizedWeeks(input.locks) : null;
  const earliest = lockInfo?.earliestRecord ?? null;

  return [...byWeek.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([periodStart, w]) => ({
      periodStart,
      periodEnd: w.periodEnd,
      badge: weekBadge({
        hasRows: w.rows.length > 0,
        status: statusByWeek.get(periodStart) ?? null,
        finalized: lockInfo?.finalized.has(periodStart) ?? false,
        beforeLockRecord: earliest !== null && periodStart < earliest,
        statusReadFailed: input.statuses === null,
        lockReadFailed: input.locks === null,
      }),
      rows: w.rows,
    }));
}

export interface AppointmentMonth {
  /** YYYY-MM of the owning Monday. */
  key: string;
  /** Newest first. */
  weeks: AppointmentWeek[];
  /** Weeks whose count may still change (see {@link NOT_FINAL_BADGES}). */
  notFinal: number;
}

/**
 * Weeks → months, newest first. A week belongs to the month of its **owning
 * Monday** (`payrollWeekMonthOrdinal`, `bonus-cadence.ts:44-65`) — the rule every
 * monthly payout already uses — so 2026-05-31 → 06-06 is a JUNE week (Monday
 * Jun 1), while 2026-08-30 → 09-05 stays in August (Monday Aug 31). Never a local
 * date rule: two rules would put one week in two months.
 */
export function groupMonths(weeks: readonly AppointmentWeek[]): AppointmentMonth[] {
  const byKey = new Map<string, AppointmentWeek[]>();
  for (const w of weeks) {
    const ord = payrollWeekMonthOrdinal(w.periodStart);
    if (ord === null) continue;
    const key = `${Math.floor(ord / 12)}-${String((ord % 12) + 1).padStart(2, '0')}`;
    const list = byKey.get(key) ?? [];
    list.push(w);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([key, list]) => ({
      key,
      weeks: [...list].sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1)),
      notFinal: list.filter((w) => NOT_FINAL_BADGES.has(w.badge)).length,
    }));
}

/** What the join needs from a roster row (a subset of `EmployeeRow`). */
export interface ApptRosterMember {
  name: string | null;
  personal_email: string | null;
  work_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
  start_date: string | null;
}

export interface RankedAppointmentRow<M extends ApptRosterMember> {
  /** Competition rank by appointments: ties share a position (1, 2, 2, 4). */
  position: number;
  /** The first roster row of this person — what the People view shows. */
  member: M;
  name: string;
  appointments: number;
  /** Weeks in the period this person has an entry for (a saved 0 counts). */
  weeksScored: number;
  /** ISO date, or null when the roster has no readable Start Date. */
  startDate: string | null;
  tenureMonths: number | null;
  tenure: string;
}

export interface RankedAppointments<M extends ApptRosterMember> {
  rows: RankedAppointmentRow<M>[];
  /** Distinct scored emails in the period that match nobody on this roster. */
  notOnRoster: number;
  /** People on this roster with no entry at all in the period. */
  unscoredOnRoster: number;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole months from `startIso` to `todayIso` (both YYYY-MM-DD); null if unordered. */
export function tenureMonths(startIso: string, todayIso: string): number | null {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  if (!sy || !sm || !sd || !ty || !tm || !td) return null;
  if (startIso > todayIso) return 0;
  let months = (ty - sy) * 12 + (tm - sm);
  if (td < sd) months -= 1;
  return Math.max(0, months);
}

/** "2y 3m" · "2y" · "5mo" · "12d" · "New" · "—". */
export function tenureLabel(startIso: string | null, todayIso: string): string {
  if (!startIso) return '—';
  const months = tenureMonths(startIso, todayIso);
  if (months === null) return '—';
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years > 0 && rem > 0) return `${years}y ${rem}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const [ty, tm, td] = todayIso.split('-').map(Number);
  const days = Math.round((Date.UTC(ty!, tm! - 1, td!) - Date.UTC(sy!, sm! - 1, sd!)) / 86_400_000);
  return days <= 0 ? 'New' : `${days}d`;
}

const EMAIL_TIERS = ['personal_email', 'work_email', 'alternate_work_email', 'alternate_work_email_2'] as const;

/** One human on the roster — possibly several duplicate master rows. */
export interface RosterPerson<M extends ApptRosterMember> {
  /** The first roster row of this person — what the People view shows. */
  member: M;
  name: string;
  /** Latest readable Start Date across the person's rows (current stint), ISO. */
  startDate: string | null;
}

/**
 * The roster, as people, and every email that points at each one. Shared by the
 * Appointments view and the Rankings leaderboard so the two can never match a
 * scored row to different people.
 *
 * - Rows sharing a PERSONAL or WORK email are one person (duplicate master rows).
 *   Aliases never merge: a stale alias on someone else's row would fuse two people.
 * - Emails are claimed tier by tier (personal → work → alt1 → alt2), so a personal
 *   email always beats an alias another row happens to carry.
 * - `startDate` is the LATEST readable start — the current stint (Kane, 229 Q5).
 */
export function indexRosterPeople<M extends ApptRosterMember>(
  members: readonly M[],
): { people: RosterPerson<M>[]; personByEmail: Map<string, RosterPerson<M>> } {
  const people: RosterPerson<M>[] = [];
  const personOfMember = new Map<M, RosterPerson<M>>();
  const sharedEmail = new Map<string, RosterPerson<M>>();
  for (const m of members) {
    const emails = [normEmail(m.personal_email), normEmail(m.work_email ?? null)].filter(
      (e): e is string => !!e,
    );
    const existing = emails.map((e) => sharedEmail.get(e)).find((p): p is RosterPerson<M> => !!p);
    const parsed = parseMasterStartDate(m.start_date);
    const start = parsed ? isoOf(parsed) : null;
    const person: RosterPerson<M> = existing ?? {
      member: m,
      name: m.name?.trim() || normEmail(m.work_email ?? m.personal_email) || '—',
      startDate: null,
    };
    if (!existing) people.push(person);
    if (start && (!person.startDate || start > person.startDate)) person.startDate = start;
    personOfMember.set(m, person);
    for (const e of emails) if (!sharedEmail.has(e)) sharedEmail.set(e, person);
  }
  const personByEmail = new Map<string, RosterPerson<M>>();
  for (const tier of EMAIL_TIERS) {
    for (const m of members) {
      const e = normEmail(m[tier] ?? null);
      if (e && !personByEmail.has(e)) personByEmail.set(e, personOfMember.get(m)!);
    }
  }
  return { people, personByEmail };
}

/**
 * Rank the period's appointments over the roster the People view shows.
 *
 * - **The roster decides who is ranked** (Kane, Q4): a scored email matching no
 *   one on it is counted in `notOnRoster`, never listed — tenure means nothing
 *   for someone who has left, and the People tab beside this would disagree.
 * - **Matching bridges all four emails.** Applied rows key personal-email-first;
 *   the roster carries work + two aliases as well. A personal-email claim beats
 *   another row's alias claim, so a shared alias cannot steal a person's count.
 * - **One person, one row.** Roster rows that share a personal or work email are
 *   one person (duplicate master rows); aliases never merge. Their tenure is the
 *   LATEST start among those rows —
 *   the current stint (Kane, Q5; a rehire resets Start Date).
 * - **A person scored under two emails is summed** — both rows were credited.
 * - **No entry ≠ zero.** A roster person with no row in the period is counted in
 *   `unscoredOnRoster`, not ranked at 0 beside people who were scored 0.
 */
export function rankAppointments<M extends ApptRosterMember>(
  weeks: readonly AppointmentWeek[],
  members: readonly M[],
  todayIso: string,
): RankedAppointments<M> {
  type Person = RosterPerson<M>;
  const { people, personByEmail } = indexRosterPeople(members);

  const totals = new Map<Person, { appointments: number; weeks: Set<string> }>();
  const strangers = new Set<string>();
  for (const w of weeks) {
    for (const r of w.rows) {
      const p = personByEmail.get(r.email);
      if (!p) {
        strangers.add(r.email);
        continue;
      }
      const t = totals.get(p) ?? { appointments: 0, weeks: new Set<string>() };
      t.appointments += r.appointments;
      t.weeks.add(w.periodStart);
      totals.set(p, t);
    }
  }

  const unranked = [...totals.entries()].map(([p, t]) => ({
    member: p.member,
    name: p.name,
    appointments: t.appointments,
    weeksScored: t.weeks.size,
    startDate: p.startDate,
    tenureMonths: p.startDate ? tenureMonths(p.startDate, todayIso) : null,
    tenure: tenureLabel(p.startDate, todayIso),
  }));
  unranked.sort(
    (a, b) =>
      b.appointments - a.appointments ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  // Sorted descending, so a tie inherits the position of the first row it ties.
  const rows: RankedAppointmentRow<M>[] = [];
  unranked.forEach((r, i) => {
    const prev = rows[i - 1];
    const position = prev && prev.appointments === r.appointments ? prev.position : i + 1;
    rows.push({ ...r, position });
  });

  return {
    rows,
    notOnRoster: strangers.size,
    unscoredOnRoster: people.filter((p) => !totals.has(p)).length,
  };
}
