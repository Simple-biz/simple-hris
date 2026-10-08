import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
  setTaskOrder,
} from '@/lib/accounting-scoreboard/server';
import { parseTaskOrder } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/accounting-scoreboard/tasks/order   { ids }   rearrange one card of one person's tasks
 *
 * Aliviah, relayed by Kane 2026-10-08: "each user could rearrange their task list". Any member of the board may call
 * it; the server lets through only the OWNER of those tasks (by any of their addresses) or an Admin (403 otherwise).
 * `ids` is EVERY live task of one owner and one frequency, in the new order: a stale list is 409, never applied in part
 * (src/lib/accounting-scoreboard/task-order.ts). Answers `{ order: [{ id, sortOrder }] }`.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    const parsed = parseTaskOrder(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await setTaskOrder(access.value, parsed.value.ids);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
