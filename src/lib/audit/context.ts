import 'server-only';

import type { AuthzOk } from '@/lib/auth/authorize-email';
import type { NewAuditLog } from '@/lib/supabase/audit-log';

/**
 * Where an audit event's actor and IP come from.
 *
 * Two problems this closes:
 *
 *  1. **The IP was re-derived by hand in 30+ routes.** Every one wrote its own
 *     `x-forwarded-for` split, several forgot `x-real-ip`, and many never read
 *     the headers at all — `audit_log.ip_address` is populated on only ~40% of
 *     rows, and it is the ONLY signal separating a staff-entered change from
 *     the employee's own submission (memory/penny-audit-log-visibility.md).
 *  2. **`getSessionActor()` fails OPEN.** It swallows its own errors and returns
 *     `{ user_name: 'anonymous', user_role: 'user' }`, so a route whose
 *     authorization gate had already resolved a real email could still write an
 *     unattributed row. `auditActor()` takes the `AuthzOk` the gate produced, so
 *     the identity is the one that was actually authorized and the type makes an
 *     un-actored call impossible to write.
 *
 * `getSessionActor()` remains for the routes with no `AuthzOk` in hand (public
 * links, employee self-service); prefer this whenever a gate ran.
 */

export type AuditActor = { user_name: string; user_role: string };

/** Best-effort client IP: first hop of `x-forwarded-for`, else `x-real-ip`. */
export function clientIp(request: Request | { headers: Headers }): string | null {
  const headers = request.headers;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

/**
 * The actor for an event, taken from the authorization result.
 *
 * `AuthzOk.sessionEmail` is a non-optional `string`, so once a route has
 * narrowed past `if (!authz.ok) return deniedResponse(authz)` there is no
 * "missing actor" branch to fall through — which is the point.
 */
export function auditActor(authz: AuthzOk): AuditActor {
  return {
    user_name: authz.sessionEmail,
    user_role: authz.roles[0] ?? 'user',
  };
}

/**
 * Actor + IP in one call, for the common route shape.
 *
 * ```ts
 * const authz = await requireFeatureEdit('orphanage', 'budget');
 * if (!authz.ok) return deniedResponse(authz);
 * await insertAuditLog({
 *   ...auditFrom(req, authz),
 *   action: 'orphanage_registry.created',
 *   resource: 'orphanages',
 *   resource_id: row.id,
 *   details: { name: row.name },
 * });
 * ```
 */
export function auditFrom(
  request: Request | { headers: Headers },
  authz: AuthzOk,
): Pick<NewAuditLog, 'user_name' | 'user_role' | 'ip_address'> {
  return { ...auditActor(authz), ip_address: clientIp(request) };
}
