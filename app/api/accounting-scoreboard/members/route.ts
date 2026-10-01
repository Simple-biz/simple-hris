import type { NextRequest } from 'next/server';
import {
  addMember,
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  removeMember,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { normalizeEmail, parseMemberWrite } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/accounting-scoreboard/members           { workEmail }   (managers)
 * DELETE /api/accounting-scoreboard/members?email=…                   (managers)
 *
 * Extra members: people who enter numbers without being a row (e.g. whoever collects the team's
 * numbers). A person row already makes its person a member. The address is any @simple.biz
 * sign-in, so someone not on the roster can be let in. Removal is a stamp, never a delete.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manager');
    if (!access.ok) return failureResponse(access);
    const parsed = parseMemberWrite(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await addMember(access.value, parsed.value.workEmail);
    if (!result.ok) return failureResponse(result);
    return okResponse({ member: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('manager');
    if (!access.ok) return failureResponse(access);
    const email = normalizeEmail(req.nextUrl.searchParams.get('email'));
    if (!email) return badRequest('email must be a work email');
    const result = await removeMember(access.value, email);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
