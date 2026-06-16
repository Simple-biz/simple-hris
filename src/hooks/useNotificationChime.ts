'use client';

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

type IncomingNotification = {
  type?: string | null;
  title?: string | null;
  message?: string | null;
};

/**
 * Plays a short bell chime + shows a toast whenever a NEW `employee_notifications`
 * row is inserted for `email` (via Supabase Realtime).
 *
 * Used by privileged dashboards (e.g. HR) so staff are alerted the moment
 * something needs them — an onboarding form submission, a transfer request, etc.
 * — regardless of which tab they're currently on. The bell is synthesized with
 * the Web Audio API so it ships no binary asset.
 *
 * `shouldNotify` (optional) gates the alert by the incoming row's `type`: return
 * false to stay silent for notifications the viewer isn't permitted to see (the
 * Realtime payload bypasses the server-side feature gate, so feature-gated types
 * like onboarding paperwork must be filtered here too). Defaults to alerting on
 * everything. Kept in a ref so changing its identity never resubscribes.
 */
export function useNotificationChime(
  email?: string | null,
  shouldNotify?: (type: string | null | undefined) => boolean,
): void {
  const normalized = email ? email.trim().toLowerCase() : null;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const shouldNotifyRef = useRef(shouldNotify);
  shouldNotifyRef.current = shouldNotify;

  // Browser autoplay policies block audio until the page has seen a user
  // gesture, so lazily create/resume the AudioContext on the first interaction.
  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) {
        try {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (Ctx) audioCtxRef.current = new Ctx();
        } catch {
          /* no Web Audio support — toast still fires, just no sound */
        }
      }
      void audioCtxRef.current?.resume();
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
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const playChime = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const now = ctx.currentTime;
      // Two-tone bell: a bright strike plus a softer overtone, each decaying.
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
    };

    const channel = supabase
      .channel(`notification-chime-${normalized}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'employee_notifications',
          filter: `recipient_email=eq.${normalized}`,
        },
        (payload) => {
          const row = (payload.new ?? null) as IncomingNotification | null;
          // Stay silent for types this viewer isn't permitted to see.
          if (shouldNotifyRef.current && !shouldNotifyRef.current(row?.type)) return;
          playChime();
          toast(row?.title ?? 'New notification', {
            description: row?.message ?? undefined,
            duration: 8000,
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [normalized]);
}
