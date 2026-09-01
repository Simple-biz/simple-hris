/** [TERMINATION-DOCS] TEST SUPPORT — the Supabase factory the stubbed modules get.
 *
 * `./stub-server-modules.ts` redirects the specifier `@/lib/supabase/server` to
 * this file for the duration of a test process, so every module in the graph —
 * the termination modules AND their collaborators (`fetchGmlStatusMap`,
 * `loadOffboardEvidenceByEmail`, `listPaymentDispatches`, `insertAuditLog`) —
 * receives the double from `./fake-supabase.ts` instead of a real client.
 *
 * THE POINT IS SAFETY AS MUCH AS REACHABILITY. `.env.local` holds PRODUCTION
 * service-role credentials (CLAUDE.md). With this redirect installed, the real
 * `createClient` is never called at all, so no code path under test can reach a
 * database even if some future runner starts loading env files.
 *
 * The current double is parked on `globalThis` rather than in a module-level
 * `let`: under `node --import tsx` a `.ts` module can be reached both through
 * the CJS require cache and through the ESM loader, and two live copies of a
 * module-level variable would silently hand the code under test a `null`
 * client. A global has exactly one copy however it is reached.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const KEY = '__terminationDocsTestSupabaseClient__';

function bag(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/**
 * Install the double every stubbed factory will hand out. Pass `null` to make
 * the factories answer "Supabase not configured", which is a real production
 * branch each module carries.
 *
 * The cast is the ONE place a fake crosses into the client's type: the double
 * implements the slice of PostgREST these modules use (see `./fake-supabase.ts`)
 * and nothing more, which is what keeps a test honest — an unemulated call is a
 * runtime failure in the test rather than a green run.
 */
export function setTestSupabaseClient(client: unknown): void {
  bag()[KEY] = (client ?? null) as SupabaseClient | null;
}

function current(): SupabaseClient | null {
  return (bag()[KEY] ?? null) as SupabaseClient | null;
}

export function createSupabaseServiceRoleClient(): SupabaseClient | null {
  return current();
}

export function createSupabaseServerClient(): SupabaseClient | null {
  return current();
}

/** Compile-time pin: if the real factories' signatures change, this file stops
 *  being a valid stand-in and `tsc --noEmit` says so here instead of the tests
 *  quietly exercising a different shape. */
export type RealServiceRoleFactory = typeof import('@/lib/supabase/server').createSupabaseServiceRoleClient;
export type RealServerFactory = typeof import('@/lib/supabase/server').createSupabaseServerClient;
export const SERVICE_ROLE_FACTORY: RealServiceRoleFactory = createSupabaseServiceRoleClient;
export const SERVER_FACTORY: RealServerFactory = createSupabaseServerClient;
