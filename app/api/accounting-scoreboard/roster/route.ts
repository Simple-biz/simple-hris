import {
  crashResponse,
  failureResponse,
  okResponse,
  readRoster,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/accounting-scoreboard/roster   (Admins)
 *
 * The Setup people picker: name, department and work email of everyone on the active roster
 * (`active_employees`, paged). Nothing else is selected: no contact, address, pay or bank column.
 * The department is the picker's filter, because a section's people come from several departments.
 */
export async function GET() {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const result = await readRoster();
    if (!result.ok) return failureResponse(result);
    return okResponse({ people: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
