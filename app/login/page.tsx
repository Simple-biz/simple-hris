'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn, signOut, useSession } from 'next-auth/react';
import { Loader2, LogIn, AlertCircle, Volume2, VolumeX } from 'lucide-react';
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
  const { data: session, status, update } = useSession();
  const [resolvingRole, setResolvingRole] = useState(false);
  // Where to send the user once sign-in resolves. We compute this up front but DON'T navigate
  // immediately -- the actual hand-off is gated on the transition video so it feels like one motion.
  const [destination, setDestination] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [fadeToWhite, setFadeToWhite] = useState(false);
  const [transitionDone, setTransitionDone] = useState(false);
  const [muted, setMuted] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  // videoActive gates visibility of the full-screen overlay; videoStartedRef prevents the
  // authenticated-status effect from double-starting the video when popup flow already launched it.
  const [videoActive, setVideoActive] = useState(false);
  const videoStartedRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const finishedRef = useRef(false);

  const authError = searchParams?.get('error') ?? null;

  // Wind down the transition video (fade to white, then allow navigation). Idempotent so the
  // onEnded / onError / Skip / safety-cap paths can all call it without double-firing.
  function finishTransition() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFadeToWhite(true);
    window.setTimeout(() => setTransitionDone(true), 300);
  }

  // When NextAuth finishes, resolve the user's role + destination and warm that route.
  // Navigation itself happens later, once the video has played out.
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
      // or admin roles switch via the in-app view switcher -- no more forced /accounting hop.
      const target: typeof views[number] = views.includes('employee') ? 'employee' : defaultViewFor(views);

      try {
        sessionStorage.setItem(SESSION_EMAIL_KEY, email);
        sessionStorage.setItem(SESSION_ROLE_KEY, target);
        sessionStorage.setItem(ACTIVE_VIEW_KEY, target);
      } catch {
        /* ignore */
      }

      // Honor `?callbackUrl=...` if the middleware pushed us here from a specific page.
      // Reject obviously-bad callback URLs (external, or a loop back to /login).
      const rawCallback = searchParams?.get('callbackUrl') ?? null;
      const safeCallback =
        rawCallback && rawCallback.startsWith('/') && !rawCallback.startsWith('/login')
          ? rawCallback
          : null;

      const url = safeCallback ?? `${VIEW_ROUTES[target]}?email=${encodeURIComponent(email)}`;
      // Prefetch so the post-video hand-off renders instantly instead of flashing a loader.
      try { router.prefetch(url); } catch { /* ignore */ }
      setDestination(url);
    })();
  }, [status, session, router, resolvingRole, searchParams]);

  // Turn sound on in response to a real click (always allowed). Used by the "Tap for sound"
  // prompt and the unmute toggle.
  function enableSound() {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.volume = 1;
    setMuted(false);
    setSoundBlocked(false);
    void v.play();
  }

  function toggleSound() {
    const v = videoRef.current;
    if (!v) return;
    if (v.muted) {
      enableSound();
    } else {
      v.muted = true;
      setMuted(true);
    }
  }

  // Open Google OAuth in a popup so the parent page stays alive with an active user gesture.
  // We call v.play() right after window.open() returns (still within the gesture window) so sound
  // is allowed without any extra tap. Falls back to a full redirect if the popup is blocked.
  async function handleGoogleSignIn() {
    const v = videoRef.current;

    let oauthUrl: string | null = null;
    try {
      const result = await signIn('google', {
        redirect: false,
        callbackUrl: `${window.location.origin}/auth-callback`,
      }) as { url?: string | null } | undefined;
      oauthUrl = result?.url ?? null;
    } catch {
      /* fall through to redirect */
    }

    if (!oauthUrl) {
      void signIn('google', { callbackUrl: '/login' });
      return;
    }

    const sw = window.screen.width;
    const sh = window.screen.height;
    const pw = 520;
    const ph = 620;
    const popup = window.open(
      oauthUrl,
      'google-oauth',
      `width=${pw},height=${ph},left=${Math.round((sw - pw) / 2)},top=${Math.round((sh - ph) / 2)},resizable=yes,scrollbars=yes`,
    );

    if (!popup) {
      // Popup blocked — fall back to the regular redirect flow.
      void signIn('google', { callbackUrl: '/login' });
      return;
    }

    // Popup opened. User gesture is still within its ~1s activation window.
    // Start the video with sound right now.
    videoStartedRef.current = true;
    if (v) {
      v.muted = false;
      v.volume = 1;
      void v.play()
        .then(() => setVideoReady(true))
        .catch(() => {
          v.muted = true;
          setMuted(true);
          setSoundBlocked(true);
          void v.play().then(() => setVideoReady(true)).catch(() => setVideoReady(true));
        });
    }
    setVideoActive(true);
    window.setTimeout(finishTransition, 9000);
  }

  // When the browser blocks autoplay-with-audio, add a one-shot document gesture listener so the
  // first click/tap anywhere on the overlay automatically enables sound.
  useEffect(() => {
    if (!soundBlocked) return;
    const onGesture = () => enableSound();
    document.addEventListener('click', onGesture, { once: true });
    document.addEventListener('touchend', onGesture, { once: true });
    return () => {
      document.removeEventListener('click', onGesture);
      document.removeEventListener('touchend', onGesture);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundBlocked]);

  // When the popup OAuth flow completes, /auth-callback posts this message. Force a session
  // refresh so useSession() picks up the new cookie without waiting for the next focus poll.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if ((e.data as { type?: string })?.type !== 'oauth_done') return;
      void update?.();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [update]);

  // Drive the transition video once authenticated. Skipped when the popup flow already started
  // it; used as the fallback path for already-logged-in users and the redirect-fallback case.
  useEffect(() => {
    if (status !== 'authenticated') return;
    if (videoStartedRef.current) return;
    videoStartedRef.current = true;
    const v = videoRef.current;
    setVideoActive(true);
    if (v) {
      v.muted = false;
      v.volume = 1;
      void v.play()
        .then(() => setVideoReady(true))
        .catch(() => {
          v.muted = true;
          setMuted(true);
          setSoundBlocked(true);
          void v.play().then(() => setVideoReady(true)).catch(() => setVideoReady(true));
        });
    }
    const cap = window.setTimeout(finishTransition, 9000);
    return () => window.clearTimeout(cap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // The single hand-off point: only navigate once BOTH the destination is known and the
  // transition has played out. Whichever finishes last triggers the move.
  useEffect(() => {
    if (transitionDone && destination) {
      // Hand a one-shot baton to the destination so it reveals itself from white (matching the
      // veil we end the video on) instead of popping in. Cleared by the destination on mount.
      try {
        if (destination.startsWith('/employee')) {
          sessionStorage.setItem('hris_post_login', '1');
        }
      } catch {
        /* ignore */
      }
      router.replace(destination);
    }
  }, [transitionDone, destination, router]);

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
                onClick={() => void handleGoogleSignIn()}
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

      {/* Seamless sign-in hand-off: full-screen video bridges the gap while the destination
          route warms in the background. Always in DOM (hidden) so videoRef is valid at click-time,
          letting us call play() with an active user gesture before any async work. */}
      <div className={`fixed inset-0 z-[100] bg-white${videoActive ? '' : ' hidden'}`}>
          <video
            ref={videoRef}
            className={`h-full w-full object-cover transition-opacity duration-500 ease-out ${
              videoReady ? 'opacity-100' : 'opacity-0'
            }`}
            src="/login.mp4"
            muted={muted}
            playsInline
            preload="none"
            onCanPlay={() => setVideoReady(true)}
            onEnded={finishTransition}
            onError={finishTransition}
          />

          {/* Closing fade into the app. If the role lookup is still in flight when the video
              ends, a quiet spinner holds the white frame until the destination is ready. */}
          <div
            className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-white transition-opacity duration-300 ease-out ${
              fadeToWhite ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {fadeToWhite && !destination && (
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
            )}
          </div>

          {/* Sound control — mute/unmute toggle. */}
          <button
            type="button"
            onClick={muted ? enableSound : toggleSound}
            className="absolute bottom-6 left-6 inline-flex items-center gap-2 rounded-full border border-white/40 bg-black/30 px-4 py-1.5 text-xs font-medium text-white/85 backdrop-blur-md transition hover:bg-black/55 hover:text-white"
          >
            {muted && !soundBlocked ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            {muted && !soundBlocked ? 'Sound off' : 'Sound on'}
          </button>

          <button
            type="button"
            onClick={finishTransition}
            className="absolute bottom-6 right-6 rounded-full border border-white/40 bg-black/30 px-4 py-1.5 text-xs font-medium text-white/85 backdrop-blur-md transition hover:bg-black/55 hover:text-white"
          >
            Skip
          </button>
        </div>
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
