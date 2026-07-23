/**
 * Auth proxy (formerly middleware.ts; renamed for Next.js 16) — gates the app behind Google SSO.
 *
 * Runs on every non-static, non-auth route. If there's no valid NextAuth JWT the user is sent
 * to /login with the original URL preserved in ?callbackUrl so we can bounce them back after
 * sign-in.
 *
 * Public paths (always let through):
 *  - /login                       — the sign-in page itself
 *  - /api/auth/*                  — NextAuth's own routes
 *  - /icon.svg, /favicon2.png,
 *    /simple-logo.png             — static assets referenced from <head> / login page
 *
 * The `matcher` below excludes Next.js internal paths (_next, static) and common public file
 * extensions so we don't pay the auth check on every image/font request.
 *
 * Rate limiting for public onboarding endpoints:
 *  - GET  /api/onboarding/*  — 30 req / IP / minute (form loads + prefills)
 *  - POST /api/onboarding/*  — 5  req / IP / minute (submissions + file uploads)
 */

import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import { evaluateRouteAccess } from '@/lib/auth/route-access';

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter for public onboarding routes.
// Keyed by "<method>:<ip>". Runs in the same Edge isolate so the map is shared
// within a region but reset on cold start — acceptable for abuse prevention.
// ---------------------------------------------------------------------------

type RateEntry = { count: number; resetAt: number };
const _rl = new Map<string, RateEntry>();

const ONBOARDING_LIMITS: Record<string, { max: number; windowMs: number }> = {
  GET:  { max: 30, windowMs: 60_000 },
  POST: { max: 5,  windowMs: 60_000 },
};

// Public bank-update flow (request-otp -> verify-otp -> save). The happy path is
// 3 POSTs in quick succession (+ the odd code retry), so POST is a touch higher
// than onboarding while still capping brute-force / email-bomb attempts.
const BANK_UPDATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  GET:  { max: 30, windowMs: 60_000 },
  POST: { max: 10, windowMs: 60_000 },
};

function rateLimited(
  req: NextRequest,
  limits: Record<string, { max: number; windowMs: number }>,
  bucket: string,
): boolean {
  const limit = limits[req.method];
  if (!limit) return false;

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  // Bucket prefix keeps onboarding and bank-update counts from colliding.
  const key = `${bucket}:${req.method}:${ip}`;
  const now = Date.now();
  const entry = _rl.get(key);

  if (!entry || now > entry.resetAt) {
    _rl.set(key, { count: 1, resetAt: now + limit.windowMs });
    return false;
  }
  if (entry.count >= limit.max) return true;
  entry.count++;
  return false;
}

function onboardingRateLimited(req: NextRequest): boolean {
  return rateLimited(req, ONBOARDING_LIMITS, 'onb');
}

function bankUpdateRateLimited(req: NextRequest): boolean {
  return rateLimited(req, BANK_UPDATE_LIMITS, 'bank');
}

// ---------------------------------------------------------------------------
// Force-logout enforcement (edge-side).
//
// `getToken()` only DECODES the cookie — it never runs the NextAuth `jwt`
// callback, so the callback's force-logout check (which neuters a revoked
// token) doesn't fire until the client next refreshes its session. That left a
// window where an admin's "Reset session" had no effect on the target's
// in-flight cookie. We close it here: the middleware reads the same
// `auth.force_logout_map` and rejects any token issued before the user's
// cutoff on their VERY NEXT request — then clears the session cookie so they're
// fully signed out and must re-authenticate (re-minting a JWT with the new
// roles/permissions).
//
// Cached per edge isolate for 30s (matching force-logout.ts) so we hit Supabase
// at most ~twice a minute per region, not on every request.
// ---------------------------------------------------------------------------
let _flCache: { ts: number; map: Record<string, string> } | null = null;
const FL_TTL_MS = 30_000;

async function getForceLogoutMap(): Promise<Record<string, string>> {
  if (_flCache && Date.now() - _flCache.ts < FL_TTL_MS) return _flCache.map;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let map: Record<string, string> = {};
  if (url && key) {
    try {
      const res = await fetch(
        `${url}/rest/v1/app_settings?select=value&key=eq.auth.force_logout_map`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store' },
      );
      if (res.ok) {
        const rows = (await res.json()) as { value?: string | null }[];
        const raw = rows?.[0]?.value;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') map = parsed as Record<string, string>;
        }
      }
    } catch {
      // Never fail a request on a lookup hiccup — reuse the last good map.
      return _flCache?.map ?? {};
    }
  }
  _flCache = { ts: Date.now(), map };
  return map;
}

/** True when this token was issued before an admin force-logged-out the email. */
async function isForceLoggedOut(emailLower: string, issuedAtSec: number): Promise<boolean> {
  if (!emailLower || !issuedAtSec) return false;
  const map = await getForceLogoutMap();
  const iso = map[emailLower];
  if (!iso) return false;
  const cutoffMs = Date.parse(iso);
  if (!Number.isFinite(cutoffMs)) return false;
  return Math.floor(cutoffMs / 1000) >= issuedAtSec;
}

/** NextAuth session-cookie names (plain + Secure prefix + chunked variants). */
const SESSION_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
  'next-auth.session-token.0',
  'next-auth.session-token.1',
  '__Secure-next-auth.session-token.0',
  '__Secure-next-auth.session-token.1',
];

const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/update-bank-info', // public OTP-gated bank/payout self-update page
]);

const PUBLIC_PREFIXES = [
  '/api/auth/', // NextAuth handler
  // /onboarding/ and /api/onboarding/ are handled above with rate limiting.
];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // -------------------------------------------------------------------------
  // Public bank-update host isolation. MUST run before the PUBLIC_PATHS
  // allowlist below — otherwise /login (a public path) would be served on this
  // host and leak the HRIS sign-in page.
  //
  // When the request arrives on the dedicated public hostname (set via the
  // BANK_UPDATE_PUBLIC_HOST env var, e.g. "secure-bank-update.vercel.app"), we
  // expose ONLY the OTP bank-update flow: the /update-bank-info page and its
  // /api/bank-update/* endpoints. EVERYTHING else is turned away so the full
  // HRIS (admin, login, dashboards) never surfaces on this domain — non-bank
  // API paths 404; any other page path redirects to the form so even the bare
  // host lands somewhere useful. Static assets bypass this via the matcher.
  //
  // Inert until the env var is set, and only fires when the host matches — so
  // the normal HRIS domain is completely unaffected.
  // -------------------------------------------------------------------------
  const bankHost = process.env.BANK_UPDATE_PUBLIC_HOST?.trim().toLowerCase();
  if (bankHost && req.headers.get('host')?.toLowerCase() === bankHost) {
    if (pathname === '/update-bank-info') return NextResponse.next();
    if (!pathname.startsWith('/api/bank-update/')) {
      if (pathname.startsWith('/api/')) {
        return new NextResponse(null, { status: 404 });
      }
      const url = req.nextUrl.clone();
      url.pathname = '/update-bank-info';
      url.search = '';
      return NextResponse.redirect(url);
    }
    // /api/bank-update/* — fall through to the existing rate-limit handling below.
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // Vercel-scheduled (or external) cron callers carry no NextAuth cookie. Let
  // them past the SSO gate only when they present the shared CRON_SECRET; the
  // route handler re-verifies it. No secret set -> no bypass, so a tokenless
  // cron request still gets redirected to /login (fail-closed).
  if (pathname.startsWith('/api/cron/')) {
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (cronSecret && (req.headers.get('authorization') ?? '') === `Bearer ${cronSecret}`) {
      return NextResponse.next();
    }
  }

  // Rate-limit the public onboarding API before letting it through.
  if (pathname.startsWith('/api/onboarding/') || pathname.startsWith('/onboarding/')) {
    if (pathname.startsWith('/api/onboarding/') && onboardingRateLimited(req)) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        { status: 429 },
      );
    }
    return NextResponse.next();
  }

  // Public bank-update API (OTP request/verify/save). The page itself is in
  // PUBLIC_PATHS above; here we rate-limit its endpoints and skip the JWT gate.
  if (pathname.startsWith('/api/bank-update/')) {
    if (bankUpdateRateLimited(req)) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment and try again.' },
        { status: 429 },
      );
    }
    return NextResponse.next();
  }

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // API/XHR callers (fetch) must NEVER be 307'd to the HTML /login page: the
  // browser transparently follows the redirect, so the caller receives the
  // login page's "<!DOCTYPE html>..." with a 200 status and its res.json()
  // throws "Unexpected token '<' ... is not valid JSON" — a broken, unhandled
  // failure (skeletons that never resolve, mystery parse errors) instead of a
  // clean auth signal. So for /api/* we hand back a JSON 401 the client can act
  // on; only real page navigations get the visible redirect to /login.
  const isApiRequest = pathname.startsWith('/api/');
  const redirectToLogin = (): NextResponse => {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = `?callbackUrl=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(loginUrl);
  };

  // A force-logout neutralized this token (jwt callback returned `{}` because
  // an admin called bumpForceLogoutFor for the user). The cookie still
  // decodes to *something* — but with no email/sub — so check those too.
  const tokenEmail = (token as { email?: string | null } | null)?.email ?? null;
  const tokenSub = (token as { sub?: string | null } | null)?.sub ?? null;
  if (!token || (!tokenEmail && !tokenSub)) {
    if (isApiRequest) {
      return NextResponse.json(
        { error: 'Not signed in', code: 'auth_required' },
        { status: 401 },
      );
    }
    return redirectToLogin();
  }

  // Force-logout enforcement: if an admin reset this person's session, reject
  // the still-valid cookie immediately, clear it, and send them to /login so
  // they re-authenticate into a fresh JWT carrying the updated access.
  {
    const emailLower = (tokenEmail ?? '').toString().trim().toLowerCase();
    const issuedAt = typeof (token as { iat?: number }).iat === 'number'
      ? (token as { iat: number }).iat
      : 0;
    if (await isForceLoggedOut(emailLower, issuedAt)) {
      // Clear the revoked session cookie either way. API callers get a JSON 401
      // (distinct code so the client can force a full re-auth); page navigations
      // get the redirect to /login. See the isApiRequest note above.
      const res = isApiRequest
        ? NextResponse.json(
            { error: 'Session ended', code: 'session_revoked' },
            { status: 401 },
          )
        : redirectToLogin();
      for (const name of SESSION_COOKIE_NAMES) {
        res.cookies.set(name, '', { path: '/', maxAge: 0 });
      }
      return res;
    }
  }

  // -------------------------------------------------------------------------
  // AUTHORIZATION. Authentication + force-logout are settled above; the access
  // *decision* is delegated to the pure, unit-tested evaluateRouteAccess() in
  // src/lib/auth/route-access.ts (the single source of truth for which role may
  // open which route). We only translate its decision into a NextResponse here.
  // -------------------------------------------------------------------------
  const decision = evaluateRouteAccess({
    pathname,
    roles: ((token as { roles?: string[] }).roles ?? []) as string[],
    sessionEmail: (token.email ?? '').toString().trim().toLowerCase(),
    elevated: Boolean((token as { elevated?: boolean }).elevated),
    requestedEmail: req.nextUrl.searchParams.get('email'),
  });

  if (decision.action === 'forbid') {
    return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 });
  }
  if (decision.action === 'redirect') {
    const url = req.nextUrl.clone();
    url.pathname = decision.pathname;
    if (decision.clearSearch) url.search = '';
    if (decision.setEmail) url.searchParams.set('email', decision.setEmail);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Skip static assets, _next internals, and any file that looks like a static resource.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|favicon\\.png|favicon2\\.png|simple-logo\\.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|ttf|mp3|wav|ogg|m4a)$).*)'],
};
