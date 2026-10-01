/**
 * The Accounting Scoreboard's own hostname (accounting-bonus.vercel.app): which paths exist there.
 * `proxy.ts` calls this BEFORE its PUBLIC_PATHS allowlist, the same position as the bank and gift
 * host blocks (proxy.ts:178-231), and for the same reason: the rest of HRIS must never surface on
 * a domain handed to a team.
 * Governing doc: docs/features/accounting-scoreboard.md § Its own domain.
 *
 * Unlike the bank and gift hosts, this host is SIGNED-IN. Passing a path here does not open it.
 * It only means "carry on through the normal pipeline", so the session gate still runs for the
 * board and its API, and the page and routes still check board membership themselves.
 *
 * On the scoreboard host:
 *   - the board page, its API, /login, /auth-callback (the sign-in popup closes there) and
 *     /api/auth/* (NextAuth) → pass
 *   - any other /api/*  → 403 JSON. 403, not 404: HRIS's global pollers (the dispatch paid toast)
 *     stop on 401/403 and would retry a 404 for as long as the tab stays open.
 *   - any other page    → redirect to the board, so the bare host lands somewhere useful
 *
 * Inert until ACCOUNTING_SCOREBOARD_HOST is set, and only when the request's host matches it.
 * Every other host is untouched.
 *
 * Sign-in works on this host with no auth change: on Vercel, NextAuth v4 takes its origin from the
 * request's x-forwarded-host (node_modules/next-auth/utils/detect-origin.js), so the Google callback
 * and the session cookie are on this host. The one outside step is that host's callback URI on the
 * Google OAuth client (Deploy notes).
 *
 * Pure, so route-access-style tests can drive it.
 */

export const SCOREBOARD_PAGE = '/accounting-scoreboard';
export const SCOREBOARD_API_PREFIX = '/api/accounting-scoreboard';

export type ScoreboardHostDecision =
  /** Not this host, or a path that exists here: continue with the normal pipeline. */
  | { action: 'pass' }
  /** A page that does not exist on this host: send it to the board. */
  | { action: 'redirect'; pathname: string }
  /** An API that does not exist on this host. */
  | { action: 'forbid_api' };

export function normalizeHost(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/:\d+$/, '');
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function decideScoreboardHost(input: {
  /** The request's Host header. */
  host: string | null | undefined;
  /** ACCOUNTING_SCOREBOARD_HOST. */
  configuredHost: string | null | undefined;
  pathname: string;
}): ScoreboardHostDecision {
  const configured = normalizeHost(input.configuredHost);
  if (!configured || normalizeHost(input.host) !== configured) return { action: 'pass' };

  const { pathname } = input;
  if (isUnder(pathname, SCOREBOARD_PAGE)) return { action: 'pass' };
  if (isUnder(pathname, SCOREBOARD_API_PREFIX)) return { action: 'pass' };
  if (pathname === '/login' || pathname === '/auth-callback') return { action: 'pass' };
  if (pathname.startsWith('/api/auth/')) return { action: 'pass' };
  if (pathname === '/api' || pathname.startsWith('/api/')) return { action: 'forbid_api' };
  return { action: 'redirect', pathname: SCOREBOARD_PAGE };
}
