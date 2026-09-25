'use client';

/**
 * "<Name> is starting payroll" — the peer modal.
 *
 * Pops on every OTHER open Payroll Wizard and Payment Dispatch when a clerk
 * confirms Start Processing, and plays the same Jellyfish Jam cue the operator
 * just heard (Kane 2026-09-15). The operator never sees it: the channel is
 * `self: false` and they already have their own Preparing Dispatch scene.
 *
 * Deliberately reuses the visual language of `LockToggleConfirmDialog`'s
 * PreparingScene — orange orb, breathing dots, shimmer — in the third person. A
 * new design for the same moment would be the defect.
 *
 * Rules:
 *   - DISMISSIBLE (Kane, Q3), and dismissing STOPS the song, the same contract
 *     the operator's Cancel already has.
 *   - Stays up for the WHOLE song (Kane 2026-09-25: "it needs to play the whole
 *     song unless the modal is being closed"). It closes on its own only when
 *     the 12s window has passed AND the cue has stopped (`shouldCloseStartModal`),
 *     with a hard ceiling (`START_MODAL_MAX_MS`) so it can never be stranded
 *     over the oversee/follow mirror.
 *   - Names who started it in full — name and account — not just a first name
 *     (Kane 2026-09-25).
 *   - Shows "Tap anywhere for sound" ONLY when the browser actually refused the
 *     audio. A silent modal with no explanation is the thing to avoid.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Send, Volume2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  isStagePreppedActive,
  playStagePreppedForPeer,
  prefetchStagePrepped,
  stopStagePreppedForPeer,
  subscribeStagePrepped,
} from '@/lib/sound/ping-chime';
import {
  START_CUE_WINDOW_MS,
  START_MODAL_MAX_MS,
  shouldCloseStartModal,
  startedByLine,
  startProcessingHeadline,
  type StartProcessingAnnouncement,
} from '@/lib/payroll/start-processing-broadcast';

const noCueOnServer = () => false;

function BreathingDots({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1.5 w-1.5 rounded-full"
          style={{ background: color }}
          initial={{ opacity: 0.3, scale: 0.7 }}
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.7, 1, 0.7] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut', delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}

export default function StartProcessingBroadcastModal({
  announcement,
  onDismiss,
}: {
  announcement: StartProcessingAnnouncement | null;
  onDismiss: () => void;
}) {
  const [needsTap, setNeedsTap] = useState(false);
  // The `at` of the announcement whose minimum window has passed. Keyed by `at`
  // so a second start can never inherit the first one's elapsed window.
  const [elapsedFor, setElapsedFor] = useState<number | null>(null);
  const cueActive = useSyncExternalStore(subscribeStagePrepped, isStagePreppedActive, noCueOnServer);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // This modal is mounted (closed) on BOTH Start Processing surfaces, so it is
  // where the song's bytes get warmed — for a peer's broadcast and for the
  // operator's own click alike. Deferred a beat so it never competes with the
  // page's first data loads.
  useEffect(() => {
    const id = window.setTimeout(prefetchStagePrepped, 1500);
    return () => window.clearTimeout(id);
  }, []);

  // One effect owns the whole run: start the cue, arm the window and the hard
  // ceiling, and on ANY exit (dismiss, auto-close, unmount, a second
  // announcement) stop the sound and disarm the pending unlock. Leaving that
  // teardown to the dismiss handler alone would let an unmount strand an armed
  // listener.
  useEffect(() => {
    if (!announcement) return;
    let cancelled = false;
    const at = announcement.at;
    setNeedsTap(false);

    void playStagePreppedForPeer().then((audible) => {
      if (!cancelled) setNeedsTap(!audible);
    });

    const windowId = window.setTimeout(() => setElapsedFor(at), START_CUE_WINDOW_MS);
    const ceilingId = window.setTimeout(() => onDismissRef.current(), START_MODAL_MAX_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(windowId);
      window.clearTimeout(ceilingId);
      stopStagePreppedForPeer();
    };
    // `at` keys the run: a second start re-triggers even from the same person.
  }, [announcement?.at, announcement]);

  // Close on our own only once the window has passed AND the song has stopped —
  // never mid-song, never left up in front of silence.
  const windowElapsed = announcement !== null && elapsedFor === announcement.at;
  useEffect(() => {
    if (!announcement) return;
    if (shouldCloseStartModal({ windowElapsed, cueActive })) onDismissRef.current();
  }, [announcement, windowElapsed, cueActive]);

  // Once they tap, the sound is running and the prompt is stale.
  useEffect(() => {
    if (!needsTap) return;
    const clear = () => setNeedsTap(false);
    window.addEventListener('pointerdown', clear);
    window.addEventListener('keydown', clear);
    return () => {
      window.removeEventListener('pointerdown', clear);
      window.removeEventListener('keydown', clear);
    };
  }, [needsTap]);

  const open = Boolean(announcement);
  const accent = '#f59e0b';
  const accent2 = '#f97316';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onDismiss(); }}>
      <DialogContent className="max-w-sm overflow-hidden border-amber-200/70 bg-white p-0 dark:border-amber-500/25 dark:bg-zinc-950">
        <DialogTitle className="sr-only">
          {announcement ? startProcessingHeadline(announcement) : 'Payroll processing started'}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Payroll processing has started. This notice closes when the song ends; closing it stops the song.
        </DialogDescription>

        <div className="relative flex flex-col items-center gap-4 px-8 py-10 text-center">
          {/* Shimmer sweep — spinning up. */}
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: `linear-gradient(105deg, transparent 35%, ${accent}22 50%, transparent 65%)`,
            }}
            animate={{ x: ['-120%', '120%'] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          />

          <motion.div
            className="relative flex h-16 w-16 items-center justify-center rounded-full"
            style={{ background: `radial-gradient(circle at 30% 30%, ${accent}, ${accent2})` }}
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          >
            <motion.span
              animate={{ y: [-2, 2, -2], rotate: [-6, 6, -6] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Send className="h-7 w-7 text-white" />
            </motion.span>
          </motion.div>

          <div className="relative space-y-1">
            <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {announcement ? startProcessingHeadline(announcement) : null}
            </p>
            <p className="flex items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              {announcement?.surface === 'dispatch' ? 'From Payment Dispatch' : 'From the Payroll Wizard'}
              <BreathingDots color={accent} />
            </p>
          </div>

          {announcement ? (
            <div className="relative w-full rounded-lg border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-left dark:border-amber-500/20 dark:bg-amber-500/5">
              <p className="text-[10px] font-medium uppercase tracking-wide text-amber-700/80 dark:text-amber-400/80">
                Started by
              </p>
              <p className="truncate text-sm text-zinc-800 dark:text-zinc-200" title={startedByLine(announcement)}>
                {startedByLine(announcement)}
              </p>
            </div>
          ) : null}

          <AnimatePresence>
            {needsTap ? (
              <motion.p
                key="tap"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="relative flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400"
              >
                <Volume2 className="h-3.5 w-3.5" />
                Tap anywhere for sound
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
