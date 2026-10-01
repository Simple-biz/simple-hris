/**
 * Payroll Timing, connected to the Payroll Wizard itself. Nobody types it.
 * Governing doc: docs/features/accounting-scoreboard.md § Payroll Timing fills itself.
 *
 * Kane, 2026-10-01, a screenshot of Carla's "Payroll Scoreboard (Timing)": per pay week, when the cycle
 * STARTED (goal: Tuesday 12:00 PM) and when it CLOSED (goal: Friday 12:00 PM), whether each was on
 * time, a cycle score, and the average over This week / Last week / Two weeks ago. Then, the same day:
 * "lets connect this to the actual payroll Wizard where we first started processing per week and
 * close it" and "Make sure to check previous weeks".
 *
 *   - started = the FIRST `dispatch.lock_acquired` whose `details.cycle` names this week's pay cycle.
 *     The Wizard writes it on Start Processing, stamped with the file it is on (`handleLockToggle` in
 *     PayrollWizard.tsx; cycle-audit.ts). The processing lock itself is global and names no week
 *     (cycle-closeout.md § Permissions), and Payment Dispatch's Start button stamps no cycle, so a
 *     start made only from Dispatch is not an input. A start for this cycle counts WHENEVER it happened:
 *     a week processed late still belongs to its own cycle, never to the week it happened in.
 *   - closed  = the cycle's `payment_cycle.closed` (Close Pay Cycle in Payment Dispatch; the Wizard
 *     never closes, cycle-closeout.md § Downloadable report). A `payment_cycle.reopened` after the
 *     close opens the cycle again, and the close that sticks is the one judged.
 *
 * Every event is matched to its cycle on the PARSED period, by the Sunday the period starts (a cycle
 * is a period, not a file: diagnostics-performance-tabs.md § A cycle is a PERIOD; " (1).csv" drift).
 *
 * Absence is not failure (diagnostics-performance-tabs.md § Three statuses, § not_run):
 *   - a FINISHED week the Wizard never started is `no_record` (payroll ran outside HRIS that week),
 *     never `missed`. A live week past Tuesday noon with no start is `missed`.
 *   - a cycle that ended before the first close-out was ever filed could not have been closed, so its
 *     close is `no_record` (Diagnostics' `pre_closeout` boundary, cycle-performance.ts).
 *
 * Cycle score: 25 for starting on time + 75 for closing on time, scored only once both are judged.
 * That reproduces the sheet's two scored rows (start on time, close late = 25%; both late = 0%). It
 * is CHOSEN, not read from the sheet; the formula is printed on the panel so Carla can correct it.
 *
 * Pure. All times are US Eastern (week.ts).
 */

import { addDays, easternToUtc, isIsoDate, weekStartOf } from './week';
import type { Light } from './stoplight';

/**
 * The three audit actions Payroll Timing reads. `payroll.dispatch.locked` is deliberately NOT one:
 * it is the global lock, written by both Start buttons, and names no week. Measured 2026-10-01, it
 * put the Jul 19–25 cycle's start at a Payment Dispatch lock on Mon 7/27 10:12 PM (on time) when the
 * Wizard first started that cycle on Tue 7/28 4:07 PM (late).
 */
export const PAYROLL_EVENT_ACTIONS = ['dispatch.lock_acquired', 'payment_cycle.closed', 'payment_cycle.reopened'] as const;
export type PayrollEventAction = (typeof PAYROLL_EVENT_ACTIONS)[number];

export interface PayrollEvent {
  action: PayrollEventAction;
  /** ISO timestamp (audit_log.created_at). */
  at: string;
  /** The file the event names: the Wizard's `details.cycle.source_file`, or the close-out's. */
  sourceFile: string | null;
  /** The Sunday its pay cycle starts on (`eventCycleStart`). Null = unreadable, and the event never counts. */
  cycleStart: string | null;
}

/** Carla's deadlines: start by Tuesday noon, close by Friday noon (Eastern). */
export const START_DEADLINE = { dayOffset: 2, hour: 12, minute: 0, label: 'Tuesday 12:00 PM' } as const;
export const CLOSE_DEADLINE = { dayOffset: 5, hour: 12, minute: 0, label: 'Friday 12:00 PM' } as const;
export const SCORE_WEIGHTS = { start: 25, close: 75 } as const;

/**
 * - `on_time`    it happened by the deadline
 * - `late`       it happened after the deadline
 * - `pending`    not yet, and the deadline has not passed
 * - `missed`     not yet, and the deadline has passed (counts as late)
 * - `no_record`  nothing to judge: a finished week the Wizard never started, or a cycle that ended
 *                before Close Pay Cycle existed. Never late, never in a score or an average.
 */
export type CheckState = 'on_time' | 'late' | 'pending' | 'missed' | 'no_record';

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
  /** 0–100 once both checks are judged, else null. */
  score: number | null;
}

/** The work week a source file covers, from the dates in its name; null if unreadable. */
export function cycleRange(sourceFile: string | null | undefined): { start: string; end: string } | null {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(sourceFile ?? '');
  if (!m || !isIsoDate(m[1]) || !isIsoDate(m[2])) return null;
  return { start: m[1], end: m[2] };
}

/**
 * The Sunday a payroll event's cycle starts on. A Wizard start carries its cycle's period
 * (`details.cycle.period_start`), with the file name as the fallback; a close or reopen carries only
 * the file. Null when neither reads as a date.
 */
export function eventCycleStart(periodStart: string | null | undefined, sourceFile: string | null | undefined): string | null {
  if (isIsoDate(periodStart)) return weekStartOf(periodStart);
  const range = cycleRange(sourceFile);
  return range === null ? null : weekStartOf(range.start);
}

/** The audit columns the board reads for Payroll Timing (server.ts). Times, actions and file names only. */
export interface PayrollAuditRow {
  action: string;
  created_at: string;
  resource_id: string | null;
  /** `details->>source_file`: the close-out's file. */
  src: string | null;
  /** `details->cycle->>source_file`: the file the Wizard was on. */
  csrc: string | null;
  /** `details->cycle->>period_start`: that file's period start. */
  cps: string | null;
}

function isPayrollAction(action: string): action is PayrollEventAction {
  return (PAYROLL_EVENT_ACTIONS as readonly string[]).includes(action);
}

/** One audit row as a Payroll Timing event; null for any other action. */
export function payrollEventFromAudit(r: PayrollAuditRow): PayrollEvent | null {
  if (!isPayrollAction(r.action)) return null;
  if (r.action === 'dispatch.lock_acquired') {
    return { action: r.action, at: r.created_at, sourceFile: r.csrc, cycleStart: eventCycleStart(r.cps, r.csrc) };
  }
  // The close-out route writes the file to both details.source_file and resource_id.
  const sourceFile = r.src ?? r.resource_id;
  return { action: r.action, at: r.created_at, sourceFile, cycleStart: eventCycleStart(null, sourceFile) };
}

/**
 * The earliest period end among cycles ever closed: close-outs existed from that cycle on, so a cycle
 * that ended before it could not have been closed (Diagnostics' `pre_closeout` boundary). Read from
 * the close EVENTS, not the live records, because a reopen frees a record but the close-out still
 * existed. Null when none was ever filed.
 */
export function firstClosedPeriodEnd(closes: readonly Pick<PayrollAuditRow, 'src' | 'resource_id'>[]): string | null {
  let first: string | null = null;
  for (const c of closes) {
    const range = cycleRange(c.src ?? c.resource_id);
    if (range !== null && (first === null || range.end < first)) first = range.end;
  }
  return first;
}

function judgeAt(at: string, deadline: Date): CheckState {
  return Date.parse(at) <= deadline.getTime() ? 'on_time' : 'late';
}

/** A check with a verdict: on time, late or missed. Pending and no_record have none. */
export function isDecided(c: CheckState): boolean {
  return c === 'on_time' || c === 'late' || c === 'missed';
}

export function isOnTime(c: CheckState): boolean {
  return c === 'on_time';
}

/**
 * @param firstClosedPeriodEnd the period end of the first cycle ever closed (close-outs existed from
 *   then on). A cycle that ended before it could not have been closed. Null = none was ever filed,
 *   which exempts nothing (Diagnostics' rule).
 */
export function cycleWeek(
  events: readonly PayrollEvent[],
  weekStart: string,
  nowIso: string,
  firstClosedPeriodEnd: string | null,
): CycleWeek {
  const weekEnd = easternToUtc(addDays(weekStart, 7), 0).getTime();
  const startDeadline = easternToUtc(addDays(weekStart, START_DEADLINE.dayOffset), START_DEADLINE.hour, START_DEADLINE.minute);
  const closeDeadline = easternToUtc(addDays(weekStart, CLOSE_DEADLINE.dayOffset), CLOSE_DEADLINE.hour, CLOSE_DEADLINE.minute);
  const paysWeek = { start: addDays(weekStart, -7), end: addDays(weekStart, -1) };

  const mine = events
    .filter((e) => e.cycleStart === paysWeek.start)
    .map((e) => ({ e, t: Date.parse(e.at) }))
    .filter(({ t }) => Number.isFinite(t))
    .sort((a, b) => a.t - b.t);

  const firstStart = mine.find(({ e }) => e.action === 'dispatch.lock_acquired');
  const startedAt = firstStart === undefined ? null : new Date(firstStart.t).toISOString();

  let closedAt: string | null = null;
  let reopened = false;
  for (const { e, t } of mine) {
    if (e.action === 'payment_cycle.closed') {
      closedAt = new Date(t).toISOString();
      reopened = false;
    } else if (e.action === 'payment_cycle.reopened') {
      closedAt = null;
      reopened = true;
    }
  }

  const now = Date.parse(nowIso);
  const preCloseout = firstClosedPeriodEnd !== null && paysWeek.end < firstClosedPeriodEnd;

  let start: CheckState;
  if (startedAt !== null) start = judgeAt(startedAt, startDeadline);
  else if (now <= startDeadline.getTime()) start = 'pending';
  else start = now < weekEnd ? 'missed' : 'no_record';

  let close: CheckState;
  if (closedAt !== null) close = judgeAt(closedAt, closeDeadline);
  else if (preCloseout && !reopened) close = 'no_record';
  else close = now <= closeDeadline.getTime() ? 'pending' : 'missed';

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
