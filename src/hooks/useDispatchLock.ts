'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import type { PayrollDispatchLockState } from '@/lib/supabase/payroll-dispatch-lock';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

const EMPTY: PayrollDispatchLockState = { locked: false, lockedAt: null, lockedBy: null };

/** Polling fallback in case Realtime is silently broken (missing publication,
 *  RLS blocking SELECT for anon, etc.). Every 30s we re-fetch the state so the
 *  banner can never get stuck on the wrong side of a toggle for long. */
const POLL_INTERVAL_MS = 30_000;

interface UseDispatchLockResult {
  state: PayrollDispatchLockState;
  loading: boolean;
  /** Optimistically toggles + writes via the API; refresh happens via Realtime. */
  setLocked: (locked: boolean) => Promise<void>;
}

/**
 * Subscribes to `payroll.dispatch_locked` in `app_settings` and reflects state
 * changes — whether they originate from this client or a remote one — through
 * Supabase Realtime. Backed by a 30-second poll so the banner can't get stuck
 * if Realtime goes down. Mount this once at the shell level; pass the result
 * down via prop to children rather than calling the hook in multiple places.
 */
export function useDispatchLock(): UseDispatchLockResult {
  const [state, setState] = useState<PayrollDispatchLockState>(EMPTY);
  const [loading, setLoading] = useState(true);
  // Unique channel suffix so multiple useDispatchLock calls don't collide on
  // the same channel name (each subscription gets its own).
  const instanceId = useId();

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/payroll-dispatch-lock', { cache: 'no-store' });
      const json = (await res.json()) as PayrollDispatchLockState & { error?: string };
      setState({
        locked: json.locked ?? false,
        lockedAt: json.lockedAt ?? null,
        lockedBy: json.lockedBy ?? null,
      });
    } catch {
      /* ignore — keep prior state */
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial hydration.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime subscription on the lock row.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channelName = `payroll-dispatch-lock${instanceId}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_settings',
          filter: 'key=eq.payroll.dispatch_locked',
        },
        () => {
          void refetch();
        },
      )
      .subscribe((status, err) => {
        // Surface lifecycle so RLS / publication issues are easy to spot in
        // DevTools console. Silent in the happy path.
        if (status === 'SUBSCRIBED') {
          // Connected — Realtime should now fire postgres_changes events.
          // Use info level rather than log so it stands out without spamming.
          // eslint-disable-next-line no-console
          console.info(`[dispatch-lock] Realtime ready (${channelName})`);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(
            `[dispatch-lock] Realtime ${status}. Falling back to 30s poll.`,
            err,
          );
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refetch, instanceId]);

  // Belt-and-braces poll so the banner is never stuck if Realtime is down.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refetch();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  // Refresh whenever the tab regains focus — covers the case where the user
  // switched away during a long dispatch and came back after Lenny finished.
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

  const setLocked = useCallback(
    async (locked: boolean) => {
      // Optimistic update so the toggling client reacts instantly. Realtime
      // (and the response body) will reconcile with authoritative state.
      setState((prev) => ({ ...prev, locked }));
      try {
        const res = await fetch('/api/payroll-dispatch-lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ locked }),
        });
        if (!res.ok) {
          throw new Error('Could not update lock');
        }
        const json = (await res.json()) as PayrollDispatchLockState;
        setState(json);
      } catch (e) {
        await refetch();
        throw e;
      }
    },
    [refetch],
  );

  return { state, loading, setLocked };
}
