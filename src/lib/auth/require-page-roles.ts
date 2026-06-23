import 'server-only';

import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth-options';

/**
 * Server-side page authorization guard — defense in depth for the edge proxy.
 *
 * Call this at the top of a privileged route's `layout.tsx`/`page.tsx` server
 * component. If the current session holds NONE of `allowed`, the user is
 * redirected to `fallback` BEFORE any child renders or fetches — so a privileged
 * dashboard shell (and the data-fetching effects it runs on mount) can never
 * render for an unauthorized user, even if the proxy `matcher` is later changed.
 *
 * The edge proxy (`proxy.ts` → `evaluateRouteAccess`) is the primary gate and
 * already bounces unauthenticated users to /login and non-matching roles to their
 * own portal; this is the belt-and-suspenders second layer.
 *
 * Roles come from the NextAuth session (stamped from the JWT in
 * `auth-options.ts`), so this is a zero-extra-DB-hit check.
 *
 * When `fallback` is omitted the redirect target mirrors the edge proxy's
 * `homePath` logic (`evaluateRouteAccess`): contractor-only sessions go to
 * `/contractor`, everyone else to `/employee` — so both layers send an
 * unauthorized user to the same safe page.
 *
 * @returns the session's active roles when authorized (never returns otherwise —
 *          `redirect()` throws).
 */
export async function requirePageRoles(
  allowed: readonly string[],
  fallback?: string,
): Promise<string[]> {
  const session = await getServerSession(authOptions);
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles) ?? [];
  if (!allowed.some((r) => roles.includes(r))) {
    const isContractorOnly = roles.length > 0 && roles.every((r) => r === 'contractor');
    redirect(fallback ?? (isContractorOnly ? '/contractor' : '/employee'));
  }
  return roles;
}
