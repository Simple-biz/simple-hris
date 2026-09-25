'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import {
  START_PROCESSING_EVENT,
  START_PROCESSING_TOPIC,
  parseFullName,
  parseStartPayload,
  shouldAnnounceStart,
  type StartProcessingAnnouncement,
} from '@/lib/payroll/start-processing-broadcast';

interface Args {
  selfEmail: string | null | undefined;
  /** Which surface this mount is, stamped onto anything it announces. */
  surface: 'wizard' | 'dispatch';
}

interface Result {
  /**
   * Call on the START branch of the lock toggle, right after `holdStagePrepped()`.
   * `byName` is the session's full name — the peer modal's "Started by" line.
   */
  announceStart: (byLabel: string, byName: string | null | undefined) => void;
  /** The announcement to render, or null. */
  announcement: StartProcessingAnnouncement | null;
  dismiss: () => void;
}

/**
 * Subscribe to the Start Processing broadcast — see
 * `src/lib/payroll/start-processing-broadcast.ts` for the topic rules and
 * `docs/features/start-processing-cue.md` for the behaviour.
 *
 * `broadcast: { self: false }` is what keeps the operator on exactly today's
 * behaviour: they never receive their own message, so they cannot double-play
 * on top of the cue their own click already started. `shouldAnnounceStart`
 * re-checks the sender anyway, because a second tab of the same person is a
 * different client and `self: false` does not cover it.
 */
export function useStartProcessingBroadcast({ selfEmail, surface }: Args): Result {
  const [announcement, setAnnouncement] = useState<StartProcessingAnnouncement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sendRef = useRef<((payload: StartProcessingAnnouncement) => void) | null>(null);
  const selfRef = useRef(selfEmail);
  selfRef.current = selfEmail;

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !selfEmail) return;

    const ch = supabase.channel(START_PROCESSING_TOPIC, {
      config: { broadcast: { self: false } },
    });

    sendRef.current = (payload: StartProcessingAnnouncement) => {
      void ch.send({ type: 'broadcast', event: START_PROCESSING_EVENT, payload });
    };

    ch.on('broadcast', { event: START_PROCESSING_EVENT }, ({ payload }: { payload: unknown }) => {
      const parsed = parseStartPayload(payload);
      // Judged at RECEIVE time, not send time: a reconnecting or backgrounded
      // tab can be handed a message long after the fact, and a late arrival
      // must stay silent (Kane 2026-09-15).
      if (!shouldAnnounceStart(parsed, selfRef.current, Date.now())) return;
      setAnnouncement(parsed);
    });

    void ch.subscribe();
    return () => {
      sendRef.current = null;
      void supabase.removeChannel(ch);
    };
  }, [selfEmail]);

  const announceStart = useCallback(
    (byLabel: string, byName: string | null | undefined) => {
      const self = (selfRef.current ?? '').trim().toLowerCase();
      if (!self) return;
      sendRef.current?.({ by: self, byLabel, byName: parseFullName(byName), at: Date.now(), surface });
    },
    [surface],
  );

  const dismiss = useCallback(() => setAnnouncement(null), []);

  return { announceStart, announcement, dismiss };
}
