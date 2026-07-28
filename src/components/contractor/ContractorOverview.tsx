'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Plus, ArrowRight, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveFirstName } from '@/lib/name/first-name';
import {
  formatGrouped,
  formatMoney,
  normalizeCurrency,
  sumByCurrency,
  type ContractorCurrency,
} from '@/lib/contractor-currency';
import { Button } from '@/components/ui/button';

interface ContractorOverviewProps {
  contractorEmail: string;
  contractorName?: string | null;
  onNavigate: (tab: string) => void;
}

interface InvoiceLineItem {
  description?: string | null;
  qty?: number | null;
  rate?: number | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  to_company: string;
  total: number;
  currency: string | null;
  status: string | null;
  created_at: string;
  line_items?: InvoiceLineItem[] | null;
}

const PANEL =
  'rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60';

// ─── Invoice status ─────────────────────────────────────────────────────────

type InvStatus = 'pending' | 'approved' | 'rejected';

// Anything that isn't an explicit decision counts as still-with-accounting.
function normStatus(status: string | null | undefined): InvStatus {
  return status === 'approved' || status === 'rejected' ? status : 'pending';
}

const STATUS_STYLE: Record<InvStatus, { label: string; dot: string; text: string }> = {
  pending: {
    label: 'Pending',
    dot: 'bg-amber-500 dark:bg-amber-400',
    text: 'text-amber-700 dark:text-amber-400',
  },
  approved: {
    label: 'Approved',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    text: 'text-emerald-700 dark:text-emerald-400',
  },
  rejected: {
    label: 'Rejected',
    dot: 'bg-rose-500 dark:bg-rose-400',
    text: 'text-rose-700 dark:text-rose-400',
  },
};

function StatusLabel({ status }: { status: string | null | undefined }) {
  const { label, dot, text } = STATUS_STYLE[normStatus(status)];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', text)}>
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}

// ─── Loading + skeleton ─────────────────────────────────────────────────────

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-zinc-200/70 motion-reduce:animate-none dark:bg-zinc-800',
        className,
      )}
    />
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className={cn(PANEL, 'grid grid-cols-1 divide-y divide-zinc-100 dark:divide-zinc-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0')}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-5 py-4">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="mt-3 h-7 w-28" />
            <SkeletonBlock className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
      <div className={PANEL}>
        <div className="border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <SkeletonBlock className="h-4 w-32" />
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between px-5 py-3.5">
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-40" />
              </div>
              <div className="flex flex-col items-end gap-2">
                <SkeletonBlock className="h-4 w-16" />
                <SkeletonBlock className="h-3 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Stat cell ──────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  sub,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start px-5 py-4 text-left transition-colors',
        'hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60',
      )}
    >
      <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="mt-1 break-words text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
        {value}
      </span>
      <span className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</span>
    </button>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export default function ContractorOverview({
  contractorEmail,
  contractorName,
  onNavigate,
}: ContractorOverviewProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!contractorEmail) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/contractor/invoices?email=${encodeURIComponent(contractorEmail)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { invoices?: InvoiceRow[] }) => {
        if (cancelled) return;
        setInvoices(j.invoices ?? []);
      })
      .catch(() => { if (!cancelled) setInvoices([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractorEmail]);

  // ── Derived figures ──
  const invoiceCount = invoices.length;
  const pending = invoices.filter((i) => normStatus(i.status) === 'pending');
  const approved = invoices.filter((i) => normStatus(i.status) === 'approved');
  const rejected = invoices.filter((i) => normStatus(i.status) === 'rejected');

  // Fall back to the contractor's most recent invoicing currency for zero buckets.
  const primaryCurrency: ContractorCurrency = normalizeCurrency(invoices[0]?.currency);

  // ── Identity + greeting ──
  // Same first-name resolution as every other dashboard greeting (handles the
  // master-list `Surname, Given... "GoBy"` form). See resolveFirstName.
  const displayName = resolveFirstName({ name: contractorName, email: contractorEmail });

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const subline = (() => {
    if (invoiceCount === 0) return 'Send your first invoice to Accounting to get started.';
    if (pending.length > 0)
      return `${plural(pending.length, 'invoice')} ${pending.length === 1 ? 'is' : 'are'} awaiting review with Accounting.`;
    if (approved.length > 0) return "You're all caught up. Nothing is awaiting review.";
    return 'Here is where your invoices stand.';
  })();

  const fade = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
      };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-[#0d1117]">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">

          {/* ── Greeting ── */}
          <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
                {timeGreeting}, {displayName}.
              </h1>
              {loading ? (
                <SkeletonBlock className="mt-2 h-4 w-64 max-w-full" />
              ) : (
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subline}</p>
              )}
            </div>
            {!loading && (
              <Button
                onClick={() => onNavigate('invoices')}
                className="shrink-0 gap-2 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                <Plus className="h-4 w-4" />
                New invoice
              </Button>
            )}
          </header>

          {/* ── Body ── */}
          {loading ? (
            <LoadingSkeleton />
          ) : (
            <motion.div {...fade} className="flex flex-col gap-6">

              {/* ── Stat strip ── */}
              <div
                className={cn(
                  PANEL,
                  'grid grid-cols-1 divide-y divide-zinc-100 overflow-hidden dark:divide-zinc-800',
                  'sm:grid-cols-3 sm:divide-x sm:divide-y-0',
                )}
              >
                <Stat
                  label="Total billed"
                  value={formatGrouped(sumByCurrency(invoices), primaryCurrency)}
                  sub={`${plural(invoiceCount, 'invoice')} submitted`}
                  onClick={() => onNavigate('invoices')}
                />
                <Stat
                  label="Awaiting review"
                  value={formatGrouped(sumByCurrency(pending), primaryCurrency)}
                  sub={pending.length === 0 ? 'Nothing pending' : `${plural(pending.length, 'invoice')} with Accounting`}
                  onClick={() => onNavigate('invoices')}
                />
                <Stat
                  label="Approved"
                  value={formatGrouped(sumByCurrency(approved), primaryCurrency)}
                  sub={approved.length === 0 ? 'None yet' : `${plural(approved.length, 'invoice')} cleared`}
                  onClick={() => onNavigate('invoices')}
                />
              </div>

              {/* ── Rejected notice ── */}
              {rejected.length > 0 && (
                <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 dark:border-rose-900/50 dark:bg-rose-950/20">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-rose-800 dark:text-rose-200">
                      {plural(rejected.length, 'invoice')} {rejected.length === 1 ? 'was' : 'were'} not approved
                    </p>
                    <p className="mt-0.5 text-xs text-rose-700 dark:text-rose-300/90">
                      Accounting didn&apos;t approve {rejected.length === 1 ? 'it' : 'them'}. Submit a corrected
                      invoice to get paid.
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onNavigate('invoices')}
                    className="h-7 shrink-0 px-2.5 text-xs text-rose-700 hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-950/50"
                  >
                    View
                  </Button>
                </div>
              )}

              {/* ── Recent invoices / empty prompt ── */}
              {invoiceCount === 0 ? (
                <div className={cn(PANEL, 'flex flex-col items-center gap-4 px-6 py-14 text-center')}>
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-white">No invoices yet</h2>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                      Create an invoice and send it to Accounting. You can track whether it&apos;s
                      pending, approved, or needs another look right here.
                    </p>
                  </div>
                  <Button
                    onClick={() => onNavigate('invoices')}
                    className="gap-2 bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
                  >
                    <Plus className="h-4 w-4" />
                    Create your first invoice
                  </Button>
                </div>
              ) : (
                <div className={PANEL}>
                  <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
                    <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">Recent invoices</h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onNavigate('invoices')}
                      className="h-7 gap-1 px-2 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
                    >
                      View all
                      <ArrowRight className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                    {invoices.slice(0, 5).map((inv) => (
                      <button
                        key={inv.id}
                        type="button"
                        onClick={() => onNavigate('invoices')}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors',
                          'hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60',
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-900 dark:text-white">
                            {inv.invoice_number || '—'}
                          </p>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                            {inv.to_company || 'No client'} · {inv.invoice_date || '—'}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-white">
                            {formatMoney(inv.total ?? 0, normalizeCurrency(inv.currency))}
                          </span>
                          <StatusLabel status={inv.status} />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
