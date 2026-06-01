import 'server-only';

import { requireElevatedSession } from './authorize-email';

/**
 * Cron / sheet-sync endpoints are reachable two legitimate ways:
 *   1. Vercel scheduled cron (or external automation) -> Authorization: Bearer CRON_SECRET
 *   2. Manual trigger from the admin or payroll UI -> an elevated NextAuth session
 *
 * The Bearer check lives inline in each route (so a valid secret short-circuits
 * without a DB/session round-trip). This helper supplies the second path: it
 * returns true only when the caller holds an elevated role.
 *
 * Combined with a fail-CLOSED Bearer check (missing CRON_SECRET no longer means
 * "open"), an unauthenticated caller with no secret and no session is denied.
 */
export async function cronSessionElevated(): Promise<boolean> {
  const authz = await requireElevatedSession();
  return authz.ok;
}
