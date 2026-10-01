import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  deleteCollection,
  failureResponse,
  logCollection,
  okResponse,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { isUuid, parseCollectionCreate } from '@/lib/accounting-scoreboard/validate';
import { todayEastern } from '@/lib/accounting-scoreboard/week';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/accounting-scoreboard/collections   { rowId, date, businessName, points, amountUsd? }
 * DELETE /api/accounting-scoreboard/collections?id=<uuid>
 *
 * The collections log. Its day totals are the numbers the Dancing Queen Bonus is typed from, so a
 * logged line is never edited (the table's trigger refuses it). A mistake is deleted (a soft
 * delete stamped with who deleted it) and logged again. Only the person who logged a line, or a
 * manager, may delete it.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('member');
    if (!access.ok) return failureResponse(access);
    const parsed = parseCollectionCreate(await readJson(req), todayEastern());
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await logCollection(access.value, parsed.value);
    if (!result.ok) return failureResponse(result);
    return okResponse({ collection: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('member');
    if (!access.ok) return failureResponse(access);
    const id = req.nextUrl.searchParams.get('id');
    if (!isUuid(id)) return badRequest('id must be a collection id');
    const result = await deleteCollection(access.value, id);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
