/**
 * Accounting Scoreboard math: the formulas of Carla's "Accounting Scoreboard" sheet, computed once
 * from stored entries instead of retyped in every cell.
 * Governing doc: docs/features/accounting-scoreboard.md § Scoring.
 *
 * Accounting Buckets: CARLA'S RULE of 2026-10-02 ("SCOREBOARD UPDATES" § 1), her reference code
 * kept as written (`clearedFromReadings`). It replaced the sheet's tiers on Σ(AM − PM):
 *   - readings = Mon AM, Mon PM, Tue AM, … Fri PM, in order, BLANKS SKIPPED (never read as 0)
 *   - Completed = Σ every decrease between back-to-back readings, overnight included; an increase is
 *     new work and never counts against it
 *   - Open = the latest reading
 *   - Score = 10 × Completed ÷ (Completed + Open), one decimal. 80% cleared = 8.0, the goal.
 *   - A bucket that was 0 all week is N/A; a weekday Collections bucket is Pending until its own
 *     day's PM is in. Neither is in the overall.
 *   - Overall = 10 × Σ Completed ÷ Σ(Completed + Open) over the scored buckets (was an average).
 * Email Inbox (the sheet's): EOD average = mean of the PM counts, score = IF(avg=0, 10, IF(avg>=9, 1,
 * 10 − avg)) (R32:R58). The headline is the score of the team's average (R59).
 * Collections: points per rep per day are summed from the log. The week runs Mon–Fri, and the record
 * is the best team week.
 *
 * Absence is never 0. The sheet's SUM read a blank PM as 0 and credited the whole AM as cleared
 * (Thursday's bucket showed +68 with nothing typed for Thursday PM). Carla's readings skip blanks, so
 * that cannot happen: a drop is only ever measured between two numbers somebody typed. An AM without
 * a PM is still flagged on screen ("PM pending" today, "PM missing" once the day is over).
 *
 * Pure: no I/O. The page recomputes from these after every edit; the routes never trust a total
 * the browser sends.
 */

import { isOutcome, type GoalRule, type Outcome, type ScoreRule, type Slot, type Weekday } from './sections';
import { weekdayOf, weekStartOf } from './week';

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

/**
 * Carla's score, her reference expression exactly: `+(10 * completed / (completed + open)).toFixed(1)`.
 * null when completed + open is 0 (the bucket was 0 all week: N/A).
 */
export function clearedScore(completed: number, open: number): number | null {
  return completed + open === 0 ? null : +((10 * completed) / (completed + open)).toFixed(1);
}

/**
 * Carla's Completed / Open / Score over one bucket's readings, in order, blanks already skipped.
 * null when there is no reading at all ("—", nothing typed).
 */
export function clearedFromReadings(
  readings: readonly number[],
): { completed: number; open: number; score: number | null } | null {
  if (!readings.length) return null;
  let completed = 0;
  for (let i = 1; i < readings.length; i++) completed += Math.max(0, readings[i - 1] - readings[i]);
  completed = round2(completed);
  const open = readings[readings.length - 1];
  return { completed, open, score: clearedScore(completed, open) };
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
 * What a cell pair shows. It flags data on screen; it never decides a score (the readings do).
 * - `complete`    both numbers in
 * - `pm_pending`  AM in, PM not yet, and it is today
 * - `pm_missing`  AM in, PM never typed, and the day is over (the sheet credited the whole AM here)
 * - `am_missing`  PM in, AM never typed
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

/** The row facts the section math needs besides its id (accounting_scoreboard_rows.bucket_day / due_soon / outcome). */
export interface AmPmRowMeta {
  id: string;
  /** A weekday Collections bucket's own day: its score is Pending until that day's PM is in. */
  bucketDay: Weekday | null;
  /**
   * An Open Disputes line that counts the disputes due in 7 days: called out, never scored, never added
   * to the open total, the overall or a Day total (it is part of open).
   */
  dueSoon: boolean;
  /** A Chargeback Outcomes line: counted as a win or a loss in the win ratio; null = neither (Pre-arb). */
  outcome?: Outcome | null;
}

/**
 * Why a row has (or has no) score:
 * - `scored`      a number
 * - `na`          the bucket was 0 all week: "N/A", left out of the overall (Carla)
 * - `pending`     a weekday Collections bucket whose own day's PM is not in yet, and that day is
 *                 today or still ahead: "Pending", left out of the overall (Carla)
 * - `pm_missing`  the same bucket once its day is over with no PM: "PM missing", left out
 * - `due_soon`    Open Disputes' "due in 7 days" line: part of open, so it is called out and never
 *                 scored or counted in the overall (Carla, 2026-10-02 and 2026-10-07)
 * - `empty`       nothing typed: "—"
 */
export type RowScoreStatus = 'scored' | 'na' | 'pending' | 'pm_missing' | 'due_soon' | 'empty';

export interface AmPmRowStats {
  days: AmPmDay[];
  /** Carla's Completed: Σ every decrease between back-to-back readings; null when nothing is typed. */
  completed: number | null;
  /** The latest reading; null when nothing is typed. */
  open: number | null;
  /** Mean of the PM counts typed on or before today; null when none (the inbox rule). */
  pmAverage: number | null;
  status: RowScoreStatus;
  /** The row's 0–10 score under the section's rule; null unless `status` is `scored` and there is a rule. */
  score: number | null;
}

export function amPmRowStats(
  row: AmPmRowMeta,
  dates: readonly string[],
  lookup: EntryLookup,
  rule: ScoreRule | undefined,
  today: string,
): AmPmRowStats {
  const days: AmPmDay[] = [];
  const readings: number[] = [];
  const pms: number[] = [];
  for (const date of dates) {
    const am = lookup.get(entryKey(row.id, date, 'am')) ?? null;
    const pm = lookup.get(entryKey(row.id, date, 'pm')) ?? null;
    let state: AmPmDayState;
    if (date > today) state = 'future';
    else if (am !== null && pm !== null) state = 'complete';
    else if (am !== null) state = date < today ? 'pm_missing' : 'pm_pending';
    else if (pm !== null) state = 'am_missing';
    else state = 'empty';
    if (state !== 'future') {
      // Carla's readings, in order, with a blank skipped: it is never a 0.
      if (am !== null) readings.push(am);
      if (pm !== null) readings.push(pm);
      if (pm !== null) pms.push(pm);
    }
    days.push({ date, am, pm, state });
  }
  const cleared = clearedFromReadings(readings);
  const pmAverage = mean(pms);
  const base = { days, completed: cleared?.completed ?? null, open: cleared?.open ?? null, pmAverage };

  if (rule === 'inbox') {
    return pmAverage === null
      ? { ...base, status: 'empty', score: null }
      : { ...base, status: 'scored', score: inboxScore(pmAverage) };
  }
  if (rule === 'cleared') {
    // The disputes due in 7 days are already counted in the open disputes: scoring them too would
    // count them twice.
    if (row.dueSoon) return { ...base, status: cleared ? 'due_soon' : 'empty', score: null };
    // A weekday Collections bucket fills the day before its day and is worked on its day, so it is
    // judged only once its own day's PM is in (Carla, 2026-10-02).
    const ownDate = row.bucketDay ? dates.find((d) => weekdayOf(d) === row.bucketDay) : undefined;
    if (ownDate !== undefined && lookup.get(entryKey(row.id, ownDate, 'pm')) === undefined) {
      if (ownDate >= today) return { ...base, status: 'pending', score: null };
      return { ...base, status: cleared ? 'pm_missing' : 'empty', score: null };
    }
    if (!cleared) return { ...base, status: 'empty', score: null };
    if (cleared.score === null) return { ...base, status: 'na', score: null };
    return { ...base, status: 'scored', score: cleared.score };
  }
  return { ...base, status: cleared ? 'scored' : 'empty', score: null };
}

export interface DayTotal {
  date: string;
  /** Sum over the rows that have a number in, leaving out a "due in 7 days" line (part of open); null when none. */
  am: number | null;
  pm: number | null;
}

export interface AmPmSectionStats {
  rows: Map<string, AmPmRowStats>;
  dayTotals: DayTotal[];
  /** Σ Completed and Σ Open over the SCORED rows only (N/A, Pending, PM missing are left out); null when none. */
  completedTotal: number | null;
  openTotal: number | null;
  /** Mean of the rows' PM averages (inbox), null when none. */
  teamPmAverage: number | null;
  /** Open Disputes: Σ of the latest reading of every line NOT marked due-soon; null when none is typed. */
  openNow: number | null;
  /** Σ of the latest reading of the lines marked "due in 7 days"; null when none is typed. */
  dueSoonNow: number | null;
  /**
   * The headline the goal is judged on:
   * - cleared (buckets, Open Disputes since 2026-10-07, AM/PM custom sections) = 10 × Σ Completed ÷
   *   Σ(Completed + Open) over the scored rows (Carla's overall)
   * - inbox             = inboxScore(teamPmAverage)
   * - no rule           = openNow (how many are open now)
   */
  headline: number | null;
}

export function amPmSectionStats(
  rowMeta: readonly AmPmRowMeta[],
  dates: readonly string[],
  lookup: EntryLookup,
  rule: ScoreRule | undefined,
  today: string,
): AmPmSectionStats {
  const rows = new Map<string, AmPmRowStats>();
  for (const r of rowMeta) rows.set(r.id, amPmRowStats(r, dates, lookup, rule, today));

  const dayTotals: DayTotal[] = dates.map((date) => {
    const ams: number[] = [];
    const pms: number[] = [];
    // The "due in 7 days" line is part of open: adding it to the day would count those disputes twice.
    for (const r of rowMeta.filter((m) => !m.dueSoon)) {
      const am = lookup.get(entryKey(r.id, date, 'am'));
      const pm = lookup.get(entryKey(r.id, date, 'pm'));
      if (am !== undefined) ams.push(am);
      if (pm !== undefined) pms.push(pm);
    }
    return { date, am: ams.length ? sum(ams) : null, pm: pms.length ? sum(pms) : null };
  });

  const scored = [...rows.values()].filter((r) => r.status === 'scored');
  const completedTotal = scored.length ? sum(scored.map((r) => r.completed as number)) : null;
  const openTotal = scored.length ? sum(scored.map((r) => r.open as number)) : null;
  const pmAvgs = [...rows.values()].map((r) => r.pmAverage).filter((a): a is number => a !== null);
  const teamPmAverage = mean(pmAvgs);

  const latest = (wantDueSoon: boolean): number | null => {
    const opens = rowMeta
      .filter((r) => r.dueSoon === wantDueSoon)
      .map((r) => rows.get(r.id)?.open ?? null)
      .filter((o): o is number => o !== null);
    return opens.length ? sum(opens) : null;
  };
  const openNow = latest(false);
  const dueSoonNow = latest(true);

  let headline: number | null;
  if (rule === 'cleared') {
    headline = completedTotal === null || openTotal === null ? null : clearedScore(completedTotal, openTotal);
  } else if (rule === 'inbox') {
    headline = teamPmAverage === null ? null : inboxScore(teamPmAverage);
  } else {
    headline = openNow;
  }
  return { rows, dayTotals, completedTotal, openTotal, teamPmAverage, openNow, dueSoonNow, headline };
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

/**
 * PM Buckets' No Meeting Streak (Carla, 2026-10-02): calendar days since the last day ANY PM meeting
 * was ticked, counted from today. All time: it runs across weeks and drops to 0 only on a day a
 * meeting is ticked. null when no meeting has ever been ticked. Computed from the ticks; never stored.
 */
export function noMeetingStreak(lastMeetingDate: string | null, today: string): number | null {
  if (lastMeetingDate === null) return null;
  return Math.max(0, daysBetween(lastMeetingDate, today));
}

/** Whole calendar days from `from` to `to` (YYYY-MM-DD, no time zone involved). */
export function daysBetween(from: string, to: string): number {
  const ms = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Chargeback Outcomes: a dollar amount and a count a day (Pre-arb, Wins, Losses)
// ---------------------------------------------------------------------------

export interface AmountCountRowStats {
  usd: (number | null)[];
  count: (number | null)[];
  /** Σ of the days typed; null when none. */
  weekUsd: number | null;
  weekCount: number | null;
}

/**
 * A line's week dollars with the sign its flag gives it (Carla, 2026-10-07, item 392: "a loss is a negative, but I
 * can't put a dash right here"; Kane: "Wins positive. PR losses have negative."): a loss or Pre-arb is negative,
 * a win positive, an unmarked line as typed. Amounts are always typed positive; the sign is never typed.
 * Nothing typed stays null.
 */
export function signedOutcomeUsd(outcome: Outcome | null, usd: number | null): number | null {
  if (usd === null) return null;
  return (outcome === 'loss' || outcome === 'pre_arb') && usd !== 0 ? -usd : usd;
}

/**
 * The Net (Carla, 2026-10-07): wins minus losses minus Pre-arb, in dollars, over the lines that carry a flag
 * and have dollars typed. An unmarked line is left out. Nothing marked or nothing typed is null ("—"), never 0.
 * Summed in whole cents, so 10.10 − 0.20 is 9.90 and never 9.899999. The $25 fee per loss is NOT added (plan
 * W0.3 (d): typed into the amount until Carla says otherwise).
 */
export function outcomesNet(lines: readonly { outcome: Outcome | null; weekUsd: number | null }[]): number | null {
  const counted = lines.filter((l) => l.outcome !== null && l.weekUsd !== null);
  if (!counted.length) return null;
  const cents = counted.reduce((total, l) => total + Math.round((signedOutcomeUsd(l.outcome, l.weekUsd) as number) * 100), 0);
  // A Net of exactly 0 prints "$0.00", never "-$0.00".
  return cents === 0 ? 0 : cents / 100;
}

/**
 * The week's Net for the Outcomes grid: each line's week $ (Σ of its typed days) through `outcomesNet`. A line's
 * flag is read with `isOutcome`, never "not null": a board cached before 2026-10-07 has no `outcome` at all.
 */
export function outcomesWeekNet(
  rows: readonly Pick<AmPmRowMeta, 'id' | 'outcome'>[],
  dates: readonly string[],
  lookup: EntryLookup,
): number | null {
  const stats = amountCountSectionStats(
    rows.map((r) => r.id),
    dates,
    lookup,
  );
  return outcomesNet(
    rows.map((r) => ({ outcome: isOutcome(r.outcome) ? r.outcome : null, weekUsd: stats.rows.get(r.id)?.weekUsd ?? null })),
  );
}

/** Wins and losses, by count, for the win ratio. Dollars never weigh in. */
export interface WinRatio {
  /** Σ this week's chargeback counts on the lines marked "win"; null when none was typed. */
  won: number | null;
  /** The same for "loss". */
  lost: number | null;
  /**
   * 100 × won ÷ (won + lost), one decimal. Null when nothing was decided (no count typed, or 0 and 0):
   * absence is never a 0% (ui-standards § 12.5).
   */
  ratio: number | null;
}

/**
 * Carla, 2026-10-07: "a win ratio of 50% or higher each week". By COUNT (the number of chargebacks, not
 * dollars). Pre-arb and any line marked neither are left out: they are not decided. A line counts by its
 * flag (rows.outcome), never by its label, so a rename keeps it.
 */
export function winRatio(
  rows: readonly Pick<AmPmRowMeta, 'id' | 'outcome'>[],
  dates: readonly string[],
  lookup: EntryLookup,
): WinRatio {
  const total = (outcome: Outcome): number | null => {
    const counts = rows
      .filter((r) => r.outcome === outcome)
      .flatMap((r) => dates.map((d) => lookup.get(entryKey(r.id, d, 'count'))))
      .filter((v): v is number => v !== undefined);
    return counts.length ? sum(counts) : null;
  };
  const won = total('win');
  const lost = total('loss');
  const decided = (won ?? 0) + (lost ?? 0);
  return { won, lost, ratio: decided > 0 ? Math.round((1000 * (won ?? 0)) / decided) / 10 : null };
}

export function amountCountSectionStats(
  rowIds: readonly string[],
  dates: readonly string[],
  lookup: EntryLookup,
): { rows: Map<string, AmountCountRowStats>; weekCount: number | null; weekUsd: number | null } {
  const rows = new Map<string, AmountCountRowStats>();
  for (const id of rowIds) {
    const usd = dates.map((d) => lookup.get(entryKey(id, d, 'usd')) ?? null);
    const count = dates.map((d) => lookup.get(entryKey(id, d, 'count')) ?? null);
    const u = usd.filter((v): v is number => v !== null);
    const c = count.filter((v): v is number => v !== null);
    rows.set(id, { usd, count, weekUsd: u.length ? sum(u) : null, weekCount: c.length ? sum(c) : null });
  }
  const counts = [...rows.values()].map((r) => r.weekCount).filter((v): v is number => v !== null);
  const usds = [...rows.values()].map((r) => r.weekUsd).filter((v): v is number => v !== null);
  return { rows, weekCount: counts.length ? sum(counts) : null, weekUsd: usds.length ? sum(usds) : null };
}

// ---------------------------------------------------------------------------
// Payroll Problems: the problem log (each problem has a type)
// ---------------------------------------------------------------------------

export interface ProblemEntry {
  id: string;
  date: string;
  rowId: string;
  typeId: string;
  /** How many problems of this type this line records (usually 1). */
  count: number;
  createdBy: string;
  createdAt: string;
}

/** The "type" of a count typed into the old grid before problems had types (read, never written). */
export const UNTYPED_PROBLEMS = 'untyped';

export interface ProblemsWeekStats {
  /** Per person: per day (in `dates` order) and the week. null = nothing logged or typed. */
  rows: Map<string, { byDay: (number | null)[]; week: number | null }>;
  byDay: (number | null)[];
  /** The headline: null when the week has no log line and no typed count (absence is not 0). */
  week: number | null;
  /** Problems per type this week, largest first; UNTYPED_PROBLEMS for the old grid's counts. */
  byType: { typeId: string; count: number }[];
}

/**
 * A person's day = Σ of their log lines + the count typed into the old grid that day, if any. A typed
 * 0 in the grid is a real 0. Nothing logged and nothing typed is null ("—"): the board cannot tell
 * "no problems" from "nobody logged", the same rule as the collections log.
 */
export function problemsWeekStats(
  rowIds: readonly string[],
  logs: readonly Pick<ProblemEntry, 'date' | 'rowId' | 'typeId' | 'count'>[],
  lookup: EntryLookup,
  dates: readonly string[],
): ProblemsWeekStats {
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const ids = new Set(rowIds);
  const cells = new Map<string, (number | null)[]>();
  const byType = new Map<string, number>();
  for (const id of rowIds) {
    const legacy = dates.map((d) => lookup.get(entryKey(id, d, 'day')) ?? null);
    cells.set(id, legacy);
    const untyped = legacy.reduce<number>((s, v) => s + (v ?? 0), 0);
    if (untyped > 0) byType.set(UNTYPED_PROBLEMS, round2((byType.get(UNTYPED_PROBLEMS) ?? 0) + untyped));
  }
  for (const log of logs) {
    const i = dayIndex.get(log.date);
    if (i === undefined || !ids.has(log.rowId)) continue;
    const row = cells.get(log.rowId)!;
    row[i] = (row[i] ?? 0) + log.count;
    byType.set(log.typeId, (byType.get(log.typeId) ?? 0) + log.count);
  }
  const rows = new Map<string, { byDay: (number | null)[]; week: number | null }>();
  for (const [id, byDay] of cells) {
    const typed = byDay.filter((v): v is number => v !== null);
    rows.set(id, { byDay, week: typed.length ? sum(typed) : null });
  }
  const byDay = dates.map((_, i) => {
    const typed = [...rows.values()].map((r) => r.byDay[i]).filter((v): v is number => v !== null);
    return typed.length ? sum(typed) : null;
  });
  const weeks = [...rows.values()].map((r) => r.week).filter((w): w is number => w !== null);
  return {
    rows,
    byDay,
    week: weeks.length ? sum(weeks) : null,
    byType: [...byType.entries()]
      .map(([typeId, count]) => ({ typeId, count }))
      .sort((a, b) => b.count - a.count || a.typeId.localeCompare(b.typeId)),
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
  /**
   * "Payment Verified" (Carla, 2026-10-02): who ticked it and when, from
   * accounting_scoreboard_collection_verifications. null = not verified. The log line itself is
   * never edited.
   */
  verified: { by: string; name: string; at: string } | null;
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
  const amount = goal.unit === '%' ? `${goal.value}%` : `${goal.value} ${goal.unit}`;
  return `${goal.direction === 'at_least' ? '≥' : '<'} ${amount}`;
}
