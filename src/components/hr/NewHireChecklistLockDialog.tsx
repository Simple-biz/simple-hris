'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  CalendarClock,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Mail,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type LockDialogMode = 'lock' | 'reopen';

/**
 * TEMPORARY client-side gate. Locking a week fires the orientation automation
 * (the n8n webhook that emails every hire their orientation invite), and
 * reopening lets a locked week be edited (and re-locked, which re-sends). We
 * restrict both to whoever holds the shared "HR Manager" passphrase so a regular
 * HR coordinator can't accidentally trigger or undo the send.
 *
 * NOTE: this is a UX ceremony gate, not real security — the PUT endpoint still
 * enforces the `new_hire_checklist` feature permission server-side. When the HR
 * Manager role firms up, replace this with a server-verified check.
 */
export const HR_MANAGER_PASSCODE = 'super-teal';

const THEME = {
  lock: {
    Icon: Lock,
    ring: 'ring-emerald-500/30',
    headBg: 'from-emerald-600 via-emerald-600 to-teal-800',
    accentText: 'text-emerald-700 dark:text-emerald-300',
    panelBorder: 'border-emerald-200 dark:border-emerald-500/30',
    panelBg: 'bg-emerald-50/70 dark:bg-emerald-950/20',
    focusRing: 'focus:border-emerald-400 focus:ring-emerald-300/60 dark:focus:border-emerald-500',
    confirmBg:
      'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-400/50 dark:bg-emerald-600 dark:hover:bg-emerald-500',
  },
  reopen: {
    Icon: LockOpen,
    ring: 'ring-amber-500/30',
    headBg: 'from-amber-600 via-amber-600 to-orange-700',
    accentText: 'text-amber-700 dark:text-amber-300',
    panelBorder: 'border-amber-200 dark:border-amber-500/30',
    panelBg: 'bg-amber-50/70 dark:bg-amber-950/20',
    focusRing: 'focus:border-amber-400 focus:ring-amber-300/60 dark:focus:border-amber-500',
    confirmBg:
      'bg-amber-500 hover:bg-amber-600 focus-visible:ring-amber-400/50 dark:bg-amber-500 dark:hover:bg-amber-400',
  },
} as const;

interface Props {
  /** null = closed; otherwise the action being confirmed. */
  mode: LockDialogMode | null;
  /** e.g. "Jun 28 – Jul 4, 2026". */
  weekLabel: string;
  /** Fully formatted orientation day, e.g. "Monday, Jul 6, 2026". */
  orientationLabel: string;
  /** Non-blank hires that will be emailed on lock. */
  hireCount: number;
  /** Who locked the week + when (reopen context only). */
  lockedBy?: string | null;
  lockedStamp?: string | null;
  onCancel: () => void;
  /** Runs the real action. Resolves true on success (parent then closes the
   *  dialog); false keeps it open with an error so the user can retry. */
  onConfirm: () => Promise<boolean>;
}

export default function NewHireChecklistLockDialog({
  mode,
  weekLabel,
  orientationLabel,
  hireCount,
  lockedBy,
  lockedStamp,
  onCancel,
  onConfirm,
}: Props) {
  const open = mode !== null;
  const reduceMotion = useReducedMotion();
  const shake = useAnimationControls();
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // The control that had focus before we opened, so we can hand focus back to it
  // on close (WAI-ARIA dialog pattern) instead of dropping the user to <body>.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form each time the dialog opens for a fresh action.
  useEffect(() => {
    if (!open) return;
    setPassword('');
    setShowPw(false);
    setError(null);
    setSubmitting(false);
  }, [open, mode]);

  // Remember the trigger on open; return focus to it when the dialog closes.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
    };
  }, [open]);

  // Autofocus the passphrase field once the entrance animation has settled.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), reduceMotion ? 0 : 180);
    return () => clearTimeout(t);
  }, [open, reduceMotion]);

  // Lock body scroll while the modal is up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const close = useCallback(() => {
    if (submitting) return;
    onCancel();
  }, [submitting, onCancel]);

  const submit = useCallback(async () => {
    if (submitting) return;
    if (password !== HR_MANAGER_PASSCODE) {
      setError('That passphrase is incorrect. Ask the HR Manager if you’re unsure.');
      if (!reduceMotion) {
        void shake.start({ x: [0, -9, 9, -7, 7, -4, 0], transition: { duration: 0.42, ease: 'easeInOut' } });
      }
      inputRef.current?.select();
      return;
    }
    setError(null);
    setSubmitting(true);
    const ok = await onConfirm();
    // On success the parent flips `mode` to null (unmounting via AnimatePresence);
    // on failure we stay open so the already-typed passphrase can be retried.
    if (!ok) {
      setSubmitting(false);
      setError('Something went wrong — check the notification and try again.');
    }
  }, [submitting, password, reduceMotion, shake, onConfirm]);

  // Escape closes (unless a request is in flight); Tab is trapped inside the card
  // so focus can't wander onto the (inert) page behind the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !cardRef.current) return;
      const focusables = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length > 0);
      // Nothing tabbable (e.g. every control disabled during an in-flight
      // submit) — swallow Tab so focus can't leak to the page behind the modal.
      if (focusables.length === 0) {
        e.preventDefault();
        cardRef.current.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (active && !cardRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (typeof document === 'undefined') return null;

  const theme = mode ? THEME[mode] : THEME.lock;
  const HeadIcon = theme.Icon;
  const noHires = hireCount === 0;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
          aria-hidden={false}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm"
            onClick={close}
            aria-hidden
          />

          {/* Card */}
          <motion.div
            ref={cardRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="nhc-lock-title"
            aria-describedby="nhc-lock-desc"
            tabIndex={-1}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 14 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 10 }}
            transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'relative z-[1] w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl shadow-black/25 ring-1 dark:bg-[#0d1117]',
              theme.ring,
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className={cn('relative overflow-hidden bg-gradient-to-br px-5 py-4 text-white', theme.headBg)}>
              <div aria-hidden className="pointer-events-none absolute -right-6 -top-8 h-32 w-32 rounded-full bg-white/10 blur-2xl" />
              <div className="relative flex items-start gap-3">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
                  <HeadIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h2 id="nhc-lock-title" className="text-[15px] font-semibold leading-tight drop-shadow-sm sm:text-base">
                    {mode === 'lock' ? 'Lock in & send orientation invites' : 'Reopen this week for editing'}
                  </h2>
                  <p className="mt-0.5 text-[12.5px] font-medium text-white/90 drop-shadow-sm">{weekLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  disabled={submitting}
                  aria-label="Cancel"
                  className="ml-auto -mr-1 -mt-1 rounded-lg p-1.5 text-white/70 transition hover:bg-white/15 hover:text-white disabled:opacity-40"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* ── Body ───────────────────────────────────────────────── */}
            <div className="max-h-[62vh] overflow-y-auto px-5 py-4">
              {mode === 'lock' ? (
                <div id="nhc-lock-desc" className={cn('rounded-xl border px-4 py-3.5', theme.panelBorder, theme.panelBg)}>
                  <div className={cn('flex items-center gap-2 text-[12.5px] font-semibold', theme.accentText)}>
                    <CalendarClock className="h-4 w-4 shrink-0" />
                    This triggers the orientation automation
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    Locking <strong className="font-semibold text-zinc-900 dark:text-white">{weekLabel}</strong>{' '}
                    doesn&apos;t just save it. The moment you confirm, an automated{' '}
                    <strong className="font-semibold text-zinc-900 dark:text-white">orientation invite</strong> email is
                    sent to every hire on this week.
                  </p>

                  <ul className="mt-3 space-y-2 text-[12.5px] leading-snug text-zinc-700 dark:text-zinc-300">
                    <li className="flex items-start gap-2">
                      <Users className={cn('mt-0.5 h-4 w-4 shrink-0', theme.accentText)} />
                      <span>
                        <strong className="font-semibold text-zinc-900 dark:text-white">
                          {hireCount} {hireCount === 1 ? 'hire' : 'hires'}
                        </strong>{' '}
                        will be emailed right now
                        {noHires && (
                          <span className="text-amber-700 dark:text-amber-300">
                            {' '}— no hires are entered yet, so the week will freeze but no emails go out
                          </span>
                        )}
                        .
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <CalendarClock className={cn('mt-0.5 h-4 w-4 shrink-0', theme.accentText)} />
                      <span>
                        Orientation date:{' '}
                        <strong className="font-semibold text-zinc-900 dark:text-white">{orientationLabel}</strong>{' '}
                        (the Monday of this week).
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Mail className={cn('mt-0.5 h-4 w-4 shrink-0', theme.accentText)} />
                      <span>
                        Each email is personalised with the hire&apos;s first name and includes their{' '}
                        <strong className="font-semibold text-zinc-900 dark:text-white">start date</strong>, the{' '}
                        <strong className="font-semibold text-zinc-900 dark:text-white">orientation date &amp; weekday</strong>, and
                        the <strong className="font-semibold text-zinc-900 dark:text-white">Zoom join link</strong> for the session.
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <Lock className={cn('mt-0.5 h-4 w-4 shrink-0', theme.accentText)} />
                      <span>The week is then <strong className="font-semibold text-zinc-900 dark:text-white">frozen (read-only)</strong> until you reopen it.</span>
                    </li>
                  </ul>

                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Emails send <strong>once</strong>, immediately, and can&apos;t be recalled. Double-check every{' '}
                      <strong>name</strong>, <strong>personal email</strong> and <strong>department</strong> before you
                      lock — reopening and re-locking will send the invites <strong>again</strong> to everyone on this week.
                    </span>
                  </div>
                </div>
              ) : (
                <div id="nhc-lock-desc" className={cn('rounded-xl border px-4 py-3.5', theme.panelBorder, theme.panelBg)}>
                  <div className={cn('flex items-center gap-2 text-[12.5px] font-semibold', theme.accentText)}>
                    <LockOpen className="h-4 w-4 shrink-0" />
                    Reopen for editing
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                    This unlocks <strong className="font-semibold text-zinc-900 dark:text-white">{weekLabel}</strong> so you
                    can edit its hires again. Reopening on its own{' '}
                    <strong className="font-semibold text-zinc-900 dark:text-white">does not</strong> send or recall any
                    emails.
                  </p>
                  {(lockedBy || lockedStamp) && (
                    <p className="mt-2 text-[12px] text-zinc-500 dark:text-zinc-400">
                      Locked{lockedBy ? <> by <strong className="text-zinc-700 dark:text-zinc-300">{lockedBy}</strong></> : null}
                      {lockedStamp ? <> on {lockedStamp}</> : null}.
                    </p>
                  )}
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[12px] leading-snug text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      When you <strong>Lock in</strong> again, the orientation automation runs again — every hire on this
                      week, <strong>including anyone already emailed</strong>, will receive the invite a second time. Fix or
                      remove rows before re-locking to avoid duplicate invites.
                    </span>
                  </div>
                </div>
              )}

              {/* ── Passphrase ───────────────────────────────────────── */}
              <motion.div animate={shake} className="mt-4">
                <label htmlFor="nhc-lock-pw" className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                  <KeyRound className="h-3.5 w-3.5" />
                  HR Manager passphrase
                </label>
                <div className="relative mt-1.5">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <input
                    ref={inputRef}
                    id="nhc-lock-pw"
                    type={showPw ? 'text' : 'password'}
                    value={password}
                    autoComplete="off"
                    disabled={submitting}
                    onChange={(e) => { setPassword(e.target.value); if (error) setError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                    placeholder="Enter passphrase to continue"
                    aria-invalid={!!error}
                    aria-describedby={error ? 'nhc-lock-pw-error' : undefined}
                    className={cn(
                      'h-11 w-full rounded-xl border bg-white pl-9 pr-10 text-[14px] text-zinc-900 outline-none transition focus:ring-2 disabled:opacity-60 dark:bg-zinc-900 dark:text-zinc-100',
                      error
                        ? 'border-rose-400 focus:border-rose-400 focus:ring-rose-300/50 dark:border-rose-500/60'
                        : cn('border-zinc-300 dark:border-zinc-700', theme.focusRing),
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((s) => !s)}
                    aria-label={showPw ? 'Hide passphrase' : 'Show passphrase'}
                    aria-pressed={showPw}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {error ? (
                  <p id="nhc-lock-pw-error" className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                  </p>
                ) : (
                  <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-zinc-500 dark:text-zinc-500">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                    Locking and reopening are restricted to the HR Manager.
                  </p>
                )}
              </motion.div>
            </div>

            {/* ── Footer ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-end gap-2.5 border-t border-zinc-100 bg-zinc-50/70 px-5 py-3.5 dark:border-zinc-800 dark:bg-zinc-900/40">
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className="h-9 rounded-lg border border-zinc-200 px-4 text-[13px] font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={submitting || password.length === 0}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold text-white shadow-sm transition focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
                  theme.confirmBg,
                )}
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {mode === 'lock' ? 'Locking & sending…' : 'Reopening…'}
                  </>
                ) : mode === 'lock' ? (
                  <>
                    <Lock className="h-4 w-4" />
                    Lock in &amp; send invites
                  </>
                ) : (
                  <>
                    <LockOpen className="h-4 w-4" />
                    Reopen week
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
