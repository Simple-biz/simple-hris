import { after, type NextRequest } from 'next/server';
import {
  badRequest,
  crashResponse,
  failureResponse,
  grantRole,
  listRoleGrants,
  okResponse,
  readJson,
  resolveAccess,
  revokeRole,
} from '@/lib/accounting-scoreboard/server';
import { announceScoreboardChange } from '@/lib/accounting-scoreboard/live-server';
import { normalizeEmail, parseRoleWrite } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET    /api/accounting-scoreboard/roles                              the live Admin / Assistant grants   (Admins)
 * POST   /api/accounting-scoreboard/roles        { email, role }       grant Admin or Assistant             (Admins)
 * DELETE /api/accounting-scoreboard/roles?email=…                      revoke                               (Admins)
 *
 * Board-local roles (Open item 393; roles.ts). A Team member is the member list, not a grant. A role change is
 * a revoke and a new grant: a grant on someone who holds the other role is refused (409). The last live Admin
 * grant cannot be revoked (409 here, and the table's trigger under a lock); an HRIS admin is the break glass.
 */
export async function GET() {
  try {
    const access = await resolveAccess('manage_roles');
    if (!access.ok) return failureResponse(access);
    const result = await listRoleGrants();
    if (!result.ok) return failureResponse(result);
    return okResponse({ grants: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const access = await resolveAccess('manage_roles');
    if (!access.ok) return failureResponse(access);
    const parsed = parseRoleWrite(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await grantRole(access.value, parsed.value.email, parsed.value.role);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('roles', req));
    return okResponse({ grant: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const access = await resolveAccess('manage_roles');
    if (!access.ok) return failureResponse(access);
    const email = normalizeEmail(req.nextUrl.searchParams.get('email'));
    if (!email) return badRequest('email must be a work email');
    const result = await revokeRole(access.value, email);
    if (!result.ok) return failureResponse(result);
    after(announceScoreboardChange('roles', req));
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
