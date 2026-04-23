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
 *  - /icon.svg, /favicon.png,
 *    /simple-logo.png             — static assets referenced from <head> / login page
 *
 * The `matcher` below excludes Next.js internal paths (_next, static) and common public file
 * extensions so we don't pay the auth check on every image/font request.
 */

import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = new Set<string>([
  '/login',
]);

const PUBLIC_PREFIXES = [
  '/api/auth/', // NextAuth handler
];

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (token) return NextResponse.next();

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = `?callbackUrl=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip static assets, _next internals, and any file that looks like a static resource.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|favicon\\.png|simple-logo\\.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?|ttf)$).*)'],
};
