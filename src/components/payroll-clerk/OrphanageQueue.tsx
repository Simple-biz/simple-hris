'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'motion/react';
import QueuePagination from './QueuePagination';
import {
  AlertTriangle,
  Banknote,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Gift,
  Heart,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OrphanagePendingItem } from '@/lib/supabase/orphanage-dispatches';

function formatPHP(v: number | null | undefined) {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// ─── Mark-Paid dialog helpers ────────────────────────────────────────────────

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

interface MarkPaidDialogProps {
  item: OrphanagePendingItem | null;
  onClose: () => void;
  onConfirm: (item: OrphanagePendingItem, payload: MarkPaidPayload) => Promise<void>;
}

interface MarkPaidPayload {
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

function OrphanageMarkPaidDialog({ item, onClose, onConfirm }: MarkPaidDialogProps) {
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
                {formatPHP(item?.amountPhp ?? null)}
              </div>
              <div className="mt-1.5 text-[12px] font-medium tracking-wide text-white/60">
                {item?.label ?? ''}
              </div>
            </div>

            {/* Right: type */}
            <div className="mt-0.5 shrink-0 text-right">
              <p className="text-[12px] font-semibold leading-tight text-white">
                {item?.sourceType === 'gift_shipping' ? 'Gift' : 'Budget'}
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

// ─── Item card ──────────────────────────────────────────────────────────────

function OrphanageItemCard({
  item,
  onMarkPaid,
}: {
  item: OrphanagePendingItem;
  onMarkPaid: (item: OrphanagePendingItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const br = item.budgetRequest;
  const gs = item.giftShipping;

  const isBudget = item.sourceType === 'budget_request';
  const accentClass = isBudget
    ? 'border-teal-200/80 dark:border-teal-900/40'
    : 'border-pink-200/80 dark:border-pink-900/40';
  const badgeClass = isBudget
    ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
    : 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300';

  const hasBankInfo = item.bankName || item.bankAccountNumber;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={cn(
        'rounded-2xl border bg-white shadow-sm dark:bg-zinc-950',
        accentClass,
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Left */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', badgeClass)}>
              {isBudget ? 'Budget Request' : 'Gift'}
            </span>
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {item.label}
            </span>
          </div>

          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {item.submitterEmail}
            {br && (
              <> · Submitted {formatDate(br.submitted_at)}</>
            )}
            {gs && gs.decided_at && (
              <> · Approved {formatDate(gs.decided_at)}</>
            )}
          </p>

          {/* Budget request extra info */}
          {br && br.notes && (
            <p className="mt-1 text-[11px] italic text-zinc-500 dark:text-zinc-400">
              &ldquo;{br.notes}&rdquo;
            </p>
          )}

          {/* Gift shipping extra info */}
          {gs && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {gs.gift_name && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <Gift className="h-3 w-3 shrink-0 text-pink-500" />
                  {gs.gift_name}
                </div>
              )}
              {gs.preferred_delivery_location && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-500">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {gs.preferred_delivery_location}
                </div>
              )}
              {gs.active_contact_number && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-500">
                  <Phone className="h-3 w-3 shrink-0" />
                  {gs.active_contact_number}
                </div>
              )}
            </div>
          )}

          {/* Expandable bank info */}
          {hasBankInfo && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-300"
              >
                <Building2 className="h-3 w-3" />
                {expanded ? 'Hide' : 'Show'} bank details
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              <AnimatePresence>
                {expanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-2 grid gap-1 rounded-xl border border-teal-100 bg-teal-50/60 p-3 text-[11px] dark:border-teal-900/30 dark:bg-teal-950/20">
                      {item.bankName && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Bank</span>
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.bankName}</span>
                        </div>
                      )}
                      {item.bankAccountName && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Account holder</span>
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.bankAccountName}</span>
                        </div>
                      )}
                      {item.bankAccountNumber && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">Account number</span>
                          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{item.bankAccountNumber}</span>
                        </div>
                      )}
                      {item.swiftCode && (
                        <div className="flex justify-between gap-2">
                          <span className="text-zinc-500 dark:text-zinc-500">SWIFT</span>
                          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100">{item.swiftCode}</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {!hasBankInfo && item.sourceType === 'gift_shipping' && (
            <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-600">
              No bank on file — enter details in the payment dialog.
            </p>
          )}
        </div>

        {/* Right — amount + action */}
        <div className="flex shrink-0 flex-col items-end gap-2 self-start sm:items-end">
          <span className="text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatPHP(item.amountPhp)}
          </span>
          <Button
            size="sm"
            onClick={() => onMarkPaid(item)}
            className={cn(
              'h-8 gap-1.5 px-3 text-xs font-semibold text-white shadow-sm',
              isBudget
                ? 'bg-gradient-to-br from-teal-500 to-emerald-600 hover:brightness-110'
                : 'bg-gradient-to-br from-pink-500 to-rose-600 hover:brightness-110',
            )}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mark paid
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function OrphanageQueue() {
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? null;

  const [items, setItems] = useState<OrphanagePendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markPaidItem, setMarkPaidItem] = useState<OrphanagePendingItem | null>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' });
      const json = (await res.json()) as { items?: OrphanagePendingItem[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setItems(json.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load orphanage queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  const budgetItems = useMemo(() => items.filter((i) => i.sourceType === 'budget_request'), [items]);
  const giftItems = useMemo(() => items.filter((i) => i.sourceType === 'gift_shipping'), [items]);

  const PAGE_SIZE = 25;
  const [budgetPage, setBudgetPage] = useState(1);
  const [giftPage, setGiftPage] = useState(1);
  const budgetPageCount = Math.max(1, Math.ceil(budgetItems.length / PAGE_SIZE));
  const giftPageCount = Math.max(1, Math.ceil(giftItems.length / PAGE_SIZE));
  useEffect(() => { if (budgetPage > budgetPageCount) setBudgetPage(budgetPageCount); }, [budgetPage, budgetPageCount]);
  useEffect(() => { if (giftPage > giftPageCount) setGiftPage(giftPageCount); }, [giftPage, giftPageCount]);
  const pagedBudgetItems = useMemo(
    () => budgetItems.slice((budgetPage - 1) * PAGE_SIZE, budgetPage * PAGE_SIZE),
    [budgetItems, budgetPage],
  );
  const pagedGiftItems = useMemo(
    () => giftItems.slice((giftPage - 1) * PAGE_SIZE, giftPage * PAGE_SIZE),
    [giftItems, giftPage],
  );

  const handleConfirmPaid = async (item: OrphanagePendingItem, payload: MarkPaidPayload) => {
    const res = await fetch('/api/orphanage-dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_type: item.sourceType,
        source_id: item.sourceId,
        label: item.label,
        submitter_email: item.submitterEmail,
        bank_name: payload.bankName,
        bank_account_name: payload.bankAccountName,
        bank_account_number: payload.bankAccountNumber,
        swift_code: payload.swiftCode,
        amount_php: item.amountPhp,
        status: payload.status,
        transaction_id: payload.transactionId || null,
        bank_used: payload.bankUsed || null,
        sent_date: payload.sentDate || null,
        note: payload.note || null,
        paid_by: userEmail,
      }),
    });
    const json = (await res.json()) as { row?: unknown; error?: string };
    if (!res.ok || json.error) {
      toast.error(json.error ?? 'Could not log payment');
      return;
    }
    toast.success(
      payload.status === 'paid'
        ? `Payment logged for "${item.label}"`
        : `Problem logged for "${item.label}"`,
      { icon: payload.status === 'paid' ? '✅' : '⚠️' },
    );
    setMarkPaidItem(null);
    // Optimistically remove from list
    setItems((prev) => prev.filter((i) => i.sourceId !== item.sourceId));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Couldn&apos;t load orphanage queue</h2>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
        <Button size="sm" variant="outline" onClick={fetchItems}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              Orphanage payments
            </h1>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
              Approved budget requests and gift purchases awaiting transfer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2.5 py-1 text-[11px] font-semibold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                {items.length} pending
              </span>
            )}
            <button
              type="button"
              onClick={fetchItems}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900"
              title="Refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-4 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-400 to-emerald-500 text-white shadow-lg shadow-teal-500/30">
              <Heart className="h-7 w-7" fill="currentColor" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">All caught up!</h2>
              <p className="mt-1 max-w-xs text-xs text-zinc-500 dark:text-zinc-400">
                No pending orphanage payments. Approved budget requests and gifts will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* Budget requests section */}
            {budgetItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Banknote className="h-3.5 w-3.5 text-teal-500" />
                  Budget Requests
                  <span className="ml-1 rounded-full bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    {budgetItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedBudgetItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={budgetPage}
                  pageCount={budgetPageCount}
                  total={budgetItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setBudgetPage}
                  label="requests"
                  className="mt-2 border-0"
                />
              </section>
            )}

            {/* Gift shipping section */}
            {giftItems.length > 0 && (
              <section>
                <h2 className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
                  <Gift className="h-3.5 w-3.5 text-pink-500" />
                  Gift Purchases
                  <span className="ml-1 rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-bold text-pink-700 dark:bg-pink-900/30 dark:text-pink-300">
                    {giftItems.length}
                  </span>
                </h2>
                <AnimatePresence mode="popLayout">
                  <div className="flex flex-col gap-3">
                    {pagedGiftItems.map((item) => (
                      <OrphanageItemCard key={item.sourceId} item={item} onMarkPaid={setMarkPaidItem} />
                    ))}
                  </div>
                </AnimatePresence>
                <QueuePagination
                  page={giftPage}
                  pageCount={giftPageCount}
                  total={giftItems.length}
                  pageSize={PAGE_SIZE}
                  onPageChange={setGiftPage}
                  label="gifts"
                  className="mt-2 border-0"
                />
              </section>
            )}
          </div>
        )}
      </div>

      <OrphanageMarkPaidDialog
        item={markPaidItem}
        onClose={() => setMarkPaidItem(null)}
        onConfirm={handleConfirmPaid}
      />
    </div>
  );
}
