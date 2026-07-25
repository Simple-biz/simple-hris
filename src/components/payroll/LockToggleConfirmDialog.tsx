'use client';

/**
 * Start / Stop payroll processing confirm dialog — the exact modal Payment
 * Dispatch uses, extracted so the Payroll Wizard renders the IDENTICAL
 * experience (same copy, motion, "Preparing Dispatch" scene and pacing).
 *
 * Owners wire the sound themselves (it must fire from the confirm click, a
 * user gesture): call `playStagePrepped()` when Start is confirmed and
 * `stopStagePrepped()` when the dialog closes — see PayrollDispatch /
 * PayrollWizard for the proven pattern.
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Lock, Play, Send, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Friendly first-name fallback chain: NextAuth name → email local part → "there". */
export function deriveFirstName(name: string | null | undefined, email: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  // Impersonation sessions set name = the raw email — treat that as an email
  // (take its local part) rather than greeting with "kaner@simple.biz".
  if (trimmed && !trimmed.includes('@')) return trimmed.split(/\s+/)[0]!;
  const local = (trimmed || (email ?? '')).split('@')[0] ?? '';
  if (local) {
    const cleaned = local.replace(/[._-]+/g, ' ').trim();
    const first = cleaned.split(/\s+/)[0] ?? '';
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return 'there';
}

/** Animated "· · ·" ellipsis for the preparing scene — three dots that breathe
 *  in sequence. Smoother + warmer than a spinner. */
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

/** Full-modal scene shown after confirm, replacing the inline button spinner.
 *  Two distinct personalities:
 *   - START ("Preparing Dispatch")  — energetic: warm orange orb, floating Send
 *     icon that sways, endless shimmer sweep (spinning up).
 *   - STOP  ("Closing Payroll Cycle") — settling: rose orb, a lock that clicks
 *     shut, a bar that FILLS to 100% then a check (winding down / completing).
 */
function PreparingScene({ firstName, stopping }: { firstName: string; stopping: boolean }) {
  const accent = stopping ? '#f43f5e' : '#f59e0b';
  const accent2 = stopping ? '#e11d48' : '#f97316';

  // Sub-line steps cycle so the closing sequence reads as real work happening.
  const steps = stopping
    ? ['Finalizing this cycle', 'Reopening employee issues', 'Clearing the live banner']
    : ['Locking the cycle', 'Pausing employee issues', 'Warming up the queue'];
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStepIdx((i) => (i + 1) % steps.length), 700);
    return () => clearInterval(id);
  }, [steps.length]);

  return (
    <motion.div
      key={stopping ? 'closing' : 'preparing'}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col items-center justify-center gap-6 px-4 py-8 text-center"
    >
      {/* Orb: soft breathing gradient halo + rotating conic sheen + icon */}
      <div className="relative flex h-28 w-28 items-center justify-center">
        <motion.div
          className="absolute inset-0 rounded-full blur-xl"
          style={{ background: `radial-gradient(circle at 50% 45%, ${accent}cc, ${accent2}55 55%, transparent 72%)` }}
          animate={{ scale: [1, 1.12, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute inset-2 rounded-full"
          style={{ background: `conic-gradient(from 0deg, transparent, ${accent}88, transparent 55%)` }}
          animate={{ rotate: stopping ? -360 : 360 }}
          transition={{ duration: stopping ? 4.2 : 3.4, repeat: Infinity, ease: 'linear' }}
        />
        {/* Start: an expanding ping ring (spinning up). Stop: a converging ring
            that contracts inward (sealing shut). */}
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ boxShadow: `0 0 0 1.5px ${accent}66` }}
          animate={stopping ? { scale: [1.35, 1], opacity: [0, 0.6] } : { scale: [1, 1.35], opacity: [0.6, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: stopping ? 'easeIn' : 'easeOut' }}
        />
        <motion.div
          className="relative flex h-16 w-16 items-center justify-center rounded-2xl text-white shadow-lg"
          style={{ background: `linear-gradient(135deg, ${accent}, ${accent2})`, boxShadow: `0 10px 30px -6px ${accent}80` }}
          // Start floats/breathes; Stop settles with a subtle downward "seat".
          animate={stopping ? { y: [0, 2, 0], scale: [1, 0.96, 1] } : { y: [0, -5, 0] }}
          transition={{ duration: stopping ? 2.6 : 2.4, repeat: Infinity, ease: 'easeInOut' }}
        >
          <motion.span
            // Start: gentle sway. Stop: a periodic "lock click" shut.
            animate={stopping ? { rotate: [0, -10, 0], scale: [1, 1.1, 1] } : { rotate: [0, 8, -8, 0] }}
            transition={{ duration: stopping ? 1.8 : 2.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            {stopping ? <Lock className="h-8 w-8" /> : <Send className="h-8 w-8" />}
          </motion.span>
        </motion.div>
      </div>

      <div className="space-y-1.5">
        <motion.h2
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-white"
        >
          {stopping ? 'Closing Payroll Cycle, ' : 'Preparing Dispatch for you, '}
          <span
            className="bg-clip-text text-transparent"
            style={{ backgroundImage: `linear-gradient(90deg, ${accent2}, ${accent})` }}
          >
            {firstName}
          </span>
        </motion.h2>
        {/* Cycling step line — crossfades between the closing/prep steps. */}
        <div className="flex h-4 items-center justify-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <AnimatePresence mode="wait">
            <motion.span
              key={stepIdx}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25 }}
            >
              {steps[stepIdx]}
            </motion.span>
          </AnimatePresence>
          <BreathingDots color={accent} />
        </div>
      </div>

      {/* Progress bar.
          START: endless shimmer sweep (spinning up, indeterminate).
          STOP:  a bar that FILLS left→right to 100% then flashes a check —
                 the cycle is completing/closing, not idling. */}
      {stopping ? (
        <div className="flex w-52 flex-col items-center gap-2">
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-white/10">
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: `linear-gradient(90deg, ${accent2}, ${accent})` }}
              initial={{ width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <motion.div
            className="flex items-center gap-1 text-[11px] font-medium"
            style={{ color: accent }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.4, duration: 0.3 }}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Cycle closed
          </motion.div>
        </div>
      ) : (
        <div className="relative h-1 w-48 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-white/10">
          <motion.div
            className="absolute inset-y-0 w-1/2 rounded-full"
            style={{ background: `linear-gradient(90deg, transparent, ${accent}, ${accent2}, transparent)` }}
            initial={{ x: '-120%' }}
            animate={{ x: '240%' }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
      )}
    </motion.div>
  );
}

export default function LockToggleConfirmDialog({
  open,
  locked,
  submitting,
  firstName,
  onClose,
  onConfirm,
}: {
  open: boolean;
  locked: boolean;
  submitting: boolean;
  firstName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  // `useDispatchLock.setLocked` flips `locked` OPTIMISTICALLY the instant the
  // POST starts, which would invert the scene mid-flight (confirming Start
  // rendered the rose "Closing Payroll Cycle" scene). Freeze the direction
  // while submitting so the scene matches the action the user confirmed.
  const [frozenLocked, setFrozenLocked] = useState(locked);
  useEffect(() => {
    if (!submitting) setFrozenLocked(locked);
  }, [locked, submitting]);
  const isStarting = !(submitting ? frozenLocked : locked);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Don't allow dismissing the dialog while the toggle POST is in flight.
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!submitting}
        // Slower, gentler open than the app-wide default (320ms) so the modal
        // eases in instead of snapping — a longer, softer zoom + rise. Scoped to
        // this dialog only via className overrides on the data-open enter state.
        className={cn(
          'overflow-hidden sm:max-w-[460px]',
          'data-open:duration-[520ms] data-open:ease-[cubic-bezier(0.16,1,0.3,1)]',
          'data-open:zoom-in-[0.92] data-open:slide-in-from-bottom-3',
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          {submitting ? (
            <PreparingScene key="prep" firstName={firstName} stopping={!isStarting} />
          ) : (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-lg">
                  {isStarting ? (
                    <Play className="h-5 w-5 text-emerald-500" />
                  ) : (
                    <StopCircle className="h-5 w-5 text-rose-500" />
                  )}
                  {isStarting ? 'Start payroll processing?' : 'Stop payroll processing?'}
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {isStarting ? (
                    <>
                      Starts the dispatch run for this cycle. Employees&apos; <span className="font-medium">File an Issue</span>{' '}
                      button will be disabled live across all dashboards while processing is active.
                    </>
                  ) : (
                    <>
                      Ends processing for this cycle. Employees can file issues again and the live banner will
                      clear from their dashboards.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="mt-4 gap-2">
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  onClick={onConfirm}
                  className={cn(
                    'gap-2 text-white transition-colors',
                    isStarting
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-rose-600 hover:bg-rose-700',
                  )}
                >
                  {isStarting ? <Play className="h-4 w-4" /> : <StopCircle className="h-4 w-4" />}
                  {isStarting ? 'Start processing' : 'Stop processing'}
                </Button>
              </DialogFooter>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
