import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
  setTaskDone,
} from '@/lib/accounting-scoreboard/server';
import { parseTaskCheck } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/accounting-scoreboard/tasks/checks   { taskId, done: boolean }
 *
 * Tick or untick a task for its CURRENT period, which the server computes from today (US Eastern); the body never
 * names one. Only the task's owner ticks it; the owner or an Admin unticks it, by a stamp, never a delete. Any role
 * may call this: whose task it is decides (setTaskDone).
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    const parsed = parseTaskCheck(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await setTaskDone(access.value, parsed.value.taskId, parsed.value.done);
    if (!result.ok) return failureResponse(result);
    return okResponse({ check: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
