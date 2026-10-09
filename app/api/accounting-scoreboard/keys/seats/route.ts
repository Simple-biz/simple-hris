import type { NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  failureResponse,
  giveKeySeat,
  okResponse,
  readJson,
  removeKeySeat,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseKeySeatWrite } from '@/lib/accounting-scoreboard/keys';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/accounting-scoreboard/keys/seats   { keyId, email }     give someone on the board a seat on a key (Admins)
 * DELETE /api/accounting-scoreboard/keys/seats?keyId=…&email=…        the seat was removed on the platform    (Admins)
 *
 * A removal is a stamp (who, when) and the seat stays as history; giving it again is a new seat (keys.ts). One live
 * seat per key per person: a second give is 409. Only someone on the board can be given a seat (422 otherwise).
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manage_keys');
    if (!access.ok) return failureResponse(access);
    const parsed = parseKeySeatWrite(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await giveKeySeat(access.value, parsed.value.keyId, parsed.value.email);
    if (!result.ok) return failureResponse(result);
    return okResponse({ seat: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('manage_keys');
    if (!access.ok) return failureResponse(access);
    const q = req.nextUrl.searchParams;
    const parsed = parseKeySeatWrite({ keyId: q.get('keyId'), email: q.get('email') });
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await removeKeySeat(access.value, parsed.value.keyId, parsed.value.email);
    if (!result.ok) return failureResponse(result);
    return okResponse({ seat: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
