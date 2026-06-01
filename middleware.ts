/**
 * Auth middleware — gates the app behind Google SSO.
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

function onboardingRateLimited(req: NextRequest): boolean {
  const limit = ONBOARDING_LIMITS[req.method];
  if (!limit) return false;

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';

  const key = `${req.method}:${ip}`;
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

const PUBLIC_PATHS = new Set<string>([
  '/login',
]);

const PUBLIC_PREFIXES = [
  '/api/auth/', // NextAuth handler
  // /onboarding/ and /api/onboarding/ are handled above with rate limiting.
];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

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

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // A force-logout neutralized this token (jwt callback returned `{}` because
  // an admin called bumpForceLogoutFor for the user). The cookie still
  // decodes to *something* — but with no email/sub — so check those too.
  const tokenEmail = (token as { email?: string | null } | null)?.email ?? null;
  const tokenSub = (token as { sub?: string | null } | null)?.sub ?? null;
  if (!token || (!tokenEmail && !tokenSub)) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = `?callbackUrl=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(loginUrl);
  }

  // Contractors are not permitted to access the employee dashboard.
  // If someone with the contractor role (and no other roles) navigates to /employee,
  // redirect them to /contractor.
  if (!pathname.startsWith('/api/')) {
    const tokenRoles = ((token as { roles?: string[] }).roles ?? []) as string[];
    const isContractorOnly =
      tokenRoles.length > 0 && tokenRoles.every((r) => r === 'contractor');
    const isEmployeePath = pathname === '/employee' || pathname.startsWith('/employee/');
    if (isContractorOnly && isEmployeePath) {
      const contractorUrl = req.nextUrl.clone();
      contractorUrl.pathname = '/contractor';
      return NextResponse.redirect(contractorUrl);
    }
  }

  // Prevent users from loading another employee's dashboard by hand-editing the `?email=`
  // query param.
  //
  // Personal dashboards (/manager, /employee) are always scoped to the session owner —
  // even elevated users (admin / payroll / finance / HR) are redirected back to their own
  // copy. Those roles have dedicated elevated dashboards for cross-employee visibility.
  //
  // On other page routes elevated users are allowed through so they can legitimately view
  // other employees' data (e.g. payroll-clerk, accounting, orphanage review queues).
  //
  // Scope: only page routes — `/api/*` already enforces ownership server-side.
  if (!pathname.startsWith('/api/')) {
    const rawEmailParam = req.nextUrl.searchParams.get('email');
    const sessionEmail = (token.email ?? '').toString().trim().toLowerCase();
    const requested = (rawEmailParam ?? '').trim().toLowerCase();
    const elevated = Boolean((token as { elevated?: boolean }).elevated);

    // /manager and /employee are strictly personal — no cross-email access regardless of role.
    const PERSONAL_ROUTES = ['/manager', '/employee', '/ceo'];
    const isPersonalRoute = PERSONAL_ROUTES.some(
      (r) => pathname === r || pathname.startsWith(`${r}/`),
    );

    if (sessionEmail && requested && requested !== sessionEmail && (!elevated || isPersonalRoute)) {
      const scoped = req.nextUrl.clone();
      scoped.searchParams.set('email', sessionEmail);
      return NextResponse.redirect(scoped);
    }
  }

  return NextResponse.next();
}

export const config = {
  // Skip static assets, _next internals, and any file that looks like a static resource.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|favicon\\.png|favicon2\\.png|simple-logo\\.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|ttf)$).*)'],
};
