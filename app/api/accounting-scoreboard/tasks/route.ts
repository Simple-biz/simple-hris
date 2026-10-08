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
  refuseTaskView,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { createTaskLineReporter, encodeTasksStreamLine, type TasksStreamLine } from '@/lib/accounting-scoreboard/task-load-progress';
import { parseTaskCreate, parseTaskPatch, parseTaskView } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The streamed read (task-load-progress.ts): the board route's headers. */
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store',
  // Defensive: some proxies buffer streamed responses without this (the npd route does the same).
  'X-Accel-Buffering': 'no',
};

/**
 * GET   /api/accounting-scoreboard/tasks?person=me|all|<work email>[&stream=1]   a task board   (any role; all / a person: Admin, Assistant)
 * POST  /api/accounting-scoreboard/tasks   { ownerEmail, title, frequency }    add a task      (Admins)
 * PATCH /api/accounting-scoreboard/tasks   { id, title?, sortOrder?, archived? }  change one   (Admins)
 *
 * Per-person task boards (plan Task 7, Open item 393; docs/features/accounting-scoreboard-tasks.md). A task is
 * archived, never deleted, and its owner and frequency never change in place.
 *
 * `&stream=1` answers the same view as NDJSON, for the loading card over the skeleton (task-load-progress.ts): a
 * `line` as each read answers, then `tasks`, or an `error` line. The member check, the view and who may see it are
 * settled BEFORE the stream starts, while a clean status is still possible (401 / 403 / 400). The plain JSON answer
 * (the cache's silent revalidation, a Refresh click) is unchanged.
 */
export async function GET(req: NextRequest) {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    const view = parseTaskView(req.nextUrl.searchParams.get('person'));
    if (!view.ok) return badRequest(view.error);
    const refused = refuseTaskView(access.value, view.value);
    if (refused) return failureResponse(refused);

    if (req.nextUrl.searchParams.get('stream') !== '1') {
      const result = await readTasks(access.value, view.value);
      if (!result.ok) return failureResponse(result);
      return okResponse(result.value);
    }

    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (line: TasksStreamLine) => {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(encodeTasksStreamLine(line)));
          } catch {
            cancelled = true; // the browser went away (picked another board, closed the page)
          }
        };
        const reporter = createTaskLineReporter((line, detail) => emit({ type: 'line', line, detail }));
        try {
          const result = await readTasks(access.value, view.value, reporter);
          if (result.ok) emit({ type: 'tasks', tasks: result.value });
          else emit({ type: 'error', error: result.message, code: result.code, line: reporter.failedLine() });
        } catch (e) {
          emit({
            type: 'error',
            error: e instanceof Error ? e.message : 'The tasks could not load.',
            code: 'server_error',
            line: reporter.failedLine(),
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
