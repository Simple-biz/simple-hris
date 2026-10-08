import {
  badRequest,
  crashResponse,
  failureResponse,
  okResponse,
  readJson,
  resolveAccess,
  setVerified,
} from '@/lib/accounting-scoreboard/server';
import { parseVerifyWrite } from '@/lib/accounting-scoreboard/validate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/accounting-scoreboard/collections/verify   { collectionId, verified: boolean }
 *
 * Payment Verified on one logged collection (Carla, 2026-10-02). Any member may tick it; the tick
 * stores the SESSION email and the name the board shows for them. Only whoever ticked it, or a
 * manager, may uncheck it. The tick lives in accounting_scoreboard_collection_verifications: the
 * collections log itself stays append-only and is never updated here.
 */
export async function POST(req: Request) {
  try {
    const access = await resolveAccess('log_lines');
    if (!access.ok) return failureResponse(access);
    const parsed = parseVerifyWrite(await readJson(req));
    if (!parsed.ok) return badRequest(parsed.error);
    const result = await setVerified(access.value, parsed.value.collectionId, parsed.value.verified);
    if (!result.ok) return failureResponse(result);
    return okResponse({ verified: result.value });
  } catch (e) {
    return crashResponse(e);
  }
}
