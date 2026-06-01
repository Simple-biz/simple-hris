'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, CheckCircle2, CircleDashed, Gauge, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPHP, formatUSD, type ProcessorId, type QueueRow } from './mock-queue';

export type DispatchStatus = 'paid' | 'not_paid' | 'threshold' | 'problem';

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
}

/* ---- helpers ---------------------------------------------------------- */

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveDefaults(row: QueueRow) {
  const p = row.processor as ProcessorId;
  const d = row.details ?? {};
  switch (p) {
    case 'hurupay': return { preferredBank: 'Hurupay',  accountNumber: d.hurupay_email ?? '',                accountHolder: row.name,                              swiftCode: '' };
    case 'wepay':   return { preferredBank: 'Wepay',    accountNumber: d.wepay_email ?? '',                  accountHolder: row.name,                              swiftCode: '' };
    case 'higlobe': return { preferredBank: 'HiGlobe',  accountNumber: d.higlobe_email ?? '',                accountHolder: d.higlobe_account_name ?? row.name,    swiftCode: '' };
    case 'wise':    return { preferredBank: 'Wise',     accountNumber: d.wise_email ?? d.wise_tag ?? '',     accountHolder: d.account_holder_name ?? row.name,     swiftCode: '' };
    case 'jeeves':  return { preferredBank: d.bank_name ?? 'Jeeves', accountNumber: d.account_number ?? d.phone_number ?? '', accountHolder: d.account_holder_name ?? row.name, swiftCode: d.swift_code ?? '' };
    case 'wires':   return { preferredBank: d.bank_name ?? row.bankPreferredRaw ?? '', accountNumber: d.account_number ?? '', accountHolder: d.account_holder_name ?? row.name, swiftCode: d.swift_code ?? '' };
    default:        return { preferredBank: '', accountNumber: '', accountHolder: row.name, swiftCode: '' };
  }
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

export default function MarkPaidDialog({ row, onClose, onConfirm }: MarkPaidDialogProps) {
  const defaults = useMemo(() => (row ? deriveDefaults(row) : null), [row]);

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
  }, [row?.id, defaults, row]);

  const open    = row != null;
  const valid   = transactionId.trim().length > 0 && bankUsed.trim().length > 0 && sentDate.length > 0;
  const isWires = row?.processor === 'wires';
  const cfg     = CFG[status];

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

          {/* Content */}
          <div className="relative z-10 flex items-start justify-between gap-4">
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

              <div className="mt-2.5 font-mono text-[2.65rem] font-black leading-none tracking-tight text-white drop-shadow-sm">
                {formatUSD(row?.amountUSD ?? null)}
              </div>
              <div className="mt-1.5 font-mono text-[13px] font-semibold tracking-wide text-white/65">
                {formatPHP(row?.amountPHP ?? null)}
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
            </div>
          </div>
        </div>

        {/* ── Status selector ───────────────────────────────────────── */}
        <div
          className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-6 py-3 dark:border-zinc-800"
          style={{ backgroundColor: 'rgba(250,250,250,0.95)' }}
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
        <div className="grid max-h-[44vh] gap-4 overflow-y-auto bg-white px-6 py-5 dark:bg-zinc-950">

          <Field id="txn" label="Transaction ID" cfg={cfg}>
            <FieldInput
              id="txn"
              cfg={cfg}
              placeholder="Paste confirmation from processor"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          <Field id="bank" label="Bank used (sent from)" cfg={cfg}>
            <FieldInput
              id="bank"
              cfg={cfg}
              placeholder="e.g. BPI corporate, Wise USD"
              value={bankUsed}
              onChange={(e) => setBankUsed(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="sent" label="Date sent" cfg={cfg}>
              <FieldInput
                id="sent"
                type="date"
                cfg={cfg}
                value={sentDate}
                onChange={(e) => setSentDate(e.target.value)}
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
              <FieldInput
                id="arrival"
                type="date"
                cfg={cfg}
                value={arrivalDate}
                onChange={(e) => setArrivalDate(e.target.value)}
              />
            </Field>
          </div>

          {/* Recipient divider */}
          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              Recipient
            </span>
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
              />
            </Field>
            <Field id="rcpt-holder" label="Account holder" cfg={cfg}>
              <FieldInput
                id="rcpt-holder"
                cfg={cfg}
                placeholder="Name on account"
                value={recipientAccountHolder}
                onChange={(e) => setRecipientAccountHolder(e.target.value)}
              />
            </Field>
          </div>

          <Field
            id="rcpt-acct"
            label={
              <>
                Account / wallet ID
                {row && row.processor !== 'wires' && (
                  <span className="font-normal normal-case tracking-normal opacity-50">
                    {' '}(email for digital wallets)
                  </span>
                )}
              </>
            }
            cfg={cfg}
          >
            <FieldInput
              id="rcpt-acct"
              cfg={cfg}
              placeholder={isWires ? '0098-2231-7710' : 'recipient@example.com'}
              value={recipientAccountNumber}
              onChange={(e) => setRecipientAccountNumber(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>

          {isWires && (
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
        </div>

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
