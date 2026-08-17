'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { toast } from 'sonner';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { renderNotificationToast } from '@/components/notifications/NotificationToast';
import type { AppView } from '@/lib/rbac/views';

/** Stable id so repeated alerts replace one another — only ever one toast. */
const NOTIF_TOAST_ID = 'notification-alert';

type NotificationRow = {
  id: string;
  type?: string | null;
  title?: string | null;
  message?: string | null;
  read_at?: string | null;
  created_at?: string | null;
};

/**
 * Plays a short bell chime + shows a toast whenever the viewer gains a NEW
 * unread `employee_notifications` row — e.g. a hire submitting their onboarding
 * form, a transfer request, a payroll-lock alert.
 *
 * Used by privileged dashboards (e.g. HR) so staff are alerted the moment
 * something needs them, regardless of which tab they're on. The bell is
 * synthesized with the Web Audio API so it ships no binary asset.
 *
 * Reliability: the bell is driven by the *unread set* (fetched through the
 * gated `GET /api/employee-notifications`, refreshed on Supabase Realtime AND a
 * polling fallback AND tab focus), NOT by a single raw Realtime INSERT event.
 * That means it still rings if a Realtime event is dropped/throttled, if the
 * tab was backgrounded, or if the notification already existed at load — the
 * old INSERT-only path silently missed all three. A per-email localStorage
 * high-water mark plus a session id-set ensures each notification chimes at
 * most once (no re-chime on refresh, tab switch, or read/delete churn).
 *
 * Gating is handled server-side: the GET excludes feature-gated types the
 * viewer isn't permitted to see (e.g. onboarding paperwork without the HR
 * Onboarding grant), so this hook needs no client-side predicate.
 *
 * `opts.view` scopes the alert to ONE dashboard's notifications, matching what
 * that dashboard's panel and sidebar badge already show
 * (`useEmployeeNotificationsUnread`). Pass it: unscoped, the GET returns EVERY
 * type the viewer may see, so someone holding two roles gets alerted on the
 * wrong dashboard — an accounting-only money alert (`people.banking.self_updated`
 * is mapped away from HR in notification-views.ts) would still chime and toast
 * while they sat on the HR dashboard.
 */
/**
 * High-water-mark key, **view-scoped** whenever the caller scopes its fetch.
 * Two dashboards alerting the same person read different SLICES of one unread
 * set, so a shared mark lets a notification alerted on dashboard A push the mark
 * past an older one belonging to dashboard B — silencing it permanently. The
 * legacy (unscoped) key is read as a fallback when the scoped one is absent, so
 * introducing the scope doesn't re-ring everybody's existing backlog once.
 */
const HW_KEY = (email: string, view?: AppView) =>
  view ? `notif-chime-hw:${email}:${view}` : `notif-chime-hw:${email}`;
const LEGACY_HW_KEY = (email: string) => `notif-chime-hw:${email}`;

/** Two-tone bell: a bright strike plus a softer overtone, each decaying. */
function playBell(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const tones: Array<[number, number, number]> = [
    [880, 0, 0.18],
    [1320, 0.08, 0.12],
  ];
  for (const [freq, delay, gain] of tones) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, now + delay);
    env.gain.linearRampToValueAtTime(gain, now + delay + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.6);
    osc.connect(env).connect(ctx.destination);
    osc.start(now + delay);
    osc.stop(now + delay + 0.65);
  }
}

/** Lazily construct the AudioContext (browsers allow this any time; it just
 *  starts 'suspended' until a user gesture resumes it). */
function ensureCtx(ref: RefObject<AudioContext | null>): AudioContext | null {
  if (!ref.current) {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) ref.current = new Ctx();
    } catch {
      /* no Web Audio support — toast still fires, just no sound */
    }
  }
  return ref.current;
}

/**
 * Try to ring the bell now. If the AudioContext can't run yet (browser autoplay
 * policy blocks audio until the first user gesture), flag `pendingRef` so the
 * gesture-unlock handler rings it the instant the user interacts.
 */
function tryChime(
  ctxRef: RefObject<AudioContext | null>,
  pendingRef: RefObject<boolean>,
): void {
  const ctx = ensureCtx(ctxRef);
  if (!ctx) return;
  if (ctx.state === 'running') {
    playBell(ctx);
    return;
  }
  // Suspended (no gesture yet, or backgrounded tab): attempt resume, and queue
  // a retry on the next user gesture in case resume() is blocked right now.
  pendingRef.current = true;
  void ctx
    .resume()
    .then(() => {
      if (ctx.state === 'running' && pendingRef.current) {
        pendingRef.current = false;
        playBell(ctx);
      }
    })
    .catch(() => {
      /* stays pending; the unlock handler will flush it */
    });
}

export function useNotificationChime(
  email?: string | null,
  opts?: { view?: AppView },
): void {
  const normalized = email ? email.trim().toLowerCase() : null;
  // Read off the object so the effect depends on a primitive — an inline
  // `{ view: 'accounting' }` is a new identity every render and would resubscribe.
  const view = opts?.view;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const pendingSoundRef = useRef(false);
  // Ids chimed this page session — guards against the same row arriving via
  // both the Realtime event and the poll, or surviving across tab switches.
  const chimedIdsRef = useRef<Set<string>>(new Set());

  // Browser autoplay policies block audio until a user gesture. Create/resume
  // the AudioContext on the first interaction, and flush any chime that was
  // requested while audio was still locked.
  useEffect(() => {
    const unlock = () => {
      const ctx = ensureCtx(audioCtxRef);
      if (!ctx) return;
      void ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running' && pendingSoundRef.current) {
            pendingSoundRef.current = false;
            playBell(ctx);
          }
        })
        .catch(() => {});
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!normalized) return;
    let cancelled = false;

    const processUnread = (unread: NotificationRow[]) => {
      // High-water mark (epoch ms) of the newest notification already chimed,
      // persisted per (email, view) so a refresh / re-login doesn't re-ring the
      // backlog — and so one dashboard's alert can't silence another's.
      let hw = 0;
      try {
        const raw =
          window.localStorage.getItem(HW_KEY(normalized, view)) ??
          window.localStorage.getItem(LEGACY_HW_KEY(normalized));
        if (raw) hw = parseInt(raw, 10) || 0;
      } catch {
        /* localStorage unavailable (private mode) — fall back to session ids */
      }

      const fresh = unread.filter((n) => {
        if (chimedIdsRef.current.has(n.id)) return false;
        const ts = n.created_at ? Date.parse(n.created_at) : 0;
        return Number.isFinite(ts) && ts > hw;
      });
      if (fresh.length === 0) return;

      let maxTs = hw;
      for (const n of fresh) {
        chimedIdsRef.current.add(n.id);
        const ts = n.created_at ? Date.parse(n.created_at) : 0;
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
      }
      try {
        window.localStorage.setItem(HW_KEY(normalized, view), String(maxTs));
      } catch {
        /* ignore */
      }

      // Toast the newest fresh notification; note how many more arrived with it.
      // A stable id + top-right position keeps it to a single themed toast.
      const newest = fresh.reduce((a, b) =>
        Date.parse(b.created_at ?? '') > Date.parse(a.created_at ?? '') ? b : a,
      );
      toast.custom(
        (tid) =>
          renderNotificationToast({
            id: tid,
            title: newest.title ?? 'New notification',
            message: newest.message,
            count: fresh.length,
          }),
        { id: NOTIF_TOAST_ID, duration: 8000, position: 'top-right', unstyled: true },
      );

      tryChime(audioCtxRef, pendingSoundRef);
    };

    const refetch = async () => {
      try {
        // Same query shape as useEmployeeNotificationsUnread, so the alert and
        // the sidebar badge can never disagree about what belongs to this view.
        const params = new URLSearchParams({ email: normalized });
        if (view) params.set('view', view);
        const res = await fetch(
          `/api/employee-notifications?${params.toString()}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { notifications?: NotificationRow[] };
        if (cancelled) return;
        processUnread((json.notifications ?? []).filter((n) => !n.read_at));
      } catch {
        /* keep prior state; the poll will retry */
      }
    };

    // 1) Reconcile on mount (catches notifications that arrived while away).
    void refetch();

    // 2) Realtime: re-check on any change for this recipient.
    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      ? supabase
          .channel(`notification-chime-${normalized}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'employee_notifications',
              filter: `recipient_email=eq.${normalized}`,
            },
            () => {
              void refetch();
            },
          )
          .subscribe()
      : null;

    // 3) Polling fallback (in case a Realtime event is dropped/throttled) +
    //    re-check when the tab regains focus.
    const pollId = window.setInterval(() => {
      void refetch();
    }, 30_000);
    const onFocus = () => {
      void refetch();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      if (supabase && channel) void supabase.removeChannel(channel);
    };
  }, [normalized, view]);
}
