import {
  badRequest,
  changeTaskFrequency,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseTaskFrequencyChange } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/accounting-scoreboard/tasks/frequency   { id, frequency, title? }   change how often a task is done (Admins)
 *
 * Kane, 2026-10-08: "the tasks edit button can also edit the frequency". A task's frequency never changes in place
 * (docs/features/accounting-scoreboard-tasks.md): this adds a NEW task with the new frequency and archives the old
 * one, which keeps its ticks. Answers `{ task, replacedId }`: the new task, and the id it replaced.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manage_tasks');
    if (!access.ok) return failureResponse(access);
    const parsed = parseTaskFrequencyChange(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await changeTaskFrequency(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value, 201);
  } catch (e) {
    return crashResponse(e);
  }
}
