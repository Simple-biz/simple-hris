import { after } from 'next/server';
import {
  badRequest,
  crashResponse,
  createRow,
  failureResponse,
  okResponse,
  patchRow,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { announceScoreboardChange } from '@/lib/accounting-scoreboard/live-server';
import { parseRowCreate, parseRowPatch } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST  /api/accounting-scoreboard/rows  { sectionKey, customSectionId?, label, workEmail? }   (Admins)
 * PATCH /api/accounting-scoreboard/rows  { id, label?, sortOrder?, archived?: true, bucketDay?, dueSoon? }   (Admins)
 *
 * A row with a work email IS that HRIS person and makes them a member, so the email must be on the
 * active roster. Anyone else (a queue, an inbox, someone not on the roster) is a named row.
 * Rows are archived, never deleted or un-archived: a logged collection keeps its rep.
 * A custom section's row is sectionKey 'custom' plus its customSectionId (a live custom section).
 * bucketDay ('mon'…'fri' | null) marks a weekday Collections bucket: Buckets rows only. dueSoon marks
 * the Open Disputes line that counts the disputes due in 7 days: Chargebacks rows only.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseRowCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await createRow(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('setup', req));
    return okResponse({ row: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseRowPatch(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await patchRow(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('setup', req));
    return okResponse({ row: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
