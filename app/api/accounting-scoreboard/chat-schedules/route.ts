import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import {
  archiveChatSchedule,
  createChatSchedule,
  readChatSchedules,
  updateChatSchedule,
} from '@/lib/accounting-scoreboard/chat-schedules-server';
import { parseScheduleCreate, parseSchedulePatch } from '@/lib/accounting-scoreboard/chat-schedule-input';
import { isUuid } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET    /api/accounting-scoreboard/chat-schedules                    every post, the recent posts, the team's counts   (Admins, Assistants)
 * POST   /api/accounting-scoreboard/chat-schedules   { definition }   add a scheduled post                               (Admins)
 * PATCH  /api/accounting-scoreboard/chat-schedules   { id, … }        edit one, or { id, paused } to pause / resume      (Admins)
 * DELETE /api/accounting-scoreboard/chat-schedules?id=…               remove one (an archive stamp, final)               (Admins)
 *
 * Setup → Scheduled Posts (chat-schedules-server.ts): the Google Chat posts the cron sends (chat-schedule.ts). Read like
 * the rest of Setup (view_setup), changed like it (edit_setup). Not part of the board read, so these writes are not
 * announced on the live channel. Every change is audited; nothing is deleted.
 */
export async function GET() {
  try {
    const access = await resolveAccess('view_setup');
    if (!access.ok) return failureResponse(access);
    const result = await readChatSchedules(access.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseScheduleCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await createChatSchedule(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ schedule: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseSchedulePatch(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await updateChatSchedule(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ schedule: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const id = req.nextUrl.searchParams.get('id');
    if (!isUuid(id)) return badRequest('id must be a scheduled post id');
    const result = await archiveChatSchedule(access.value, id);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
