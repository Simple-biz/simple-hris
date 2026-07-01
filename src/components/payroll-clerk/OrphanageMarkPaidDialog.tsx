'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';
import { workerTypeLabel } from '@/lib/orphanage/worker-payment';

export function formatOrphanagePHP(v: number | null | undefined) {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Mark-Paid dialog config ─────────────────────────────────────────────────

interface OrphanageCfg {
  heroBg:     string;
  accent:     string;
  accentDim:  string;
  accentGlow: string;
  btnFrom:    string;
  btnTo:      string;
  pillActive: string;
  Icon:       React.ComponentType<{ className?: string }>;
}

const ORPHANAGE_PAID_CFG: OrphanageCfg = {
  heroBg:     'from-emerald-500 via-emerald-600 to-teal-700',
  accent:     '#10b981',
  accentDim:  'rgba(16,185,129,0.28)',
  accentGlow: 'rgba(16,185,129,0.14)',
  btnFrom:    '#059669',
  btnTo:      '#047857',
  pillActive: 'border-emerald-400 bg-emerald-50 text-emerald-800',
  Icon:       CheckCircle2,
};

const ORPHANAGE_PROBLEM_CFG: OrphanageCfg = {
  heroBg:     'from-rose-500 via-rose-600 to-red-700',
  accent:     '#f43f5e',
  accentDim:  'rgba(244,63,94,0.28)',
  accentGlow: 'rgba(244,63,94,0.14)',
  btnFrom:    '#e11d48',
  btnTo:      '#be123c',
  pillActive: 'border-rose-400 bg-rose-50 text-rose-800',
  Icon:       AlertTriangle,
};

function OInput({
  cfg,
  className,
  onFocus,
  onBlur,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'input'>, 'style'> & { cfg: OrphanageCfg }) {
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

function OTextarea({
  cfg,
  className,
  onFocus,
  onBlur,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'textarea'>, 'style'> & { cfg: OrphanageCfg }) {
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

function OField({
  id,
  label,
  cfg,
  children,
}: {
  id: string;
  label: React.ReactNode;
  cfg: OrphanageCfg;
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

// ─── Mark-Paid dialog ────────────────────────────────────────────────────────

export interface OrphanageMarkPaidPayload {
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  swiftCode: string;
  transactionId: string;
  bankUsed: string;
  sentDate: string;
  note: string;
  status: 'paid' | 'problem';
}

interface MarkPaidDialogProps {
  item: OrphanagePendingItem | null;
  onClose: () => void;
  onConfirm: (item: OrphanagePendingItem, payload: OrphanageMarkPaidPayload) => Promise<void>;
}

export default function OrphanageMarkPaidDialog({ item, onClose, onConfirm }: MarkPaidDialogProps) {
  const [bankName,        setBankName]        = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [swiftCode,       setSwiftCode]       = useState('');
  const [transactionId,   setTransactionId]   = useState('');
  const [bankUsed,        setBankUsed]        = useState('');
  const [sentDate,        setSentDate]        = useState(new Date().toISOString().slice(0, 10));
  const [note,            setNote]            = useState('');
  const [status,          setStatus]          = useState<'paid' | 'problem'>('paid');
  const [saving,          setSaving]          = useState(false);

  useEffect(() => {
    if (!item) return;
    setBankName(item.bankName);
    setBankAccountName(item.bankAccountName);
    setBankAccountNumber(item.bankAccountNumber);
    setSwiftCode(item.swiftCode);
    setTransactionId('');
    setBankUsed('');
    setSentDate(new Date().toISOString().slice(0, 10));
    setNote('');
    setStatus('paid');
  }, [item]);

  const handleConfirm = async () => {
    if (!item) return;
    if (!transactionId.trim()) { toast.error('Transaction ID is required.'); return; }
    setSaving(true);
    try {
      await onConfirm(item, {
        bankName: bankName.trim(),
        bankAccountName: bankAccountName.trim(),
        bankAccountNumber: bankAccountNumber.trim(),
        swiftCode: swiftCode.trim(),
        transactionId: transactionId.trim(),
        bankUsed: bankUsed.trim(),
        sentDate,
        note: note.trim(),
        status,
      });
    } finally {
      setSaving(false);
    }
  };

  const cfg   = status === 'paid' ? ORPHANAGE_PAID_CFG : ORPHANAGE_PROBLEM_CFG;
  const valid = transactionId.trim().length > 0;

  const PILLS: { value: 'paid' | 'problem'; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
    { value: 'paid',    label: 'Paid',        Icon: CheckCircle2 },
    { value: 'problem', label: 'Problem',     Icon: AlertTriangle },
  ];

  return (
    <Dialog open={!!item} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[540px] [&>button]:z-20 [&>button]:!text-white/70 [&>button]:transition-colors [&>button]:hover:!text-white">

        <DialogTitle className="sr-only">Log Orphanage Payment</DialogTitle>
        <DialogDescription className="sr-only">{item?.label}</DialogDescription>

        {/* ── Hero ──────────────────────────────────────────────────── */}
        <div className="relative overflow-hidden px-6 pb-6 pt-5">
          {/* Cross-fading gradient layers */}
          {(['paid', 'problem'] as const).map((s) => {
            const heroBg = s === 'paid' ? ORPHANAGE_PAID_CFG.heroBg : ORPHANAGE_PROBLEM_CFG.heroBg;
            return (
              <div
                key={s}
                aria-hidden
                className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', heroBg)}
                style={{ opacity: status === s ? 1 : 0, transition: 'opacity 0.45s cubic-bezier(0.4,0,0.2,1)' }}
              />
            );
          })}
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-44 w-44 rounded-full bg-white/10 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-6 left-6 h-28 w-28 rounded-full bg-white/6 blur-2xl" />

          <div className="relative z-10 flex items-start justify-between gap-4">
            {/* Left: badge + amount */}
            <div>
              <AnimatePresence mode="wait">
                <motion.span
                  key={`badge-${status}`}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.17, ease: 'easeOut' }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.18em] text-white backdrop-blur-sm"
                >
                  <cfg.Icon className="h-2.5 w-2.5" />
                  {status === 'paid' ? 'Sending' : 'Problem'}
                </motion.span>
              </AnimatePresence>

              <div className="mt-2.5 font-mono text-[2.65rem] font-black leading-none tracking-tight text-white drop-shadow-sm">
                {formatOrphanagePHP(item?.amountPhp ?? null)}
              </div>
              <div className="mt-1.5 text-[12px] font-medium tracking-wide text-white/60">
                {item?.label ?? ''}
              </div>
            </div>

            {/* Right: type */}
            <div className="mt-0.5 shrink-0 text-right">
              <p className="text-[12px] font-semibold leading-tight text-white">
                {item?.sourceType === 'gift_shipping'
                  ? 'Gift'
                  : item?.sourceType === 'worker_payment'
                    ? (item.workerPayment ? workerTypeLabel(item.workerPayment) : 'Worker')
                    : 'Budget'}
              </p>
              <p className="mt-0.5 text-[9.5px] font-medium uppercase tracking-widest text-white/50">
                Orphanage
              </p>
            </div>
          </div>
        </div>

        {/* ── Status pills ──────────────────────────────────────────── */}
        <div
          className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-6 py-3 dark:border-zinc-800"
          style={{ backgroundColor: 'rgba(250,250,250,0.95)' }}
          role="radiogroup"
          aria-label="Dispatch status"
        >
          {PILLS.map(({ value, label, Icon }) => {
            const isActive = status === value;
            const activeCfg = value === 'paid' ? ORPHANAGE_PAID_CFG : ORPHANAGE_PROBLEM_CFG;
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
                    ? activeCfg.pillActive
                    : 'border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700',
                )}
              >
                <Icon className="h-3 w-3" />
                {label}
              </motion.button>
            );
          })}
        </div>

        {/* ── Form fields ───────────────────────────────────────────── */}
        <div className="grid max-h-[44vh] gap-4 overflow-y-auto bg-white px-6 py-5 dark:bg-zinc-950">

          <OField id="o-txn" label="Transaction ID" cfg={cfg}>
            <OInput
              id="o-txn"
              cfg={cfg}
              placeholder="Reference / confirmation number"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              className="font-mono text-xs"
              disabled={saving}
            />
          </OField>

          <OField id="o-bank" label="Bank used (sent from)" cfg={cfg}>
            <OInput
              id="o-bank"
              cfg={cfg}
              placeholder="e.g. BPI corporate, Metrobank"
              value={bankUsed}
              onChange={(e) => setBankUsed(e.target.value)}
              disabled={saving}
            />
          </OField>

          <OField id="o-date" label="Date sent" cfg={cfg}>
            <OInput
              id="o-date"
              type="date"
              cfg={cfg}
              value={sentDate}
              onChange={(e) => setSentDate(e.target.value)}
              disabled={saving}
            />
          </OField>

          {/* Recipient divider */}
          <div className="flex items-center gap-2.5">
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            <span className="text-[9.5px] font-bold uppercase tracking-[0.16em] text-zinc-400">
              Recipient
            </span>
            <div className="h-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <OField id="o-rcpt-bank" label="Bank" cfg={cfg}>
              <OInput
                id="o-rcpt-bank"
                cfg={cfg}
                placeholder="BDO, BPI, UnionBank..."
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                disabled={saving}
              />
            </OField>
            <OField id="o-rcpt-holder" label="Account holder" cfg={cfg}>
              <OInput
                id="o-rcpt-holder"
                cfg={cfg}
                placeholder="Name on account"
                value={bankAccountName}
                onChange={(e) => setBankAccountName(e.target.value)}
                disabled={saving}
              />
            </OField>
          </div>

          <OField id="o-rcpt-acct" label="Account number" cfg={cfg}>
            <OInput
              id="o-rcpt-acct"
              cfg={cfg}
              placeholder="1234-5678-9012"
              value={bankAccountNumber}
              onChange={(e) => setBankAccountNumber(e.target.value)}
              className="font-mono text-xs"
              disabled={saving}
            />
          </OField>

          {swiftCode !== undefined && (
            <OField id="o-swift" label="SWIFT / routing code" cfg={cfg}>
              <OInput
                id="o-swift"
                cfg={cfg}
                placeholder="e.g. BNORPHMM"
                value={swiftCode}
                onChange={(e) => setSwiftCode(e.target.value)}
                className="font-mono text-xs uppercase"
                disabled={saving}
              />
            </OField>
          )}

          <OField
            id="o-note"
            label={<>Note <span className="font-normal normal-case tracking-normal opacity-50">optional</span></>}
            cfg={cfg}
          >
            <OTextarea
              id="o-note"
              cfg={cfg}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. Transfer split across two banks."
              disabled={saving}
            />
          </OField>
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <div className="flex items-center justify-end gap-2.5 border-t border-zinc-100 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            className="border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            Cancel
          </Button>

          <motion.button
            type="button"
            onClick={handleConfirm}
            disabled={!valid || saving}
            whileTap={valid && !saving ? { scale: 0.96 } : undefined}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={cn(
              'relative inline-flex min-w-[130px] items-center justify-center gap-2 overflow-hidden rounded-md px-5 py-2 text-[12.5px] font-semibold text-white shadow-md transition-opacity',
              (!valid || saving) && 'cursor-not-allowed opacity-50',
            )}
            style={{
              background: `linear-gradient(135deg, ${cfg.btnFrom}, ${cfg.btnTo})`,
              boxShadow: `0 4px 16px ${cfg.accentGlow}, 0 1px 3px rgba(0,0,0,0.12)`,
              transition: 'background 0.38s ease, box-shadow 0.38s ease, opacity 0.2s ease',
            }}
          >
            <div aria-hidden className="pointer-events-none absolute -right-2 -top-2 h-14 w-14 rounded-full bg-white/15 blur-xl" />
            <span className="relative inline-flex items-center gap-2">
              {saving ? (
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
                    {status === 'paid' ? 'Mark paid' : 'Log problem'}
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
