'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

/**
 * App-wide online presence over a single Supabase Realtime channel.
 *
 * Every authenticated client (any role) tracks itself on `hris-presence`, so
 * any other client subscribed to the same channel can tell who is currently
 * using the HRIS — including which dashboard route and (if the dashboard
 * shell reports one via {@link usePublishPresenceTab}) which tab they're on.
 * Mounted once at the app root (inside the NextAuth session provider) so the
 * roster stays accurate regardless of which view is open.
 *
 * Read the live roster with {@link useOnlineEmails}; read full per-person
 * detail (name/route/tab) with {@link usePresenceDetails}.
 */
const PRESENCE_CHANNEL = 'hris-presence';

interface PresenceMeta {
  email: string;
  name: string | null;
  /** Current pathname, e.g. `/hr`. Always present. */
  path: string | null;
  /** Current in-dashboard tab label, e.g. `"Onboarding"`. Null when the route
   *  has no tabbed shell (login, onboarding links, etc.) or hasn't reported one yet. */
  tab: string | null;
  online_at: string;
}

/** Live detail for one online person, keyed by normalized email. */
export interface PresenceDetail {
  name: string | null;
  path: string | null;
  tab: string | null;
  online_at: string;
}

/** Set of normalized emails currently online. Empty until the first sync. */
const OnlinePresenceContext = createContext<ReadonlySet<string>>(new Set());
/** Full live detail per online person, keyed by normalized email. */
const PresenceDetailsContext = createContext<ReadonlyMap<string, PresenceDetail>>(new Map());
/** Lets a dashboard shell publish its current tab label up to the provider. */
const PresenceTabSetterContext = createContext<(label: string | null) => void>(() => {});
/** Imperatively force a re-read of the live presence roster (manual "Refresh"). */
const PresenceRefreshContext = createContext<() => void>(() => {});

/** Returns the live set of normalized emails that are currently online. */
export function useOnlineEmails(): ReadonlySet<string> {
  return useContext(OnlinePresenceContext);
}

/** Returns live per-person detail (name, current route, current dashboard tab)
 *  for everyone online right now, keyed by normalized email. */
export function usePresenceDetails(): ReadonlyMap<string, PresenceDetail> {
  return useContext(PresenceDetailsContext);
}

/**
 * Returns a function that force-recomputes the presence roster from the live
 * channel state. Presence already streams in over Realtime (join/leave/sync),
 * so this is only for a manual "Refresh" affordance / belt-and-suspenders pull —
 * it's a no-op-shaped recompute, never a network round-trip.
 */
export function usePresenceRefresh(): () => void {
  return useContext(PresenceRefreshContext);
}

/**
 * Dashboard shells call this with their current tab's human label (or `null`
 * when there's nothing tab-like active) so viewers of {@link usePresenceDetails}
 * can show e.g. "HR Dashboard · Onboarding" instead of just the route. Clears
 * itself on unmount so navigating away doesn't leave a stale tab behind.
 */
export function usePublishPresenceTab(label: string | null): void {
  const setTabLabel = useContext(PresenceTabSetterContext);
  useEffect(() => {
    setTabLabel(label);
    return () => setTabLabel(null);
  }, [label, setTabLabel]);
}

/** Resolve the logged-in user's email: NextAuth session first, then the
 *  sessionStorage fallback used by email/impersonation login paths. Exported
 *  so other root-mounted watchers (e.g. {@link GlobalPingListener}) can reuse
 *  the exact same resolution instead of re-deriving it. */
export function useSelfEmail(): string | null {
  const { data: session } = useSession();
  const sessionEmail = session?.user?.email ?? null;
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => {
    if (sessionEmail) return;
    try {
      setStored(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      /* sessionStorage unavailable (SSR / privacy mode) */
    }
  }, [sessionEmail]);

  const raw = sessionEmail ?? stored;
  return raw ? (normEmail(raw) ?? raw.trim().toLowerCase()) : null;
}

/** How often each client pings `/api/presence/heartbeat` so My Team can show
 *  "Last seen 5m ago" for offline teammates. Realtime presence alone is
 *  broadcast-only — the timestamp is gone the moment a tab closes. */
const HEARTBEAT_INTERVAL_MS = 60_000;

function sendHeartbeat(email: string, name: string | null): void {
  // Fire-and-forget. `keepalive` lets the final beat survive a tab close so
  // the DB stamp matches "actually went offline at T".
  fetch('/api/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name }),
    keepalive: true,
  }).catch(() => {
    /* network errors are non-fatal — next interval will retry */
  });
}

export default function PresenceProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const selfEmail = useSelfEmail();
  const selfName = session?.user?.name ?? null;
  const pathname = usePathname();
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [details, setDetails] = useState<ReadonlyMap<string, PresenceDetail>>(new Map());

  // Keep the latest name/path/tab in refs so `retrack` can stay a stable
  // function (identity only changes with `selfEmail`) while always sending
  // the freshest values — avoids stale-closure re-tracks on route/tab changes.
  const nameRef = useRef(selfName);
  nameRef.current = selfName;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const tabLabelRef = useRef<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channelRef = useRef<any>(null);
  const subscribedRef = useRef(false);
  // Holds the latest `sync` closure so an external "Refresh" can force a
  // recompute from the current channel state without tearing anything down.
  const syncRef = useRef<() => void>(() => {});

  // Re-announce our presence payload (path/tab may have changed) without
  // tearing down the channel/subscription. No-ops until SUBSCRIBED fires once.
  const retrack = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || !selfEmail || !subscribedRef.current) return;
    // `usePathname()` can transiently return null on the very first render; fall
    // back to the live location so we never broadcast a null path (which would
    // read as "Simple HRIS" on the Global Master List instead of the real page).
    const path =
      pathnameRef.current ?? (typeof window !== 'undefined' ? window.location.pathname : null);
    void channel.track({
      email: selfEmail,
      name: nameRef.current,
      path,
      tab: tabLabelRef.current,
      online_at: new Date().toISOString(),
    } satisfies PresenceMeta);
  }, [selfEmail]);

  const setTabLabel = useCallback(
    (label: string | null) => {
      tabLabelRef.current = label;
      retrack();
    },
    [retrack],
  );

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase.channel(PRESENCE_CHANNEL, {
      config: { presence: { key: selfEmail ?? 'anon' } },
    });
    channelRef.current = channel;

    const sync = () => {
      const state = channel.presenceState<PresenceMeta>();
      const set = new Set<string>();
      const map = new Map<string, PresenceDetail>();
      for (const key of Object.keys(state)) {
        const meta = state[key]?.[0];
        const candidate = meta?.email ?? key;
        const norm = normEmail(candidate) ?? candidate.trim().toLowerCase();
        if (!norm || norm === 'anon') continue;
        set.add(norm);
        map.set(norm, {
          name: meta?.name ?? null,
          path: meta?.path ?? null,
          tab: meta?.tab ?? null,
          online_at: meta?.online_at ?? new Date().toISOString(),
        });
      }
      setOnline(set);
      setDetails(map);
    };
    syncRef.current = sync;

    channel
      .on('presence', { event: 'sync' }, sync)
      .on('presence', { event: 'join' }, sync)
      .on('presence', { event: 'leave' }, sync)
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED' && selfEmail) {
          subscribedRef.current = true;
          retrack();
        }
      });

    return () => {
      subscribedRef.current = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [selfEmail, retrack]);

  // Re-announce on route change (e.g. navigating to a different dashboard).
  useEffect(() => {
    retrack();
  }, [pathname, retrack]);

  // Persist a "last seen" stamp so offline teammates can be shown as
  // "Last seen Xm ago" — the realtime channel alone forgets immediately on
  // disconnect. Beat on mount, every minute while visible, on visibility
  // changes, and once more on tab close (keepalive: true).
  //
  // We also `retrack()` alongside each beat / on focus: presence is broadcast-
  // only, so if the initial track ever raced (path not yet resolved), this
  // re-announces the correct path/tab within a minute instead of leaving the
  // person stuck showing "Simple HRIS".
  useEffect(() => {
    if (!selfEmail) return;

    sendHeartbeat(selfEmail, nameRef.current);

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat(selfEmail, nameRef.current);
        retrack();
      }
    }, HEARTBEAT_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat(selfEmail, nameRef.current);
        retrack();
      }
    };
    const onUnload = () => {
      sendHeartbeat(selfEmail, nameRef.current);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onUnload);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onUnload);
    };
  }, [selfEmail, retrack]);

  const onlineValue = useMemo(() => online, [online]);
  const detailsValue = useMemo(() => details, [details]);
  // Force-recompute from the current channel state. Stable identity.
  const resync = useCallback(() => syncRef.current(), []);

  return (
    <OnlinePresenceContext.Provider value={onlineValue}>
      <PresenceDetailsContext.Provider value={detailsValue}>
        <PresenceTabSetterContext.Provider value={setTabLabel}>
          <PresenceRefreshContext.Provider value={resync}>
            {children}
          </PresenceRefreshContext.Provider>
        </PresenceTabSetterContext.Provider>
      </PresenceDetailsContext.Provider>
    </OnlinePresenceContext.Provider>
  );
}
