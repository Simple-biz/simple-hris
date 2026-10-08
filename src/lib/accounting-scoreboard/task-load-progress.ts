/**
 * The Tasks view's loading card (Kane, 2026-10-08: "on top of the skeleton lets add the modal loading similar to
 * HRIS - NPD"). Governing doc: docs/features/accounting-scoreboard-tasks.md § Loading and the browser cache.
 *
 * Pure: the route, the server read and the browser all use it, and task-load-progress.test.ts pins it.
 *
 * ACCURATE means NPD's card rules (npd-dashboard.md § Loading a sheet) and ui-standards § 10.1, on the shared step
 * model (src/lib/refresh-progress/refresh-progress.ts), exactly as the board's modal (load-progress.ts):
 *   - Every line is real work. `access` is the member check (and, for someone else's board or Everyone, the role
 *     check) the route runs before it answers. `people`, `tasks` and `ticks` are the three reads `readTasks` really
 *     sends, side by side; each line is done the moment its read answered, saying what came back. `ticks` also waits
 *     for `tasks`, because a tick is matched to its task's current period before it is counted.
 *   - Then the page lays the tasks out, and only once they are painted is the bar full and green.
 *   - No percentage is printed. The bar never moves backwards.
 *
 * GET /api/accounting-scoreboard/tasks?person=…&stream=1 answers NDJSON (one JSON object per line):
 *   line    { line, detail }          a read has answered
 *   tasks   { tasks }                 the whole view, once every read answered
 *   error   { error, code, line }     the read failed (`line`: whose read, when known); nothing follows
 * The browser assembles it FAIL-CLOSED: a stream that stops early, a line it cannot read, an unknown line id, a view
 * that is not the one asked for, or anything after the view is a failed load, never a partial board.
 */

import { countOf, type RefreshPlan } from '@/lib/refresh-progress/refresh-progress';
import { isBoardRole } from './roles';
import type { TasksPayload } from './types';

/** The card's lines, in the order it lists them. */
export const TASK_LOAD_LINES = ['access', 'people', 'tasks', 'ticks'] as const;
export type TaskLoadLine = (typeof TASK_LOAD_LINES)[number];
/** The lines the server reports (`access` is the route answering at all). */
export type TaskServerLine = Exclude<TaskLoadLine, 'access'>;
const SERVER_LINES = new Set<string>(TASK_LOAD_LINES.filter((l) => l !== 'access'));

/** Whose board a read is for: `me`, `all`, or a board person's work email (the GET's `person`). */
export type TaskViewKey = string;

/** The plan the card starts with. `whose` names the board: "your", "everyone's", "Blake's". */
export function tasksLoadPlan(subject: string, whose: string): RefreshPlan {
  return {
    subject,
    steps: [
      { id: 'access', label: "Checking you're on the scoreboard", doneLabel: "You're on the scoreboard" },
      { id: 'people', label: "Finding the board's people", doneLabel: "Found the board's people" },
      { id: 'tasks', label: `Reading ${whose} tasks`, doneLabel: 'Read the tasks' },
      { id: 'ticks', label: 'Matching ticks to the current periods', doneLabel: 'Matched the ticks' },
    ],
    applyLabel: 'Laying out the tasks',
    appliedLabel: 'Tasks ready',
  };
}

/** A finished line's own sentence, from what its read returned. */
export function describeTaskLine(line: TaskServerLine, count: number): string {
  switch (line) {
    case 'people':
      return `Found ${countOf(count, 'person', 'people')} on the board`;
    case 'tasks':
      return count ? `Read ${countOf(count, 'task')}` : 'No tasks on this board yet';
    case 'ticks':
      return count ? `${countOf(count, 'task')} ticked this period` : 'Nothing ticked yet this period';
  }
}

/**
 * Server side: reports a line once, the moment its read answers. `failed` records the FIRST read that failed, so the
 * error line blames only it. A line whose read failed is never reported as done; a read beside it that really
 * answered still is (the reads run side by side, so it did happen).
 */
export function createTaskLineReporter(report: (line: TaskServerLine, detail: string) => void) {
  const reported = new Set<TaskServerLine>();
  const failed = new Set<TaskServerLine>();
  let failedLine: TaskServerLine | null = null;
  return {
    done(line: TaskServerLine, count: number) {
      if (reported.has(line) || failed.has(line)) return;
      reported.add(line);
      report(line, describeTaskLine(line, count));
    },
    failed(line: TaskServerLine) {
      if (reported.has(line)) return;
      failed.add(line);
      if (failedLine === null) failedLine = line;
    },
    failedLine: () => failedLine,
  };
}
export type TaskReadProgress = Pick<ReturnType<typeof createTaskLineReporter>, 'done' | 'failed'>;

// ---------------------------------------------------------------------------
// The payload and the view it answers
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Does a payload show the view it was asked for? `me` is the viewer's own board, `all` Everyone, else that person. */
export function payloadShowsView(view: TaskViewKey, shown: TasksPayload['view'] | undefined): boolean {
  if (!isObj(shown)) return false;
  if (view === 'me') return shown.kind === 'person' && shown.own === true;
  if (view === 'all') return shown.kind === 'all';
  return shown.kind === 'person' && isObj(shown.person) && shown.person.email === view;
}

/** The Tasks payload's shape, checked before anything paints it: a partial board is worse than none. */
export function isTasksPayload(v: unknown): v is TasksPayload {
  if (!isObj(v) || !isObj(v.viewer) || !isObj(v.view)) return false;
  return (
    typeof v.today === 'string' &&
    typeof v.viewer.email === 'string' &&
    isBoardRole(v.viewer.role) &&
    (v.view.kind === 'all' || v.view.kind === 'person') &&
    (v.people === null || Array.isArray(v.people)) &&
    Array.isArray(v.tasks) &&
    Array.isArray(v.checks) &&
    (v.teamProgress === null || Array.isArray(v.teamProgress)) &&
    (v.chatConfigured === null || typeof v.chatConfigured === 'boolean')
  );
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export type TasksStreamLine =
  | { type: 'line'; line: TaskServerLine; detail: string }
  | { type: 'tasks'; tasks: TasksPayload }
  | { type: 'error'; error: string; code: string; line: TaskServerLine | null };

export function encodeTasksStreamLine(line: TasksStreamLine): string {
  return `${JSON.stringify(line)}\n`;
}

export type TasksStreamEvent =
  | { kind: 'line'; line: TaskServerLine; detail: string }
  | { kind: 'tasks'; tasks: TasksPayload }
  | { kind: 'failed'; error: string; code: string; line: TaskServerLine | null };

export const TASKS_STREAM_CUT_SHORT =
  'The tasks stopped arriving part-way through, so none of them are shown. Nothing was changed. Try again.';
const UNREADABLE = 'The tasks arrived in a form this page could not read, so none of them are shown. Nothing was changed.';

/**
 * Assemble one view from its stream. `push` takes one line of text and returns the event it means (or null for a
 * blank line); `finish` says whether a whole, valid view of `view` arrived. After the first problem every later line
 * is ignored.
 */
export function createTasksStreamAssembler(view: TaskViewKey) {
  let tasks: TasksPayload | null = null;
  let failure: { error: string; code: string; line: TaskServerLine | null } | null = null;

  const fail = (error: string, code = 'unreadable', line: TaskServerLine | null = null): TasksStreamEvent => {
    failure = { error, code, line };
    return { kind: 'failed', error, code, line };
  };

  return {
    push(text: string): TasksStreamEvent | null {
      if (failure) return null;
      const trimmed = text.trim();
      if (!trimmed) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return fail(UNREADABLE);
      }
      if (!isObj(parsed)) return fail(UNREADABLE);
      if (tasks) return fail(UNREADABLE); // nothing may follow the view
      switch (parsed.type) {
        case 'line':
          if (typeof parsed.line !== 'string' || !SERVER_LINES.has(parsed.line) || typeof parsed.detail !== 'string') {
            return fail(UNREADABLE);
          }
          return { kind: 'line', line: parsed.line as TaskServerLine, detail: parsed.detail };
        case 'tasks':
          if (!isTasksPayload(parsed.tasks) || !payloadShowsView(view, parsed.tasks.view)) return fail(UNREADABLE);
          tasks = parsed.tasks;
          return { kind: 'tasks', tasks };
        case 'error': {
          const line = typeof parsed.line === 'string' && SERVER_LINES.has(parsed.line) ? (parsed.line as TaskServerLine) : null;
          return fail(
            typeof parsed.error === 'string' && parsed.error ? parsed.error : 'The tasks could not load.',
            typeof parsed.code === 'string' ? parsed.code : 'server_error',
            line,
          );
        }
        default:
          return fail(UNREADABLE);
      }
    },
    finish(): { ok: true; tasks: TasksPayload } | { ok: false; error: string; code: string; line: TaskServerLine | null } {
      if (failure) return { ok: false, ...failure };
      if (!tasks) return { ok: false, error: TASKS_STREAM_CUT_SHORT, code: 'cut_short', line: null };
      return { ok: true, tasks };
    },
  };
}
