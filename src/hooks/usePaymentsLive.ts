'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

export interface PaymentsLiveState {
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  loading: boolean;
  error: string | null;
}

const EMPTY: PaymentsLiveState = {
  sourceFile: null,
  label: 'Current pay week',
  total: 0,
  paid: 0,
  remaining: 0,
  loading: true,
  error: null,
};

const POLL_INTERVAL_MS = 20_000;
const DEBOUNCE_MS = 400;

/**
 * Live "payments to send" progress for the current cycle. Hydrates from
 * `/api/ceo/payments-live`, then stays fresh three ways (the project's standard
 * Realtime + poll + focus trio):
 *   1. Supabase Realtime on `payment_dispatches` — fires the instant anyone
 *      marks a worker paid (INSERT) or undoes it (DELETE), so the count ticks
 *      down / back up live. Requires payment_dispatches in the realtime
 *      publication (references/sql/alter/add_payment_dispatches_to_realtime.sql).
 *   2. A 20s poll as a fallback if Realtime is down (missing publication / RLS).
 *   3. A refetch on tab focus.
 */
export function usePaymentsLive(): PaymentsLiveState {
  const [state, setState] = useState<PaymentsLiveState>(EMPTY);
  const instanceId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/ceo/payments-live', { cache: 'no-store' });
      const json = (await res.json()) as Omit<PaymentsLiveState, 'loading'> & { error?: string };
      setState({
        sourceFile: json.sourceFile ?? null,
        label: json.label ?? 'Current pay week',
        total: json.total ?? 0,
        paid: json.paid ?? 0,
        remaining: json.remaining ?? 0,
        loading: false,
        error: json.error ?? null,
      });
    } catch {
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  const debouncedRefetch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void refetch();
    }, DEBOUNCE_MS);
  }, [refetch]);

  // Initial hydration.
  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime, two independent channels so a bad binding on one can't silence
  // the other:
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    // RELIABLE: every Mark Paid / Undo bumps the `payroll.payments.pulse`
    // app_settings key, and app_settings is proven to reach the browser over
    // Realtime (it's what the dispatch-lock banner uses). Kept literal — see
    // PAYMENTS_LIVE_PULSE_KEY in src/lib/supabase/app-settings.ts.
    const pulseChannel = supabase
      .channel(`ceo-payments-pulse${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_settings', filter: 'key=eq.payroll.payments.pulse' },
        () => debouncedRefetch(),
      )
      .subscribe();

    // BONUS: direct payment_dispatches changes, if Realtime delivers them (needs
    // the table in the publication + readable by the anon client). On its own
    // channel so a binding error here can't take down the pulse channel above.
    const directChannel = supabase
      .channel(`ceo-payments-direct${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'payment_dispatches' },
        () => debouncedRefetch(),
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // eslint-disable-next-line no-console
          console.warn(
            `[payments-live] direct payment_dispatches Realtime ${status}; ` +
              `relying on the app_settings pulse + ${POLL_INTERVAL_MS / 1000}s poll.`,
            err,
          );
        }
      });

    return () => {
      void supabase.removeChannel(pulseChannel);
      void supabase.removeChannel(directChannel);
    };
  }, [debouncedRefetch, instanceId]);

  // Poll fallback.
  useEffect(() => {
    const id = window.setInterval(() => void refetch(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refetch]);

  // Refresh on tab refocus.
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refetch]);

  return state;
}
