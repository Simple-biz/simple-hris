'use client';

import { useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  FPU_LIVE_DEBOUNCE_MS,
  FPU_LIVE_EVENT,
  FPU_LIVE_POLL_MS,
  FPU_LIVE_TOPIC,
  type FpuLivePayload,
} from '@/lib/mesa/fpu-live';

export type FpuLiveStatus = 'connecting' | 'live' | 'degraded';

interface Options {
  /** Reload the view. Called debounced on a broadcast, on the poll timer, and
   *  when the tab regains focus. Keep it idempotent — the latest closure is
   *  always used, so it may depend on changing state. */
  onChange: (payload: FpuLivePayload | null) => void;
  /** Off until the first load has painted (or while the migration is absent). */
  enabled?: boolean;
  /** Optional: only react to changes that name one of these emails (the
   *  employee view), or that carry no email list at all. */
  emails?: string[];
}

/**
 * Keeps an FPU surface live: Supabase Realtime **Broadcast** on the FPU topic
 * (the routes that write announce it server-side), plus a poll floor and a
 * tab-focus refresh so a dropped socket degrades to "a few seconds late", never
 * to "stale". Modeled on useDispatchQueue's sync channel.
 *
 * Returns the honest channel state so a view can show Live vs Polling.
 */
export function useFpuLive({ onChange, enabled = true, emails }: Options): FpuLiveStatus {
  const [status, setStatus] = useState<FpuLiveStatus>('connecting');
  const cbRef = useRef(onChange);
  cbRef.current = onChange;
  const emailsKey = (emails ?? []).map((e) => e.trim().toLowerCase()).sort().join(',');
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setStatus('degraded');
      return;
    }
    const mine = new Set(emailsKey ? emailsKey.split(',') : []);

    const fire = (payload: FpuLivePayload | null) => {
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => {
        debounce.current = null;
        cbRef.current(payload);
      }, FPU_LIVE_DEBOUNCE_MS);
    };

    const channel = supabase.channel(FPU_LIVE_TOPIC);
    channel.on('broadcast', { event: FPU_LIVE_EVENT }, ({ payload }) => {
      const p = (payload ?? {}) as Partial<FpuLivePayload>;
      if (mine.size && Array.isArray(p.emails) && p.emails.length && !p.emails.some((e) => mine.has(e.toLowerCase()))) return;
      fire({ kind: p.kind === 'class' ? 'class' : 'enrollment', classId: p.classId ?? null, emails: p.emails, ts: p.ts ?? Date.now() });
    });
    channel.subscribe((state, err) => {
      if (state === 'SUBSCRIBED') setStatus('live');
      else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setStatus('degraded');
        if (err) {
          // eslint-disable-next-line no-console
          console.warn(`[fpu-live] Realtime ${state} — falling back to the ${FPU_LIVE_POLL_MS / 1000}s poll.`, err);
        }
      }
    });

    // Poll floor — skipped while hidden; the focus listener catches up on return.
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') fire(null);
    }, FPU_LIVE_POLL_MS);
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
  }, [enabled, emailsKey]);

  return status;
}
