'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, signOut, useSession } from 'next-auth/react';
import { Loader2, LogIn, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import {
  ACTIVE_VIEW_KEY,
  SESSION_EMAIL_KEY,
  VIEW_ROUTES,
  defaultViewFor,
  viewsForRoles,
  type Role,
} from '@/lib/rbac/views';

const SESSION_ROLE_KEY = 'employee_session_role';

/**
 * Google SSO sign-in screen.
 *
 * Flow:
 *  1. User clicks "Continue with Google" → NextAuth redirects to Google.
 *  2. Google verifies the @simple.biz Workspace account; NextAuth callback filters non-Workspace emails.
 *  3. On return, `useSession()` resolves with the authenticated user.
 *  4. We run the same role-resolution logic the email-only login used (the HRIS still stores
 *     roles in Supabase keyed by work email), cache the view in sessionStorage, then redirect.
 *
 * NextAuth only guarantees a valid @simple.biz email; Supabase is still the source of truth for
 * which departments/roles that email has.
 */
/**
 * Default export wraps the inner client component in a Suspense boundary because
 * `useSearchParams()` triggers a CSR-bailout during Next.js static prerender without it.
 * (Next 16 requires the Suspense wrapper even for fully client-rendered pages.)
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginSkeleton />}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginSkeleton() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden bg-white px-4 py-10">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.12),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.10),transparent_32%),linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)]" />
      <div className="absolute left-[8%] top-[10%] h-64 w-64 rounded-full bg-orange-200/20 blur-3xl" aria-hidden />
      <div className="absolute bottom-[12%] right-[10%] h-72 w-72 rounded-full bg-sky-200/20 blur-3xl" aria-hidden />
      <div className="relative flex flex-col items-center gap-3 rounded-3xl border border-white/70 bg-white/55 px-8 py-10 text-sm text-zinc-500 shadow-[0_24px_80px_rgba(15,23,42,0.12)] backdrop-blur-2xl">
        <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
        <span>Loading sign-in…</span>
      </div>
    </main>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const [resolvingRole, setResolvingRole] = useState(false);

  const authError = searchParams?.get('error') ?? null;

  // When NextAuth finishes, resolve role and route the user.
  useEffect(() => {
    if (status !== 'authenticated' || !session?.user?.email) return;
    if (resolvingRole) return;
    setResolvingRole(true);

    const email = session.user.email;
    (async () => {
      let roles: Role[] = [];
      try {
        const res = await fetch(`/api/employee-roles?email=${encodeURIComponent(email)}`);
        const json = (await res.json()) as { rows?: { role: Role }[] };
        roles = (json.rows ?? []).map((r) => r.role);
      } catch {
        /* fall through to employee view */
      }

      const views = viewsForRoles(roles);
      // Everyone lands on the employee view by default after sign-in. Users with accounting
      // or admin roles switch via the in-app view switcher — no more forced /accounting hop.
      const target: typeof views[number] = views.includes('employee') ? 'employee' : defaultViewFor(views);

      try {
        sessionStorage.setItem(SESSION_EMAIL_KEY, email);
        sessionStorage.setItem(SESSION_ROLE_KEY, target);
        sessionStorage.setItem(ACTIVE_VIEW_KEY, target);
      } catch {
        /* ignore */
      }

      // Honor `?callbackUrl=…` if the middleware pushed us here from a specific page.
      // Reject obviously-bad callback URLs (external, or a loop back to /login).
      const rawCallback = searchParams?.get('callbackUrl') ?? null;
      const safeCallback =
        rawCallback && rawCallback.startsWith('/') && !rawCallback.startsWith('/login')
          ? rawCallback
          : null;

      if (safeCallback) {
        router.replace(safeCallback);
        return;
      }

      const base = VIEW_ROUTES[target];
      router.replace(`${base}?email=${encodeURIComponent(email)}`);
    })();
  }, [status, session, router, resolvingRole, searchParams]);

  // Turn NextAuth error query params into a friendly toast exactly once on mount.
  useEffect(() => {
    if (!authError) return;
    const msg =
      authError === 'AccessDenied'
        ? 'Only @simple.biz Google accounts can sign in.'
        : 'Google sign-in failed. Please try again.';
    toast.error(msg);
  }, [authError]);

  return (
    <>
      <main className="relative flex min-h-screen items-center justify-center overflow-x-hidden bg-white px-4 py-10">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(251,146,60,0.14),transparent_32%),radial-gradient(circle_at_top_right,rgba(255,255,255,0.92),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.10),transparent_30%),linear-gradient(180deg,#ffffff_0%,#f8fafc_52%,#ffffff_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.65)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.65)_1px,transparent_1px)] bg-[size:28px_28px] opacity-50" />
        <div className="absolute left-[-6rem] top-[-4rem] h-72 w-72 rounded-full bg-orange-200/30 blur-3xl" aria-hidden />
        <div className="absolute bottom-[-5rem] right-[-4rem] h-80 w-80 rounded-full bg-sky-200/30 blur-3xl" aria-hidden />

        <div className="relative w-full max-w-5xl">
          <div className="pointer-events-none absolute inset-y-10 left-10 hidden w-px bg-gradient-to-b from-transparent via-zinc-300/60 to-transparent lg:block" />
          <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <section className="relative hidden overflow-hidden rounded-[2rem] border border-white/70 bg-white/45 p-10 shadow-[0_28px_90px_rgba(15,23,42,0.10)] backdrop-blur-2xl lg:flex lg:flex-col lg:justify-between">
              <div className="space-y-6">
                <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200/70 bg-white/80 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-zinc-500">
                  Simple HRIS
                </div>
                <div className="space-y-4">
                  <h2 className="max-w-lg text-5xl font-semibold tracking-[-0.04em] text-zinc-950">
                    A cleaner front door for payroll, people, and approvals.
                  </h2>
                  <p className="max-w-xl text-sm leading-7 text-zinc-600">
                    Secure access to employee records, payroll workflows, dispute handling, and operational dashboards in one place.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/80 bg-white/72 p-4 shadow-sm backdrop-blur-xl">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Access</div>
                  <div className="mt-2 text-sm font-semibold text-zinc-900">Google Workspace</div>
                  <div className="mt-1 text-xs leading-5 text-zinc-500">@simple.biz only</div>
                </div>
                <div className="rounded-2xl border border-white/80 bg-white/72 p-4 shadow-sm backdrop-blur-xl">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Scope</div>
                  <div className="mt-2 text-sm font-semibold text-zinc-900">Employee + Accounting</div>
                  <div className="mt-1 text-xs leading-5 text-zinc-500">Role-aware entry</div>
                </div>
                <div className="rounded-2xl border border-white/80 bg-white/72 p-4 shadow-sm backdrop-blur-xl">
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Session</div>
                  <div className="mt-2 text-sm font-semibold text-zinc-900">Protected by SSO</div>
                  <div className="mt-1 text-xs leading-5 text-zinc-500">Auto-routed after sign-in</div>
                </div>
              </div>
            </section>

            <Card className="relative overflow-hidden rounded-[2rem] border border-white/80 bg-white/62 shadow-[0_30px_100px_rgba(15,23,42,0.14)] backdrop-blur-3xl">
              <div className="absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent" />
              <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.36),transparent_42%,rgba(251,146,60,0.06)_78%,rgba(59,130,246,0.06)_100%)]" />
              <CardContent className="relative flex flex-col items-center gap-6 px-8 py-10 sm:px-10 sm:py-12">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="rounded-2xl border border-white/90 bg-white/80 p-3 shadow-sm backdrop-blur-xl">
                <img src="/simple-logo.png" alt="Simple" className="h-12 w-auto" />
              </div>

              <p className="max-w-xs text-sm leading-6 text-zinc-600">
                Sign in with your{' '}
                <span className="font-semibold text-zinc-900">@simple.biz</span>{' '}
                Google account to access payroll, hours, and employee data.
              </p>
            </div>

            {authError && (
              <div className="flex w-full items-start gap-2 rounded-2xl border border-red-200/80 bg-white/80 px-4 py-3 text-[12px] text-red-700 shadow-sm backdrop-blur-xl">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {authError === 'AccessDenied'
                    ? 'Only @simple.biz Google accounts can sign in.'
                    : 'Google sign-in failed. Please try again.'}
                </span>
              </div>
            )}

            {status === 'loading' || resolvingRole ? (
              <div className="flex flex-col items-center gap-2 py-4 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                <span>{resolvingRole ? 'Loading your profile…' : 'Checking session…'}</span>
              </div>
            ) : status === 'authenticated' ? (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <p className="text-sm text-zinc-700">
                  Signed in as{' '}
                  <span className="font-semibold text-zinc-950">
                    {session?.user?.email}
                  </span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl border-white/80 bg-white/80 backdrop-blur-xl"
                  onClick={() => void signOut({ callbackUrl: '/login' })}
                >
                  Sign out
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="lg"
                className="h-14 w-full gap-3 rounded-2xl border border-white/90 bg-white/88 text-zinc-900 shadow-[0_12px_30px_rgba(15,23,42,0.08)] ring-0 backdrop-blur-xl transition hover:bg-white"
                onClick={() => void signIn('google', { callbackUrl: '/login' })}
              >
                <GoogleMark />
                <span className="font-medium">Continue with Google</span>
                <LogIn className="ml-auto h-4 w-4 text-orange-500" />
              </Button>
            )}

            <div className="flex w-full items-center gap-3 py-1">
              <div className="h-px flex-1 bg-zinc-200/80" />
              <span className="text-[10px] uppercase tracking-[0.22em] text-zinc-400">Secure Access</span>
              <div className="h-px flex-1 bg-zinc-200/80" />
            </div>

            <p className="text-center text-[10px] leading-relaxed text-zinc-400">
              By signing in you agree to the company's acceptable-use policy for HR data. Sessions
              expire after 30 days of inactivity.
            </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
      <Toaster position="top-right" />
    </>
  );
}

function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C41.388 35.844 44 30.465 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}
