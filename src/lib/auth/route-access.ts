/**
 * Centralized, side-effect-free route authorization for Simple HRIS.
 *
 * This is the SINGLE SOURCE OF TRUTH for "which role may open which page route"
 * and "which API namespaces are role-gated at the edge". The edge proxy
 * (`proxy.ts`) performs all the I/O (decoding the JWT, force-logout lookups,
 * rate limiting) and then delegates the actual access *decision* to
 * {@link evaluateRouteAccess} here. Server components/layouts can reuse
 * {@link requiredRolesFor} for defense-in-depth guards.
 *
 * Pure module on purpose — it imports nothing from `next`, Node, or `server-only`
 * so it runs in the edge runtime AND can be unit-tested directly with the Node
 * test runner (see `src/lib/auth/route-access.test.ts`).
 *
 * Role names mirror `employee_roles.role` / `src/lib/rbac/views.ts`.
 */

/**
 * Page routes that require a specific role to even load.
 *
 * Authentication (a valid @simple.biz JWT) is NOT enough for these — a signed-in
 * employee with no roles, or the wrong role, must be turned away. `admin` is
 * accepted on every privileged route on purpose ("keys to the castle", mirroring
 * `viewsForRoles()` in `src/lib/rbac/views.ts`).
 *
 * TO ADD A NEW PRIVILEGED DASHBOARD: add its route prefix + the role(s) allowed
 * to open it here. Do not gate the route from inside the (client-rendered) page
 * component — that is not a real server-side protection.
 *
 * Routes deliberately ABSENT (open to any authenticated user): `/`,
 * `/auth-callback` (dispatchers), `/employee` and `/contractor` (personal portals
 * scoped to the session owner server-side), `/login`, `/onboarding/*` (public).
 */
export const ROUTE_REQUIRED_ROLES: ReadonlyArray<{ prefix: string; roles: readonly string[] }> = [
  { prefix: '/admin',         roles: ['admin'] },
  { prefix: '/ceo',           roles: ['ceo', 'admin'] },
  { prefix: '/accounting',    roles: ['accounting', 'admin'] },
  { prefix: '/payroll-clerk', roles: ['accounting', 'admin'] },
  { prefix: '/hr',            roles: ['hr_coordinator', 'admin'] },
  { prefix: '/orphanage',     roles: ['orphanage_manager', 'admin'] },
  { prefix: '/manager',       roles: ['manager', 'admin'] },
];

/**
 * The role(s) allowed to open `pathname`, or `null` when the route is not
 * role-gated. Matches the exact route AND any sub-route (`/admin`, `/admin/`,
 * `/admin/users`, `/admin/settings/...` all resolve to the `/admin` entry).
 */
export function requiredRolesFor(pathname: string): readonly string[] | null {
  const match = ROUTE_REQUIRED_ROLES.find(
    (r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`),
  );
  return match ? match.roles : null;
}

/** True if `roles` satisfies the requirement for `pathname` (always true for open routes). */
export function isRouteAuthorized(pathname: string, roles: readonly string[]): boolean {
  const required = requiredRolesFor(pathname);
  if (!required) return true;
  return required.some((r) => roles.includes(r));
}

/** API namespaces that are role-gated at the edge as defense-in-depth. */
export function apiNamespaceRequiresAdmin(pathname: string): boolean {
  return pathname.startsWith('/api/admin/');
}

export type RouteDecision =
  /** Let the request through. */
  | { action: 'allow' }
  /** Authenticated but lacks the role for an admin API → JSON 403. */
  | { action: 'forbid' }
  /** Authenticated but lacks access to a page route → 302 to a safe page. */
  | { action: 'redirect'; pathname: string; clearSearch?: boolean; setEmail?: string };

/**
 * Decide access for an ALREADY-AUTHENTICATED request. The proxy handles the
 * unauthenticated case (redirect to /login) and force-logout *before* calling
 * this, so callers here are guaranteed to hold a live session.
 *
 * Order mirrors `proxy.ts`:
 *   1. Admin API namespaces are admin-only (403 otherwise).
 *   2. Contractor-only accounts are bounced off /employee to /contractor.
 *   3. Privileged page routes require a matching role (else redirect home).
 *   4. `?email=` is pinned to the session owner on personal routes / for
 *      non-elevated users (prevents viewing another employee's dashboard).
 */
export function evaluateRouteAccess(input: {
  pathname: string;
  roles: readonly string[];
  sessionEmail: string;
  elevated: boolean;
  requestedEmail: string | null;
}): RouteDecision {
  const { pathname, roles, sessionEmail, elevated, requestedEmail } = input;

  // (1) Admin API namespaces — defense-in-depth (handlers also enforce this).
  if (apiNamespaceRequiresAdmin(pathname)) {
    return roles.includes('admin') ? { action: 'allow' } : { action: 'forbid' };
  }

  // Remaining checks are page-route only. /api/* enforces its own authz.
  if (pathname.startsWith('/api/')) return { action: 'allow' };

  const isContractorOnly = roles.length > 0 && roles.every((r) => r === 'contractor');
  const homePath = isContractorOnly ? '/contractor' : '/employee';

  // (2) Contractor-only → /contractor when they hit the employee dashboard.
  if (isContractorOnly && (pathname === '/employee' || pathname.startsWith('/employee/'))) {
    return { action: 'redirect', pathname: '/contractor' };
  }

  // (3) Role-gated dashboards. None of the required roles held → go home.
  if (!isRouteAuthorized(pathname, roles)) {
    return { action: 'redirect', pathname: homePath, clearSearch: true };
  }

  // (4) `?email=` ownership pinning.
  const requested = (requestedEmail ?? '').trim().toLowerCase();
  const PERSONAL_ROUTES = ['/manager', '/employee', '/ceo'];
  const isPersonalRoute = PERSONAL_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(`${r}/`),
  );
  if (sessionEmail && requested && requested !== sessionEmail && (!elevated || isPersonalRoute)) {
    return { action: 'redirect', pathname, setEmail: sessionEmail };
  }

  return { action: 'allow' };
}
