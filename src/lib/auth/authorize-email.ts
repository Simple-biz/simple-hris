import 'server-only';

import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from './auth-options';
import { hasElevatedRole } from './elevated-roles';

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
