import type { NextRequest } from 'next/server';
import {
  archiveKey,
  badRequest,
  crashResponse,
  createKey,
  failureResponse,
  okResponse,
  readJson,
  readKeys,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseKeyCreate } from '@/lib/accounting-scoreboard/keys';
import { isUuid } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET    /api/accounting-scoreboard/keys                 every key, every seat, the board's people   (Admins)
 * POST   /api/accounting-scoreboard/keys    { label }    add a key (a paid platform)                (Admins)
 * DELETE /api/accounting-scoreboard/keys?id=…            archive a key nobody holds a seat on       (Admins)
 *
 * Keys (Open item 424; keys.ts): Carla's "keys" to QBO, Stripe and the rest, so offboarding someone shows every seat
 * still to remove. Admin only, reading too: "It's not for the team." Not part of the board read, so these writes are
 * not announced on the live channel. A key is archived, never deleted, and only once nobody holds a seat on it.
 */
export async function GET() {
  try {
    const access = await resolveAccess('manage_keys');
    if (!access.ok) return failureResponse(access);
    const result = await readKeys(access.value);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manage_keys');
    if (!access.ok) return failureResponse(access);
    const parsed = parseKeyCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await createKey(access.value, parsed.value.label);
    if (!result.ok) return failureResponse(result);
    return okResponse({ key: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('manage_keys');
    if (!access.ok) return failureResponse(access);
    const id = req.nextUrl.searchParams.get('id');
    if (!isUuid(id)) return badRequest('id must be a key id');
    const result = await archiveKey(access.value, id);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
