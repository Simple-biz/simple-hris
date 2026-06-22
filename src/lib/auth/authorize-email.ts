import 'server-only';

import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from './auth-options';
import { hasElevatedRole, hasRateVisibility } from './elevated-roles';

/**
 * Authorizes the current session to act on `requestedEmail`.
 *
 * Rules:
 *  - No session                              → 401
 *  - Requested email absent or == session    → allow (effective = session email)
 *  - Session user has an elevated role       → allow (effective = requested)
 *  - Otherwise                               → 403
 *
 * Elevated roles come from the NextAuth JWT (stashed in auth-options.ts at sign-in), so this
 * is a zero-DB-hit check on the hot path.
 */

export type AuthzOk = {
  ok: true;
  sessionEmail: string;
  effectiveEmail: string;
  elevated: boolean;
  roles: string[];
};

export type AuthzDenied = {
  ok: false;
  status: 401 | 403;
  message: string;
};

export type AuthzResult = AuthzOk | AuthzDenied;

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

export async function authorizeEmailAccess(
  requestedEmail: string | null | undefined,
): Promise<AuthzResult> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | {
        email?: string | null;
        roles?: string[];
        elevated?: boolean;
      }
    | undefined;
  const sessionEmail = norm(user?.email);
  if (!sessionEmail) {
    return { ok: false, status: 401, message: 'Not signed in' };
  }

  const roles = user?.roles ?? [];
  const elevated = user?.elevated ?? hasElevatedRole(roles);
  const target = norm(requestedEmail);

  if (!target || target === sessionEmail) {
    return {
      ok: true,
      sessionEmail,
      effectiveEmail: sessionEmail,
      elevated,
      roles,
    };
  }

  if (elevated) {
    return {
      ok: true,
      sessionEmail,
      effectiveEmail: target,
      elevated: true,
      roles,
    };
  }

  return { ok: false, status: 403, message: 'Forbidden' };
}

/**
 * Require that the current session holds an elevated role. Used by endpoints that list data
 * across all employees (no per-email scoping).
 */
export async function requireElevatedSession(): Promise<AuthzResult> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { email?: string | null; roles?: string[]; elevated?: boolean }
    | undefined;
  const sessionEmail = norm(user?.email);
  if (!sessionEmail) return { ok: false, status: 401, message: 'Not signed in' };
  const roles = user?.roles ?? [];
  const elevated = user?.elevated ?? hasElevatedRole(roles);
  if (!elevated) return { ok: false, status: 403, message: 'Forbidden' };
  return {
    ok: true,
    sessionEmail,
    effectiveEmail: sessionEmail,
    elevated: true,
    roles,
  };
}

/**
 * Resolve the current session's roles and whether it may see RAW pay rates,
 * WITHOUT forcing a 401/403. For endpoints that return data to everyone but must
 * project away the numeric rate columns for callers without rate visibility
 * (HR, Managers, employees viewing a roster). Rate-bearing endpoints whose ENTIRE
 * purpose is shipping figures should use {@link requireRateVisibilitySession}
 * instead.
 */
export async function getSessionRateVisibility(): Promise<{
  sessionEmail: string | null;
  roles: string[];
  rateVisible: boolean;
}> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { email?: string | null; roles?: string[] }
    | undefined;
  const sessionEmail = norm(user?.email) || null;
  const roles = user?.roles ?? [];
  return { sessionEmail, roles, rateVisible: hasRateVisibility(roles) };
}

/**
 * Require that the current session has FULL rate visibility — i.e. holds one of
 * {@link RATE_VISIBLE_ROLES} (`admin`, `accounting`, `ceo`). Stricter than
 * {@link requireElevatedSession}, which also admits `hr_coordinator`. Use for
 * endpoints whose response is raw pay-rate data (pay structures, rate history)
 * so that HR/Manager clients are denied outright.
 */
export async function requireRateVisibilitySession(): Promise<AuthzResult> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { email?: string | null; roles?: string[] }
    | undefined;
  const sessionEmail = norm(user?.email);
  if (!sessionEmail) return { ok: false, status: 401, message: 'Not signed in' };
  const roles = user?.roles ?? [];
  if (!hasRateVisibility(roles)) return { ok: false, status: 403, message: 'Forbidden' };
  return {
    ok: true,
    sessionEmail,
    effectiveEmail: sessionEmail,
    elevated: true,
    roles,
  };
}

/**
 * Require that the current session holds the `admin` role specifically — a
 * stricter gate than {@link requireElevatedSession}, which also admits
 * `accounting` and `hr_coordinator` (see `elevated-roles.ts`). Use for actions
 * reserved for true administrators (e.g. managing API credentials).
 */
export async function requireAdminSession(): Promise<AuthzResult> {
  const authz = await requireElevatedSession();
  if (!authz.ok) return authz;
  if (!authz.roles.includes('admin')) {
    return { ok: false, status: 403, message: 'Forbidden — admin only' };
  }
  return authz;
}

/**
 * Convenience: turn a denied AuthzResult into a NextResponse error.
 * Accepts the full AuthzResult so callers can pass it directly after a `!result.ok` check
 * without needing extra narrowing ceremony (tsconfig has strict: false).
 */
export function deniedResponse(result: AuthzResult): NextResponse {
  if (result.ok) {
    // Defensive — callers should only invoke this on the denied branch.
    return NextResponse.json({ error: 'Internal authorization error' }, { status: 500 });
  }
  const denied = result as AuthzDenied;
  return NextResponse.json({ error: denied.message }, { status: denied.status });
}
