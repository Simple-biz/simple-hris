'use client';

import { useEffect, useState } from 'react';
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
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const [resolvingRole, setResolvingRole] = useState(false);

  const authError = searchParams.get('error');

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
      const target = defaultViewFor(views);

      try {
        sessionStorage.setItem(SESSION_EMAIL_KEY, email);
        sessionStorage.setItem(SESSION_ROLE_KEY, target);
        sessionStorage.setItem(ACTIVE_VIEW_KEY, target);
      } catch {
        /* ignore */
      }

      const base = VIEW_ROUTES[target];
      router.replace(`${base}?email=${encodeURIComponent(email)}`);
    })();
  }, [status, session, router, resolvingRole]);

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
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-white via-orange-50/40 to-blue-50/30 px-4 dark:from-[#0d1117] dark:via-[#0f1729] dark:to-[#0a1628]">
        <Card className="w-full max-w-md border-zinc-200 bg-white/90 shadow-xl backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <CardContent className="flex flex-col items-center gap-6 px-8 py-10">
            <div className="flex flex-col items-center gap-2 text-center">
              <img src="/simple-logo.png" alt="Simple" className="h-12 w-auto" />
              <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white">
                Simple HRIS
              </h1>
              <p className="max-w-xs text-xs text-zinc-600 dark:text-zinc-400">
                Sign in with your{' '}
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">@simple.biz</span>{' '}
                Google account to access payroll, hours, and employee data.
              </p>
            </div>

            {authError && (
              <div className="flex w-full items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {authError === 'AccessDenied'
                    ? 'Only @simple.biz Google accounts can sign in.'
                    : 'Google sign-in failed. Please try again.'}
                </span>
              </div>
            )}

            {status === 'loading' || resolvingRole ? (
              <div className="flex flex-col items-center gap-2 py-4 text-sm text-zinc-500 dark:text-zinc-400">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>{resolvingRole ? 'Loading your profile…' : 'Checking session…'}</span>
              </div>
            ) : status === 'authenticated' ? (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                  Signed in as{' '}
                  <span className="font-semibold text-zinc-900 dark:text-white">
                    {session?.user?.email}
                  </span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void signOut({ callbackUrl: '/login' })}
                >
                  Sign out
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="lg"
                className="w-full gap-2 bg-white text-zinc-800 ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800"
                onClick={() => void signIn('google', { callbackUrl: '/login' })}
              >
                <GoogleMark />
                <span>Continue with Google</span>
                <LogIn className="ml-auto h-4 w-4 opacity-60" />
              </Button>
            )}

            <p className="text-center text-[10px] leading-relaxed text-zinc-400">
              By signing in you agree to the company's acceptable-use policy for HR data. Sessions
              expire after 30 days of inactivity.
            </p>
          </CardContent>
        </Card>
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
