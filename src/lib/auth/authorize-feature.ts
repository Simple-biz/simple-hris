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
 * (`src/lib/rbac/view-tabs.ts`).
 *
 * Model (attribute-based, default-deny): the per-tab grant is the sole gate.
 * To mutate a feature the caller needs an explicit `edit` grant on it; `view`
 * is read-only; a missing grant is denied. Assigning a dashboard role
 * auto-provisions its tabs to `edit` (employee-roles grant route), so granting
 * the dashboard is what confers access. The `admin` role bypasses.
 *
 * Returns the same `AuthzResult` shape as `authorize-email.ts`, so routes can
 * reuse `deniedResponse(authz)` on the `!authz.ok` branch.
 */

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
 * bypasses; a missing grant is denied (default-deny). `view` grants read-only,
 * `edit` grants mutation.
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
  const access = resolveFeatureAccess(perms, view, feature);
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
    if (resolveFeatureAccess(perms, view, feature) === 'edit') return ok(sess.email, sess.roles);
  }
  return { ok: false, status: 403, message: `You don't have edit access to this feature.` };
}
