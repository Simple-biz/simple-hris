import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  currentWeekStart,
  failureResponse,
  okResponse,
  readHistory,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseHistoryWindow } from '@/lib/accounting-scoreboard/history';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/accounting-scoreboard/history?from=YYYY-MM-DD&to=YYYY-MM-DD (Sundays, at most 26 weeks, never past this week)
 *
 * The History tab's weeks: per week, every Overview card's number, stop light and Team Score card, and the week's Team
 * Score, computed by the Overview's own calls (history.ts). Anyone on the board, like the board GET: it shows the
 * numbers the Overview already shows. Read-only, not on the live channel. The panel asks for one quarter at a time,
 * newest first. Governing doc: docs/features/accounting-scoreboard-history.md.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    const q = req.nextUrl.searchParams;
    const window = parseHistoryWindow({ from: q.get('from'), to: q.get('to') }, currentWeekStart());
    if (!window.ok) return badRequest(window.error);
    const result = await readHistory(window.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
