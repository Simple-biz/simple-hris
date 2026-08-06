'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/** One recently-dispatched payment for the live "being paid now" feed. */
export interface PaidFeedEntry {
  email: string;
  name: string | null;
  amountUsd: number | null;
  amountPhp: number | null;
  amountCop: number | null;
  paidAt: string;
}

/** One department in the current cycle with its paid progress. */
export interface DeptProgress {
  key: string;
  name: string;
  total: number;
  paid: number;
}

export interface PaymentsLiveState {
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  /** Most-recently-paid recipients this cycle, newest first. */
  recent: PaidFeedEntry[];
  /** True once `recent` has been populated from a real fetch at least once —
   *  NOT the same as `!loading`: a Realtime broadcast or a failed fetch can
   *  both flip `loading` false without `recent` ever holding real data. */
  recentHydrated: boolean;
  /** Departments being paid this cycle, with per-dept paid progress. */
  departments: DeptProgress[];
  loading: boolean;
  error: string | null;
}

const EMPTY: PaymentsLiveState = {
  sourceFile: null,
  label: 'Current pay week',
  total: 0,
  paid: 0,
  remaining: 0,
  recent: [],
  recentHydrated: false,
  departments: [],
  loading: true,
  error: null,
};

const POLL_INTERVAL_MS = 20_000;
const DEBOUNCE_MS = 400;

/**
 * Supabase Realtime *Broadcast* channel over which the Accounting dispatch
 * screen publishes its EXACT live counts and the CEO card consumes them.
 *
 * Why Broadcast (not postgres_changes): the browser Supabase client connects as
 * the `anon` role, and `app_settings` / `payment_dispatches` are RLS-protected
 * ("Admins only"), so postgres_changes events never reach the browser — the old
 * `app_settings` "pulse" silently never fired and the card only moved on the
 * 20s poll (i.e. "not live"). Broadcast is a pub/sub message bus that doesn't
 * touch the DB or RLS, so it reaches every subscriber; and because Accounting
 * sends the very numbers IT computed, the CEO card mirrors it by construction.
 *
 * Kept as literals in this existing client module (rather than a brand-new
 * shared file) so PayrollDispatch can import them without risking Turbopack
 * dev's "module factory is not available" on a fresh file.
 */
export const PAYMENTS_LIVE_CHANNEL = 'payments-live';
export const PAYMENTS_LIVE_EVENT_SNAPSHOT = 'snapshot';
export const PAYMENTS_LIVE_EVENT_REQUEST = 'request';

/** Exact live payment counts, broadcast by Accounting → shown by the CEO card. */
export interface PaymentsLiveSnapshot {
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
  /** Client ms timestamp; lets a consumer ignore an out-of-order replay. */
  ts: number;
}

/** How long a received broadcast "wins" over the server poll baseline. While an
 *  accountant is actively on the dispatch screen (broadcasting), the CEO shows
 *  their exact numbers; if broadcasts stop for this long the poll resumes. */
const BROADCAST_FRESH_MS = 45_000;

/**
 * Live "payments to send" progress for the current cycle. Hydrates from
 * `/api/ceo/payments-live`, then stays fresh:
 *   1. PRIMARY — the Accounting Broadcast (see PAYMENTS_LIVE_CHANNEL). When an
 *      accountant is on the Payment Dispatch screen it broadcasts its EXACT
 *      counts, which the card shows verbatim (and which a fresh broadcast keeps
 *      authoritative over the poll for BROADCAST_FRESH_MS). This is the path that
 *      actually reaches the browser — RLS blocks the postgres_changes ones below.
 *   2. A 20s poll of the server baseline — used when no accountant is publishing
 *      (nobody on the dispatch tab); its `total` is an approximation of the
 *      dispatch queue, so the card can read slightly high while idle.
 *   3. A refetch on tab focus.
 *   4. Legacy postgres_changes channels (app_settings pulse + payment_dispatches)
 *      — kept as a no-cost bonus for any admin whose JWT can read those tables;
 *      they never fire for the anon browser, hence the Broadcast path above.
 */
export function usePaymentsLive(): PaymentsLiveState {
  const [state, setState] = useState<PaymentsLiveState>(EMPTY);
  const instanceId = useId();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last Accounting broadcast we applied. A fresh one makes the
  // server poll defer (below) so it can't stomp Accounting's exact numbers.
  const lastBroadcastAtRef = useRef(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/ceo/payments-live', { cache: 'no-store' });
      const json = (await res.json()) as Omit<PaymentsLiveState, 'loading'> & { error?: string };
      // While a recent Accounting broadcast is authoritative, keep its exact
      // counts and only let the poll refresh the poll-driven parts (the
      // "recently paid" feed + the department breakdown) — don't overwrite
      // total/paid/remaining with the (possibly divergent) baseline.
      if (Date.now() - lastBroadcastAtRef.current < BROADCAST_FRESH_MS) {
        setState((prev) => ({
          ...prev,
          recent: Array.isArray(json.recent) ? json.recent : prev.recent,
          departments: Array.isArray(json.departments) ? json.departments : prev.departments,
          loading: false,
          recentHydrated: true,
        }));
        return;
      }
      setState({
        sourceFile: json.sourceFile ?? null,
        label: json.label ?? 'Current pay week',
        total: json.total ?? 0,
        paid: json.paid ?? 0,
        remaining: json.remaining ?? 0,
        recent: Array.isArray(json.recent) ? json.recent : [],
        departments: Array.isArray(json.departments) ? json.departments : [],
        loading: false,
        recentHydrated: true,
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

  // PRIMARY live path: the Accounting dispatch screen broadcasts its exact
  // counts on PAYMENTS_LIVE_CHANNEL. Broadcast is RLS-independent, so — unlike
  // the postgres_changes channels above — it actually reaches this anon browser.
  // On connect we ask any present publisher to replay its current snapshot, so a
  // CEO who opens the dashboard mid-cycle gets Accounting's numbers immediately.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase.channel(PAYMENTS_LIVE_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    channel.on('broadcast', { event: PAYMENTS_LIVE_EVENT_SNAPSHOT }, ({ payload }) => {
      const p = (payload ?? {}) as Partial<PaymentsLiveSnapshot>;
      if (typeof p.total !== 'number') return;
      lastBroadcastAtRef.current = Date.now();
      const total = p.total ?? 0;
      const paid = p.paid ?? 0;
      setState((prev) => ({
        ...prev,
        sourceFile: p.sourceFile ?? null,
        label: p.label ?? 'Current pay week',
        total,
        paid,
        remaining: typeof p.remaining === 'number' ? p.remaining : Math.max(0, total - paid),
        // `recent` stays poll-driven — Accounting doesn't publish the feed.
        loading: false,
        error: null,
      }));
    });
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        void channel.send({
          type: 'broadcast',
          event: PAYMENTS_LIVE_EVENT_REQUEST,
          payload: {},
        });
      }
    });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

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

/**
 * Accounting-side publisher: broadcasts the dispatch screen's EXACT live counts
 * on {@link PAYMENTS_LIVE_CHANNEL} so the CEO "Payments to send" card mirrors
 * them in real time. Fires on every change (mount, mark-paid → refresh, undo,
 * wizard lock flip) and replays on demand when a CEO joins and asks. No-op while
 * `enabled` is false (e.g. viewing a past week, queue not ready) so only the
 * live cycle is ever published.
 */
export function usePaymentsLivePublisher(snapshot: {
  enabled: boolean;
  sourceFile: string | null;
  label: string;
  total: number;
  paid: number;
  remaining: number;
}): void {
  const { enabled, sourceFile, label, total, paid, remaining } = snapshot;

  // Latest snapshot in a ref so the on-request responder always has current
  // data without re-subscribing. `null` = nothing to publish right now.
  const latestRef = useRef<Omit<PaymentsLiveSnapshot, 'ts'> | null>(null);
  latestRef.current =
    enabled && sourceFile ? { sourceFile, label, total, paid, remaining } : null;

  // Stable flush() reference the change-effect can call after each render.
  const flushRef = useRef<(() => void) | null>(null);

  // Subscribe once; wire the request-responder and expose flush().
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    let ready = false;
    const channel = supabase.channel(PAYMENTS_LIVE_CHANNEL, {
      config: { broadcast: { self: false } },
    });
    const flush = () => {
      const snap = latestRef.current;
      if (!ready || !snap) return;
      void channel.send({
        type: 'broadcast',
        event: PAYMENTS_LIVE_EVENT_SNAPSHOT,
        payload: { ...snap, ts: Date.now() },
      });
    };
    flushRef.current = flush;
    channel.on('broadcast', { event: PAYMENTS_LIVE_EVENT_REQUEST }, () => flush());
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ready = true;
        flush();
      }
    });
    return () => {
      flushRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, []);

  // Re-broadcast whenever the numbers (or enabled) change.
  useEffect(() => {
    flushRef.current?.();
  }, [enabled, sourceFile, label, total, paid, remaining]);
}
