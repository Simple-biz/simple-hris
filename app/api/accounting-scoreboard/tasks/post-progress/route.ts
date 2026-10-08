import { crashResponse, failureResponse, okResponse, postTaskProgress, resolveAccess } from '@/lib/accounting-scoreboard/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/accounting-scoreboard/tasks/post-progress   (Admins)
 *
 * Posts the team's task progress to the accounting team space's Google Chat (plan Task 8, Open item 393), through
 * ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL. 503 when it is not set; 502 when Google refuses or does not answer. The
 * webhook URL carries a key and never appears in a response. This is the manual post; the scheduled ones are
 * /api/cron/accounting-scoreboard-chat (docs/features/accounting-scoreboard-tasks.md § Scheduled posts).
 */
export async function POST() {
  try {
    const access = await resolveAccess('manage_tasks');
    if (!access.ok) return failureResponse(access);
    const result = await postTaskProgress(access.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
