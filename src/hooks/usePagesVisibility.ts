'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  PAGES_VISIBILITY_KEY,
  parsePagesVisibility,
  pageVisibility,
  type DashboardKey,
  type PagesVisibilityConfig,
  type PageVisibility,
} from '@/lib/pages/visibility';

/** Polling fallback when Realtime is silently broken (missing publication, RLS,
 *  etc.) so a hidden/under-construction flip is never stuck for long. */
const POLL_INTERVAL_MS = 30_000;

interface UsePagesVisibilityResult {
  config: PagesVisibilityConfig;
  /** False until the first fetch settles — gate any nav redirect on this so the
   *  initial (empty) state doesn't briefly flash hidden tabs as visible/etc. */
  ready: boolean;
  /** EFFECTIVE state used for gating: admins see `construction` as `visible`. */
  visibilityOf: (dash: DashboardKey, key: string) => PageVisibility;
  /** TRUE stored state (no admin bypass) — use to still SHOW an
   *  "under construction" indicator to the admin who is bypassing the gate. */
  rawVisibilityOf: (dash: DashboardKey, key: string) => PageVisibility;
  /** Whether the viewer holds the `admin` role (drives the bypass). */
  isAdmin: boolean;
}

/**
 * Subscribes to the global `pages.visibility` row in `app_settings` and reflects
 * admin changes — local or remote — live via Supabase Realtime, backed by a 30s
 * poll + focus refresh. Mount once per dashboard shell and thread the result
 * into the sidebar + content gate. Mirrors {@link useDispatchLock}.
 */
export function usePagesVisibility(): UsePagesVisibilityResult {
  const { data: session } = useSession();
  // Admins bypass the "under construction" gate — they always see the real page
  // (so they can preview/verify what's being built). "Hidden" still hides for
  // everyone, admins included. Derived from the JWT session roles, so the bypass
  // rides along even when an admin is viewing another dashboard via the switcher.
  const isAdmin = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []).includes('admin');
  const [config, setConfig] = useState<PagesVisibilityConfig>({});
  const [ready, setReady] = useState(false);
  const instanceId = useId();

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/app-settings?key=${encodeURIComponent(PAGES_VISIBILITY_KEY)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { value?: string | null };
      setConfig(parsePagesVisibility(json.value));
      // Only flag ready once we've actually loaded the config. On failure we
      // keep the prior config AND prior ready state; the 30s poll retries. Until
      // a load succeeds, dashboards leave Pages gating off (fail-open) rather
      // than acting on an empty config that would treat hidden pages as visible.
      setReady(true);
    } catch {
      /* keep prior config + ready state; a later poll/realtime retry recovers */
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime subscription on the single config row.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channelName = `pages-visibility${instanceId}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: `key=eq.${PAGES_VISIBILITY_KEY}`,
        },
        () => {
          void refetch();
        },
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(`[pages-visibility] Realtime ${status}. Falling back to 30s poll.`, err);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refetch, instanceId]);

  // Belt-and-braces poll + focus reconcile.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refetch();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  useEffect(() => {
    const onFocus = () => {
      void refetch();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetch]);

  const visibilityOf = useCallback(
    (dash: DashboardKey, key: string): PageVisibility => {
      const v = pageVisibility(config, dash, key);
      // Admin override: an under-construction page renders as normal for admins.
      if (isAdmin && v === 'construction') return 'visible';
      return v;
    },
    [config, isAdmin],
  );

  const rawVisibilityOf = useCallback(
    (dash: DashboardKey, key: string): PageVisibility => pageVisibility(config, dash, key),
    [config],
  );

  return useMemo(
    () => ({ config, ready, visibilityOf, rawVisibilityOf, isAdmin }),
    [config, ready, visibilityOf, rawVisibilityOf, isAdmin],
  );
}
