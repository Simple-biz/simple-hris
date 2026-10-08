import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  createTask,
  failureResponse,
  okResponse,
  patchTask,
  readJson,
  readTasks,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseTaskCreate, parseTaskPatch, parseTaskView } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET   /api/accounting-scoreboard/tasks?person=me|all|<work email>   a task board              (any role; all / a person: Admin, Assistant)
 * POST  /api/accounting-scoreboard/tasks   { ownerEmail, title, frequency }    add a task      (Admins)
 * PATCH /api/accounting-scoreboard/tasks   { id, title?, sortOrder?, archived? }  change one   (Admins)
 *
 * Per-person task boards (plan Task 7, Open item 393; docs/features/accounting-scoreboard-tasks.md). A task is
 * archived, never deleted, and its owner and frequency never change in place.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    const view = parseTaskView(req.nextUrl.searchParams.get('person'));
    if (!view.ok) return badRequest(view.error);
    const result = await readTasks(access.value, view.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manage_tasks');
    if (!access.ok) return failureResponse(access);
    const parsed = parseTaskCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await createTask(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ task: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('manage_tasks');
    if (!access.ok) return failureResponse(access);
    const parsed = parseTaskPatch(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await patchTask(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
