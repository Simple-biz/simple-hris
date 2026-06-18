import 'server-only';

import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth-options';
import { hasElevatedRole } from './elevated-roles';
import type { AuthzResult } from './authorize-email';
import {
  fetchFeaturePermissionsForEmail,
  resolveFeatureAccess,
  ROLE_TO_FEATURE_VIEW,
  type FeatureViewKey,
} from '@/lib/rbac/feature-permissions';

/**
 * Server-side per-feature authorization, the mirror of the client tab overlay
 * (`src/lib/rbac/view-tabs.ts`). Two regimes, kept in sync with that file:
 *   - ROLE GRANTS FULL ACCESS (manager, hr, orphanage, ceo, contractor):
 *     holding the dashboard's role confers `edit` on every feature by default;
 *     an explicit `view` row downgrades a single feature to read-only.
 *   - HIDDEN UNTIL GRANTED (accounting): the per-tab grant is the sole gate —
 *     `edit` needs an explicit `edit` grant, `view` is read-only.
 * The `admin` role bypasses both.
 *
 * Returns the same `AuthzResult` shape as `authorize-email.ts`, so routes can
 * reuse `deniedResponse(authz)` on the `!authz.ok` branch.
 */

/** Single-role dashboards where holding the mapped role grants full default
 *  access. Mirrors `ROLE_BASELINE_VIEW_ROLES` in `view-tabs.ts`. */
const ROLE_BASELINE_VIEWS = new Set<FeatureViewKey>(['manager', 'hr', 'orphanage', 'ceo', 'contractor']);

/** True when the caller holds a role that grants full default access to `view`. */
function roleGrantsFullView(view: FeatureViewKey, roles: string[]): boolean {
  if (!ROLE_BASELINE_VIEWS.has(view)) return false;
  return roles.some((r) => ROLE_TO_FEATURE_VIEW[r] === view);
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

async function resolveSession(): Promise<{ email: string; roles: string[] } | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const email = norm(user?.email);
  if (!email) return null;
  return { email, roles: user?.roles ?? [] };
}

function ok(email: string, roles: string[]): AuthzResult {
  return { ok: true, sessionEmail: email, effectiveEmail: email, elevated: hasElevatedRole(roles), roles };
}

/**
 * Require `level` (default `edit`) access to a single (view, feature). Admin
 * bypasses. On role-baseline views the caller's role grants access by default
 * (a `view` row downgrades to read-only); elsewhere a missing grant is denied.
 */
export async function requireFeatureAccess(
  view: FeatureViewKey,
  feature: string,
  level: 'view' | 'edit' = 'edit',
): Promise<AuthzResult> {
  const sess = await resolveSession();
  if (!sess) return { ok: false, status: 401, message: 'Not signed in' };
  if (sess.roles.includes('admin')) return ok(sess.email, sess.roles);

  const perms = await fetchFeaturePermissionsForEmail(sess.email);
  const explicit = resolveFeatureAccess(perms, view, feature);
  // Role-baseline views grant `edit` by default; an explicit `view` row is the
  // only override that downgrades it. Other views stay hidden-until-granted.
  const access = roleGrantsFullView(view, sess.roles)
    ? (explicit === 'view' ? 'view' : 'edit')
    : explicit;
  const allowed = level === 'edit' ? access === 'edit' : access === 'view' || access === 'edit';
  if (!allowed) {
    return { ok: false, status: 403, message: `You don't have ${level} access to this feature.` };
  }
  return ok(sess.email, sess.roles);
}

export function requireFeatureEdit(view: FeatureViewKey, feature: string): Promise<AuthzResult> {
  return requireFeatureAccess(view, feature, 'edit');
}

/**
 * For features that live under several views (e.g. `announcements`,
 * `notifications`, `s_wall`): allow when ANY of the caller's role-mapped views
 * grants the required level on that feature. Edit anywhere wins. Admin bypasses.
 */
export async function requireFeatureEditAnyView(feature: string): Promise<AuthzResult> {
  const sess = await resolveSession();
  if (!sess) return { ok: false, status: 401, message: 'Not signed in' };
  if (sess.roles.includes('admin')) return ok(sess.email, sess.roles);

  const perms = await fetchFeaturePermissionsForEmail(sess.email);
  for (const role of sess.roles) {
    const view = ROLE_TO_FEATURE_VIEW[role] as FeatureViewKey | undefined;
    if (!view) continue;
    const explicit = resolveFeatureAccess(perms, view, feature);
    if (roleGrantsFullView(view, sess.roles)) {
      // Baseline edit unless this feature was explicitly downgraded to view.
      if (explicit !== 'view') return ok(sess.email, sess.roles);
    } else if (explicit === 'edit') {
      return ok(sess.email, sess.roles);
    }
  }
  return { ok: false, status: 403, message: `You don't have edit access to this feature.` };
}
