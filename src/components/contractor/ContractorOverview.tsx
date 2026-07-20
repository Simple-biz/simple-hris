'use client';

import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import {
  Plus,
  ArrowRight,
  Receipt,
  Clock,
  CheckCircle2,
  AlertCircle,
  Wallet,
  Briefcase,
  CalendarClock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
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
  'rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900';

// ─── Invoice status ─────────────────────────────────────────────────────────

type InvStatus = 'pending' | 'approved' | 'rejected';

// Anything that isn't an explicit decision counts as still-with-accounting.
function normStatus(status: string | null | undefined): InvStatus {
  return status === 'approved' || status === 'rejected' ? status : 'pending';
}

const STATUS_STYLE: Record<InvStatus, { label: string; Icon: React.ElementType; badge: string }> = {
  pending: {
    label: 'Pending',
    Icon: Clock,
    badge:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
  },
  approved: {
    label: 'Approved',
    Icon: CheckCircle2,
    badge:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300',
  },
  rejected: {
    label: 'Rejected',
    Icon: AlertCircle,
    badge:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300',
  },
};

function StatusBadge({ status }: { status: string | null | undefined }) {
  const { label, Icon, badge } = STATUS_STYLE[normStatus(status)];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', badge)}>
      <Icon className="h-3 w-3" />
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={cn(PANEL, 'p-4')}>
            <SkeletonBlock className="h-9 w-9 rounded-xl" />
            <SkeletonBlock className="mt-3 h-3 w-24" />
            <SkeletonBlock className="mt-2 h-6 w-28" />
            <SkeletonBlock className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>
      <div className={PANEL}>
        <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <SkeletonBlock className="h-4 w-32" />
        </div>
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3">
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <SkeletonBlock className="h-3 w-40" />
              </div>
              <div className="flex flex-col items-end gap-2">
                <SkeletonBlock className="h-4 w-16" />
                <SkeletonBlock className="h-4 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── KPI card ───────────────────────────────────────────────────────────────

type AccentKey = 'blue' | 'indigo' | 'violet' | 'amber' | 'emerald' | 'sky';

// Icon-chip colours per accent, tuned for 4.5:1+ contrast in both themes.
const ACCENT_CHIP: Record<AccentKey, string> = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400',
  indigo: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-400',
  violet: 'bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  sky: 'bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400',
};

function KpiCard({
  label,
  value,
  sub,
  Icon,
  accent,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  Icon: React.ElementType;
  accent: AccentKey;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition-colors',
        'hover:border-zinc-300 hover:bg-zinc-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60',
        'dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:bg-zinc-800/40',
        onClick ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-xl',
            ACCENT_CHIP[accent],
          )}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        {onClick && (
          <ArrowRight className="h-4 w-4 text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400" />
        )}
      </div>
      <p className="mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-0.5 break-words text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-white">
        {value}
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>
    </button>
  );
}

// Compact relative-day label for the "Latest invoice" tile.
function relativeDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
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

  // Services = line items billed across every invoice; distinct = unique descriptions.
  const allLineItems = invoices.flatMap((i) =>
    Array.isArray(i.line_items) ? i.line_items : [],
  );
  const totalServices = allLineItems.length;
  const distinctServices = new Set(
    allLineItems
      .map((it) => (it.description ?? '').trim().toLowerCase())
      .filter(Boolean),
  ).size;

  // Invoices arrive ordered by created_at desc, so [0] is the latest.
  const latest = invoices[0];

  // Fall back to the contractor's most recent invoicing currency for zero buckets.
  const primaryCurrency: ContractorCurrency = normalizeCurrency(invoices[0]?.currency);

  // ── Identity + greeting ──
  const firstName =
    (contractorName?.trim().split(/\s+/)[0]) ||
    contractorEmail.split('@')[0].replace(/[._-]/g, ' ').split(' ')[0];
  const displayName = firstName.charAt(0).toUpperCase() + firstName.slice(1);

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
    <div className="flex h-full min-h-0 flex-col bg-[#f8faff] dark:bg-[#0d1117]">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8">

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

              {/* ── KPI cards ── */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <KpiCard
                  label="Total billed"
                  value={formatGrouped(sumByCurrency(invoices), primaryCurrency)}
                  sub={`${plural(invoiceCount, 'invoice')} submitted`}
                  Icon={Wallet}
                  accent="blue"
                  onClick={() => onNavigate('invoices')}
                />
                <KpiCard
                  label="Invoices"
                  value={String(invoiceCount)}
                  sub={`${pending.length} pending · ${approved.length} approved`}
                  Icon={Receipt}
                  accent="indigo"
                  onClick={() => onNavigate('invoices')}
                />
                <KpiCard
                  label="Services delivered"
                  value={String(totalServices)}
                  sub={
                    distinctServices === 0
                      ? 'No line items yet'
                      : `${plural(distinctServices, 'distinct service')}`
                  }
                  Icon={Briefcase}
                  accent="violet"
                  onClick={() => onNavigate('invoices')}
                />
                <KpiCard
                  label="Awaiting review"
                  value={formatGrouped(sumByCurrency(pending), primaryCurrency)}
                  sub={pending.length === 0 ? 'Nothing pending' : `${plural(pending.length, 'invoice')} with Accounting`}
                  Icon={Clock}
                  accent="amber"
                  onClick={() => onNavigate('invoices')}
                />
                <KpiCard
                  label="Approved"
                  value={formatGrouped(sumByCurrency(approved), primaryCurrency)}
                  sub={approved.length === 0 ? 'None yet' : `${plural(approved.length, 'invoice')} cleared`}
                  Icon={CheckCircle2}
                  accent="emerald"
                  onClick={() => onNavigate('invoices')}
                />
                <KpiCard
                  label="Latest invoice"
                  value={latest ? formatMoney(latest.total ?? 0, normalizeCurrency(latest.currency)) : '—'}
                  sub={latest ? `${latest.invoice_number || 'Invoice'} · ${relativeDay(latest.created_at)}` : 'None yet'}
                  Icon={CalendarClock}
                  accent="sky"
                  onClick={() => onNavigate('invoices')}
                />
              </div>

              {/* ── Rejected notice ── */}
              {rejected.length > 0 && (
                <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-900/50 dark:bg-rose-950/30">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 dark:text-rose-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-rose-800 dark:text-rose-200">
                      {plural(rejected.length, 'invoice')} {rejected.length === 1 ? 'was' : 'were'} not approved
                    </p>
                    <p className="mt-0.5 text-xs text-rose-700/90 dark:text-rose-300/80">
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
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-950/40">
                    <Receipt className="h-7 w-7 text-blue-500 dark:text-blue-400" />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900 dark:text-white">No invoices yet</h2>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                      Create an invoice and send it to Accounting. Once you do, these cards fill in and
                      you can track whether it&apos;s pending, approved, or needs another look right here.
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
                  <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
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
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-blue-50/50 dark:hover:bg-blue-950/20"
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
                        <StatusBadge status={inv.status} />
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
