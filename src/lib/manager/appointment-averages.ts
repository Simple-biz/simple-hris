/**
 * Rankings leaderboard — Manager → My Team → <department> → Rankings, for a
 * department that scores appointments (Lead Gen, Callback). Ranks the current
 * roster by AVERAGE appointments set — per day worked, per week, per month — over
 * a chosen window. Doc: `docs/features/manager-appointment-leaderboard.md`.
 *
 * PURE — no I/O. The weeks come from the Appointments view's read
 * (`appointment-rankings.ts`), the days from `supabase/appointment-days.ts`; this
 * module decides every rule.
 *
 * **No money values** (Kane, 2026-09-26: *"No money values should be displayed
 * here"*). Counts and averages of counts only. The Hubstaff rows this reads carry
 * pay columns (`Spent total`, `Currency`); the read's projection excludes them and
 * a test pins it.
 */
import { normEmail } from '@/lib/email/norm-email';
import { parseHubstaffDurationSeconds } from '@/lib/hubstaff/duration';
import { payWeekStartFromSourceFile } from '@/lib/payroll/adjustment-bridge';
import {
  indexRosterPeople,
  tenureLabel,
  tenureMonths,
  type ApptRosterMember,
  type AppointmentWeek,
  type RosterPerson,
  type AppointmentWeekBadge,
} from '@/lib/manager/appointment-rankings';

/** The seven Hubstaff day columns (Sunday-first, as the weekly files are). */
export const HUBSTAFF_DAY_COLUMNS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type AverageBasis = 'daily' | 'weekly' | 'monthly';
export type AverageWindow = 'last4w' | 'last3m' | 'all';

/** Counted weeks each window takes, newest first. "3 months" = 13 weeks. */
export const WINDOW_WEEKS: Record<AverageWindow, number | null> = {
  last4w: 4,
  last3m: 13,
  all: null,
};

/** Kane, Q4: fewer scored weeks than this in the window → "Not enough history yet". */
export const MIN_SCORED_WEEKS = 2;

/** Kane, Q6 (a): monthly = weekly × 52/12, so a partial month cannot shrink it. */
export const WEEKS_PER_MONTH = 52 / 12;

/** Decimals each average is SHOWN with — and therefore what counts as a tie. */
export const BASIS_DECIMALS: Record<AverageBasis, number> = { daily: 2, weekly: 1, monthly: 1 };

/**
 * Weeks whose counts are settled enough to average (Kane, Q5). `no_record` weeks
 * predate the wizard lock and were paid, so they are history, not drafts. A draft
 * is half-scored by definition and would drag every average down; `unknown`
 * cannot be told apart from one.
 */
export const COUNTED_BADGES: ReadonlySet<AppointmentWeekBadge> = new Set([
  'finalized',
  'with_accounting',
  'no_record',
]);

// ── Hubstaff days ─────────────────────────────────────────────────────────────

/**
 * The Sunday week a Hubstaff file covers, or null when it is not a WEEKLY file.
 *
 * The range is PARSED from the name (`..._2026-08-30_to_2026-09-05 4.csv` is a
 * fine weekly file), never matched against the junk-filename regex that hides
 * paid weeks. A file counts when its range spans 7 or 8 days (the ingest
 * contract allows both). That drops the 27-day `time-activity-report`, which is
 * 14,094 rows with no emails at all (measured 2026-09-26).
 */
export function weeklyHubstaffWeek(sourceFile: string | null | undefined): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(sourceFile ?? '');
  if (!m) return null;
  const start = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
  const end = Date.UTC(+m[4]!, +m[5]! - 1, +m[6]!);
  const spanDays = Math.round((end - start) / 86_400_000);
  if (spanDays < 6 || spanDays > 7) return null;
  return payWeekStartFromSourceFile(sourceFile);
}

/** Days in one Hubstaff row with ANY tracked time (Kane, Q2 → a). */
export function daysWorkedInRow(row: Record<string, unknown>): number {
  let n = 0;
  for (const col of HUBSTAFF_DAY_COLUMNS) if (parseHubstaffDurationSeconds(row[col]) > 0) n += 1;
  return n;
}

export interface DaysWorkedRow {
  /** Lower-cased. */
  email: string;
  /** Sunday, YYYY-MM-DD. */
  weekStart: string;
  days: number;
}

/**
 * Hubstaff rows → days worked per (email, week), restricted to `allowedEmails`.
 *
 * **Deduped, never summed** (INDEX "Hubstaff ingest": readers dedupe): an
 * api_sync + daily_report pair for one week, a re-ingest, or a Monday-anchored
 * backfill that lands on the same Sunday all describe the SAME days, so the week
 * takes the MAX. Emails match case-insensitively — 26 rows are `Alyson@`.
 */
export function buildDaysWorked(
  files: readonly { sourceFile: string; rows: readonly Record<string, unknown>[] }[],
  allowedEmails: ReadonlySet<string>,
): DaysWorkedRow[] {
  const best = new Map<string, DaysWorkedRow>();
  for (const f of files) {
    const weekStart = weeklyHubstaffWeek(f.sourceFile);
    if (!weekStart) continue;
    for (const row of f.rows) {
      const email = normEmail(typeof row.Email === 'string' ? row.Email : null);
      if (!email || !allowedEmails.has(email)) continue;
      const days = daysWorkedInRow(row);
      const key = `${email}|${weekStart}`;
      const prev = best.get(key);
      if (!prev || days > prev.days) best.set(key, { email, weekStart, days });
    }
  }
  return [...best.values()].sort(
    (a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : a.email.localeCompare(b.email)),
  );
}

// ── The leaderboard ───────────────────────────────────────────────────────────

export interface LeaderboardRow<M extends ApptRosterMember> {
  /** Competition rank on the chosen basis, tied on its SHOWN precision. */
  position: number;
  member: M;
  name: string;
  /** Appointments per day worked; null when no scored week had Hubstaff days. */
  avgDaily: number | null;
  avgWeekly: number;
  avgMonthly: number;
  totalAppointments: number;
  /** Days worked across the weeks that fed `avgDaily`. */
  daysWorked: number;
  weeksScored: number;
  /** Scored weeks with appointments but no Hubstaff days — left out of `avgDaily` only. */
  weeksWithoutDays: number;
  startDate: string | null;
  tenureMonths: number | null;
  tenure: string;
}

export interface NotRankedRow<M extends ApptRosterMember> {
  member: M;
  name: string;
  weeksScored: number;
  /** `history`: fewer than MIN_SCORED_WEEKS · `no_days`: daily basis, no Hubstaff days. */
  reason: 'history' | 'no_days';
}

export interface Leaderboard<M extends ApptRosterMember> {
  rows: LeaderboardRow<M>[];
  notRanked: NotRankedRow<M>[];
  /** The counted weeks the averages cover, newest first. */
  windowWeeks: AppointmentWeek[];
  /** Weeks newer than the window's oldest week that were NOT counted (draft / couldn't check). */
  leftOut: AppointmentWeek[];
  /** Distinct scored emails in the window that match nobody on this roster. */
  notOnRoster: number;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Rank the roster by average appointments over the window.
 *
 * - Window = the newest N COUNTED weeks (4 · 13 · all), so "Last 4 weeks" always
 *   has four weeks of settled data even while the latest week is still a draft.
 * - Weekly = appointments ÷ weeks the person has an entry for (a saved 0 counts).
 *   Monthly = weekly × 52/12. Daily = appointments ÷ Hubstaff days worked, over
 *   the weeks that HAVE days — a week with appointments and no Hubstaff row is
 *   left out of the daily figure (never ÷ 0) and counted in `weeksWithoutDays`.
 * - Ranked only with ≥ MIN_SCORED_WEEKS in the window; on the daily basis, also
 *   only with a daily figure. Everyone else is in `notRanked` with a reason.
 * - People, emails and tenure come from {@link indexRosterPeople} — the same
 *   matching the Appointments view uses.
 */
export function computeLeaderboard<M extends ApptRosterMember>(input: {
  weeks: readonly AppointmentWeek[];
  days: readonly DaysWorkedRow[] | null;
  members: readonly M[];
  window: AverageWindow;
  basis: AverageBasis;
  todayIso: string;
}): Leaderboard<M> {
  const newestFirst = [...input.weeks].sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1));
  const counted = newestFirst.filter((w) => COUNTED_BADGES.has(w.badge) && w.rows.length > 0);
  const limit = WINDOW_WEEKS[input.window];
  const windowWeeks = limit === null ? counted : counted.slice(0, limit);
  const oldest = windowWeeks[windowWeeks.length - 1]?.periodStart ?? null;
  const leftOut = newestFirst.filter(
    (w) => w.rows.length > 0 && !COUNTED_BADGES.has(w.badge) && oldest !== null && w.periodStart >= oldest,
  );

  const daysByKey = new Map<string, number>();
  for (const d of input.days ?? []) daysByKey.set(`${d.email}|${d.weekStart}`, d.days);

  const { personByEmail } = indexRosterPeople(input.members);
  // Every email a person owns, so their Hubstaff (work-email) days are found
  // whichever address their applied row was keyed on.
  const emailsOf = new Map<RosterPerson<M>, string[]>();
  for (const [email, p] of personByEmail) emailsOf.set(p, [...(emailsOf.get(p) ?? []), email]);

  type Acc = { appts: number; weeks: Set<string>; dailyAppts: number; dailyDays: number; noDays: number };
  const acc = new Map<RosterPerson<M>, Acc>();
  const strangers = new Set<string>();
  for (const w of windowWeeks) {
    // One person may be scored under two emails in a week — sum the week first,
    // then look up the week's days once.
    const weekly = new Map<RosterPerson<M>, number>();
    for (const r of w.rows) {
      const p = personByEmail.get(r.email);
      if (!p) {
        strangers.add(r.email);
        continue;
      }
      weekly.set(p, (weekly.get(p) ?? 0) + r.appointments);
    }
    for (const [p, appts] of weekly) {
      const a = acc.get(p) ?? { appts: 0, weeks: new Set<string>(), dailyAppts: 0, dailyDays: 0, noDays: 0 };
      a.appts += appts;
      a.weeks.add(w.periodStart);
      let days = 0;
      for (const e of emailsOf.get(p) ?? []) days = Math.max(days, daysByKey.get(`${e}|${w.periodStart}`) ?? 0);
      if (days > 0) {
        a.dailyAppts += appts;
        a.dailyDays += days;
      } else if (appts > 0) {
        a.noDays += 1;
      }
      acc.set(p, a);
    }
  }

  const ranked: Omit<LeaderboardRow<M>, 'position'>[] = [];
  const notRanked: NotRankedRow<M>[] = [];
  for (const [p, a] of acc) {
    const weeksScored = a.weeks.size;
    const avgWeekly = weeksScored > 0 ? a.appts / weeksScored : 0;
    const avgDaily = input.days !== null && a.dailyDays > 0 ? a.dailyAppts / a.dailyDays : null;
    if (weeksScored < MIN_SCORED_WEEKS) {
      notRanked.push({ member: p.member, name: p.name, weeksScored, reason: 'history' });
      continue;
    }
    if (input.basis === 'daily' && avgDaily === null) {
      notRanked.push({ member: p.member, name: p.name, weeksScored, reason: 'no_days' });
      continue;
    }
    ranked.push({
      member: p.member,
      name: p.name,
      avgDaily,
      avgWeekly,
      avgMonthly: avgWeekly * WEEKS_PER_MONTH,
      totalAppointments: a.appts,
      daysWorked: a.dailyDays,
      weeksScored,
      weeksWithoutDays: a.noDays,
      startDate: p.startDate,
      tenureMonths: p.startDate ? tenureMonths(p.startDate, input.todayIso) : null,
      tenure: tenureLabel(p.startDate, input.todayIso),
    });
  }

  const decimals = BASIS_DECIMALS[input.basis];
  // Ranked on the value as SHOWN, so two people displayed as "2.4" share a place.
  const valueOf = (r: Pick<LeaderboardRow<M>, 'avgDaily' | 'avgWeekly' | 'avgMonthly'>) =>
    round(
      input.basis === 'daily' ? (r.avgDaily ?? 0) : input.basis === 'weekly' ? r.avgWeekly : r.avgMonthly,
      decimals,
    );
  ranked.sort(
    (a, b) =>
      valueOf(b) - valueOf(a) ||
      b.totalAppointments - a.totalAppointments ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
  const rows: LeaderboardRow<M>[] = [];
  ranked.forEach((r, i) => {
    const prev = rows[i - 1];
    const tie = prev !== undefined && valueOf(prev) === valueOf(r);
    rows.push({ ...r, position: tie ? prev.position : i + 1 });
  });
  notRanked.sort(
    (a, b) => b.weeksScored - a.weeksScored || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );

  return { rows, notRanked, windowWeeks, leftOut, notOnRoster: strangers.size };
}

