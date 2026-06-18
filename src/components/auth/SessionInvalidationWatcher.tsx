'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

/**
 * Live force-logout. When an admin clicks "Reset session" (Admin → Roles), the
 * server bumps `auth.force_logout_map` in `app_settings`. Supabase Realtime
 * fires that change to every connected client; each one re-validates its own
 * session via `/api/auth/session-status`. Only the targeted user comes back
 * invalid — and gets signed out where they sit and bounced to /login, instead
 * of staying put until their next navigation.
 *
 * Mounted once at the app root inside the NextAuth session provider. Backed by
 * a 45s poll + a focus check so the yank still lands if Realtime is down.
 */
const POLL_INTERVAL_MS = 45_000;

export default function SessionInvalidationWatcher() {
  const { data: session, status } = useSession();
  const email = session?.user?.email ?? null;
  // Guard so a burst of events (realtime + focus + poll) only triggers one
  // sign-out, and we stop probing once we're on our way out.
  const signingOutRef = useRef(false);

  const check = useCallback(async () => {
    if (signingOutRef.current) return;
    try {
      const res = await fetch('/api/auth/session-status', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { valid?: boolean };
      if (json.valid === false) {
        signingOutRef.current = true;
        try {
          sessionStorage.removeItem(SESSION_EMAIL_KEY);
        } catch {
          /* sessionStorage unavailable — ignore */
        }
        await signOut({ callbackUrl: '/login' });
      }
    } catch {
      /* network hiccup — the poll/focus path will retry */
    }
  }, []);

  // Realtime: the instant the force-logout map changes, re-validate.
  useEffect(() => {
    if (status !== 'authenticated' || !email) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel(`session-invalidation-${email}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: 'key=eq.auth.force_logout_map',
        },
        () => {
          void check();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [status, email, check]);

  // Fallback poll + re-check on focus, in case Realtime is unavailable.
  useEffect(() => {
    if (status !== 'authenticated' || !email) return;
    const id = window.setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);
    const onFocus = () => {
      void check();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [status, email, check]);

  return null;
}
