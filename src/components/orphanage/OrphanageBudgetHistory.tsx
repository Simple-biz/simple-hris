'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock,
  Gift,
  HeartHandshake,
  History as HistoryIcon,
  PiggyBank,
  Plane,
  RefreshCw,
  Truck,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  OrphanageBudgetRequestRow,
  OrphanageBudgetRequestStatus,
  OrphanageBudgetRequestVisitType,
} from '@/lib/supabase/orphanage-budget-requests';
import type { GiftPaymentRow, GiftPaymentStatus } from '@/lib/supabase/gift-payments';

interface AuditTrailEntry {
  id: string;
  user_name: string;
  user_role: string;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

interface RowWithAudit extends OrphanageBudgetRequestRow {
  audit_trail?: AuditTrailEntry[];
}

interface OrphanageBudgetHistoryProps {
  viewerEmail: string | null;
}

const STATUS_PALETTE: Record<
  OrphanageBudgetRequestStatus,
  {
    label: string;
    bg: string;
    text: string;
    ring: string;
    Icon: typeof CheckCircle2;
  }
> = {
  pending: {
    label: 'Pending',
    bg: 'bg-amber-100 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-300',
    ring: 'ring-amber-300/60 dark:ring-amber-700/40',
    Icon: Clock,
  },
  approved: {
    label: 'Approved',
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-800 dark:text-emerald-300',
    ring: 'ring-emerald-300/60 dark:ring-emerald-700/40',
    Icon: CheckCircle2,
  },
  rejected: {
    label: 'Rejected',
    bg: 'bg-rose-100 dark:bg-rose-950/40',
    text: 'text-rose-800 dark:text-rose-300',
    ring: 'ring-rose-300/60 dark:ring-rose-700/40',
    Icon: XCircle,
  },
};

const VISIT_TYPE_META: Record<
  OrphanageBudgetRequestVisitType,
  { label: string; Icon: typeof HeartHandshake; color: string }
> = {
  monthly: {
    label: 'Monthly Visit',
    Icon: HeartHandshake,
    color: '#ec4899',
  },
  frequent: {
    label: 'Frequent Travelers',
    Icon: Plane,
    color: '#0ea5e9',
  },
  special: {
    label: 'Special Project',
    Icon: PiggyBank,
    color: '#a855f7',
  },
};

function formatPhp(n: number): string {
  return `₱${n.toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRelative(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function actionMeta(action: string): {
  label: string;
  Icon: typeof CheckCircle2;
  tone: 'amber' | 'emerald' | 'rose' | 'zinc';
} {
  switch (action) {
    case 'orphanage_budget.created':
      return { label: 'Submitted', Icon: AlertCircle, tone: 'amber' };
    case 'orphanage_budget.approved':
      return { label: 'Approved by Accounting', Icon: CheckCircle2, tone: 'emerald' };
    case 'orphanage_budget.rejected':
      return { label: 'Rejected by Accounting', Icon: XCircle, tone: 'rose' };
    default:
      return { label: action, Icon: HistoryIcon, tone: 'zinc' };
  }
}

export default function OrphanageBudgetHistory({ viewerEmail }: OrphanageBudgetHistoryProps) {
  const [source, setSource] = useState<'budgets' | 'gifts'>('budgets');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [statusFilter, setStatusFilter] = useState<OrphanageBudgetRequestStatus | 'all'>('all');
  const [giftStatusFilter, setGiftStatusFilter] = useState<GiftPaymentStatus | 'all'>('all');
  const [rows, setRows] = useState<RowWithAudit[]>([]);
  const [giftRows, setGiftRows] = useState<GiftPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRows = useMemo(() => {
    return async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        if (source === 'budgets') {
          const params = new URLSearchParams();
          if (scope === 'mine' && viewerEmail) {
            params.set('email', viewerEmail);
          }
          params.set('with_audit', '1');
          const res = await fetch(`/api/orphanage-budget-requests?${params.toString()}`, {
            cache: 'no-store',
          });
          const json = (await res.json()) as { rows?: RowWithAudit[]; error?: string | null };
          if (json.error) setError(json.error);
          setRows(json.rows ?? []);
        } else {
          const params = new URLSearchParams();
          if (scope === 'mine' && viewerEmail) {
            params.set('email', viewerEmail);
          }
          const res = await fetch(`/api/gift-payments?${params.toString()}`, { cache: 'no-store' });
          const json = (await res.json()) as { rows?: GiftPaymentRow[]; error?: string | null };
          if (json.error) setError(json.error);
          setGiftRows(json.rows ?? []);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load history');
      } finally {
        if (showSpinner) setLoading(false);
        else setRefreshing(false);
      }
    };
  }, [source, scope, viewerEmail]);

  useEffect(() => {
    void fetchRows(true);
  }, [fetchRows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => statusFilter === 'all' || r.status === statusFilter);
  }, [rows, statusFilter]);

  const filteredGiftRows = useMemo(() => {
    return giftRows.filter((r) => giftStatusFilter === 'all' || r.status === giftStatusFilter);
  }, [giftRows, giftStatusFilter]);

  const giftStats = useMemo(() => {
    let pending = 0;
    let sent = 0;
    let paid = 0;
    let cancelled = 0;
    let paidTotalUsd = 0;
    let pendingTotalUsd = 0;
    for (const r of giftRows) {
      if (r.status === 'pending') {
        pending += 1;
        pendingTotalUsd += Number(r.total_usd ?? 0);
      } else if (r.status === 'sent') {
        sent += 1;
        pendingTotalUsd += Number(r.total_usd ?? 0);
      } else if (r.status === 'paid') {
        paid += 1;
        paidTotalUsd += Number(r.total_usd ?? 0);
      } else if (r.status === 'cancelled') {
        cancelled += 1;
      }
    }
    return {
      pending,
      sent,
      paid,
      cancelled,
      paidTotalUsd,
      pendingTotalUsd,
      total: giftRows.length,
    };
  }, [giftRows]);

  const stats = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    let approvedTotal = 0;
    let pendingTotal = 0;
    for (const r of rows) {
      if (r.status === 'pending') {
        pending += 1;
        pendingTotal += Number(r.final_amount ?? 0);
      } else if (r.status === 'approved') {
        approved += 1;
        approvedTotal += Number(r.final_amount ?? 0);
      } else if (r.status === 'rejected') {
        rejected += 1;
      }
    }
    return {
      pending,
      approved,
      rejected,
      approvedTotal,
      pendingTotal,
      total: rows.length,
    };
  }, [rows]);

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-pink-50/20 to-white text-zinc-900 dark:from-black dark:via-pink-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            {source === 'budgets' ? 'Budget Requests · History' : 'Gift Payments · History'}
          </p>
          <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            {scope === 'mine'
              ? source === 'budgets'
                ? 'My requests'
                : 'My gift payments'
              : source === 'budgets'
                ? 'All requests'
                : 'All gift payments'}
            <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
              {source === 'budgets'
                ? `${stats.total} ${stats.total === 1 ? 'request' : 'requests'}`
                : `${giftStats.total} ${giftStats.total === 1 ? 'payment' : 'payments'}`}
            </span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <SourcePillToggle value={source} onChange={setSource} />
          <ScopePillToggle value={scope} onChange={setScope} />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            onClick={() => void fetchRows(false)}
            disabled={loading || refreshing}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {source === 'budgets' ? (
          <>
            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Pending" value={String(stats.pending)} hint={formatPhp(stats.pendingTotal)} tone="amber" />
              <StatTile label="Approved" value={String(stats.approved)} hint={formatPhp(stats.approvedTotal)} tone="emerald" />
              <StatTile label="Rejected" value={String(stats.rejected)} hint="Closed out" tone="rose" />
              <StatTile label="Total" value={String(stats.total)} hint="all-time" tone="zinc" />
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-pink-100/80 bg-white px-3 py-2 shadow-sm dark:border-pink-950/45 dark:bg-zinc-950/40">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                Filter
              </span>
              <FilterChip
                label="All"
                active={statusFilter === 'all'}
                onClick={() => setStatusFilter('all')}
              />
              {(['pending', 'approved', 'rejected'] as OrphanageBudgetRequestStatus[]).map((s) => {
                const palette = STATUS_PALETTE[s];
                return (
                  <FilterChip
                    key={s}
                    label={palette.label}
                    active={statusFilter === s}
                    onClick={() => setStatusFilter(s)}
                  />
                );
              })}
            </div>

            {/* Body */}
            {loading ? (
              <HistorySkeleton />
            ) : error ? (
              <div className="rounded-xl border border-rose-200/80 bg-rose-50/60 px-4 py-6 text-center text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
                {error}
              </div>
            ) : filteredRows.length === 0 ? (
              <EmptyState scope={scope} hasRows={rows.length > 0} />
            ) : (
              <ul className="flex flex-col gap-2.5">
                <AnimatePresence initial={false}>
                  {filteredRows.map((row, idx) => (
                    <RequestCard
                      key={row.id}
                      row={row}
                      index={idx}
                      expanded={expandedId === row.id}
                      onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </>
        ) : (
          <>
            {/* Gift stats */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile label="Pending" value={String(giftStats.pending + giftStats.sent)} hint={`$${giftStats.pendingTotalUsd.toFixed(2)} owed`} tone="amber" />
              <StatTile label="Paid" value={String(giftStats.paid)} hint={`$${giftStats.paidTotalUsd.toFixed(2)} sent`} tone="emerald" />
              <StatTile label="Cancelled" value={String(giftStats.cancelled)} hint="Closed out" tone="rose" />
              <StatTile label="Total" value={String(giftStats.total)} hint="all-time" tone="zinc" />
            </div>

            {/* Gift filter chips */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-pink-100/80 bg-white px-3 py-2 shadow-sm dark:border-pink-950/45 dark:bg-zinc-950/40">
              <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                Filter
              </span>
              <FilterChip
                label="All"
                active={giftStatusFilter === 'all'}
                onClick={() => setGiftStatusFilter('all')}
              />
              {(['pending', 'sent', 'paid', 'cancelled'] as GiftPaymentStatus[]).map((s) => (
                <FilterChip
                  key={s}
                  label={s.charAt(0).toUpperCase() + s.slice(1)}
                  active={giftStatusFilter === s}
                  onClick={() => setGiftStatusFilter(s)}
                />
              ))}
            </div>

            {loading ? (
              <HistorySkeleton />
            ) : error ? (
              <div className="rounded-xl border border-rose-200/80 bg-rose-50/60 px-4 py-6 text-center text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
                {error}
              </div>
            ) : filteredGiftRows.length === 0 ? (
              <GiftEmptyState scope={scope} hasRows={giftRows.length > 0} />
            ) : (
              <ul className="flex flex-col gap-2.5">
                <AnimatePresence initial={false}>
                  {filteredGiftRows.map((row, idx) => (
                    <GiftPaymentCard
                      key={row.id}
                      row={row}
                      index={idx}
                      expanded={expandedId === row.id}
                      onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                    />
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SourcePillToggle({
  value,
  onChange,
}: {
  value: 'budgets' | 'gifts';
  onChange: (v: 'budgets' | 'gifts') => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {(['budgets', 'gifts'] as const).map((opt) => {
        const selected = value === opt;
        const Icon = opt === 'budgets' ? PiggyBank : Gift;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors',
              selected
                ? 'bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-500/25'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
            aria-pressed={selected}
          >
            <Icon className="h-3 w-3" />
            {opt === 'budgets' ? 'Budgets' : 'Gifts'}
          </button>
        );
      })}
    </div>
  );
}

const GIFT_STATUS_PALETTE: Record<
  GiftPaymentStatus,
  { label: string; bg: string; text: string; ring: string; Icon: typeof CheckCircle2 }
> = {
  pending: {
    label: 'Pending',
    bg: 'bg-amber-100 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-300',
    ring: 'ring-amber-300/60 dark:ring-amber-700/40',
    Icon: Clock,
  },
  sent: {
    label: 'Sent',
    bg: 'bg-sky-100 dark:bg-sky-950/40',
    text: 'text-sky-800 dark:text-sky-300',
    ring: 'ring-sky-300/60 dark:ring-sky-700/40',
    Icon: Truck,
  },
  paid: {
    label: 'Paid',
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-800 dark:text-emerald-300',
    ring: 'ring-emerald-300/60 dark:ring-emerald-700/40',
    Icon: CheckCircle2,
  },
  cancelled: {
    label: 'Cancelled',
    bg: 'bg-rose-100 dark:bg-rose-950/40',
    text: 'text-rose-800 dark:text-rose-300',
    ring: 'ring-rose-300/60 dark:ring-rose-700/40',
    Icon: XCircle,
  },
};

function GiftEmptyState({ scope, hasRows }: { scope: 'mine' | 'all'; hasRows: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/30 px-4 py-12 text-center dark:border-pink-900/50 dark:bg-pink-950/15">
      <Gift className="h-6 w-6 text-pink-400" />
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {hasRows
          ? 'No gift payments match the current filter'
          : scope === 'mine'
            ? 'No gift payments logged yet'
            : 'No gift payments on file'}
      </p>
      <p className="max-w-md text-[11.5px] text-zinc-500 dark:text-zinc-400">
        {hasRows
          ? 'Loosen the status filter to see more.'
          : 'Use the Gift Tracker → Payments tab to log a vendor batch.'}
      </p>
    </div>
  );
}

function GiftPaymentCard({
  row,
  index,
  expanded,
  onToggle,
}: {
  row: GiftPaymentRow;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const palette = GIFT_STATUS_PALETTE[row.status];
  const StatusIcon = palette.Icon;
  const itemsTotal = row.items.reduce((s, it) => s + Number(it.quantity ?? 0) * Number(it.unit_price ?? 0), 0);
  const grandTotalPhp = itemsTotal + Number(row.shipping_fee ?? 0);

  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.2,
        delay: Math.min(index * 0.018, 0.18),
        ease: [0.22, 1, 0.36, 1],
      }}
      className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700"
      style={{ borderLeft: '3px solid #ec4899' }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50/60 dark:hover:bg-zinc-900/40"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
          style={{ backgroundColor: '#ec4899' }}
        >
          <Gift className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {row.vendor?.name || 'Untitled vendor'}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                palette.bg,
                palette.text,
                palette.ring,
              )}
            >
              <StatusIcon className="h-2.5 w-2.5" />
              {palette.label}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{row.period_label || '—'}</span>
            {row.batch_label ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span className="truncate">{row.batch_label}</span>
              </>
            ) : null}
            {row.staff ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span>{row.staff}</span>
              </>
            ) : null}
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span>logged {formatRelative(row.created_at)}</span>
          </div>
        </div>

        <div className="text-right">
          <div className="font-mono text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            ${Number(row.total_usd ?? 0).toFixed(2)}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            usd sent
          </div>
        </div>

        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200',
            expanded && 'rotate-180',
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="gift-details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-zinc-200 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-950/40"
          >
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <section className="flex flex-col gap-2.5">
                <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  Payment details
                </h4>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-[12px]">
                  <DetailRow label="Vendor" value={row.vendor?.name || '—'} />
                  <DetailRow label="Period" value={row.period_label || '—'} />
                  <DetailRow label="Batches" value={row.batch_label || '—'} />
                  <DetailRow label="Items total" value={formatPhp(itemsTotal)} mono />
                  <DetailRow label="Shipping" value={formatPhp(Number(row.shipping_fee ?? 0))} mono />
                  <DetailRow label="Grand total" value={formatPhp(grandTotalPhp)} mono emphasis />
                  <DetailRow
                    label="USD sent"
                    value={`$${Number(row.total_usd ?? 0).toFixed(2)}`}
                    mono
                  />
                  <DetailRow label="Ordered by" value={row.ordered_by || '—'} />
                  <DetailRow label="Staff" value={row.staff || '—'} />
                  <DetailRow label="Transaction ID" value={row.transaction_id || '—'} mono />
                  <DetailRow label="Date sent" value={row.date_sent ? formatDate(row.date_sent) : '—'} />
                  <DetailRow label="Arrival" value={row.arrival_date ? formatDate(row.arrival_date) : '—'} />
                  <DetailRow label="Our bank" value={row.our_bank || '—'} />
                </dl>
                {row.notes ? (
                  <div className="mt-1 rounded-md border border-pink-100/80 bg-pink-50/40 px-3 py-2 text-[11.5px] leading-relaxed text-zinc-600 dark:border-pink-900/40 dark:bg-pink-950/15 dark:text-zinc-400">
                    {row.notes}
                  </div>
                ) : null}
              </section>

              <section className="flex flex-col gap-2.5">
                <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  Line items ({row.items.length})
                </h4>
                {row.items.length === 0 ? (
                  <p className="rounded-md border border-dashed border-zinc-200 bg-white/60 px-3 py-2 text-[11.5px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/40">
                    No items recorded.
                  </p>
                ) : (
                  <ul className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
                    {row.items.map((it) => (
                      <li
                        key={it.id}
                        className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-1.5 text-[11.5px] last:border-b-0 dark:border-zinc-800/60"
                      >
                        <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300">
                          {it.name || 'Untitled'}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-zinc-500">
                          {it.quantity} × {formatPhp(Number(it.unit_price ?? 0))} ={' '}
                          <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                            {formatPhp(Number(it.quantity ?? 0) * Number(it.unit_price ?? 0))}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function ScopePillToggle({
  value,
  onChange,
}: {
  value: 'mine' | 'all';
  onChange: (v: 'mine' | 'all') => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {(['mine', 'all'] as const).map((opt) => {
        const selected = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              'rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors',
              selected
                ? 'bg-gradient-to-r from-pink-600 to-rose-700 text-white shadow-sm shadow-pink-500/25'
                : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
            aria-pressed={selected}
          >
            {opt === 'mine' ? 'My requests' : 'All'}
          </button>
        );
      })}
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: 'amber' | 'emerald' | 'rose' | 'zinc';
}) {
  const toneCls = {
    amber:
      'border-amber-200/70 from-white to-amber-50/40 dark:border-amber-950/40 dark:from-zinc-950 dark:to-amber-950/20',
    emerald:
      'border-emerald-200/70 from-white to-emerald-50/40 dark:border-emerald-950/40 dark:from-zinc-950 dark:to-emerald-950/20',
    rose: 'border-rose-200/70 from-white to-rose-50/40 dark:border-rose-950/40 dark:from-zinc-950 dark:to-rose-950/20',
    zinc: 'border-zinc-200 from-white to-zinc-50/60 dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900/40',
  } as const;
  return (
    <div className={cn('rounded-lg border bg-gradient-to-br px-3 py-2 shadow-sm', toneCls[tone])}>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
      <div className="font-mono text-[10px] text-zinc-500">{hint}</div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors',
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:text-zinc-900 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
      )}
    >
      {label}
    </button>
  );
}

function EmptyState({ scope, hasRows }: { scope: 'mine' | 'all'; hasRows: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/30 px-4 py-12 text-center dark:border-pink-900/50 dark:bg-pink-950/15">
      <CalendarDays className="h-6 w-6 text-pink-400" />
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {hasRows
          ? 'No requests match the current filter'
          : scope === 'mine'
            ? 'No requests submitted yet'
            : 'No requests on file'}
      </p>
      <p className="max-w-md text-[11.5px] text-zinc-500 dark:text-zinc-400">
        {hasRows
          ? 'Loosen the status filter to see more.'
          : 'Use the Budget Request tab to submit one — it shows up here right after.'}
      </p>
    </div>
  );
}

function HistorySkeleton() {
  return (
    <ul className="flex flex-col gap-2.5">
      {Array.from({ length: 4 }, (_, i) => (
        <li
          key={i}
          className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60"
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1.5">
              <div
                className="h-3.5 w-44 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                style={{ animationDelay: `${i * 60}ms` }}
              />
              <div className="h-2.5 w-56 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
            </div>
            <div className="h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-7 w-7 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function RequestCard({
  row,
  index,
  expanded,
  onToggle,
}: {
  row: RowWithAudit;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const visit = VISIT_TYPE_META[row.visit_type];
  const palette = STATUS_PALETTE[row.status];
  const StatusIcon = palette.Icon;
  const VisitIcon = visit.Icon;

  return (
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.2,
        delay: Math.min(index * 0.018, 0.18),
        ease: [0.22, 1, 0.36, 1],
      }}
      className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700"
      style={{ borderLeft: `3px solid ${visit.color}` }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50/60 dark:hover:bg-zinc-900/40"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
          style={{ backgroundColor: visit.color }}
        >
          <VisitIcon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              {visit.label}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                palette.bg,
                palette.text,
                palette.ring,
              )}
            >
              <StatusIcon className="h-2.5 w-2.5" />
              {palette.label}
            </span>
            {row.mission_trip && (
              <span className="rounded-full bg-pink-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-pink-700 dark:bg-pink-950/40 dark:text-pink-300">
                Mission
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="truncate font-mono">{row.submitter_email}</span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span>submitted {formatRelative(row.submitted_at)}</span>
            {row.decided_at && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span>
                  {row.status === 'approved' ? 'approved' : 'rejected'}{' '}
                  {formatRelative(row.decided_at)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="text-right">
          <div className="font-mono text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatPhp(Number(row.final_amount ?? 0))}
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
            final amount
          </div>
        </div>

        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200',
            expanded && 'rotate-180',
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden border-t border-zinc-200 bg-zinc-50/40 dark:border-zinc-800 dark:bg-zinc-950/40"
          >
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <DetailsBlock row={row} />
              <AuditTimeline row={row} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function DetailsBlock({ row }: { row: RowWithAudit }) {
  const visit = VISIT_TYPE_META[row.visit_type];
  return (
    <section className="flex flex-col gap-2.5">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        Request details
      </h4>
      <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <DetailRow label="Visit type" value={visit.label} />
        <DetailRow label="Mission trip" value={row.mission_trip ? 'Yes' : 'No'} />
        <DetailRow label="Submitted" value={formatDate(row.submitted_at)} />
        <DetailRow label="Subtotal" value={formatPhp(Number(row.subtotal ?? 0))} mono />
        <DetailRow label="Leftover" value={formatPhp(Number(row.leftover ?? 0))} mono />
        <DetailRow
          label="Final amount"
          value={formatPhp(Number(row.final_amount ?? 0))}
          mono
          emphasis
        />
        {row.decided_at && (
          <>
            <DetailRow label="Decided by" value={row.decided_by ?? '—'} />
            <DetailRow label="Decided at" value={formatDate(row.decided_at)} />
          </>
        )}
        {row.decision_note && (
          <DetailRow label="Decision note" value={row.decision_note} wrap />
        )}
        {row.notes && <DetailRow label="Notes for Bob" value={row.notes} wrap />}
      </dl>
      <details className="mt-1 rounded-md border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
        <summary className="cursor-pointer font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
          Bank account snapshot
        </summary>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[11px]">
          <DetailRow label="Account name" value={row.bank_account_name} />
          <DetailRow label="Account number" value={row.bank_account_number} mono />
          <DetailRow label="Bank name" value={row.bank_name} />
          <DetailRow label="Swift code" value={row.swift_code} mono />
        </dl>
      </details>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
  wrap,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
  emphasis?: boolean;
}) {
  return (
    <>
      <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-zinc-900 dark:text-zinc-100',
          mono && 'font-mono tabular-nums',
          wrap && 'whitespace-pre-wrap break-words',
          !wrap && 'truncate',
          emphasis && 'font-bold text-emerald-700 dark:text-emerald-400',
        )}
        title={wrap ? undefined : value}
      >
        {value}
      </dd>
    </>
  );
}

function AuditTimeline({ row }: { row: RowWithAudit }) {
  const trail = row.audit_trail ?? [];
  // Always show the implicit "submitted" event even if the audit_log insert
  // missed somehow — the row's own submitted_at is authoritative.
  const events: { action: string; created_at: string; user_name: string; details: Record<string, unknown> | null }[] =
    trail.length > 0
      ? trail
      : [
          {
            action: 'orphanage_budget.created',
            created_at: row.submitted_at,
            user_name: row.submitter_email,
            details: null,
          },
        ];
  if (row.status === 'pending') {
    events.push({
      action: '__awaiting_accounting',
      created_at: '',
      user_name: '',
      details: null,
    });
  }

  const toneCls: Record<'amber' | 'emerald' | 'rose' | 'zinc', { dot: string; text: string }> = {
    amber: { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' },
    emerald: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400' },
    rose: { dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' },
    zinc: { dot: 'bg-zinc-400', text: 'text-zinc-600 dark:text-zinc-400' },
  };

  return (
    <section className="flex flex-col gap-2.5">
      <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        Audit log
      </h4>
      <ol className="relative ml-1 flex flex-col gap-2 border-l border-zinc-200 pl-4 dark:border-zinc-800">
        {events.map((e, i) => {
          if (e.action === '__awaiting_accounting') {
            return (
              <li key={`awaiting-${i}`} className="relative">
                <span className="absolute -left-[18px] top-1 flex h-3 w-3 items-center justify-center">
                  <span className="absolute inline-flex h-3 w-3 animate-ping rounded-full bg-amber-400/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
                </span>
                <div className="text-[11.5px] text-amber-700 dark:text-amber-400">
                  Awaiting Accounting decision
                </div>
              </li>
            );
          }
          const meta = actionMeta(e.action);
          const tone = toneCls[meta.tone];
          const Icon = meta.Icon;
          const note =
            e.details && typeof e.details.decision_note === 'string'
              ? (e.details.decision_note as string)
              : null;
          return (
            <li key={`${e.action}-${e.created_at}-${i}`} className="relative">
              <span
                className={cn(
                  'absolute -left-[19px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full ring-2 ring-white dark:ring-zinc-950',
                  tone.dot,
                )}
              >
                <Icon className="h-2 w-2 text-white" />
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className={cn('text-[11.5px] font-medium', tone.text)}>{meta.label}</span>
                <span className="font-mono text-[10.5px] text-zinc-500">
                  {e.user_name?.split('@')[0] ?? '—'}
                </span>
                <span className="font-mono text-[10px] text-zinc-400">
                  {e.created_at ? formatRelative(e.created_at) : ''}
                </span>
              </div>
              {note && (
                <p className="mt-0.5 rounded-md bg-white px-2 py-1 text-[11px] italic text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">
                  &ldquo;{note}&rdquo;
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
