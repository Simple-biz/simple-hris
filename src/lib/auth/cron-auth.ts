import 'server-only';

import { requireElevatedSession, type AuthzOk } from './authorize-email';

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
  return (await cronSessionAuthz()) !== null;
}

/**
 * The elevated session behind a MANUAL trigger, or null. Routes that audit use
 * this instead of {@link cronSessionElevated} so the row names the person who
 * clicked Sync — the sheet syncs used to record every manual run as
 * "GSheets Sync" / "System" (2026-09-28 inventory, session log item 240).
 */
export async function cronSessionAuthz(): Promise<AuthzOk | null> {
  const authz = await requireElevatedSession();
  return authz.ok ? authz : null;
}
