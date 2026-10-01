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
import { isWeekStart } from '@/lib/accounting-scoreboard/week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/accounting-scoreboard?week=YYYY-MM-DD (a Sunday; default = this week, US Eastern)
 *
 * The whole board for one week: rows, this and last week's entries and collections, all-time
 * collections and the record, the section switches, and the Dancing Queen preview candidate.
 * Members only (src/lib/accounting-scoreboard/server.ts → resolveAccess). Members are listed for
 * managers only. Governing doc: docs/features/accounting-scoreboard.md.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccess('member');
    if (!access.ok) return failureResponse(access);
    const week = req.nextUrl.searchParams.get('week');
    if (week !== null && !isWeekStart(week)) return badRequest('week must be a Sunday written YYYY-MM-DD');
    const board = await readBoard(access.value, week ?? currentWeekStart());
    if (!board.ok) return failureResponse(board);
    return okResponse(board.value);
  } catch (e) {
    return crashResponse(e);
  }
}
