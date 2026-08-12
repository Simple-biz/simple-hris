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
import { AlertTriangle, Archive, CheckCircle2, FileDown, Lock, Play, Send, StopCircle } from 'lucide-react';
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

/**
 * The optional "close the pay cycle" half of the STOP dialog.
 *
 * Payment Dispatch passes this; the Payroll Wizard does not, so the wizard's
 * Start/Stop panel keeps the exact dialog it has always had. Closing writes a
 * permanent close-out record — see `src/lib/payroll/cycle-closeout.ts`.
 */
export interface LockToggleCloseOut {
  /** Toggle state, owned by the caller so the confirm handler can read it. */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** Already closed by an earlier stop — the toggle is shown, locked on, inert. */
  alreadyClosed: boolean;
  /** Human label for the week being closed, e.g. "August 3-9, 2026". */
  cycleLabel: string;
  /** Payable people with no payment this cycle. EXCLUDES the Excluded tab —
   *  those are held deliberately and are not "unpaid" in this sense. */
  unpaidCount: number;
  unpaidPHP: number;
  /** Distinct payees already settled, and what went out. */
  paidCount: number;
  paidUSD: number;
  /**
   * Download-a-report checkbox, caller-owned like `enabled` so the confirm
   * handler can read it. What downloads depends on the close toggle:
   * closing → the FINAL close-out CSV (from the filed record); just stopping →
   * a PREMATURE XLSX snapshot stamped NOT YET CLOSED; already closed → a
   * re-download of the filed record's CSV.
   */
  downloadReport: boolean;
  onDownloadReportChange: (next: boolean) => void;
}

function formatPHP(n: number): string {
  return `₱${Math.round(n).toLocaleString('en-PH')}`;
}

function formatUSD(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The download-report line under the close-out block. What the file IS depends
 * on the close toggle, and the copy says so out loud — a premature snapshot
 * must never be mistaken for the filed record.
 */
function DownloadReportRow({ closeOut }: { closeOut: LockToggleCloseOut }) {
  const { alreadyClosed, enabled, downloadReport } = closeOut;
  const closing = alreadyClosed || enabled;
  return (
    <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-zinc-200 bg-white/70 px-2.5 py-2 dark:border-zinc-700 dark:bg-zinc-900/50">
      <input
        type="checkbox"
        checked={downloadReport}
        onChange={(e) => closeOut.onDownloadReportChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-violet-600"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">
          <FileDown className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
          {alreadyClosed ? 'Download the filed close-out (CSV)' : 'Download a report when I stop'}
        </span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {alreadyClosed ? (
            <>Re-downloads the permanent record exactly as it was filed — frozen totals and the unpaid list.</>
          ) : closing ? (
            <>
              Final close-out <span className="font-medium">CSV</span>, rendered from the filed
              record — frozen totals, per-processor split, and the unpaid list.
            </>
          ) : (
            <>
              Premature <span className="font-medium">XLSX</span> snapshot, stamped{' '}
              <span className="font-semibold text-amber-600 dark:text-amber-400">NOT YET CLOSED</span>{' '}
              with a timestamp — figures are live and may still move.
            </>
          )}
        </span>
      </span>
    </label>
  );
}

function CloseOutBlock({ closeOut }: { closeOut: LockToggleCloseOut }) {
  const { enabled, alreadyClosed, unpaidCount } = closeOut;
  const on = alreadyClosed || enabled;
  return (
    <div
      className={cn(
        'mt-3 rounded-xl border px-3 py-2.5 transition-colors',
        on
          ? 'border-violet-300 bg-violet-50/70 dark:border-violet-800/60 dark:bg-violet-950/25'
          : 'border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">
            <Archive className={cn('h-3.5 w-3.5', on ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-400')} />
            {alreadyClosed ? 'Pay cycle already closed' : 'Close the pay cycle'}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {alreadyClosed ? (
              <>
                <span className="font-medium">{closeOut.cycleLabel}</span> already has a permanent
                close-out record. Stopping again won&apos;t write a second one.
              </>
            ) : (
              <>
                Files a permanent close-out record for{' '}
                <span className="font-medium">{closeOut.cycleLabel}</span> — who was paid, through
                which processor, and who wasn&apos;t.
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Close the pay cycle"
          disabled={alreadyClosed}
          onClick={() => closeOut.onEnabledChange(!enabled)}
          className={cn(
            'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
            on ? 'bg-violet-600' : 'bg-zinc-300 dark:bg-zinc-700',
            alreadyClosed && 'cursor-not-allowed opacity-60',
          )}
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm',
              on ? 'left-[1.125rem]' : 'left-0.5',
            )}
          />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {on && !alreadyClosed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-violet-200/70 pt-2.5 dark:border-violet-800/40">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                  Paid
                </p>
                <p className="text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
                  {closeOut.paidCount.toLocaleString()}{' '}
                  <span className="text-[11px] font-normal text-zinc-500">
                    · {formatUSD(closeOut.paidUSD)}
                  </span>
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                  Not paid
                </p>
                <p
                  className={cn(
                    'text-[13px] font-semibold',
                    unpaidCount > 0
                      ? 'text-rose-600 dark:text-rose-400'
                      : 'text-zinc-500 dark:text-zinc-400',
                  )}
                >
                  {unpaidCount.toLocaleString()}{' '}
                  <span className="text-[11px] font-normal text-zinc-500">
                    · {formatPHP(closeOut.unpaidPHP)}
                  </span>
                </p>
              </div>
            </div>

            {unpaidCount > 0 && (
              <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] leading-relaxed text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  <span className="font-semibold">
                    {unpaidCount.toLocaleString()} payable{' '}
                    {unpaidCount === 1 ? 'person has' : 'people have'} not been paid
                  </span>{' '}
                  ({formatPHP(closeOut.unpaidPHP)} still owed). They&apos;ll be named in the
                  close-out. People held in <span className="font-medium">Excluded</span> aren&apos;t
                  counted.
                </span>
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* The choice must be made BEFORE confirm — PreparingScene replaces the
          whole modal while submitting, so no prompt can live after the click. */}
      <DownloadReportRow closeOut={closeOut} />
    </div>
  );
}

export default function LockToggleConfirmDialog({
  open,
  locked,
  submitting,
  firstName,
  onClose,
  onConfirm,
  closeOut,
}: {
  open: boolean;
  locked: boolean;
  submitting: boolean;
  firstName: string;
  onClose: () => void;
  onConfirm: () => void;
  /** Payment Dispatch only. Omitted by the Payroll Wizard, which keeps the
   *  plain Start/Stop dialog. Only ever rendered on the STOP side. */
  closeOut?: LockToggleCloseOut;
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
  // A cycle already closed by an earlier stop must NOT re-title the dialog as
  // "Close Pay Cycle?" — nothing new gets written, so claiming it would be a lie.
  const closingCycle = !isStarting && Boolean(closeOut?.enabled) && !closeOut?.alreadyClosed;
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
                  ) : closingCycle ? (
                    <Archive className="h-5 w-5 text-violet-500" />
                  ) : (
                    <StopCircle className="h-5 w-5 text-rose-500" />
                  )}
                  {isStarting
                    ? 'Start payroll processing?'
                    : closingCycle
                      ? 'Close Pay Cycle?'
                      : 'Stop payroll processing?'}
                </DialogTitle>
                <DialogDescription className="text-xs leading-relaxed">
                  {isStarting ? (
                    <>
                      Starts the dispatch run for this cycle. Employees&apos; <span className="font-medium">File an Issue</span>{' '}
                      button will be disabled live across all dashboards while processing is active.
                    </>
                  ) : closingCycle ? (
                    <>
                      Ends processing <span className="font-medium">and closes the whole payroll
                      cycle</span>. Employees can file issues again, and a permanent close-out
                      record is filed. It can&apos;t be re-filed for this week afterwards.
                    </>
                  ) : (
                    <>
                      Ends processing for this cycle. Employees can file issues again and the live banner will
                      clear from their dashboards.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              {!isStarting && closeOut && <CloseOutBlock closeOut={closeOut} />}
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
                      : closingCycle
                        ? 'bg-violet-600 hover:bg-violet-700'
                        : 'bg-rose-600 hover:bg-rose-700',
                  )}
                >
                  {isStarting ? (
                    <Play className="h-4 w-4" />
                  ) : closingCycle ? (
                    <Archive className="h-4 w-4" />
                  ) : (
                    <StopCircle className="h-4 w-4" />
                  )}
                  {isStarting
                    ? 'Start processing'
                    : closingCycle
                      ? 'Stop & close cycle'
                      : 'Stop processing'}
                </Button>
              </DialogFooter>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
