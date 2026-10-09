import { crashResponse, failureResponse, okResponse, pingDatabase, resolveAccess } from '@/lib/accounting-scoreboard/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/accounting-scoreboard/ping   the server's round trip to the database for one tiny read   (anyone on the board)
 *
 * The Overview's database signal (db-signal.ts; accounting-scoreboard.md § Database signal). Read-only, one row, raced
 * against 3 s. A slow or failed database is an ANSWER here (200 with ok:false), so the bars can show it; only a
 * refused viewer is an error.
 */
export async function GET() {
  try {
    const access = await resolveAccess();
    if (!access.ok) return failureResponse(access);
    return okResponse(await pingDatabase());
  } catch (e) {
    return crashResponse(e);
  }
}
