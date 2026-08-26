/**
 * Schedule periods — what a person is EXPECTED to work, effective-dated.
 *
 * ## Why "period" and not "schedule"
 *
 * A schedule is not a property of a person, it is a property of a person *during a
 * stretch of time*. Storing it as a flat field means changing someone's rest days in
 * October silently rewrites what September's coverage looked like, and every
 * historical number moves under you. So the unit here is a PERIOD with
 * `effectiveFrom` / `effectiveTo`, exactly mirroring the proposed
 * `employee_rest_day_patterns` + `employee_shift_windows` tables — the UI is built
 * against the shape the tables will have, so wiring the backend later is a swap of
 * the data source, not a rewrite of the surface.
 *
 * ## What this can and cannot tell you
 *
 * Measured 2026-08-26: the timesheet (`hubstaff_hours`) stores a per-day TOTAL and
 * no clock times; the Hubstaff endpoint this system calls (`activities/daily`)
 * returns `{date, tracked, overall}`; `user_presence` keeps a single `last_seen_at`
 * with no history. The only clock times anywhere are
 * `time_adjustment_requests.requested_segments`, which record MISSED time — an
 * exception log, not a record of hours worked.
 *
 * Therefore:
 *  - **Rest days are checkable.** "Scheduled Tuesday, no hours Tuesday" compares a
 *    scheduled day against a daily total. Both sides exist.
 *  - **Shift windows are NOT checkable.** A stored window says what should happen;
 *    nothing records when work actually started. "Started three hours late" needs a
 *    time-entry feed this system does not have.
 *
 * Do not build an adherence metric on `shiftWindow` without adding that feed first.
 *
 * ## The money wall
 *
 * HSL already prices days: the +₱15/h weekend premium, PAB weekday coverage, and
 * orphanage OT all key on the CALENDAR (is it a Saturday?). It is tempting to let
 * them ask this module "was it a scheduled day?" instead. **Nothing here feeds pay.**
 * A schedule describes expectation; rates stay keyed on the calendar. Wiring a
 * schedule into a pay rule turns a descriptive surface into a money path and is its
 * own decision, under the hardening rules — not a refactor.
 *
 * Client-safe: constants and pure functions only, no I/O.
 */

import { parseDateOnlyLocal } from '@/lib/date-only';
import type { ShiftWindow } from '@/lib/manager/shift-window';

/** JS `getDay()` convention: 0 = Sunday … 6 = Saturday. Used verbatim so a stored
 *  `rest_days smallint[]` needs no translation layer. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat',
};

export const WEEKDAY_LONG: Record<Weekday, string> = {
  0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday',
  4: 'Thursday', 5: 'Friday', 6: 'Saturday',
};

export function isWeekend(d: Weekday): boolean {
  return d === 0 || d === 6;
}

/** One person's expectation over one stretch of time. */
export interface SchedulePeriod {
  id: string;
  workEmail: string;
  name: string;
  /** Master-list `Department` cell, e.g. `hsl:intake_specialist`. */
  department: string;
  /** Days this person is NOT expected to work. Everything else is a scheduled day. */
  restDays: Weekday[];
  /** Expected window. Null = "we know their days but not their hours", which is a
   *  legitimate and common state — never render it as 00:00. */
  shiftWindow: ShiftWindow | null;
  /** IANA zone the window is expressed in. The workforce is on EST/EDT, and every
   *  Hubstaff row measured carries `America/New_York`. */
  timezone: string;
  /** `YYYY-MM-DD`, inclusive. */
  effectiveFrom: string;
  /** `YYYY-MM-DD`, inclusive. Null = still current. */
  effectiveTo: string | null;
}

/** A per-sub-team starting point, so seeding 591 people is not 591 forms. */
export interface TeamDefault {
  department: string;
  restDays: Weekday[];
  shiftWindow: ShiftWindow | null;
  timezone: string;
}

/** True when `isoDate` falls inside the period's effective range. */
export function periodCoversDate(period: SchedulePeriod, isoDate: string): boolean {
  if (isoDate < period.effectiveFrom) return false;
  if (period.effectiveTo && isoDate > period.effectiveTo) return false;
  return true;
}

/**
 * The function the coverage panel's third bucket is waiting on: is this person
 * EXPECTED to work on this date?
 *
 * Returns null when no period covers the date — which is not "no", it is "we have
 * no schedule on file for then". Collapsing that null into false is the same
 * mistake as collapsing "no timesheet record" into "day off", so the type makes
 * the caller handle it.
 */
export function isScheduledDay(period: SchedulePeriod, isoDate: string): boolean | null {
  if (!periodCoversDate(period, isoDate)) return null;
  const d = parseDateOnlyLocal(isoDate);
  if (!d) return null;
  return !period.restDays.includes(d.getDay() as Weekday);
}

/** Days a period expects work on — the complement of its rest days. */
export function scheduledDays(period: SchedulePeriod): Weekday[] {
  return WEEKDAYS.filter((d) => !period.restDays.includes(d));
}

/** How many days a week this period expects. */
export function scheduledDaysPerWeek(period: SchedulePeriod): number {
  return scheduledDays(period).length;
}

/**
 * Scheduled headcount per weekday across a set of periods — the forecast a manager
 * cannot get today at all, because it needs no timesheet. This is the number that
 * answers "how thin is Saturday going to be" BEFORE the week rather than after it.
 *
 * `onDate` is optional: pass an ISO date to count only periods effective then;
 * omit it to count every period given (the "current picture" reading).
 */
export function scheduledHeadcountByWeekday(
  periods: readonly SchedulePeriod[],
  onDate?: string,
): Record<Weekday, number> {
  const out = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 } as Record<Weekday, number>;
  for (const p of periods) {
    if (onDate && !periodCoversDate(p, onDate)) continue;
    for (const d of scheduledDays(p)) out[d] += 1;
  }
  return out;
}

/** Human rest-day summary: "Sat, Sun", "Sun", or "None" — never an empty string. */
export function formatRestDays(restDays: readonly Weekday[]): string {
  if (restDays.length === 0) return 'None';
  if (restDays.length === 7) return 'Every day';
  return [...restDays].sort((a, b) => a - b).map((d) => WEEKDAY_SHORT[d]).join(', ');
}

/** Periods with no shift window on file. Counted and shown, never defaulted. */
export function periodsMissingWindow(periods: readonly SchedulePeriod[]): SchedulePeriod[] {
  return periods.filter((p) => p.shiftWindow === null);
}

/**
 * Two periods for the same person whose effective ranges overlap. An overlap means
 * a date has two answers, so this is a hard data error rather than a warning — the
 * proposed unique index on `(lower(work_email), effective_from)` stops exact
 * duplicates but cannot stop a straddle, so it is checked here too.
 */
export function findOverlaps(periods: readonly SchedulePeriod[]): Array<[SchedulePeriod, SchedulePeriod]> {
  const byEmail = new Map<string, SchedulePeriod[]>();
  for (const p of periods) {
    const k = p.workEmail.trim().toLowerCase();
    const arr = byEmail.get(k);
    if (arr) arr.push(p);
    else byEmail.set(k, [p]);
  }

  const hits: Array<[SchedulePeriod, SchedulePeriod]> = [];
  for (const group of byEmail.values()) {
    const sorted = [...group].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      // `a` starts first. They overlap unless `a` has closed before `b` opens.
      if (a.effectiveTo === null || a.effectiveTo >= b.effectiveFrom) hits.push([a, b]);
    }
  }
  return hits;
}

export interface SchedulingCoverageSummary {
  /** People with at least one period on file. */
  scheduled: number;
  /** In-scope people with NO period at all — the seeding backlog, shown as its own
   *  number so "we scheduled the team" cannot quietly mean "we scheduled 60% of it". */
  unscheduled: number;
  /** Of the scheduled, how many have days but no hours on file. */
  missingWindow: number;
  byWeekday: Record<Weekday, number>;
  /** Thinnest and fattest weekday, for the at-a-glance read. */
  thinnestDay: Weekday;
  fattestDay: Weekday;
}

export function summarizeScheduling(
  periods: readonly SchedulePeriod[],
  rosterSize: number,
): SchedulingCoverageSummary {
  const emails = new Set(periods.map((p) => p.workEmail.trim().toLowerCase()));
  const byWeekday = scheduledHeadcountByWeekday(periods);

  let thinnestDay: Weekday = 0;
  let fattestDay: Weekday = 0;
  for (const d of WEEKDAYS) {
    if (byWeekday[d] < byWeekday[thinnestDay]) thinnestDay = d;
    if (byWeekday[d] > byWeekday[fattestDay]) fattestDay = d;
  }

  return {
    scheduled: emails.size,
    unscheduled: Math.max(0, rosterSize - emails.size),
    missingWindow: periodsMissingWindow(periods).length,
    byWeekday,
    thinnestDay,
    fattestDay,
  };
}
