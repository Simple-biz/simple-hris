'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

interface UseLiveRefreshOptions {
  /** Postgres tables to watch for INSERT/UPDATE/DELETE (public schema). */
  tables: string[];
  /** Invoked (debounced) when a watched table changes, on the poll timer, or
   *  when the tab regains focus. Keep it cheap and idempotent — it may fire
   *  often, and from this client's own writes too. The latest closure is always
   *  used, so it's safe to depend on changing state inside it. */
  onRefresh: () => void;
  /** Channel-name base; an instance suffix is appended so concurrent mounts
   *  don't collide on one Realtime channel. */
  channel: string;
  /** Polling fallback — re-runs `onRefresh` on this interval even when Realtime
   *  is down or the tables aren't in the `supabase_realtime` publication.
   *  Default 30s. Pass 0 to disable polling. */
  pollMs?: number;
  /** Coalesce bursts of Realtime events into a single refresh. Default 600ms. */
  debounceMs?: number;
  /** Gate the whole thing — no subscription, poll, or focus listener while
   *  false (e.g. before the first load, or nothing visible yet). */
  enabled?: boolean;
}

/**
 * Keeps a view live without manual reloads: subscribes to Supabase Realtime
 * `postgres_changes` on the given tables, backed by a polling fallback and a
 * focus/visibility refresh. Modeled on {@link useDispatchLock}.
 *
 * Realtime only fires if the tables are in the `supabase_realtime` publication.
 * If they aren't, the poll (and tab-focus refresh) still keep the view fresh —
 * just on a delay — so the feature degrades gracefully.
 */
export function useLiveRefresh({
  tables,
  onRefresh,
  channel,
  pollMs = 30_000,
  debounceMs = 600,
  enabled = true,
}: UseLiveRefreshOptions) {
  const instanceId = useId();
  // Hold the latest callback in a ref so changing it never re-subscribes the
  // Realtime channel (subscribing/unsubscribing churns the websocket).
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;
  const timer = useRef<number | null>(null);
  // Stable key so the effect re-runs only when the *set* of tables changes.
  const tableKey = tables.join(',');

  const fire = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      cbRef.current();
    }, debounceMs);
  }, [debounceMs]);

  // Realtime subscription on the watched tables.
  useEffect(() => {
    if (!enabled || !tableKey) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channelName = `${channel}-${instanceId}`;
    let ch = supabase.channel(channelName);
    for (const table of tableKey.split(',')) {
      ch = ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => fire(),
      );
    }
    ch.subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // eslint-disable-next-line no-console
        console.warn(`[${channel}] Realtime ${status}; relying on ${pollMs}ms poll.`, err);
      }
    });

    return () => {
      void supabase.removeChannel(ch);
    };
  }, [enabled, channel, instanceId, tableKey, fire, pollMs]);

  // Polling fallback — never lets the view get stuck if Realtime is unavailable.
  useEffect(() => {
    if (!enabled || !pollMs) return;
    const id = window.setInterval(() => cbRef.current(), pollMs);
    return () => window.clearInterval(id);
  }, [enabled, pollMs]);

  // Refresh whenever the tab regains focus — covers changes made while away.
  // Route through the debounced `fire()` (not cbRef.current() directly): a single
  // alt-tab back typically emits BOTH a window 'focus' and a document
  // 'visibilitychange', so calling directly would fire onRefresh twice. Debouncing
  // coalesces them into one refresh — important when onRefresh hits an expensive
  // endpoint, where duplicate concurrent calls only slow each other down.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => fire();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [enabled, fire]);

  // Drop any pending debounced refresh on unmount.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
}
