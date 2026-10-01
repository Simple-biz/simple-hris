/**
 * Accounting Scoreboard math: the formulas of Carla's "Accounting Scoreboard" sheet, computed once
 * from stored entries instead of retyped in every cell.
 * Governing doc: docs/features/accounting-scoreboard.md § Scoring.
 *
 * Kept EXACTLY as the sheet:
 *   - Accounting Buckets: Comp = Σ(AM − PM), tiers <0 → 1, 0 → 2, 1–5 → 4, 6–10 → 6, 11–15 → 8, >15 → 10
 *     (sheet R9:R27). The headline is the AVERAGE of the row scores (R28).
 *   - Email Inbox: EOD average = mean of the PM counts, score = IF(avg=0, 10, IF(avg>=9, 1, 10 − avg))
 *     (R32:R58). The headline is the score of the team's average (R59).
 *   - Collections: points per rep per day are summed from the log. The week runs Mon–Fri, and
 *     the record is the best team week.
 *
 * ONE deliberate difference: the sheet's SUM treats a blank cell as 0, so a day with an AM count and
 * no PM count was credited as fully cleared (Thursday's bucket showed +68 with nothing typed for
 * Thursday PM). Here a day counts only when BOTH numbers are in. An AM without a PM is "PM missing"
 * once the day is over and "PM pending" today, and it is never credited. The other scoring quirks
 * (a day bucket's fill-up counts against it; an empty bucket scores 2) are the sheet's rules and are
 * Carla's to change, so they are kept.
 *
 * Pure: no I/O. The page recomputes from these after every edit; the routes never trust a total
 * the browser sends.
 */

import type { GoalRule, ScoreRule, Slot } from './sections';
import { weekStartOf } from './week';

export function entryKey(rowId: string, date: string, slot: Slot): string {
  return `${rowId}|${date}|${slot}`;
}

export interface StoredEntry {
  rowId: string;
  date: string;
  slot: Slot;
  value: number;
}

export type EntryLookup = ReadonlyMap<string, number>;

export function buildLookup(entries: readonly StoredEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) out.set(entryKey(e.rowId, e.date, e.slot), e.value);
  return out;
}

/** 2dp, so sums of numeric(12,2) values never print 0.30000000000000004. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sum(values: readonly number[]): number {
  return round2(values.reduce((s, v) => s + v, 0));
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/** Accounting Buckets' tiers, exactly the sheet's formula. */
export function bucketScore(comp: number): number {
  if (comp < 0) return 1;
  if (comp === 0) return 2;
  if (comp <= 5) return 4;
  if (comp <= 10) return 6;
  if (comp <= 15) return 8;
  return 10;
}

/** Email Inbox: =IF(avg=0, 10, IF(avg>=9, 1, 10 − avg)). */
export function inboxScore(averagePm: number): number {
  if (averagePm === 0) return 10;
  if (averagePm >= 9) return 1;
  return 10 - averagePm;
}

// ---------------------------------------------------------------------------
// AM / PM sections (buckets, chargebacks, inbox)
// ---------------------------------------------------------------------------

/**
 * - `complete`    both numbers in: the day counts
 * - `pm_pending`  AM in, PM not yet, and it is today: not counted yet
 * - `pm_missing`  AM in, PM never typed, and the day is over: NOT counted (the sheet counted it as cleared)
 * - `am_missing`  PM in, AM never typed: not counted in Comp (the inbox average still uses the PM)
 * - `empty`       nothing typed
 * - `future`      after today
 */
export type AmPmDayState = 'complete' | 'pm_pending' | 'pm_missing' | 'am_missing' | 'empty' | 'future';

export interface AmPmDay {
  date: string;
  am: number | null;
  pm: number | null;
  state: AmPmDayState;
}

export interface AmPmRowStats {
  days: AmPmDay[];
  /** Σ(AM − PM) over complete days; null when no day is complete. */
  comp: number | null;
  /** Mean of the PM counts typed on or before today; null when none. */
  pmAverage: number | null;
  /** The row's 1–10 score under the section's rule; null when there is nothing to score. */
  score: number | null;
}

export function amPmRowStats(
  rowId: string,
  dates: readonly string[],
  lookup: EntryLookup,
  rule: ScoreRule | undefined,
  today: string,
): AmPmRowStats {
  const days: AmPmDay[] = [];
  const diffs: number[] = [];
  const pms: number[] = [];
  for (const date of dates) {
    const am = lookup.get(entryKey(rowId, date, 'am')) ?? null;
    const pm = lookup.get(entryKey(rowId, date, 'pm')) ?? null;
    let state: AmPmDayState;
    if (date > today) state = 'future';
    else if (am !== null && pm !== null) state = 'complete';
    else if (am !== null) state = date < today ? 'pm_missing' : 'pm_pending';
    else if (pm !== null) state = 'am_missing';
    else state = 'empty';
    if (state === 'complete') diffs.push((am as number) - (pm as number));
    if (state !== 'future' && pm !== null) pms.push(pm);
    days.push({ date, am, pm, state });
  }
  const comp = diffs.length ? sum(diffs) : null;
  const pmAverage = mean(pms);
  let score: number | null = null;
  if (rule === 'bucket' && comp !== null) score = bucketScore(comp);
  if (rule === 'inbox' && pmAverage !== null) score = inboxScore(pmAverage);
  return { days, comp, pmAverage, score };
}

export interface DayTotal {
  date: string;
  /** Sum over the rows that have a number in; null when nobody typed one. */
  am: number | null;
  pm: number | null;
}

export interface AmPmSectionStats {
  rows: Map<string, AmPmRowStats>;
  dayTotals: DayTotal[];
  /** Σ of the rows' Comp; null when no row has one. */
  compTotal: number | null;
  /** Mean of the row scores (buckets), null when none. */
  averageScore: number | null;
  /** Mean of the rows' PM averages (inbox), null when none. */
  teamPmAverage: number | null;
  /** The headline the goal is judged on: buckets = averageScore; inbox = inboxScore(teamPmAverage);
   *  no rule (chargebacks) = compTotal. */
  headline: number | null;
}

export function amPmSectionStats(
  rowIds: readonly string[],
  dates: readonly string[],
  lookup: EntryLookup,
  rule: ScoreRule | undefined,
  today: string,
): AmPmSectionStats {
  const rows = new Map<string, AmPmRowStats>();
  for (const id of rowIds) rows.set(id, amPmRowStats(id, dates, lookup, rule, today));

  const dayTotals: DayTotal[] = dates.map((date) => {
    const ams: number[] = [];
    const pms: number[] = [];
    for (const id of rowIds) {
      const am = lookup.get(entryKey(id, date, 'am'));
      const pm = lookup.get(entryKey(id, date, 'pm'));
      if (am !== undefined) ams.push(am);
      if (pm !== undefined) pms.push(pm);
    }
    return { date, am: ams.length ? sum(ams) : null, pm: pms.length ? sum(pms) : null };
  });

  const all = [...rows.values()];
  const comps = all.map((r) => r.comp).filter((c): c is number => c !== null);
  const scores = all.map((r) => r.score).filter((s): s is number => s !== null);
  const pmAvgs = all.map((r) => r.pmAverage).filter((a): a is number => a !== null);
  const compTotal = comps.length ? sum(comps) : null;
  const averageScore = mean(scores);
  const teamPmAverage = mean(pmAvgs);
  const headline =
    rule === 'bucket'
      ? averageScore
      : rule === 'inbox'
        ? teamPmAverage === null
          ? null
          : inboxScore(teamPmAverage)
        : compTotal;
  return { rows, dayTotals, compTotal, averageScore, teamPmAverage, headline };
}

// ---------------------------------------------------------------------------
// One-number-a-day sections (onboarding, compliance, cancellations, payroll problems, PM buckets)
// ---------------------------------------------------------------------------

export interface DailyRowStats {
  values: (number | null)[];
  /** Σ of the days typed; null when none. */
  week: number | null;
  /** Mean of the days typed; null when none. PM Buckets' "WTD AVG". */
  average: number | null;
  /** Days ticked "had a meeting" (PM Buckets). */
  meetings: number;
  /** Per day: true = met, false = ticked off, null = not set. */
  met: (boolean | null)[];
}

export function dailyRowStats(rowId: string, dates: readonly string[], lookup: EntryLookup): DailyRowStats {
  const values = dates.map((d) => lookup.get(entryKey(rowId, d, 'day')) ?? null);
  const met = dates.map((d) => {
    const v = lookup.get(entryKey(rowId, d, 'mtg'));
    return v === undefined ? null : v === 1;
  });
  const typed = values.filter((v): v is number => v !== null);
  return {
    values,
    week: typed.length ? sum(typed) : null,
    average: mean(typed),
    meetings: met.filter((m) => m === true).length,
    met,
  };
}

export interface DailySectionStats {
  rows: Map<string, DailyRowStats>;
  /** Σ per day over the rows typed; null when nobody typed. */
  dayTotals: (number | null)[];
  /** Rows ticked "met" per day (PM Buckets). */
  meetingsByDay: number[];
  /** Σ of the rows' weeks; null when nothing typed. */
  weekTotal: number | null;
  /** Σ of the rows' averages (PM Buckets' WTD AVG total, the sheet's AF44). */
  averageTotal: number | null;
}

export function dailySectionStats(
  rowIds: readonly string[],
  dates: readonly string[],
  lookup: EntryLookup,
): DailySectionStats {
  const rows = new Map<string, DailyRowStats>();
  for (const id of rowIds) rows.set(id, dailyRowStats(id, dates, lookup));
  const all = [...rows.values()];
  const dayTotals = dates.map((_, i) => {
    const typed = all.map((r) => r.values[i]).filter((v): v is number => v !== null);
    return typed.length ? sum(typed) : null;
  });
  const meetingsByDay = dates.map((_, i) => all.filter((r) => r.met[i] === true).length);
  const weeks = all.map((r) => r.week).filter((w): w is number => w !== null);
  const avgs = all.map((r) => r.average).filter((a): a is number => a !== null);
  return {
    rows,
    dayTotals,
    meetingsByDay,
    weekTotal: weeks.length ? sum(weeks) : null,
    averageTotal: avgs.length ? round2(avgs.reduce((s, v) => s + v, 0)) : null,
  };
}

// ---------------------------------------------------------------------------
// Payroll Timing: start and end times
// ---------------------------------------------------------------------------

export interface TimeSpanDay {
  date: string;
  /** Minutes after midnight. */
  start: number | null;
  end: number | null;
  /** (end − start) in hours when both are in and end is after start. */
  hours: number | null;
  /** Both are in but end is not after start: shown, never counted. */
  invalid: boolean;
}

export interface TimeSpanRowStats {
  days: TimeSpanDay[];
  hours: number | null;
}

export function timeSpanRowStats(rowId: string, dates: readonly string[], lookup: EntryLookup): TimeSpanRowStats {
  const days = dates.map((date): TimeSpanDay => {
    const start = lookup.get(entryKey(rowId, date, 'start')) ?? null;
    const end = lookup.get(entryKey(rowId, date, 'end')) ?? null;
    const both = start !== null && end !== null;
    const valid = both && (end as number) > (start as number);
    return {
      date,
      start,
      end,
      hours: valid ? round2(((end as number) - (start as number)) / 60) : null,
      invalid: both && !valid,
    };
  });
  const hrs = days.map((d) => d.hours).filter((h): h is number => h !== null);
  return { days, hours: hrs.length ? sum(hrs) : null };
}

export function timeSpanSectionHours(
  rowIds: readonly string[],
  dates: readonly string[],
  lookup: EntryLookup,
): { rows: Map<string, TimeSpanRowStats>; total: number | null } {
  const rows = new Map<string, TimeSpanRowStats>();
  for (const id of rowIds) rows.set(id, timeSpanRowStats(id, dates, lookup));
  const hrs = [...rows.values()].map((r) => r.hours).filter((h): h is number => h !== null);
  return { rows, total: hrs.length ? sum(hrs) : null };
}

/** "9:05 AM" ↔ 545 minutes. */
export function minutesToClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** "HH:MM" (an <input type="time"> value) → minutes after midnight, or null. */
export function timeInputToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToTimeInput(minutes: number | null): string {
  if (minutes === null) return '';
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface CollectionEntry {
  id: string;
  date: string;
  rowId: string;
  businessName: string;
  points: number;
  amountUsd: number | null;
  createdBy: string;
  createdAt: string;
}

export interface PointsAndAccounts {
  points: number;
  accounts: number;
}

export interface CollectionsWeekStats {
  /** Per rep row: per day (in `dates` order) and the week. */
  rows: Map<string, { byDay: PointsAndAccounts[]; week: PointsAndAccounts }>;
  /** The team per day, in `dates` order. These are the Dancing Queen Bonus's day values. */
  byDay: PointsAndAccounts[];
  week: PointsAndAccounts;
  /** Top three reps by week points (only reps with points), ties in row order. */
  podium: { rowId: string; points: number }[];
}

export function collectionsWeekStats(
  rowIds: readonly string[],
  logs: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[],
  dates: readonly string[],
): CollectionsWeekStats {
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const zero = (): PointsAndAccounts => ({ points: 0, accounts: 0 });
  const rows = new Map<string, { byDay: PointsAndAccounts[]; week: PointsAndAccounts }>();
  for (const id of rowIds) rows.set(id, { byDay: dates.map(zero), week: zero() });
  const byDay = dates.map(zero);
  for (const log of logs) {
    const i = dayIndex.get(log.date);
    const row = rows.get(log.rowId);
    if (i === undefined || !row) continue;
    row.byDay[i].points = round2(row.byDay[i].points + log.points);
    row.byDay[i].accounts += 1;
    row.week.points = round2(row.week.points + log.points);
    row.week.accounts += 1;
    byDay[i].points = round2(byDay[i].points + log.points);
    byDay[i].accounts += 1;
  }
  const week = {
    points: round2(byDay.reduce((s, d) => s + d.points, 0)),
    accounts: byDay.reduce((s, d) => s + d.accounts, 0),
  };
  const order = new Map(rowIds.map((id, i) => [id, i]));
  const podium = [...rows.entries()]
    .filter(([, r]) => r.week.points > 0)
    .sort((a, b) => b[1].week.points - a[1].week.points || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .slice(0, 3)
    .map(([rowId, r]) => ({ rowId, points: r.week.points }));
  return { rows, byDay, week, podium };
}

export interface CollectionsHistory {
  /** Points per rep row since the board went live. */
  allTimeByRow: Map<string, number>;
  /** The best team week (Sunday key) and its points; null before the first collection. */
  record: { weekStart: string; points: number } | null;
}

/** All-time points and the record week, over every live log row. */
export function collectionsHistory(logs: readonly Pick<CollectionEntry, 'date' | 'rowId' | 'points'>[]): CollectionsHistory {
  const allTimeByRow = new Map<string, number>();
  const byWeek = new Map<string, number>();
  for (const log of logs) {
    allTimeByRow.set(log.rowId, round2((allTimeByRow.get(log.rowId) ?? 0) + log.points));
    const wk = weekStartOf(log.date);
    byWeek.set(wk, round2((byWeek.get(wk) ?? 0) + log.points));
  }
  let record: CollectionsHistory['record'] = null;
  for (const [weekStart, points] of [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!record || points > record.points) record = { weekStart, points };
  }
  return { allTimeByRow, record };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** true = met, false = missed, null = nothing to judge yet. */
export function goalMet(goal: GoalRule | undefined, value: number | null): boolean | null {
  if (!goal || value === null) return null;
  return goal.direction === 'at_least' ? value >= goal.value : value < goal.value;
}

export function goalText(goal: GoalRule): string {
  return `${goal.direction === 'at_least' ? '≥' : '<'} ${goal.value} ${goal.unit}`;
}
