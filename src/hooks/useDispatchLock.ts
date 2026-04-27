'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PayrollDispatchLockState } from '@/lib/supabase/payroll-dispatch-lock';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

const EMPTY: PayrollDispatchLockState = { locked: false, lockedAt: null, lockedBy: null };

interface UseDispatchLockResult {
  state: PayrollDispatchLockState;
  loading: boolean;
  /** Optimistically toggles + writes via the API; refresh happens via Realtime. */
  setLocked: (locked: boolean) => Promise<void>;
}

/**
 * Subscribes to the `payroll.dispatch_locked` flag in `app_settings` and
 * reflects state changes (whether they originate from this client or a remote
 * one) immediately via Supabase Realtime. Used by both Lenny's dispatch view
 * and the employee dispute UI.
 */
export function useDispatchLock(): UseDispatchLockResult {
  const [state, setState] = useState<PayrollDispatchLockState>(EMPTY);
  const [loading, setLoading] = useState(true);

  // Initial fetch from REST so we hydrate before the Realtime channel attaches.
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

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime subscription on app_settings rows whose key matches the lock keys.
  // Any UPDATE pulled by Postgres triggers a refetch — simpler than parsing
  // each individual key change since we need all three (locked / at / by).
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel('payroll-dispatch-lock')
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
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refetch]);

  const setLocked = useCallback(
    async (locked: boolean) => {
      // Optimistic update so the UI reacts instantly. Realtime will reconcile.
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
        // Roll back optimistic state.
        await refetch();
        throw e;
      }
    },
    [refetch],
  );

  return { state, loading, setLocked };
}
