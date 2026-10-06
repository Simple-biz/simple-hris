import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  currentWeekStart,
  failureResponse,
  okResponse,
  readBoard,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { createLineTracker, encodeBoardStreamLine, type BoardStreamLine } from '@/lib/accounting-scoreboard/load-progress';
import { isWeekStart } from '@/lib/accounting-scoreboard/week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The streamed read (load-progress.ts): the npd route's headers. */
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  // Defensive: some proxies buffer streamed responses without this (the npd route does the same).
  'X-Accel-Buffering': 'no',
};

/**
 * GET /api/accounting-scoreboard?week=YYYY-MM-DD (a Sunday; default = this week, US Eastern)
 *
 * The whole board for one week: rows, this and last week's entries and collections, all-time
 * collections and the record, the section switches, and the Dancing Queen preview candidate.
 * Members only (src/lib/accounting-scoreboard/server.ts → resolveAccess). Members are listed for
 * managers only. Governing doc: docs/features/accounting-scoreboard.md.
 *
 * `&stream=1` answers the same board as NDJSON, for the loading modal (§ Loading the board): a `line`
 * as each group of reads answers, then `board`, or an `error` line. The member check and the week are
 * settled BEFORE the stream starts, while a clean status is still possible (401 / 403 / 400). The
 * plain JSON answer (the cache's silent revalidation, the 45 s tick, a focus) is unchanged.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccess('member');
    if (!access.ok) return failureResponse(access);
    const week = req.nextUrl.searchParams.get('week');
    if (week !== null && !isWeekStart(week)) return badRequest('week must be a Sunday written YYYY-MM-DD');
    const weekStart = week ?? currentWeekStart();

    if (req.nextUrl.searchParams.get('stream') !== '1') {
      const board = await readBoard(access.value, weekStart);
      if (!board.ok) return failureResponse(board);
      return okResponse(board.value);
    }

    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (line: BoardStreamLine) => {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(encodeBoardStreamLine(line)));
          } catch {
            cancelled = true; // the browser went away (changed week, closed the page)
          }
        };
        const tracker = createLineTracker((line, detail) => emit({ type: 'line', line, detail }));
        try {
          const board = await readBoard(access.value, weekStart, tracker);
          if (board.ok) emit({ type: 'board', board: board.value });
          else emit({ type: 'error', error: board.message, code: board.code, line: tracker.failedLine() });
        } catch (e) {
          emit({
            type: 'error',
            error: e instanceof Error ? e.message : 'The scoreboard could not load.',
            code: 'server_error',
            line: tracker.failedLine(),
          });
        } finally {
          try {
            if (!cancelled) controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(stream, { headers: NDJSON_HEADERS });
  } catch (e) {
    return crashResponse(e);
  }
}
