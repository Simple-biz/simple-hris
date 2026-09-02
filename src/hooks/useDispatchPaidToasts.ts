'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { playPaymentConfirmed } from '@/lib/sound/ping-chime';
import {
  PAID_TOAST_CHIME_STAGGER_MS,
  PAID_TOAST_EVENT,
  PAID_TOAST_LOCAL_EVENT,
  PAID_TOAST_TOPIC,
  PAID_TOAST_TTL_MS,
  parsePaidToastPayload,
  pushPaidToast,
  type PaidToastEvent,
} from '@/lib/payroll/dispatch-paid-toast';

export interface DispatchPaidToastsState {
  /** Oldest first, newest last (= bottom of the lower-left stack). */
  stack: PaidToastEvent[];
  dismiss: (id: string) => void;
}

/**
 * The live half of the Payment Dispatch "paid" toast. Mount ONCE per Accounting
 * shell (App.tsx) and pass the global dispatch lock:
 *
 *  - LOCAL: PayrollDispatch's Mark Paid handler fires `hris:dispatch-paid` on
 *    `window` after each successful paid POST leg. We show the card and
 *    re-broadcast it. No chime — MarkPaidDialog already played
 *    `playPaymentConfirmed` on this browser for that confirm.
 *  - REMOTE: every other Accounting shell hears the Broadcast on
 *    `payment-dispatch-paid` and shows the same card, WITH the chime
 *    (staggered like the CEO "Being paid now" rail so a burst reads as a
 *    cascade, not a chord).
 *
 * Nothing shows while `locked` is false — the toast is a processing-time
 * surface — and flipping the lock off clears whatever is still on screen.
 * De-dupe is by dispatch row id, so the same payment arriving twice (local +
 * wire, or a retried send) is one card.
 */
export function useDispatchPaidToasts(locked: boolean): DispatchPaidToastsState {
  const [stack, setStack] = useState<PaidToastEvent[]>([]);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const seenRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());
  const chimeTimersRef = useRef<number[]>([]);
  const nextChimeAtRef = useRef(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelReadyRef = useRef(false);

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timersRef.current.delete(id);
    }
    setStack((prev) => (prev.some((x) => x.id === id) ? prev.filter((x) => x.id !== id) : prev));
  }, []);

  const push = useCallback(
    (evt: PaidToastEvent, opts: { chime: boolean }) => {
      if (!lockedRef.current) return;
      if (seenRef.current.has(evt.id)) return;
      seenRef.current.add(evt.id);
      setStack((prev) => pushPaidToast(prev, evt));
      timersRef.current.set(
        evt.id,
        window.setTimeout(() => dismiss(evt.id), PAID_TOAST_TTL_MS),
      );
      if (opts.chime) {
        const now = Date.now();
        const playAt = Math.max(now, nextChimeAtRef.current);
        chimeTimersRef.current.push(window.setTimeout(playPaymentConfirmed, playAt - now));
        nextChimeAtRef.current = playAt + PAID_TOAST_CHIME_STAGGER_MS;
      }
    },
    [dismiss],
  );

  // Lock OFF → the surface is gone: clear cards, timers, queued chimes and the
  // de-dupe memory (a new processing run starts fresh).
  useEffect(() => {
    if (locked) return;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current.clear();
    chimeTimersRef.current.forEach((t) => window.clearTimeout(t));
    chimeTimersRef.current = [];
    nextChimeAtRef.current = 0;
    seenRef.current.clear();
    setStack([]);
  }, [locked]);

  // REMOTE path — Realtime Broadcast, RLS-independent (see the lib header).
  // Subscribed regardless of the lock so the socket is already up the moment
  // processing starts.
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(PAID_TOAST_TOPIC, {
      // Our own payments are shown from the local event; hearing them back
      // would only race the de-dupe.
      config: { broadcast: { self: false } },
    });
    channel.on('broadcast', { event: PAID_TOAST_EVENT }, ({ payload }) => {
      const evt = parsePaidToastPayload(payload);
      if (evt) push(evt, { chime: true });
    });
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') channelReadyRef.current = true;
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        channelReadyRef.current = false;
        // eslint-disable-next-line no-console
        console.warn(`[dispatch-paid-toast] Realtime ${status} — remote paid toasts paused.`, err);
      }
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channelReadyRef.current = false;
      void supabase.removeChannel(channel);
    };
  }, [push]);

  // LOCAL path — the Mark Paid handler on THIS document. Show, then tell
  // everyone else. Broadcast is unconditional: the paying screen's own lock
  // state is not the receiver's.
  useEffect(() => {
    const onLocal = (e: Event) => {
      const evt = parsePaidToastPayload((e as CustomEvent<unknown>).detail);
      if (!evt) return;
      push(evt, { chime: false });
      const channel = channelRef.current;
      if (channel && channelReadyRef.current) {
        void channel.send({ type: 'broadcast', event: PAID_TOAST_EVENT, payload: evt });
      }
    };
    window.addEventListener(PAID_TOAST_LOCAL_EVENT, onLocal);
    return () => window.removeEventListener(PAID_TOAST_LOCAL_EVENT, onLocal);
  }, [push]);

  // Unmount: nothing may fire for a shell that is gone.
  useEffect(() => {
    return () => {
      timersRef.current.forEach((t) => window.clearTimeout(t));
      chimeTimersRef.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  return { stack, dismiss };
}

/** Fire from the paying browser after a successful `paid` POST. Kept here so
 *  the Mark Paid handler never touches the channel itself. */
export function announceDispatchPaid(evt: PaidToastEvent): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PAID_TOAST_LOCAL_EVENT, { detail: evt }));
}
