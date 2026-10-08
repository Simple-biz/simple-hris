import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  patchSection,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseSectionPatch } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/accounting-scoreboard/sections  { sectionKey, enabled?, goal?, showOnOverview? }   (Admins)
 *
 * Carla's switch: turn a section off (it disappears from the board, and its rows and numbers are
 * kept), or override its goal (`goal: null` goes back to the default, or clears a goal set on a section
 * with none). Since 2026-10-07 every built-in section can take a goal. `showOnOverview: false` (Carla,
 * 2026-10-07) takes its card off the Overview and out of the Team Score; its tab stays.
 */
export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseSectionPatch(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await patchSection(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ setting: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
