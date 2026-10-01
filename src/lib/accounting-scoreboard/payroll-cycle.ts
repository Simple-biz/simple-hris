/**
 * Payroll Timing, filled from HRIS itself. Nobody types it.
 * Governing doc: docs/features/accounting-scoreboard.md § Payroll Timing fills itself.
 *
 * Kane, 2026-10-01, a screenshot of Carla's "Payroll Scoreboard (Timing)": per week, when the cycle
 * STARTED (goal: Tuesday 12:00 PM) and when it CLOSED (goal: Friday 12:00 PM), whether each was on
 * time, a cycle score, and the average over This week / Last week / Two weeks ago. Every time on that
 * sheet is one of HRIS's own audit events (measured read-only 2026-10-01: 9/15 8:09 AM, 9/18 3:50 PM,
 * 9/22 1:21 PM, 9/25 3:50 PM, 9/29 11:01 AM, all Eastern):
 *
 *   - started = the FIRST `payroll.dispatch.locked` of the week. Start Processing turns on the
 *     wizard's `payroll.dispatch_locked` lock (processing-guard.ts:9-10).
 *   - closed  = the cycle's `payment_cycle.closed` (Close Pay Cycle in Payment Dispatch). A week
 *     PAYS the Sunday–Saturday before it, matched on the PARSED date range in the source file
 *     (never the file name: " (1).csv" drift). A `payment_cycle.reopened` after the close means the
 *     cycle is open again (cycle-closeout.md:145-187).
 *
 * Cycle score: 25 for starting on time + 75 for closing on time, scored only once both are decided.
 * That reproduces the sheet's two scored rows (start on time, close late = 25%; both late = 0%). It
 * is CHOSEN, not read from the sheet; the formula is printed on the panel so Carla can correct it.
 *
 * Pure. All times are US Eastern (week.ts).
 */

import { addDays, easternToUtc, isIsoDate } from './week';
import type { Light } from './stoplight';

export const PAYROLL_EVENT_ACTIONS = ['payroll.dispatch.locked', 'payment_cycle.closed', 'payment_cycle.reopened'] as const;
export type PayrollEventAction = (typeof PAYROLL_EVENT_ACTIONS)[number];

export interface PayrollEvent {
  action: PayrollEventAction;
  /** ISO timestamp (audit_log.created_at). */
  at: string;
  /** The cycle's source file, for close/reopen events. */
  sourceFile: string | null;
}

/** Carla's deadlines: start by Tuesday noon, close by Friday noon (Eastern). */
export const START_DEADLINE = { dayOffset: 2, hour: 12, minute: 0, label: 'Tuesday 12:00 PM' } as const;
export const CLOSE_DEADLINE = { dayOffset: 5, hour: 12, minute: 0, label: 'Friday 12:00 PM' } as const;
export const SCORE_WEIGHTS = { start: 25, close: 75 } as const;

/**
 * - `on_time`  it happened by the deadline
 * - `late`     it happened after the deadline
 * - `pending`  not yet, and the deadline has not passed
 * - `missed`   not yet, and the deadline has passed (counts as late)
 */
export type CheckState = 'on_time' | 'late' | 'pending' | 'missed';

export interface CycleWeek {
  /** The processing week (Sunday key). */
  weekStart: string;
  /** The work week this processing week pays: the Sunday–Saturday before it. */
  paysWeek: { start: string; end: string };
  startedAt: string | null;
  startDeadline: string;
  start: CheckState;
  closedAt: string | null;
  closeDeadline: string;
  close: CheckState;
  /** The cycle was closed and then reopened, and is not closed again. */
  reopened: boolean;
  /** 0–100 once both checks are decided, else null. */
  score: number | null;
}

/** The work week (Sunday–Saturday) a source file covers, from the dates in its name; null if unreadable. */
export function cycleRange(sourceFile: string | null | undefined): { start: string; end: string } | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(sourceFile ?? '');
  if (!m || !isIsoDate(m[1]) || !isIsoDate(m[2])) return null;
  return { start: m[1], end: m[2] };
}

function judge(at: string | null, deadlineMs: number, nowMs: number): CheckState {
  if (at !== null) return Date.parse(at) <= deadlineMs ? 'on_time' : 'late';
  return nowMs > deadlineMs ? 'missed' : 'pending';
}

export function isDecided(c: CheckState): boolean {
  return c !== 'pending';
}

export function isOnTime(c: CheckState): boolean {
  return c === 'on_time';
}

export function cycleWeek(events: readonly PayrollEvent[], weekStart: string, nowIso: string): CycleWeek {
  const from = easternToUtc(weekStart, 0).getTime();
  const to = easternToUtc(addDays(weekStart, 7), 0).getTime();
  const startDeadline = easternToUtc(addDays(weekStart, START_DEADLINE.dayOffset), START_DEADLINE.hour, START_DEADLINE.minute);
  const closeDeadline = easternToUtc(addDays(weekStart, CLOSE_DEADLINE.dayOffset), CLOSE_DEADLINE.hour, CLOSE_DEADLINE.minute);
  const paysWeek = { start: addDays(weekStart, -7), end: addDays(weekStart, -1) };

  const firstLock = events
    .filter((e) => e.action === 'payroll.dispatch.locked')
    .map((e) => Date.parse(e.at))
    .filter((t) => Number.isFinite(t) && t >= from && t < to)
    .sort((a, b) => a - b)[0];
  const startedAt = firstLock === undefined ? null : new Date(firstLock).toISOString();

  let closedAt: string | null = null;
  let reopened = false;
  const cycleEvents = events
    .filter((e) => e.action !== 'payroll.dispatch.locked')
    .filter((e) => {
      const r = cycleRange(e.sourceFile);
      return r !== null && r.start === paysWeek.start && r.end === paysWeek.end;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of cycleEvents) {
    if (e.action === 'payment_cycle.closed') {
      closedAt = new Date(Date.parse(e.at)).toISOString();
      reopened = false;
    } else if (e.action === 'payment_cycle.reopened') {
      closedAt = null;
      reopened = true;
    }
  }

  const now = Date.parse(nowIso);
  const start = judge(startedAt, startDeadline.getTime(), now);
  const close = judge(closedAt, closeDeadline.getTime(), now);
  const score =
    isDecided(start) && isDecided(close)
      ? (isOnTime(start) ? SCORE_WEIGHTS.start : 0) + (isOnTime(close) ? SCORE_WEIGHTS.close : 0)
      : null;

  return {
    weekStart,
    paysWeek,
    startedAt,
    startDeadline: startDeadline.toISOString(),
    start,
    closedAt,
    closeDeadline: closeDeadline.toISOString(),
    close,
    reopened,
    score,
  };
}

export interface CycleAverages {
  /** Share of decided starts that were on time, 0–100; null when none is decided. */
  startOnTime: number | null;
  closeOnTime: number | null;
  /** Mean of the scored weeks; null when none is scored. */
  score: number | null;
}

/** The sheet's Average row: each column over the weeks where it is decided. */
export function cycleAverages(weeks: readonly CycleWeek[]): CycleAverages {
  const pct = (checks: CheckState[]) => {
    const decided = checks.filter(isDecided);
    return decided.length ? (decided.filter(isOnTime).length / decided.length) * 100 : null;
  };
  const scores = weeks.map((w) => w.score).filter((s): s is number => s !== null);
  return {
    startOnTime: pct(weeks.map((w) => w.start)),
    closeOnTime: pct(weeks.map((w) => w.close)),
    score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}

/** A cycle's stop light: every decided check on time = green, none = red, a mix = amber. */
export function cycleLight(week: Pick<CycleWeek, 'start' | 'close'>): Light {
  const decided = [week.start, week.close].filter(isDecided);
  if (!decided.length) return 'none';
  const good = decided.filter(isOnTime).length;
  if (good === decided.length) return 'green';
  if (good === 0) return 'red';
  return 'amber';
}
