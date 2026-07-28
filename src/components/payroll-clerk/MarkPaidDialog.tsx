'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Copy, Gauge, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { playPaymentConfirmed } from '@/lib/sound/ping-chime';
import { formatPHP, formatUSD, formatCOP, type QueueRow } from './mock-queue';
import ContractorChip, { showsContractorBadge } from './ContractorChip';
import { resolveMarkPaidDefaults } from '@/lib/payroll/mark-paid-defaults';

export type DispatchStatus = 'paid' | 'not_paid' | 'threshold' | 'problem';

/**
 * Source banks / accounts the company sends payroll FROM. Shown as a dropdown
 * in the "Bank used" field so the clerk picks a consistent value instead of
 * free text (which produced inconsistent spellings that were hard to report
 * on). Order mirrors the accounting team's canonical list.
 */
const BANK_USED_OPTIONS = [
  'Chase',
  'Jeeves',
  'Parallax',
  'PayPal',
  'Wise',
  'x1161',
  'x1153',
  'x0048',
  'Remitly',
  'HiGlobe',
  'Hurupay',
] as const;

/* ---- status configuration -------------------------------------------- */

interface StatusCfg {
  label: string;
  heroLabel: string;
  Icon: React.ComponentType<{ className?: string }>;
  heroBg: string;       // tailwind gradient classes for cross-fade layer
  pillActive: string;   // tailwind for active status pill
  accent: string;       // hex — focused borders, labels, active pills
  accentDim: string;    // rgba — unfocused border tint
  accentGlow: string;   // rgba — focus ring glow + button shadow
  btnBg: string;        // hex gradient start for confirm button
  btnHover: string;     // hex gradient end
  confirmLabel: string;
}

const CFG: Record<DispatchStatus, StatusCfg> = {
  paid: {
    label: 'Paid',
    heroLabel: 'Sending',
    Icon: CheckCircle2,
    heroBg: 'from-emerald-500 via-emerald-600 to-teal-700',
    pillActive: 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:border-emerald-500/40 dark:text-emerald-200',
    accent: '#10b981',
    accentDim: 'rgba(16,185,129,0.28)',
    accentGlow: 'rgba(16,185,129,0.14)',
    btnBg: '#059669',
    btnHover: '#047857',
    confirmLabel: 'Confirm sent',
  },
  not_paid: {
    label: 'Not Paid',
    heroLabel: 'Not sent',
    Icon: CircleDashed,
    heroBg: 'from-zinc-600 via-zinc-700 to-zinc-800',
    pillActive: 'border-zinc-400 bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:border-zinc-600 dark:text-zinc-200',
    accent: '#71717a',
    accentDim: 'rgba(113,113,122,0.28)',
    accentGlow: 'rgba(113,113,122,0.12)',
    btnBg: '#3f3f46',
    btnHover: '#27272a',
    confirmLabel: 'Log dispatch',
  },
  threshold: {
    label: 'Threshold',
    heroLabel: 'Threshold',
    Icon: Gauge,
    heroBg: 'from-amber-400 via-amber-500 to-orange-600',
    pillActive: 'border-amber-400 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:border-amber-500/40 dark:text-amber-200',
    accent: '#f59e0b',
    accentDim: 'rgba(245,158,11,0.28)',
    accentGlow: 'rgba(245,158,11,0.14)',
    btnBg: '#d97706',
    btnHover: '#b45309',
    confirmLabel: 'Log dispatch',
  },
  problem: {
    label: 'Problem',
    heroLabel: 'Problem',
    Icon: AlertTriangle,
    heroBg: 'from-rose-500 via-rose-600 to-red-700',
    pillActive: 'border-rose-400 bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:border-rose-500/40 dark:text-rose-200',
    accent: '#f43f5e',
    accentDim: 'rgba(244,63,94,0.28)',
    accentGlow: 'rgba(244,63,94,0.14)',
    btnBg: '#e11d48',
    btnHover: '#be123c',
    confirmLabel: 'Log problem',
  },
};

/* ---- types ------------------------------------------------------------ */

export interface MarkPaidPayload {
  rowId: string;
  transactionId: string;
  bankUsed: string;
  sentDate: string;
  arrivalDate: string;
  recipientPreferredBank: string;
  recipientAccountNumber: string;
  recipientAccountHolder: string;
  recipientSwiftCode: string;
  status: DispatchStatus;
  note: string;
}

interface MarkPaidDialogProps {
  row: QueueRow | null;
  onClose: () => void;
  onConfirm: (payload: MarkPaidPayload) => Promise<void> | void;
  /**
   * Gallery navigation. When provided (and `total > 1`), the dialog shows
   * prev/next chevrons + a counter and responds to ←/→ arrow keys so the user
   * can slide between payments without closing the modal.
   */
  position?: { index: number; total: number };
  onPrev?: () => void;
  onNext?: () => void;
  /**
   * Fires after a successful profile override (Save to profile) so the parent
   * can silently refetch the queue — the corrected details become the row's
   * new defaults. Optional: render sites without a queue skip it.
   */
  onBankDetailsOverridden?: () => void;
}

/* ---- gallery slide animation ----------------------------------------- */

/**
 * Direction-aware slide used when navigating between payments. `dir` is +1 when
 * moving to the next payment (content slides in from the right, out to the
 * left) and -1 when moving to the previous one.
 */
const slideVariants = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 26 : -26 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -26 : 26 }),
};

const slideTransition = { duration: 0.2, ease: [0.16, 1, 0.3, 1] as const };

/* ---- helpers ---------------------------------------------------------- */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ---- reactive field components --------------------------------------- */

interface FieldInputProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'style'> {
  cfg: StatusCfg;
}

function FieldInput({ cfg, className, onFocus, onBlur, ...props }: FieldInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="rounded-md transition-[box-shadow] duration-200"
      style={{ boxShadow: focused ? `0 0 0 3px ${cfg.accentGlow}` : '0 0 0 3px transparent' }}
    >
      <input
        {...props}
        className={cn(
          'flex h-9 w-full rounded-md border bg-white px-3 py-1 text-sm text-zinc-900 outline-none',
          'placeholder:text-zinc-400 transition-[border-color] duration-200',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500',
          className,
        )}
        style={{ borderColor: focused ? cfg.accent : cfg.accentDim }}
        onFocus={(e) => { setFocused(true);  onFocus?.(e); }}
        onBlur={(e)  => { setFocused(false); onBlur?.(e);  }}
      />
    </div>
  );
}

interface FieldSelectProps extends Omit<React.ComponentPropsWithoutRef<'select'>, 'style'> {
  cfg: StatusCfg;
  /** Renders the value in muted placeholder color while nothing is chosen. */
  placeholderActive?: boolean;
}

function FieldSelect({ cfg, className, placeholderActive, onFocus, onBlur, children, ...props }: FieldSelectProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="relative rounded-md transition-[box-shadow] duration-200"
      style={{ boxShadow: focused ? `0 0 0 3px ${cfg.accentGlow}` : '0 0 0 3px transparent' }}
    >
      <select
        {...props}
        className={cn(
          'flex h-9 w-full cursor-pointer appearance-none rounded-md border bg-white px-3 py-1 pr-9 text-sm text-zinc-900 outline-none',
          'transition-[border-color] duration-200',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-zinc-950 dark:text-zinc-100',
          placeholderActive && 'text-zinc-400 dark:text-zinc-500',
          className,
        )}
        style={{ borderColor: focused ? cfg.accent : cfg.accentDim }}
        onFocus={(e) => { setFocused(true);  onFocus?.(e); }}
        onBlur={(e)  => { setFocused(false); onBlur?.(e);  }}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400 transition-colors duration-200"
        style={{ color: focused ? cfg.accent : undefined }}
      />
    </div>
  );
}

interface FieldTextareaProps extends Omit<React.ComponentPropsWithoutRef<'textarea'>, 'style'> {
  cfg: StatusCfg;
}

function FieldTextarea({ cfg, className, onFocus, onBlur, ...props }: FieldTextareaProps) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      className="rounded-md transition-[box-shadow] duration-200"
      style={{ boxShadow: focused ? `0 0 0 3px ${cfg.accentGlow}` : '0 0 0 3px transparent' }}
    >
      <textarea
        {...props}
        className={cn(
          'flex w-full resize-none rounded-md border bg-white px-3 py-2 text-sm text-zinc-900 outline-none',
          'placeholder:text-zinc-400 transition-[border-color] duration-200',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500',
          className,
        )}
        style={{ borderColor: focused ? cfg.accent : cfg.accentDim }}
        onFocus={(e) => { setFocused(true);  onFocus?.(e); }}
        onBlur={(e)  => { setFocused(false); onBlur?.(e);  }}
      />
    </div>
  );
}

function Field({
  id,
  label,
  cfg,
  children,
}: {
  id: string;
  label: React.ReactNode;
  cfg: StatusCfg;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={id}
        className="text-[10.5px] font-semibold uppercase tracking-wider transition-[color] duration-300"
        style={{ color: cfg.accent }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/* ---- main component -------------------------------------------------- */

export default function MarkPaidDialog({
  row,
  onClose,
  onConfirm,
  position,
  onPrev,
  onNext,
  onBankDetailsOverridden,
}: MarkPaidDialogProps) {
  const defaults = useMemo(() => (row ? resolveMarkPaidDefaults(row) : null), [row]);

  const [transactionId,          setTransactionId]          = useState('');
  const [bankUsed,               setBankUsed]               = useState('');
  const [sentDate,               setSentDate]               = useState(todayISO());
  const [arrivalDate,            setArrivalDate]            = useState('');
  const [recipientPreferredBank, setRecipientPreferredBank] = useState('');
  const [recipientAccountNumber, setRecipientAccountNumber] = useState('');
  const [recipientAccountHolder, setRecipientAccountHolder] = useState('');
  const [recipientSwiftCode,     setRecipientSwiftCode]     = useState('');
  const [status,                 setStatus]                 = useState<DispatchStatus>('paid');
  const [note,                   setNote]                   = useState('');
  const [submitting,             setSubmitting]             = useState(false);
  const [copied,                 setCopied]                 = useState(false);
  const [copiedAcct,             setCopiedAcct]             = useState(false);

  // ── Profile override (pencil on the Recipient divider) ─────────────────
  // Arms an explicit "Save to profile" that writes the recipient fields back
  // to employee_ids, overriding the employee dashboard. Typing WITHOUT the
  // pencil keeps the log-only behavior. Snapshot restores on Cancel.
  const [overrideMode, setOverrideMode]         = useState(false);
  const [overrideSaving, setOverrideSaving]     = useState(false);
  const [overrideSnapshot, setOverrideSnapshot] = useState<{
    bank: string; holder: string; acct: string; swift: string;
  } | null>(null);

  // The hero leads with the currency the recipient is actually PAID in, because
  // that's the figure the clerk keys into the processor — the USD anchor drops
  // to the secondary line beneath it. Every rail settles locally: the wallets
  // (Hurupay, HiGlobe, Wise) deposit in local currency, and `wires` for a PHP
  // payee is a domestic peso wire. Only genuinely USD-paid people (US managers,
  // USD contractors) lead with dollars, and they keep the PHP equivalent below.
  const heroCurrency = row?.payCurrency ?? 'PHP';
  const heroAmount =
    (heroCurrency === 'COP' ? row?.amountCOP
      : heroCurrency === 'USD' ? row?.amountUSD
      : row?.amountPHP) ?? null;
  const formatHero =
    heroCurrency === 'COP' ? formatCOP : heroCurrency === 'USD' ? formatUSD : formatPHP;
  const subAmount =
    heroCurrency === 'USD' ? formatPHP(row?.amountPHP ?? null) : formatUSD(row?.amountUSD ?? null);

  const copyAmount = useCallback(() => {
    if (heroAmount == null || !row) return;
    // Copy the hero amount as a bare number — "$1,234.50" / "₱1,234.50" paste
    // as "1234.50" (cents preserved) straight into processors / spreadsheets.
    // COP copies whole pesos ("$COP1.234.567" → "1234567"): es-CO groups with
    // dots, so stripping the formatted string would fabricate a decimal point.
    const text = heroCurrency === 'COP' ? String(Math.round(heroAmount)) : heroAmount.toFixed(2);
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      done();
    }
  }, [heroAmount, heroCurrency, row]);

  // Copy the recipient's account / wallet ID verbatim — unlike the amount, this
  // pastes as-is (email, account number, or tag) straight into the processor.
  const copyAccount = useCallback(() => {
    const text = recipientAccountNumber.trim();
    if (!text) return;
    const done = () => {
      setCopiedAcct(true);
      window.setTimeout(() => setCopiedAcct(false), 1400);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      done();
    }
  }, [recipientAccountNumber]);

  const enterOverride = useCallback(() => {
    setOverrideSnapshot({
      bank: recipientPreferredBank,
      holder: recipientAccountHolder,
      acct: recipientAccountNumber,
      swift: recipientSwiftCode,
    });
    setOverrideMode(true);
  }, [recipientPreferredBank, recipientAccountHolder, recipientAccountNumber, recipientSwiftCode]);

  const cancelOverride = useCallback(() => {
    if (overrideSnapshot) {
      setRecipientPreferredBank(overrideSnapshot.bank);
      setRecipientAccountHolder(overrideSnapshot.holder);
      setRecipientAccountNumber(overrideSnapshot.acct);
      setRecipientSwiftCode(overrideSnapshot.swift);
    }
    setOverrideSnapshot(null);
    setOverrideMode(false);
  }, [overrideSnapshot]);

  const saveOverride = useCallback(async () => {
    if (!row || recipientAccountNumber.trim() === '' || overrideSaving) return;
    setOverrideSaving(true);
    try {
      const res = await fetch('/api/payment-dispatch/bank-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: row.email,
          target: (defaults?.showSwiftField ?? false) ? 'bank' : 'wallet',
          processor: row.processor,
          display_name: row.name,
          values: {
            preferredBank: recipientPreferredBank,
            accountNumber: recipientAccountNumber,
            accountHolder: recipientAccountHolder,
            swiftCode: recipientSwiftCode,
          },
        }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to save to profile');
      toast.success(`Saved to ${row.name}'s profile — their dashboard now shows these details.`);
      setOverrideSnapshot(null);
      setOverrideMode(false);
      onBankDetailsOverridden?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save to profile');
    } finally {
      setOverrideSaving(false);
    }
  }, [row, defaults, recipientPreferredBank, recipientAccountNumber, recipientAccountHolder, recipientSwiftCode, overrideSaving, onBankDetailsOverridden]);

  useEffect(() => {
    if (!row || !defaults) return;
    setTransactionId('');
    setBankUsed('');
    setSentDate(todayISO());
    setArrivalDate('');
    setRecipientPreferredBank(defaults.preferredBank);
    setRecipientAccountNumber(defaults.accountNumber);
    setRecipientAccountHolder(defaults.accountHolder);
    setRecipientSwiftCode(defaults.swiftCode);
    setStatus('paid');
    setNote('');
    setSubmitting(false);
    setCopiedAcct(false);
    setOverrideMode(false);
    setOverrideSnapshot(null);
    setOverrideSaving(false);
  }, [row?.id, defaults, row]);

  const open    = row != null;
  /**
   * Hurupay and Higlobe don't hand back a usable confirmation reference, so a
   * transaction ID can't be required for them — the clerk would have to invent one.
   * Every other rail still requires it. Mirrored server-side in
   * POST /api/payment-dispatches (TXN_OPTIONAL_PROCESSORS).
   */
  const txnOptional = row?.processor === 'hurupay' || row?.processor === 'higlobe';
  const valid =
    (txnOptional || transactionId.trim().length > 0) &&
    bankUsed.trim().length > 0 &&
    sentDate.length > 0;
  // Whether the recipient is paid INTO a bank account — a genuine wire, OR a
  // wallet-routed employee (e.g. Wise) whose dashboard payout is their own bank.
  // Drives the SWIFT field, the account placeholder, and the wallet hint so the
  // receiving-end display follows the Employee Dashboard, not just the processor.
  const isBankWire = defaults?.showSwiftField ?? false;

  // Which recipient fields the profile override can actually persist. Wallet
  // processors only store what their columns carry: hurupay/wepay just the
  // wallet email; higlobe/wise also the holder. Bank wires store all four.
  const overrideEditable = {
    bank: isBankWire,
    holder: isBankWire || row?.processor === 'higlobe' || row?.processor === 'wise',
    acct: true,
    swift: isBankWire,
  };

  const cfg     = CFG[status];

  const hasGallery = position != null && position.total > 1;
  const canPrev    = hasGallery && position!.index > 0;
  const canNext    = hasGallery && position!.index < position!.total - 1;

  // Slide direction for the content animation: -1 = previous, +1 = next.
  const [dir, setDir] = useState(0);
  const goPrev = useCallback(() => { setDir(-1); onPrev?.(); }, [onPrev]);
  const goNext = useCallback(() => { setDir(1);  onNext?.(); }, [onNext]);

  // ←/→ slide between payments — but only when the user isn't typing in a
  // field (otherwise we'd hijack cursor movement inside the inputs).
  useEffect(() => {
    if (!open || !hasGallery) return;
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      if (e.key === 'ArrowLeft' && canPrev) {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight' && canNext) {
        e.preventDefault();
        goNext();
      }
    };
    // Capture phase: Base UI's dialog manages keyboard/focus and can stop the
    // event from bubbling to window, so we intercept it before that happens.
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, hasGallery, canPrev, canNext, goPrev, goNext]);

  const handleConfirm = async () => {
    if (!row || !valid) return;
    setSubmitting(true);
    try {
      await onConfirm({
        rowId: row.id,
        transactionId: transactionId.trim(),
        bankUsed: bankUsed.trim(),
        sentDate,
        arrivalDate,
        recipientPreferredBank: recipientPreferredBank.trim(),
        recipientAccountNumber: recipientAccountNumber.trim(),
        recipientAccountHolder: recipientAccountHolder.trim(),
        recipientSwiftCode: recipientSwiftCode.trim(),
        status,
        note: note.trim(),
      });
      // Confirmed sent — reward the clerk with a crisp confirmation tick.
      // Only for a successful "paid" dispatch, not problem/not-paid/threshold logs.
      if (status === 'paid') playPaymentConfirmed();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      {/*
        [&>button] targets the DialogPrimitive.Close (direct child button only).
        Ensures it stays above the hero gradient and is legible on the dark bg.
      */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[540px] [&>button]:z-20 [&>button]:!text-white/70 [&>button]:transition-colors [&>button]:hover:!text-white">

        {/* Accessible title — visually hidden; hero carries the visual label */}
        <DialogTitle className="sr-only">Mark payment as sent</DialogTitle>

        {/* ── Hero ──────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden px-6 pb-6 pt-5">
          {/* Cross-fading gradient layers — one per status */}
          {(Object.keys(CFG) as DispatchStatus[]).map((s) => (
            <div
              key={s}
              aria-hidden
              className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', CFG[s].heroBg)}
              style={{
                opacity: status === s ? 1 : 0,
                transition: 'opacity 0.45s cubic-bezier(0.4,0,0.2,1)',
              }}
            />
          ))}
          {/* Decorative orbs */}
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-44 w-44 rounded-full bg-white/10 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-6 left-6 h-28 w-28 rounded-full bg-white/6 blur-2xl" />

          {/* Gallery navigation — prev / counter / next. Hidden for single rows. */}
          {hasGallery && (
            <div className="relative z-10 mb-3 flex items-center gap-1">
              <button
                type="button"
                onClick={() => canPrev && goPrev()}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!canPrev}
                aria-label="Previous payment"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white outline-none backdrop-blur-sm transition-[background,opacity] hover:bg-white/25 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[3.5rem] text-center font-mono text-[11px] font-semibold tabular-nums text-white/85">
                {position!.index + 1} / {position!.total}
              </span>
              <button
                type="button"
                onClick={() => canNext && goNext()}
                onMouseDown={(e) => e.preventDefault()}
                disabled={!canNext}
                aria-label="Next payment"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white outline-none backdrop-blur-sm transition-[background,opacity] hover:bg-white/25 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="ml-1.5 hidden text-[9.5px] font-medium uppercase tracking-[0.14em] text-white/45 sm:inline">
                ← / → to navigate
              </span>
            </div>
          )}

          {/* Content — slides left/right when navigating between payments */}
          <AnimatePresence mode="wait" custom={dir} initial={false}>
            <motion.div
              key={row?.id ?? 'none'}
              custom={dir}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={slideTransition}
              className="relative z-10 flex items-start justify-between gap-4"
            >
            {/* Left: amount */}
            <div>
              <AnimatePresence mode="wait">
                <motion.span
                  key={`hl-${status}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.17, ease: 'easeOut' }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.18em] text-white backdrop-blur-sm"
                >
                  <cfg.Icon className="h-2.5 w-2.5" />
                  {cfg.heroLabel}
                </motion.span>
              </AnimatePresence>

              <div className="mt-2.5 flex items-center gap-2.5">
                <span className="font-mono text-[2.65rem] font-black leading-none tracking-tight text-white drop-shadow-sm">
                  {formatHero(heroAmount)}
                </span>
                <button
                  type="button"
                  onClick={copyAmount}
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={heroAmount == null}
                  aria-label={copied ? 'Amount copied' : 'Copy amount'}
                  title={copied ? 'Copied' : 'Copy amount'}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-white outline-none backdrop-blur-sm transition-[background,opacity] hover:bg-white/25 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <div className="mt-1.5 font-mono text-[13px] font-semibold tracking-wide text-white/65">
                {subAmount}
              </div>

              {row && row.bonusTotalPHP > 0 && (
                <div className="mt-2.5 inline-flex items-center rounded-full bg-white/20 px-2.5 py-0.5 text-[9.5px] font-semibold text-white backdrop-blur-sm">
                  {`incl. ${formatPHP(row.bonusTotalPHP)} bonus`}
                </div>
              )}
            </div>

            {/* Right: recipient */}
            <div className="mt-0.5 shrink-0 text-right">
              <p className="text-[12px] font-semibold leading-tight text-white">
                {row?.name ?? ''}
              </p>
              <p className="mt-0.5 text-[9.5px] font-medium uppercase tracking-widest text-white/50">
                {row?.processor ?? ''}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1">
                {/* Which invoice this settles — the safeguard for contractors who
                    also have an employee identity and can legitimately have two
                    payable rows in the same cycle. */}
                {row && showsContractorBadge(row) && (
                  <ContractorChip variant="hero" invoiceNumber={row.invoiceNumber} />
                )}
                {row?.departmentName && (
                  <span className="inline-flex items-center rounded-full bg-white/20 px-2 py-0.5 text-[9.5px] font-semibold text-white backdrop-blur-sm">
                    {row.departmentName}
                  </span>
                )}
              </div>
            </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* ── Status selector ───────────────────────────────────────── */}
        <div
          className="flex flex-wrap gap-1.5 border-b border-zinc-100 bg-[rgba(250,250,250,0.95)] px-6 py-3 dark:border-zinc-800 dark:bg-[rgba(24,24,27,0.95)]"
          role="radiogroup"
          aria-label="Dispatch status"
        >
          {(Object.entries(CFG) as [DispatchStatus, StatusCfg][]).map(([value, c]) => {
            const isActive = status === value;
            return (
              <motion.button
                key={value}
                type="button"
                role="radio"
                aria-checked={isActive}
                onClick={() => setStatus(value)}
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold transition-all duration-200',
                  isActive
                    ? c.pillActive
                    : 'border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-700 dark:bg-transparent dark:text-zinc-400 dark:hover:bg-zinc-800/60',
                )}
              >
                <c.Icon className="h-3 w-3" />
                {c.label}
              </motion.button>
            );
          })}
        </div>

        {/* ── Form fields ───────────────────────────────────────────── */}
        <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.div
          key={row?.id ?? 'none'}
          custom={dir}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={slideTransition}
          className="grid max-h-[44vh] gap-4 overflow-y-auto overflow-x-hidden bg-white px-6 py-5 dark:bg-zinc-950"
        >

          <Field id="txn" label={txnOptional ? 'Transaction ID (optional)' : 'Transaction ID'} cfg={cfg}>
            <FieldInput
              id="txn"
              cfg={cfg}
              placeholder={
                txnOptional
                  ? 'Optional — Hurupay/Higlobe give no reference'
                  : 'Paste confirmation from processor'
              }
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <Field id="bank" label="Bank used (sent from)" cfg={cfg}>
            <FieldSelect
              id="bank"
              cfg={cfg}
              value={bankUsed}
              placeholderActive={bankUsed === ''}
              onChange={(e) => setBankUsed(e.target.value)}
            >
              <option value="" disabled>Select a bank…</option>
              {BANK_USED_OPTIONS.map((bank) => (
                <option key={bank} value={bank}>{bank}</option>
              ))}
            </FieldSelect>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="sent" label="Date sent" cfg={cfg}>
              <DatePicker
                id="sent"
                value={sentDate}
                onChange={setSentDate}
                required
              />
            </Field>
            <Field
              id="arrival"
              label={
                <>
                  Arrival{' '}
                  <span className="font-normal normal-case tracking-normal opacity-50">optional</span>
                </>
              }
              cfg={cfg}
            >
              <DatePicker
                id="arrival"
                value={arrivalDate}
                onChange={setArrivalDate}
              />
            </Field>
          </div>

          {/* Recipient divider — pencil arms the profile override */}
          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              Recipient
            </span>
            {overrideMode ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[9.5px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                <Pencil className="h-2.5 w-2.5" />
                Editing employee profile
              </span>
            ) : (
              <button
                type="button"
                onClick={enterOverride}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Override employee profile bank details"
                title="Override the employee's saved bank details"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-600 focus:outline-none focus-visible:outline-none dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field id="rcpt-bank" label="Bank" cfg={cfg}>
              <FieldInput
                id="rcpt-bank"
                cfg={cfg}
                placeholder="BPI, UnionBank, Wise..."
                value={recipientPreferredBank}
                onChange={(e) => setRecipientPreferredBank(e.target.value)}
                disabled={overrideMode && !overrideEditable.bank}
                className={cn(overrideMode && !overrideEditable.bank && 'opacity-60')}
              />
            </Field>
            <Field id="rcpt-holder" label="Account holder" cfg={cfg}>
              <FieldInput
                id="rcpt-holder"
                cfg={cfg}
                placeholder="Name on account"
                value={recipientAccountHolder}
                onChange={(e) => setRecipientAccountHolder(e.target.value)}
                disabled={overrideMode && !overrideEditable.holder}
                className={cn(overrideMode && !overrideEditable.holder && 'opacity-60')}
              />
            </Field>
          </div>

          <Field
            id="rcpt-acct"
            label={
              <>
                Account / wallet ID
                {row && !isBankWire && (
                  <span className="font-normal normal-case tracking-normal opacity-50">
                    {' '}(email for digital wallets)
                  </span>
                )}
              </>
            }
            cfg={cfg}
          >
            <div className="relative">
              <FieldInput
                id="rcpt-acct"
                cfg={cfg}
                placeholder={isBankWire ? '0098-2231-7710' : 'recipient@example.com'}
                value={recipientAccountNumber}
                onChange={(e) => setRecipientAccountNumber(e.target.value)}
                className="pr-10 font-mono text-xs"
              />
              <button
                type="button"
                onClick={copyAccount}
                onMouseDown={(e) => e.preventDefault()}
                disabled={recipientAccountNumber.trim().length === 0}
                aria-label={copiedAcct ? 'Account ID copied' : 'Copy account / wallet ID'}
                title={copiedAcct ? 'Copied' : 'Copy'}
                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-zinc-100 hover:text-zinc-600 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                style={copiedAcct ? { color: cfg.accent } : undefined}
              >
                {copiedAcct ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          </Field>

          {isBankWire && (
            <Field id="rcpt-swift" label="SWIFT code" cfg={cfg}>
              <FieldInput
                id="rcpt-swift"
                cfg={cfg}
                placeholder="e.g. BOPIPHMM"
                value={recipientSwiftCode}
                onChange={(e) => setRecipientSwiftCode(e.target.value.toUpperCase())}
                className="font-mono text-xs uppercase"
              />
            </Field>
          )}

          {overrideMode && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/20">
              <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                Saves these details to {row?.name ?? 'the employee'}&apos;s profile —
                overriding their dashboard.
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-md text-[11.5px]"
                  disabled={overrideSaving}
                  onClick={cancelOverride}
                >
                  <X className="h-3 w-3" />
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1 rounded-md bg-amber-600 text-[11.5px] text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
                  disabled={overrideSaving || recipientAccountNumber.trim() === ''}
                  onClick={() => void saveOverride()}
                >
                  {overrideSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Save to profile
                </Button>
              </div>
            </div>
          )}

          <Field
            id="note"
            label={
              <>
                Note{' '}
                <span className="font-normal normal-case tracking-normal opacity-50">optional</span>
              </>
            }
            cfg={cfg}
          >
            <FieldTextarea
              id="note"
              cfg={cfg}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Bank rejected, will retry tomorrow morning."
            />
          </Field>
        </motion.div>
        </AnimatePresence>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-2.5 border-t border-zinc-100 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            className="border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            Cancel
          </Button>

          {/* Confirm — background transitions smoothly between status colors */}
          <motion.button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || submitting}
            whileTap={valid && !submitting ? { scale: 0.96 } : undefined}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={cn(
              'relative inline-flex min-w-[148px] items-center justify-center gap-2 overflow-hidden rounded-md px-5 py-2 text-[12.5px] font-semibold text-white shadow-md transition-opacity',
              (!valid || submitting) && 'cursor-not-allowed opacity-50',
            )}
            style={{
              background: `linear-gradient(135deg, ${cfg.btnBg}, ${cfg.btnHover})`,
              boxShadow: `0 4px 16px ${cfg.accentGlow}, 0 1px 3px rgba(0,0,0,0.12)`,
              transition: 'background 0.38s ease, box-shadow 0.38s ease, opacity 0.2s ease',
            }}
          >
            {/* Shimmer orb inside button */}
            <div
              aria-hidden
              className="pointer-events-none absolute -right-2 -top-2 h-14 w-14 rounded-full bg-white/15 blur-xl"
            />
            <span className="relative inline-flex items-center gap-2">
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AnimatePresence mode="wait">
                  <motion.span
                    key={status}
                    className="inline-flex items-center gap-1.5"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.14 }}
                  >
                    <cfg.Icon className="h-3.5 w-3.5" />
                    {cfg.confirmLabel}
                  </motion.span>
                </AnimatePresence>
              )}
            </span>
          </motion.button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
