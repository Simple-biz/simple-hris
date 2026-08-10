'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ArrowRightLeft,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  AlertTriangle,
  Table2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { getTabCache, hasFetchedThisSession, markFetchedThisSession, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import type { AccountingTransferRow, TransferRateChange } from '@/lib/transfers/accounting-transfers';
import type { TransferRequestStatus } from '@/lib/supabase/department-transfer-requests';
import { CURRENCY_SYMBOL, type PayCurrency } from '@/lib/payment-catalog/pay-structure';
import {
  buildTransferExport,
  downloadTransfersCsv,
  downloadTransfersPdf,
  downloadTransfersXlsx,
} from '@/lib/transfers/transfers-export';

/** Format a rate in its own currency (PHP/USD/COP), always with 2 decimals. */
function money(n: number | null, c: PayCurrency | null): string {
  if (n == null) return '—';
  const sym = c ? CURRENCY_SYMBOL[c] : '';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_STYLE: Record<TransferRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  applied: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};
const STATUS_LABEL: Record<TransferRequestStatus, string> = {
  pending: 'Awaiting release',
  approved: 'Scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

function RateCell({ rc }: { rc: TransferRateChange | null }) {
  if (!rc || (rc.old_regular == null && rc.new_regular == null)) {
    return <span className="text-[11px] italic text-zinc-400">no catalog rate set</span>;
  }
  const otLine =
    rc.old_ot != null || rc.new_ot != null
      ? `OT ${money(rc.old_ot, rc.old_currency)} → ${money(rc.new_ot, rc.new_currency)}`
      : null;
  // Compare only when both sides are known and in the same currency — a
  // cross-currency numeric compare (e.g. $10 vs ₱500) is meaningless.
  const comparable =
    rc.old_regular != null && rc.new_regular != null && rc.old_currency === rc.new_currency;
  const dir = comparable ? Math.sign(rc.new_regular! - rc.old_regular!) : 0;
  const newClass =
    dir > 0
      ? 'text-emerald-700 dark:text-emerald-300' // increase
      : dir < 0
        ? 'text-rose-600 dark:text-rose-400' // decrease
        : 'text-zinc-700 dark:text-zinc-200'; // no change / not comparable
  return (
    <div className="text-xs" title={otLine ?? undefined}>
      <span className="text-zinc-500 line-through dark:text-zinc-500">
        {money(rc.old_regular, rc.old_currency)}
      </span>
      <ArrowRight className="mx-1 inline h-3 w-3 text-zinc-400" />
      <span className={cn('font-semibold', newClass)}>{money(rc.new_regular, rc.new_currency)}</span>
    </div>
  );
}

// ── KPI cards ──────────────────────────────────────────────────────────────

/** Accent palettes for the KPI cards — icon chip + value tint, tuned for both
 *  themes. Mirrors the manager Transfers tab so the two views read as siblings. */
const KPI_ACCENT = {
  emerald: {
    ring: 'hover:border-emerald-300/80 dark:hover:border-emerald-500/40',
    chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    value: 'text-emerald-600 dark:text-emerald-300',
    glow: 'from-emerald-500/10',
  },
  amber: {
    ring: 'hover:border-amber-300/80 dark:hover:border-amber-500/40',
    chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    value: 'text-amber-600 dark:text-amber-300',
    glow: 'from-amber-500/10',
  },
  sky: {
    ring: 'hover:border-sky-300/80 dark:hover:border-sky-500/40',
    chip: 'bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    value: 'text-sky-600 dark:text-sky-300',
    glow: 'from-sky-500/10',
  },
  rose: {
    ring: 'hover:border-rose-300/80 dark:hover:border-rose-500/40',
    chip: 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    value: 'text-rose-600 dark:text-rose-300',
    glow: 'from-rose-500/10',
  },
} as const;

/** One at-a-glance metric card. Clickable when `onClick` toggles its filter. */
function KpiCard({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  onClick,
  active,
}: {
  label: string;
  value: number;
  hint: string;
  icon: typeof Inbox;
  accent: keyof typeof KPI_ACCENT;
  onClick?: () => void;
  active?: boolean;
}) {
  const a = KPI_ACCENT[accent];
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      whileHover={onClick ? { y: -2 } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      aria-pressed={onClick ? !!active : undefined}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-2xl border bg-white p-4 text-left shadow-sm transition-colors dark:bg-zinc-950',
        'border-zinc-200/80 dark:border-zinc-800/80',
        onClick ? 'cursor-pointer' : 'cursor-default',
        a.ring,
        active && 'ring-1 ring-inset ring-orange-400/50 dark:ring-orange-500/40',
      )}
    >
      {/* soft corner glow on hover */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gradient-to-br to-transparent opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100',
          a.glow,
        )}
      />
      <div className="flex items-center justify-between">
        <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-lg', a.chip)}>
          <Icon className="h-4 w-4" />
        </span>
        <span className={cn('text-3xl font-bold tabular-nums leading-none tracking-tight', a.value)}>
          {value}
        </span>
      </div>
      <div className="mt-3">
        <div className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{label}</div>
        <div className="mt-0.5 text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
          {hint}
        </div>
      </div>
    </motion.button>
  );
}

// ── Export menu (PDF · XLSX · CSV — themed like the Accounting dashboard) ────

type ExportFormat = 'pdf' | 'xlsx' | 'csv';

/** Download the transfers currently in view (respecting the active search) as a
 *  branded PDF, an Excel workbook, or a flat CSV. Fully client-side. */
function ExportMenu({
  rows,
  total,
  filterLabel,
}: {
  rows: AccountingTransferRow[];
  total: number;
  filterLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const runExport = useCallback(
    async (format: ExportFormat) => {
      if (rows.length === 0) {
        toast.error('Nothing to export in this view.');
        return;
      }
      setBusy(format);
      setOpen(false);
      try {
        const model = buildTransferExport({ rows, total, filterLabel });
        if (format === 'csv') {
          downloadTransfersCsv(model);
        } else if (format === 'xlsx') {
          downloadTransfersXlsx(model);
        } else {
          await downloadTransfersPdf(model);
        }
        toast.success(
          `Exported ${rows.length.toLocaleString()} ${rows.length === 1 ? 'transfer' : 'transfers'} as ${format.toUpperCase()}.`,
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to export ${format.toUpperCase()}`);
      } finally {
        setBusy(null);
      }
    },
    [rows, total, filterLabel],
  );

  const items: { format: ExportFormat; label: string; hint: string; Icon: typeof FileText }[] = [
    { format: 'pdf', label: 'PDF', hint: 'Branded document', Icon: FileText },
    { format: 'xlsx', label: 'Excel', hint: 'XLSX workbook', Icon: FileSpreadsheet },
    { format: 'csv', label: 'CSV', hint: 'Plain data', Icon: Table2 },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export the transfers in view (CSV · Excel · PDF)"
        className="h-8 gap-1.5 border-orange-200 px-2.5 text-[12px] text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
        <span className="hidden sm:inline">{busy ? `Exporting ${busy.toUpperCase()}…` : 'Export'}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </Button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-200 bg-white p-1 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              Export {rows.length.toLocaleString()} {rows.length === 1 ? 'transfer' : 'transfers'}
            </p>
            {items.map(({ format, label, hint, Icon }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                onClick={() => void runExport(format)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-orange-50 dark:hover:bg-orange-950/30"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm">
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</span>
                </span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Status keys a KPI card filters to when toggled on. */
type StatusFilter = 'applied' | 'pending' | 'approved' | 'sheet_fail';

/**
 * Accounting → Transfers (read-only). The history of who moved departments, who
 * requested and released them, when it took effect, and the pay-rate change the
 * move triggered (linked from employee_rate_history by the effective date).
 * Gated network-side to rate-visible roles.
 *
 * On top of the audit table: four at-a-glance KPI cards (each a click-to-filter
 * chip), a text search over people / departments / requesters, and a
 * CSV / XLSX / PDF export of whatever is currently in view.
 */
export default function AccountingTransfers() {
  const [rows, setRows] = useState<AccountingTransferRow[]>(
    () => getTabCache<AccountingTransferRow[]>(TAB_CACHE_KEYS.transfers) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasFetchedThisSession(TAB_CACHE_KEYS.transfers));
  const [error, setError] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter | null>(null);

  // `silent` refetches (live Realtime events, the poll backstop, tab refocus)
  // must NOT flash the full-page spinner or wipe the visible table on a blip —
  // they swap rows in place and keep the last-good view on error, so an
  // auditing session never goes blank or (worse) silently stale.
  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/accounting/transfers', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: AccountingTransferRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setRows(json.rows ?? []);
      setTabCache(TAB_CACHE_KEYS.transfers, json.rows ?? []);
      markFetchedThisSession(TAB_CACHE_KEYS.transfers);
    } catch (e) {
      if (!opts?.silent) setError(e instanceof Error ? e.message : 'Failed to load transfers');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasFetchedThisSession(TAB_CACHE_KEYS.transfers)) return;
    void fetchAll();
  }, [fetchAll]);

  // Keep the view live so an auditor never chases a manager over an already-
  // handled request. A transfer row flipping pending -> applied/rejected (and
  // the rate-history entry that fills the rate-change column) fires a Realtime
  // event -> in-place refetch. The 60s poll + focus refresh are the backstop if
  // the Realtime socket ever drops silently.
  useLiveRefresh({
    tables: ['department_transfer_requests', 'employee_rate_history'],
    onRefresh: () => void fetchAll({ silent: true }),
    channel: 'accounting-transfers',
    pollMs: 60_000,
  });

  const retrySheet = async (id: string) => {
    setRetryId(id);
    try {
      const res = await fetch('/api/accounting/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'retry_sheet' }),
      });
      const json = (await res.json()) as { error?: string; sheet_synced?: boolean };
      if (!res.ok || json.error) throw new Error(json.error || 'Retry failed');
      toast[json.sheet_synced ? 'success' : 'error'](
        json.sheet_synced ? 'Google Sheet updated' : 'Still could not update the Sheet',
      );
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setRetryId(null);
    }
  };

  // KPIs over ALL loaded rows (not the filtered view) — a stable at-a-glance
  // read that doesn't shift as you narrow the search.
  const kpis = useMemo(() => {
    let applied = 0;
    let awaiting = 0;
    let scheduled = 0;
    let sheetFail = 0;
    for (const r of rows) {
      if (r.status === 'applied') {
        applied += 1;
        if (!r.sheet_synced) sheetFail += 1;
      } else if (r.status === 'pending') {
        awaiting += 1;
      } else if (r.status === 'approved') {
        scheduled += 1;
      }
    }
    return { applied, awaiting, scheduled, sheetFail };
  }, [rows]);

  // Apply the search + active KPI filter, then sort. Search matches the person,
  // both departments, the requester and the releaser (case-insensitive).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byStatus = (r: AccountingTransferRow): boolean => {
      switch (statusFilter) {
        case 'applied':
          return r.status === 'applied';
        case 'pending':
          return r.status === 'pending';
        case 'approved':
          return r.status === 'approved';
        case 'sheet_fail':
          return r.status === 'applied' && !r.sheet_synced;
        default:
          return true;
      }
    };
    const bySearch = (r: AccountingTransferRow): boolean => {
      if (!q) return true;
      const hay = [
        r.employee_name,
        r.employee_email,
        r.from_department,
        r.to_department,
        r.requested_by,
        r.decided_by,
        STATUS_LABEL[r.status],
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    };
    return rows.filter((r) => byStatus(r) && bySearch(r));
  }, [rows, query, statusFilter]);

  const sorted = useMemo(() => {
    // Applied/scheduled first, then everything else — each newest-first.
    const rank: Record<TransferRequestStatus, number> = {
      applied: 0,
      approved: 1,
      pending: 2,
      rejected: 3,
      cancelled: 4,
    };
    return [...filtered].sort(
      (a, b) => rank[a.status] - rank[b.status] || b.created_at.localeCompare(a.created_at),
    );
  }, [filtered]);

  // Human-facing description of the active filter, threaded into the export's
  // provenance preamble so a saved file records what it was scoped to.
  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    const statusName: Record<StatusFilter, string> = {
      applied: 'Applied',
      pending: 'Awaiting release',
      approved: 'Scheduled',
      sheet_fail: 'Sheet-sync failures',
    };
    if (statusFilter) parts.push(statusName[statusFilter]);
    if (query.trim()) parts.push(`matching "${query.trim()}"`);
    return parts.length ? parts.join(' · ') : 'All transfers';
  }, [statusFilter, query]);

  const toggleStatus = (s: StatusFilter) => setStatusFilter((cur) => (cur === s ? null : s));

  const hasAnyFilter = query.trim().length > 0 || statusFilter !== null;
  const clearFilters = () => {
    setQuery('');
    setStatusFilter(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-orange-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-orange-950/40 dark:bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ArrowRightLeft className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              Transfers
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Who moved departments, who approved it, and the pay-rate change it triggered.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ExportMenu rows={sorted} total={rows.length} filterLabel={filterLabel} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void fetchAll()}
              className="h-8 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {/* At-a-glance KPI cards — click a card to filter the table to that status */}
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard
            label="Applied"
            value={kpis.applied}
            hint={statusFilter === 'applied' ? 'Filtering · click to clear' : 'Completed department moves'}
            icon={CheckCircle2}
            accent="emerald"
            onClick={() => toggleStatus('applied')}
            active={statusFilter === 'applied'}
          />
          <KpiCard
            label="Awaiting release"
            value={kpis.awaiting}
            hint={statusFilter === 'pending' ? 'Filtering · click to clear' : 'Pending a manager release'}
            icon={Inbox}
            accent="amber"
            onClick={() => toggleStatus('pending')}
            active={statusFilter === 'pending'}
          />
          <KpiCard
            label="Scheduled"
            value={kpis.scheduled}
            hint={statusFilter === 'approved' ? 'Filtering · click to clear' : 'Released, not yet applied'}
            icon={CalendarCheck}
            accent="sky"
            onClick={() => toggleStatus('approved')}
            active={statusFilter === 'approved'}
          />
          <KpiCard
            label="Sheet-sync failures"
            value={kpis.sheetFail}
            hint={statusFilter === 'sheet_fail' ? 'Filtering · click to clear' : 'Applied, Sheet not updated'}
            icon={AlertTriangle}
            accent="rose"
            onClick={() => toggleStatus('sheet_fail')}
            active={statusFilter === 'sheet_fail'}
          />
        </div>

        {/* Search bar */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search people, departments, requester…"
              aria-label="Search transfers"
              className="h-9 w-full rounded-xl border border-orange-100 bg-white pl-9 pr-9 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-200/60 dark:border-orange-950/40 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:ring-orange-500/20"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {hasAnyFilter && (
            <>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {sorted.length.toLocaleString()} of {rows.length.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-medium text-orange-600 hover:underline dark:text-orange-400"
              >
                Clear filters
              </button>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading transfers...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-orange-950/40 dark:bg-[#0d1117]">
            <Inbox className="h-7 w-7 text-orange-300 dark:text-orange-800" />
            <p className="text-sm text-zinc-500">No transfers yet.</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-orange-950/40 dark:bg-[#0d1117]">
            <Search className="h-7 w-7 text-orange-300 dark:text-orange-800" />
            <p className="text-sm text-zinc-500">No transfers match this view.</p>
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-orange-600 hover:underline dark:text-orange-400"
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-orange-100/80 bg-white dark:border-orange-950/40 dark:bg-zinc-950">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-orange-50/60 text-xs text-zinc-600 dark:bg-orange-950/20 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Employee</th>
                  <th className="px-3 py-2.5 font-semibold">Move</th>
                  <th className="px-3 py-2.5 font-semibold">Effective</th>
                  <th className="px-3 py-2.5 font-semibold">Requested by</th>
                  <th className="px-3 py-2.5 font-semibold">Released by</th>
                  <th className="px-3 py-2.5 font-semibold">Rate change</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/40">
                {sorted.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-orange-50/30 dark:hover:bg-orange-950/10">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {r.employee_name ?? r.employee_email}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {formatDeptLabel(r.from_department)}
                        </span>
                        <ArrowRight className="h-3 w-3 text-zinc-400" />
                        <span className="rounded bg-orange-600 px-1.5 py-0.5 font-semibold text-white">
                          {formatDeptLabel(r.to_department)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                      {r.effective_date ?? (r.proposed_effective_date ? `${r.proposed_effective_date} (proposed)` : '—')}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">{r.requested_by}</td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">{r.decided_by ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <RateCell rc={r.rate_change} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                            STATUS_STYLE[r.status],
                          )}
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.status === 'applied' && !r.sheet_synced && (
                          <button
                            type="button"
                            onClick={() => void retrySheet(r.id)}
                            disabled={retryId === r.id}
                            title={r.sheet_sync_error ?? 'The Google Sheet was not updated'}
                            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-200 disabled:opacity-60 dark:bg-amber-500/15 dark:text-amber-300"
                          >
                            {retryId === r.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <AlertTriangle className="h-3 w-3" />
                            )}
                            Sheet not synced · Retry
                          </button>
                        )}
                        {r.status === 'applied' && r.sheet_synced && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            Sheet synced
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
