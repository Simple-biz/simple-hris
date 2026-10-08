import {
  addProblemType,
  archiveProblemType,
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
} from '@/lib/accounting-scoreboard/server';
import { parseProblemTypeArchive, parseProblemTypeCreate } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST  /api/accounting-scoreboard/problem-types   { label }                 (Admins)
 * PATCH /api/accounting-scoreboard/problem-types   { id, archived: true }    (Admins)
 *
 * The Payroll Problems type list (Carla, 2026-10-02: "Admins should be able to add new types"; the
 * board's admins are its managers, Accounting and Admin). A type is archived, never deleted, so a
 * problem already logged keeps its type. The list is read with the board (GET).
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseProblemTypeCreate(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await addProblemType(access.value, parsed.value.label);
    if (!result.ok) return failureResponse(result);
    return okResponse({ type: result.value }, 201);
  } catch (e) {
    return crashResponse(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await resolveAccess('edit_setup');
    if (!access.ok) return failureResponse(access);
    const parsed = parseProblemTypeArchive(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await archiveProblemType(access.value, parsed.value.id);
    if (!result.ok) return failureResponse(result);
    return okResponse(result.value);
  } catch (e) {
    return crashResponse(e);
  }
}
