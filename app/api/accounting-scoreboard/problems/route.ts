import { after, type NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  deleteProblem,
  failureResponse,
  logProblem,
  okResponse,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { announceScoreboardChange } from '@/lib/accounting-scoreboard/live-server';
import { isUuid, parseProblemCreate } from '@/lib/accounting-scoreboard/validate';
import { todayEastern } from '@/lib/accounting-scoreboard/week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/accounting-scoreboard/problems   { rowId, date, typeId, count? (1–1000, default 1) }
 * DELETE /api/accounting-scoreboard/problems?id=<uuid>
 *
 * The Payroll Problems log (Carla, 2026-10-02: a Problem Type on every problem). Any member logs.
 * A line is never edited (the table's trigger refuses it), so a mistake is deleted (soft, stamped)
 * and logged again. Only the person who logged a line, or a manager, may delete it.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('log_lines');
    if (!access.ok) return failureResponse(access);
    const parsed = parseProblemCreate(await readJson(req), todayEastern());
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await logProblem(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('problems', req));
    return okResponse({ problem: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('log_lines');
    if (!access.ok) return failureResponse(access);
    const id = req.nextUrl.searchParams.get('id');
    if (!isUuid(id)) return badRequest('id must be a problem id');
    const result = await deleteProblem(access.value, id);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('problems', req));
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
