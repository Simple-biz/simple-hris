/**
 * The scoreboard's loading modal (Kane, 2026-10-06: *"Onloading the dashboard lets add a progress bar
 * modal that has appropriate texts inside it please like collecting buckets and etc"* · *"make sure the
 * progress bar is accurate"*). Governing doc: docs/features/accounting-scoreboard.md § Loading the board.
 *
 * Pure: the route, the server read and the browser all use it, and load-progress.test.ts pins it.
 *
 * ACCURATE means the NPD card's rules (npd-dashboard.md § Loading a sheet) and ui-standards § 10.1
 * ("the bar tracks completed STEPS, never elapsed time"), with the shared step model
 * (src/lib/refresh-progress/refresh-progress.ts):
 *   - Every line is real work. `access` is the member check the route runs before it answers; every
 *     other line is a group of the database reads `readBoard` really sends (BOARD_READS), and it is
 *     done only when its LAST read has answered. The server says so on the stream the moment it
 *     happens, with what came back ("Collected 866 numbers this week and last").
 *   - Then the page lays the board out, and only once it is painted is the bar full and green.
 *   - No percentage is printed. The bar never moves backwards.
 *
 * GET /api/accounting-scoreboard?stream=1 answers NDJSON (one JSON object per line):
 *   line    { line, detail }          a group of reads has all answered
 *   board   { board }                 the whole board, once every read answered
 *   error   { error, code, line }     the read failed (`line`: whose read, when known); nothing follows
 * The browser assembles it FAIL-CLOSED: a stream that stops early, a line it cannot read, an unknown
 * line id, or a board for another week is a failed load, never a partial board.
 */

import { countOf, type RefreshPlan } from '@/lib/refresh-progress/refresh-progress';
import { isBoardRole } from './roles';
import type { BoardPayload } from './types';
import { isWeekStart } from './week';

/** The modal's lines, in the order it lists them. */
export const BOARD_LOAD_LINES = ['access', 'rows', 'numbers', 'collections', 'problems', 'payroll', 'setup'] as const;
export type BoardLoadLine = (typeof BOARD_LOAD_LINES)[number];
/** The lines the server reports (`access` is the route answering at all). */
export type ServerLine = Exclude<BoardLoadLine, 'access'>;

/**
 * Which of `readBoard`'s reads each line waits for. `removedRows` (rows removed from the board that
 * still hold numbers in the two weeks shown) runs only after entries, collections and problems have
 * answered, and only when one is missing; `members` only for a manager. A read that is not needed is
 * reported as answered with 0, at the moment the server decides it is not needed.
 */
export const BOARD_READS = {
  rows: ['rows', 'removedRows'],
  numbers: ['entries'],
  collections: ['collections', 'collectionWeeks'],
  problems: ['problems', 'problemTypes'],
  payroll: ['payrollEvents', 'closes', 'handCloses'],
  setup: ['settings', 'customSections', 'bonus', 'lastMeeting', 'members'],
} as const satisfies Record<ServerLine, readonly string[]>;
export type BoardRead = (typeof BOARD_READS)[ServerLine][number];

const LINE_OF = new Map<BoardRead, ServerLine>(
  (Object.entries(BOARD_READS) as [ServerLine, readonly BoardRead[]][]).flatMap(([line, reads]) =>
    reads.map((r) => [r, line] as [BoardRead, ServerLine]),
  ),
);

export function lineOfRead(read: BoardRead): ServerLine {
  const line = LINE_OF.get(read);
  if (!line) throw new Error(`Unknown scoreboard read: ${read}`);
  return line;
}

/** What `readBoard` tells the tracker. `count` is how many records came back. */
export interface BoardReadProgress {
  done(read: BoardRead, count: number, note?: string): void;
}

/** The plan the modal starts with. Labels say what is being fetched; a done line says what came back. */
export function boardLoadPlan(subject: string): RefreshPlan {
  return {
    subject,
    steps: [
      { id: 'access', label: "Checking you're on the scoreboard", doneLabel: "You're on the scoreboard" },
      { id: 'rows', label: 'Gathering the buckets, inboxes and people', doneLabel: 'Gathered the board’s lines' },
      { id: 'numbers', label: 'Collecting the bucket, inbox and PM counts', doneLabel: 'Collected the counts' },
      { id: 'collections', label: 'Collecting the collections log', doneLabel: 'Collected the collections log' },
      { id: 'problems', label: 'Collecting payroll problems', doneLabel: 'Collected payroll problems' },
      { id: 'payroll', label: 'Checking Payroll Wizard starts and closes', doneLabel: 'Checked payroll timing' },
      { id: 'setup', label: 'Reading goals, sections and the bonus formula', doneLabel: 'Read the setup' },
    ],
    applyLabel: 'Laying out the board',
    appliedLabel: 'Board ready',
  };
}

/** A finished line's own sentence, from what its reads returned. */
export function describeLine(line: ServerLine, counts: Readonly<Partial<Record<BoardRead, number>>>, notes: Readonly<Partial<Record<BoardRead, string>>> = {}): string {
  const n = (r: BoardRead) => counts[r] ?? 0;
  switch (line) {
    case 'rows': {
      const removed = n('removedRows');
      return `Found ${countOf(n('rows'), 'line')} on the board${removed ? ` (+ ${countOf(removed, 'removed line')} with numbers)` : ''}`;
    }
    case 'numbers':
      return `Collected ${countOf(n('entries'), 'number')} this week and last`;
    case 'collections':
      return `Collected ${countOf(n('collections'), 'collection')} this week and last`;
    case 'problems':
      return n('problems') ? `Collected ${countOf(n('problems'), 'payroll problem line')} this week and last` : 'No payroll problems logged this week or last';
    case 'payroll':
      return `Found ${countOf(n('payrollEvents'), 'Payroll Wizard start or close', 'Payroll Wizard starts and closes')}`;
    case 'setup':
      // The bonus read is TOLERATED by the board (its card says it could not be read), so the line
      // stays done, but it never claims the formula was read when it was not.
      return notes.bonus ? `Read the goals and sections · ${notes.bonus}` : 'Read the goals, sections and the bonus formula';
  }
}

/**
 * Server side: counts what each read returned and reports a line the moment its LAST read answers.
 * A read reported twice counts once. `failed` records whose read failed (the first one), so the
 * error line can blame only that line; a line with a failed read is never reported as done.
 */
export function createLineTracker(report: (line: ServerLine, detail: string) => void): BoardReadProgress & {
  failed(read: BoardRead): void;
  failedLine(): ServerLine | null;
} {
  const pending = new Map<ServerLine, Set<BoardRead>>(
    (Object.entries(BOARD_READS) as [ServerLine, readonly BoardRead[]][]).map(([line, reads]) => [line, new Set(reads)]),
  );
  const counts: Partial<Record<BoardRead, number>> = {};
  const notes: Partial<Record<BoardRead, string>> = {};
  let failedLine: ServerLine | null = null;
  return {
    failed(read) {
      const line = lineOfRead(read);
      if (failedLine === null) failedLine = line;
      pending.delete(line);
    },
    failedLine: () => failedLine,
    done(read, count, note) {
      const line = lineOfRead(read);
      const waiting = pending.get(line);
      if (!waiting || !waiting.has(read)) return;
      counts[read] = count;
      if (note) notes[read] = note;
      waiting.delete(read);
      if (waiting.size === 0) {
        pending.delete(line);
        report(line, describeLine(line, counts, notes));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export type BoardStreamLine =
  | { type: 'line'; line: ServerLine; detail: string }
  | { type: 'board'; board: BoardPayload }
  | { type: 'error'; error: string; code: string; line: ServerLine | null };

export function encodeBoardStreamLine(line: BoardStreamLine): string {
  return `${JSON.stringify(line)}\n`;
}

export type BoardStreamEvent =
  | { kind: 'line'; line: ServerLine; detail: string }
  | { kind: 'board'; board: BoardPayload }
  | { kind: 'failed'; error: string; code: string; line: ServerLine | null };

export const BOARD_STREAM_CUT_SHORT =
  'The scoreboard stopped arriving part-way through, so none of it is shown. Nothing was changed. Try again.';
const UNREADABLE = 'The scoreboard arrived in a form this page could not read, so none of it is shown. Nothing was changed.';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const SERVER_LINES = new Set<string>(BOARD_LOAD_LINES.filter((l) => l !== 'access'));

/** The board's shape, checked before anything paints it: a partial board is worse than none. */
export function isBoardPayload(v: unknown): v is BoardPayload {
  if (!isObj(v)) return false;
  const arrays = ['settings', 'customSections', 'rows', 'entries', 'collections', 'problems', 'problemTypes', 'payrollEvents'];
  return (
    isWeekStart(v.weekStart) &&
    isWeekStart(v.lastWeekStart) &&
    typeof v.today === 'string' &&
    isObj(v.viewer) &&
    typeof (v.viewer as Record<string, unknown>).email === 'string' &&
    isBoardRole((v.viewer as Record<string, unknown>).role) &&
    arrays.every((k) => Array.isArray(v[k])) &&
    isObj(v.history) &&
    isObj(v.bonus)
  );
}

/**
 * Assemble one board from its stream. `push` takes one line of text and returns the event it means
 * (or null for a blank line); `finish` says whether a whole, valid board arrived. `week` is the week
 * asked for (null = this week, whatever the server says that is). After the first problem every later
 * line is ignored.
 */
export function createBoardStreamAssembler(week: string | null) {
  let board: BoardPayload | null = null;
  let failure: { error: string; code: string; line: ServerLine | null } | null = null;

  const fail = (error: string, code = 'unreadable', line: ServerLine | null = null): BoardStreamEvent => {
    failure = { error, code, line };
    return { kind: 'failed', error, code, line };
  };

  return {
    push(text: string): BoardStreamEvent | null {
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
      if (board) return fail(UNREADABLE); // nothing may follow the board
      switch (parsed.type) {
        case 'line':
          if (typeof parsed.line !== 'string' || !SERVER_LINES.has(parsed.line) || typeof parsed.detail !== 'string') {
            return fail(UNREADABLE);
          }
          return { kind: 'line', line: parsed.line as ServerLine, detail: parsed.detail };
        case 'board':
          if (!isBoardPayload(parsed.board)) return fail(UNREADABLE);
          if (week !== null && parsed.board.weekStart !== week) return fail(UNREADABLE);
          board = parsed.board;
          return { kind: 'board', board };
        case 'error': {
          const line = typeof parsed.line === 'string' && SERVER_LINES.has(parsed.line) ? (parsed.line as ServerLine) : null;
          return fail(
            typeof parsed.error === 'string' && parsed.error ? parsed.error : 'The scoreboard could not load.',
            typeof parsed.code === 'string' ? parsed.code : 'server_error',
            line,
          );
        }
        default:
          return fail(UNREADABLE);
      }
    },
    finish(): { ok: true; board: BoardPayload } | { ok: false; error: string; code: string; line: ServerLine | null } {
      if (failure) return { ok: false, ...failure };
      if (!board) return { ok: false, error: BOARD_STREAM_CUT_SHORT, code: 'cut_short', line: null };
      return { ok: true, board };
    },
  };
}
