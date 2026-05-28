'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSession } from 'next-auth/react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

/**
 * App-wide online presence over a single Supabase Realtime channel.
 *
 * Every authenticated client (any role) tracks itself on `hris-presence`, so
 * any other client subscribed to the same channel can tell who is currently
 * using the HRIS. Mounted once at the app root (inside the NextAuth session
 * provider) so the roster stays accurate regardless of which view is open.
 *
 * Read the live roster with {@link useOnlineEmails}.
 */
const PRESENCE_CHANNEL = 'hris-presence';

interface PresenceMeta {
  email: string;
  name: string | null;
  online_at: string;
}

/** Set of normalized emails currently online. Empty until the first sync. */
const OnlinePresenceContext = createContext<ReadonlySet<string>>(new Set());

/** Returns the live set of normalized emails that are currently online. */
export function useOnlineEmails(): ReadonlySet<string> {
  return useContext(OnlinePresenceContext);
}

/** Resolve the logged-in user's email: NextAuth session first, then the
 *  sessionStorage fallback used by email/impersonation login paths. */
function useSelfEmail(): string | null {
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
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());

  // Keep the latest name without forcing a re-subscribe when only it changes.
  const nameRef = useRef(selfName);
  nameRef.current = selfName;

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase.channel(PRESENCE_CHANNEL, {
      config: { presence: { key: selfEmail ?? 'anon' } },
    });

    const sync = () => {
      const state = channel.presenceState<PresenceMeta>();
      const set = new Set<string>();
      for (const key of Object.keys(state)) {
        const meta = state[key]?.[0];
        const candidate = meta?.email ?? key;
        const norm = normEmail(candidate) ?? candidate.trim().toLowerCase();
        if (norm && norm !== 'anon') set.add(norm);
      }
      setOnline(set);
    };

    channel
      .on('presence', { event: 'sync' }, sync)
      .on('presence', { event: 'join' }, sync)
      .on('presence', { event: 'leave' }, sync)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED' && selfEmail) {
          void channel.track({
            email: selfEmail,
            name: nameRef.current,
            online_at: new Date().toISOString(),
          } satisfies PresenceMeta);
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [selfEmail]);

  // Persist a "last seen" stamp so offline teammates can be shown as
  // "Last seen Xm ago" — the realtime channel alone forgets immediately on
  // disconnect. Beat on mount, every minute while visible, on visibility
  // changes, and once more on tab close (keepalive: true).
  useEffect(() => {
    if (!selfEmail) return;

    sendHeartbeat(selfEmail, nameRef.current);

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat(selfEmail, nameRef.current);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendHeartbeat(selfEmail, nameRef.current);
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
  }, [selfEmail]);

  const value = useMemo(() => online, [online]);

  return (
    <OnlinePresenceContext.Provider value={value}>
      {children}
    </OnlinePresenceContext.Provider>
  );
}
