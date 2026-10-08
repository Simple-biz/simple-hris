import type { NextRequest } from 'next/server';
import { crashResponse, failureResponse, okResponse } from '@/lib/accounting-scoreboard/server';
import { runScheduledChatPosts } from '@/lib/accounting-scoreboard/scheduled-chat';
import { anyPostFailed } from '@/lib/accounting-scoreboard/scheduled-chat-core';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bearer CRON_SECRET only (what Vercel Cron sends). Unlike the sheet-sync crons there is no signed-in manual trigger:
 * the manual path is the Admin's Post to Chat button, and this route only ever posts a slot that is due now.
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  return (req.headers.get('authorization') ?? '') === `Bearer ${expected}`;
}

/**
 * GET/POST /api/cron/accounting-scoreboard-chat
 *
 * Posts the Accounting Scoreboard team's task progress to the accounting team's Google Chat on Carla's schedule
 * (src/lib/accounting-scoreboard/chat-schedule.ts): daily at 3:00 PM, weekly on Wednesday and Friday at 9:00 AM,
 * monthly on the 1st and the 30th at 9:00 AM, all US Eastern. vercel.json calls it at 13:00, 14:00, 19:00 and 20:00
 * UTC (each slot's EDT and EST hour); a call that is not inside a slot's window does nothing, and a slot already
 * claimed by an earlier call (or a duplicate delivery) is not posted again.
 *
 * 200 = nothing due, or every due post went out (or was skipped / already claimed). 502 = a due post did not go out.
 * 503 = the webhook or the posts table is not set up (nothing claimed, nothing posted). The webhook URL is never in it.
 */
async function run(req: NextRequest) {
  if (!isAuthorized(req)) return okResponse({ success: false, error: 'Unauthorized' }, 401);
  try {
    const result = await runScheduledChatPosts(new Date(), req.headers.get('x-vercel-cron-schedule'));
    if (!result.ok) {
      console.error(`[cron accounting-scoreboard-chat] ${result.code}: ${result.message}`);
      return failureResponse(result);
    }
    const failed = anyPostFailed(result.value.results);
    if (failed) console.error('[cron accounting-scoreboard-chat] a due post did not go out:', JSON.stringify(result.value.results));
    return okResponse({ success: !failed, ...result.value }, failed ? 502 : 200);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
