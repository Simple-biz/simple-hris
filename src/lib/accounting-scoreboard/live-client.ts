'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { joinSharedBroadcast } from '@/lib/supabase/shared-broadcast';
import {
  SCOREBOARD_LIVE_EVENT,
  SCOREBOARD_LIVE_TOPIC,
  createLiveScheduler,
  isOwnEcho,
  parseScoreboardLivePayload,
} from './live';

let tabId: string | null = null;

/** This browser tab's id, sent with every board write (`SCOREBOARD_TAB_HEADER`) so its own echo is skipped. */
export function getScoreboardTabId(): string {
  if (tabId) return tabId;
  tabId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return tabId;
}

export interface ScoreboardSnapshotOptions {
  /** True while a re-read must wait: a cell is being edited, a foreground load is running, the tab is hidden.
   *  The change stays pending and is read once this turns false. */
  blocked: () => boolean;
}

/**
 * The scoreboard's onSnapshot listener (Kane, 2026-10-08). Subscribe once, get `onSnapshot` called whenever
 * the board changed anywhere: a teammate typed a cell, logged or deleted a line, ticked Payment Verified, or an
 * Admin changed Setup, Members or Access. Returns the unsubscribe, like Firestore's `onSnapshot`.
 *
 * `onSnapshot` re-reads the board through the member-gated GET. The message itself carries no values (`live.ts`
 * says why). It is also called when the channel re-subscribes after a drop, which may have swallowed a message.
 * This tab's own writes are skipped: it painted them already. Bursts coalesce, re-reads are at least
 * `LIVE_MIN_GAP_MS` apart, and nothing runs while `blocked()`.
 *
 * It is the fast path only. The board keeps its 45 s tick and its focus refresh, so a lost message costs the
 * tick, never correctness.
 */
export function onScoreboardSnapshot(onSnapshot: () => void, opts: ScoreboardSnapshotOptions): () => void {
  const scheduler = createLiveScheduler({
    run: onSnapshot,
    blocked: opts.blocked,
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
    random: Math.random,
  });
  const leave = joinSharedBroadcast(
    SCOREBOARD_LIVE_TOPIC,
    SCOREBOARD_LIVE_EVENT,
    (raw) => {
      // `null` = the channel came back after a drop: re-read, a message may have been lost meanwhile.
      if (raw !== null && isOwnEcho(parseScoreboardLivePayload(raw), getScoreboardTabId())) return;
      scheduler.signal();
    },
    getSupabaseBrowserClient,
  );
  return () => {
    scheduler.dispose();
    leave();
  };
}
