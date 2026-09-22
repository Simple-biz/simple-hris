'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  GIFT_LIVE_DEBOUNCE_MS,
  GIFT_LIVE_EVENT,
  GIFT_LIVE_POLL_MS,
  GIFT_LIVE_TOPIC,
  type GiftLivePayload,
} from '@/lib/gift-tracker/gift-live';

export type GiftLiveStatus = 'connecting' | 'live' | 'degraded';

interface Options {
  /** Reload the feed. Called debounced on a broadcast, on the poll timer, and
   *  when the tab regains focus. Keep it idempotent — the latest closure is
   *  always used, so it may depend on changing state. */
  onChange: (payload: GiftLivePayload | null) => void;
  /** Off until the sub-tab is actually open — no point holding a socket and a
   *  20s timer for a panel nobody is looking at. */
  enabled?: boolean;
}

/**
 * Keeps the "Recently filled / updated" sub-tab live: Supabase Realtime
 * **Broadcast** on the gift topic (the routes that write announce it
 * server-side), plus a poll floor and a tab-focus refresh so a dropped socket
 * degrades to "a few seconds late", never to "stale".
 *
 * BROADCAST, NOT `postgres_changes`, AND NOT THE BANK FEED'S PULSE KEY: the
 * browser client is `anon`, and both `employee_gift_shipping_details` and
 * `app_settings` are RLS-gated from it — `app_settings` by a single "Admins
 * only" policy, verified against the live catalog on 2026-09-02
 * (memory/supabase-realtime-anon-rls-dead). `PeopleBankChanges.tsx` binds
 * `postgres_changes` to an `app_settings` pulse key and says it works; Kane
 * ruled (a) on that conflict, so this surface does not inherit the channel. See
 * `src/lib/gift-tracker/gift-live.ts`.
 *
 * Returns the honest channel state so the panel can say Live vs Polling rather
 * than claiming a freshness it does not have.
 */
export function useGiftShippingLive({ onChange, enabled = true }: Options): GiftLiveStatus {
  const [status, setStatus] = useState<GiftLiveStatus>('connecting');
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setStatus('degraded');
      return;
    }

    // A public-link campaign lands in bursts — 60 saves inside 13 minutes on
    // 2026-09-22 — so every message is coalesced into one refetch rather than
    // sixty.
    const fire = (payload: GiftLivePayload | null) => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        debounce.current = null;
        cbRef.current(payload);
      }, GIFT_LIVE_DEBOUNCE_MS);
    };

    const channel = supabase.channel(GIFT_LIVE_TOPIC);
    channel.on('broadcast', { event: GIFT_LIVE_EVENT }, ({ payload }) => {
      const p = (payload ?? {}) as Partial<GiftLivePayload>;
      fire({
        channel: p.channel ?? 'external_link',
        milestones: Array.isArray(p.milestones) ? p.milestones : [],
        ts: p.ts ?? Date.now(),
      });
    });
    channel.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') setStatus('live');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setStatus('degraded');
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[gift-live] Realtime ${state} — falling back to the ${GIFT_LIVE_POLL_MS / 1000}s poll.`,
            err,
          );
        }
      }
    });

    // Poll floor — skipped while hidden; the focus listener catches up on return.
    // It also covers a write that does not broadcast at all (a staff edit through
    // the `[id]` routes, or a direct database change).
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') fire(null);
    }, GIFT_LIVE_POLL_MS);
    const onFocus = () => {
      if (document.visibilityState === 'visible') fire(null);
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);

    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      void supabase.removeChannel(channel);
    };
  }, [enabled]);

  return status;
}
