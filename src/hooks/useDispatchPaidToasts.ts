'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { playPaymentConfirmed } from '@/lib/sound/ping-chime';
import {
  PAID_TOAST_CHIME_STAGGER_MS,
  PAID_TOAST_EVENT,
  PAID_TOAST_LOCAL_EVENT,
  PAID_TOAST_POLL_MS,
  PAID_TOAST_REMOTE_EVENT,
  PAID_TOAST_TOPIC,
  PAID_TOAST_TTL_MS,
  foldRecentPaidRows,
  parsePaidToastPayload,
  pushPaidToast,
  type PaidToastEvent,
  type RecentPaidRowLike,
} from '@/lib/payroll/dispatch-paid-toast';

export interface DispatchPaidToastsState {
  /** Oldest first, newest last (= bottom of the lower-left stack). */
  stack: PaidToastEvent[];
  dismiss: (id: string) => void;
}

interface RecentPaidResponse {
  rows?: RecentPaidRowLike[];
  latest?: string | null;
  truncated?: boolean;
  now?: string;
  error?: string | null;
}

/**
 * The live half of the Payment Dispatch "paid" toast. Mounted ONCE per document
 * from the root layout (DispatchPaidToastsGlobal) with the global dispatch lock
 * and the viewer's email. Three delivery paths feed one de-duped stack:
 *
 *  - LOCAL: PayrollDispatch's Mark Paid handler fires `hris:dispatch-paid` on
 *    `window` after each successful paid POST leg. We show the card and
 *    re-broadcast it. No chime — MarkPaidDialog already played
 *    `playPaymentConfirmed` on this browser for that confirm.
 *  - REMOTE (Broadcast): every other Accounting shell running this code hears
 *    `payment-dispatch-paid` and shows the same card WITH the chime.
 *  - REMOTE (poll): while locked and visible, `GET /api/payment-dispatches/
 *    recent-paid?since=` every 10 s. This is what catches a payer whose browser
 *    cannot broadcast — an older production build, a down socket, a write from
 *    outside the app. The server sets the watermark (never this clock), OWN
 *    rows are skipped (the local path owns them), and rows older than 90 s only
 *    advance the watermark.
 *
 * The poll's first answer is also the AUTHORIZATION probe: 200 means this
 * viewer has Accounting → Payment Dispatch view access (or is admin) and remote
 * cards may render; 401/403 stops the poll and no remote card ever renders on
 * this document. Mounted from the root layout on every dashboard, so that
 * server verdict is the only gate — no client-side RBAC copy.
 *
 * Nothing shows while `locked` is false, and flipping the lock off clears the
 * stack. De-dupe is by dispatch row id, so a payment arriving on two paths is
 * one card and one chime.
 */
export function useDispatchPaidToasts(
  locked: boolean,
  selfEmail: string | null | undefined,
): DispatchPaidToastsState {
  const [stack, setStack] = useState<PaidToastEvent[]>([]);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const seenRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());
  const chimeTimersRef = useRef<number[]>([]);
  const nextChimeAtRef = useRef(0);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelReadyRef = useRef(false);
  // Who may see remote payments is the SERVER's call: the recent-paid route's
  // first answer (200 vs 401/403) sets this. `null` = not yet known. Remote
  // cards (broadcast + poll) require `true`; the local path does not — a browser
  // that just had a paid POST accepted is authorized by construction.
  const authorizedRef = useRef<boolean | null>(null);
  const self = (selfEmail ?? '').trim().toLowerCase() || null;

  const dismiss = useCallback((id: string) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timersRef.current.delete(id);
    }
    setStack((prev) => (prev.some((x) => x.id === id) ? prev.filter((x) => x.id !== id) : prev));
  }, []);

  const push = useCallback(
    (evt: PaidToastEvent, opts: { chime: boolean; remote: boolean }) => {
      if (!lockedRef.current) return;
      if (opts.remote && authorizedRef.current !== true) return;
      // The server now broadcasts every paid row, so a payer hears their OWN
      // payment back over the wire. The local path already showed and chimed
      // it; a remote echo of our own actor must never mint a card or a chime.
      if (opts.remote && self && evt.by === self) return;
      if (seenRef.current.has(evt.id)) return;
      seenRef.current.add(evt.id);
      setStack((prev) => pushPaidToast(prev, evt));
      // Tell the Payment Dispatch table (if this document is showing it) so the
      // paid person leaves the queue the same instant the card appears.
      if (opts.remote) {
        window.dispatchEvent(new CustomEvent(PAID_TOAST_REMOTE_EVENT, { detail: evt }));
      }
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
    [dismiss, self],
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
    authorizedRef.current = null;
    setStack([]);
  }, [locked]);

  // REMOTE path 1 — Realtime Broadcast, RLS-independent (see the lib header).
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
      if (evt) push(evt, { chime: true, remote: true });
    });
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') channelReadyRef.current = true;
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        channelReadyRef.current = false;
        // eslint-disable-next-line no-console
        console.warn(`[dispatch-paid-toast] Realtime ${status} — relying on the poll.`, err);
      }
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channelReadyRef.current = false;
      void supabase.removeChannel(channel);
    };
  }, [push]);

  // REMOTE path 2 — the poll. Runs only while locked; the first request carries
  // no `since` and only fetches the server's watermark, so opening a screen
  // mid-cycle replays nothing.
  useEffect(() => {
    if (!locked) return;
    let cancelled = false;
    let stopped = false;
    let since: string | null = null;
    let timer: number | null = null;

    const schedule = () => {
      if (cancelled || stopped) return;
      timer = window.setTimeout(() => void tick(), PAID_TOAST_POLL_MS);
    };

    const tick = async (): Promise<void> => {
      if (cancelled || stopped) return;
      if (document.visibilityState !== 'visible') {
        schedule();
        return;
      }
      try {
        const url = since
          ? `/api/payment-dispatches/recent-paid?since=${encodeURIComponent(since)}`
          : '/api/payment-dispatches/recent-paid';
        const res = await fetch(url, { cache: 'no-store' });
        if (cancelled) return;
        if (res.status === 401 || res.status === 403) {
          // Not authorized for this surface — nothing renders on this document
          // until the lock cycles (a grant change takes effect next run).
          authorizedRef.current = false;
          stopped = true;
          return;
        }
        const json = (await res.json()) as RecentPaidResponse;
        if (!res.ok || json.error) {
          schedule();
          return;
        }
        authorizedRef.current = true;
        const serverNow = typeof json.now === 'string' ? Date.parse(json.now) : NaN;
        if (since) {
          const { events } = foldRecentPaidRows(json.rows ?? [], {
            selfEmail: self,
            serverNow: Number.isFinite(serverNow) ? serverNow : Date.now(),
          });
          for (const evt of events) push(evt, { chime: true, remote: true });
        }
        const prev = since;
        if (typeof json.latest === 'string' && json.latest) since = json.latest;
        else if (!since) since = typeof json.now === 'string' ? json.now : new Date().toISOString();
        // A full page means more is waiting — continue now, but only if the
        // watermark actually moved (a page of identical timestamps must not
        // spin; the toast cap makes those extra rows irrelevant anyway).
        if (json.truncated && since !== prev) {
          void tick();
          return;
        }
      } catch {
        /* network blip — keep the watermark, try again next tick */
      }
      schedule();
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer !== null) window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [locked, self, push]);

  // LOCAL path — the Mark Paid handler on THIS document. Show, then tell
  // everyone else. Broadcast is unconditional: the paying screen's own lock
  // state is not the receiver's.
  useEffect(() => {
    const onLocal = (e: Event) => {
      const evt = parsePaidToastPayload((e as CustomEvent<unknown>).detail);
      if (!evt) return;
      push(evt, { chime: false, remote: false });
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
