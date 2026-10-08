/**
 * Accounting Scoreboard task boards (plan Task 7, Open item 393): frequencies, periods and progress. Pure, so the
 * server and the client count the same way.
 *
 * Carla, 2026-10-07: "every person has a task board ... daily task, weekly task, bi-weekly, monthly, bimonthly,
 * quarterly, annually. And then there's tasks that just come up on our desk and we do them as they are needed."
 *
 * A tick belongs to the task's CURRENT PERIOD, in US Eastern (the board's day, week.ts):
 *   daily      the day                      weekly     the Sunday week (the board's week key)
 *   biweekly   the two-week block from Sunday 2026-01-04, then every 14 days
 *   monthly    the month                    bimonthly  the two-month block starting Jan, Mar, May, Jul, Sep or Nov
 *   quarterly  the quarter                  annually   the year
 *   as_needed  no period: listed, NEVER counted and never ticked ("if it's needed, cool, do it")
 * The period key is always the period's first day (YYYY-MM-DD). The server computes it; the client never sends one.
 *
 * Governing doc: docs/features/accounting-scoreboard-tasks.md.
 */

import { addDays, weekStartOf } from './week';

export const TASK_FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'bimonthly',
  'quarterly',
  'annually',
  'as_needed',
] as const;
export type TaskFrequency = (typeof TASK_FREQUENCIES)[number];
export type CountedFrequency = Exclude<TaskFrequency, 'as_needed'>;
export const COUNTED_FREQUENCIES = TASK_FREQUENCIES.filter((f): f is CountedFrequency => f !== 'as_needed');

export const FREQUENCY_LABEL: Record<TaskFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
  bimonthly: 'Bimonthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
  as_needed: 'As needed',
};

/** What "this period" means, for the "done of total" line. */
export const PERIOD_WORDS: Record<CountedFrequency, string> = {
  daily: 'today',
  weekly: 'this week',
  biweekly: 'these two weeks',
  monthly: 'this month',
  bimonthly: 'these two months',
  quarterly: 'this quarter',
  annually: 'this year',
};

export function isTaskFrequency(value: unknown): value is TaskFrequency {
  return typeof value === 'string' && (TASK_FREQUENCIES as readonly string[]).includes(value);
}

/** A Sunday. CHOSEN (plan Task 7): the two-week rhythm starts on the first Sunday of 2026. */
export const BIWEEKLY_ANCHOR = '2026-01-04';
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** The first day of the period `day` falls in, for a counted frequency; null for as-needed. */
export function taskPeriodKey(freq: TaskFrequency, day: string): string | null {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  switch (freq) {
    case 'daily':
      return day;
    case 'weekly':
      return weekStartOf(day);
    case 'biweekly': {
      const weeks = Math.round((Date.parse(weekStartOf(day)) - Date.parse(BIWEEKLY_ANCHOR)) / DAY_MS / 7);
      return addDays(BIWEEKLY_ANCHOR, Math.floor(weeks / 2) * 14);
    }
    case 'monthly':
      return `${y}-${pad(m)}-01`;
    case 'bimonthly':
      return `${y}-${pad(m - ((m - 1) % 2))}-01`;
    case 'quarterly':
      return `${y}-${pad(m - ((m - 1) % 3))}-01`;
    case 'annually':
      return `${y}-01-01`;
    case 'as_needed':
      return null;
  }
}

/** Every counted frequency's current period key, for one read of the live ticks. */
export function currentPeriodKeys(today: string): Record<CountedFrequency, string> {
  const out = {} as Record<CountedFrequency, string>;
  for (const f of COUNTED_FREQUENCIES) out[f] = taskPeriodKey(f, today) as string;
  return out;
}

export interface TaskLike {
  id: string;
  ownerEmail: string;
  frequency: TaskFrequency;
  archived: boolean;
}
export interface CheckLike {
  taskId: string;
  periodKey: string;
}

export interface FrequencyProgress {
  frequency: CountedFrequency;
  total: number;
  done: number;
}

/** The set of `taskId|periodKey` with a live tick. Only live ticks are ever passed in. */
function liveSet(checks: readonly CheckLike[]): Set<string> {
  return new Set(checks.map((c) => `${c.taskId}|${c.periodKey}`));
}

/** Is this task ticked for its current period? As-needed and archived tasks never are. */
export function isTaskDone(task: TaskLike, checks: readonly CheckLike[], today: string): boolean {
  if (task.archived) return false;
  const key = taskPeriodKey(task.frequency, today);
  return key !== null && checks.some((c) => c.taskId === task.id && c.periodKey === key);
}

/**
 * Done of total, per counted frequency, for the current periods. Live tasks only; as-needed never counted; a
 * frequency with no tasks is left out (never "0 of 0").
 */
export function taskProgress(tasks: readonly TaskLike[], checks: readonly CheckLike[], today: string): FrequencyProgress[] {
  const live = liveSet(checks);
  const keys = currentPeriodKeys(today);
  return COUNTED_FREQUENCIES.map((frequency) => {
    const own = tasks.filter((t) => !t.archived && t.frequency === frequency);
    return { frequency, total: own.length, done: own.filter((t) => live.has(`${t.id}|${keys[frequency]}`)).length };
  }).filter((p) => p.total > 0);
}

/** The All view: each owner's progress, for every owner with at least one live task (as-needed alone counts as none). */
export function progressByOwner(
  tasks: readonly TaskLike[],
  checks: readonly CheckLike[],
  today: string,
): Array<{ ownerEmail: string; progress: FrequencyProgress[] }> {
  const owners = [...new Set(tasks.filter((t) => !t.archived).map((t) => t.ownerEmail))];
  return owners
    .map((ownerEmail) => ({ ownerEmail, progress: taskProgress(tasks.filter((t) => t.ownerEmail === ownerEmail), checks, today) }))
    .filter((o) => o.progress.length > 0);
}

/**
 * Changing how often a task is done (Kane, 2026-10-08: "the tasks edit button can also edit the frequency"). The
 * owner and the frequency never change in place (the table's trigger refuses it), so a new frequency is a NEW task:
 * the old one is archived and keeps its ticks, and the new one starts unticked. An old tick never changes meaning.
 *
 * The two writes cannot share a transaction over PostgREST, so their ORDER is the guard:
 *   1. add the new task. If that fails, nothing changed.
 *   2. archive the old one. If that fails (or it was archived meanwhile), archive the new one again, so the change
 *      never leaves the task on the board twice. Archived is final, so a task is never lost: the old one is still live.
 *   3. If undoing also fails, the task IS on the board twice, and the caller says so (`undone: false`), never "failed".
 * Archive-first would be worse: a failed add would leave the task gone from the board for good.
 */
export async function changeFrequencyInOrder<T, F extends { ok: false }>(steps: {
  add: () => Promise<{ ok: true; value: T } | F>;
  archiveOld: () => Promise<{ ok: true } | F>;
  undoAdd: (added: T) => Promise<boolean>;
}): Promise<{ ok: true; value: T } | { ok: false; failure: F; added: T | null; undone: boolean }> {
  const added = await steps.add();
  if (!added.ok) return { ok: false, failure: added, added: null, undone: true };
  const archived = await steps.archiveOld();
  if (archived.ok) return { ok: true, value: added.value };
  const undone = await steps.undoAdd(added.value);
  return { ok: false, failure: archived, added: added.value, undone };
}
