'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileText,
  Inbox,
  Loader2,
  RefreshCw,
  RefreshCcwDot,
  Search,
  Users,
  X,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import type {
  DepartmentTransferRequestRow,
  TransferRequestStatus,
} from '@/lib/supabase/department-transfer-requests';

const PAGE_SIZE = 10;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Up-to-two-letter initials for the modal avatar (falls back to the email). */
function initials(name: string | null, email: string): string {
  const src = (name && name.trim()) || email.split('@')[0] || '?';
  const parts = src.trim().split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : src.slice(0, 2);
  return letters.toUpperCase();
}

/** "Jul 15, 2026, 3:04 PM" — full stamp for the details modal. */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
  approved: 'Released — scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

const STATUS_FILTER_OPTIONS: { value: '' | TransferRequestStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'pending', label: STATUS_LABEL.pending },
  { value: 'approved', label: STATUS_LABEL.approved },
  { value: 'applied', label: STATUS_LABEL.applied },
  { value: 'rejected', label: STATUS_LABEL.rejected },
  { value: 'cancelled', label: STATUS_LABEL.cancelled },
];

// The <select> lives inside <SelectWrapper> — it's borderless/transparent and
// lets the wrapper own the pill chrome, focus ring, and icon/label.
const SELECT_CLASS =
  'h-full cursor-pointer appearance-none bg-transparent pr-6 text-sm font-medium text-zinc-800 outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-100 [color-scheme:light] dark:[color-scheme:dark]';
const OPTION_CLASS = 'bg-white font-normal text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100';

/**
 * HR "Transfers" tab — read-only history (v2). Managers now own the transfer
 * decision end to end (receiving manager requests → source manager releases);
 * HR no longer approves. This surfaces the full trail for reference: who was
 * moved, both manager decisions, the effective date, and whether the Google
 * Sheet was written back. No pay data (HR never sees rates).
 */
export default function HrTransfers() {
  const [rows, setRows] = useState<DepartmentTransferRequestRow[]>(
    () => getHrTabCache<DepartmentTransferRequestRow[]>(HR_TAB_CACHE_KEYS.transfers) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.transfers));
  const [error, setError] = useState<string | null>(null);

  // Filters + search + pagination
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | TransferRequestStatus>('');
  const [page, setPage] = useState(1);

  // Details modal — the transfer whose "View" button was clicked (null = closed).
  const [viewing, setViewing] = useState<DepartmentTransferRequestRow | null>(null);
  const reduceMotion = useReducedMotion();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // scope=all = the full company-wide trail. The unscoped default is the
      // caller's own outbox, which for HR is empty — see list-scope.test.ts.
      const res = await fetch('/api/department-transfers?scope=all', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: DepartmentTransferRequestRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setRows(json.rows ?? []);
      setHrTabCache(HR_TAB_CACHE_KEYS.transfers, json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transfer requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasHrTabCache(HR_TAB_CACHE_KEYS.transfers)) return;
    void fetchAll();
  }, [fetchAll]);

  // ── KPI counts (movement metrics) — max 4 cards ──
  const kpis = useMemo(() => {
    let inProgress = 0;
    let completed = 0;
    let declined = 0;
    for (const r of rows) {
      if (r.status === 'pending' || r.status === 'approved') inProgress += 1;
      else if (r.status === 'applied') completed += 1;
      else declined += 1; // rejected | cancelled
    }
    return { total: rows.length, inProgress, completed, declined };
  }, [rows]);

  // Department options — every department that appears on either side of a move.
  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) {
      const from = (r.from_department || '').trim();
      const to = (r.to_department || '').trim();
      if (from) set.add(from);
      if (to) set.add(to);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  // Rows after search + department + status filters.
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dept = deptFilter.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false;
      if (dept) {
        const from = (r.from_department || '').trim().toLowerCase();
        const to = (r.to_department || '').trim().toLowerCase();
        if (from !== dept && to !== dept) return false;
      }
      if (q) {
        const haystack = [
          r.employee_name,
          r.employee_email,
          r.employee_work_email,
          r.employee_personal_email,
          r.from_department,
          r.to_department,
          r.requested_by,
          r.approver_email,
          r.reason,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, deptFilter, statusFilter]);

  const anyFilterActive = !!(query.trim() || deptFilter || statusFilter);

  // ── Pagination over the filtered rows ──
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  // Reset to page 1 whenever the filter set changes.
  useEffect(() => { setPage(1); }, [query, deptFilter, statusFilter]);
  // Never leave the page index past the end after rows shrink.
  useEffect(() => { setPage((p) => Math.min(p, pageCount)); }, [pageCount]);

  const pageRows = useMemo(
    () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRows, page],
  );
  const rangeStart = filteredRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, filteredRows.length);

  const clearFilters = useCallback(() => {
    setQuery('');
    setDeptFilter('');
    setStatusFilter('');
  }, []);

  // Close the details modal on Escape.
  useEffect(() => {
    if (!viewing) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewing(null); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [viewing]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-emerald-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-emerald-950/40 dark:bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ArrowRightLeft className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              Department Transfers
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Read-only history. Managers request and release transfers between departments.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchAll()}
            className="h-8 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto w-full max-w-5xl space-y-5">
          {/* ── KPI cards (movement metrics) — exactly 4 ── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Total transfers" value={kpis.total} tone="emerald" icon={<ArrowRightLeft className="h-4 w-4" />} />
            <KpiCard label="In progress" value={kpis.inProgress} tone="amber" icon={<Clock className="h-4 w-4" />} />
            <KpiCard label="Completed" value={kpis.completed} tone="teal" icon={<CheckCircle2 className="h-4 w-4" />} />
            <KpiCard label="Declined / cancelled" value={kpis.declined} tone="rose" icon={<XCircle className="h-4 w-4" />} />
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200/80 bg-rose-50/70 px-4 py-2.5 text-xs text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-100">
              {error}
            </div>
          )}

          {/* ── Search + filters ── */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by employee, department, or requester…"
                aria-label="Search transfers"
                className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-8 text-sm text-zinc-800 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <SelectWrapper
              icon={<ArrowRightLeft className="h-3.5 w-3.5" />}
              label="Dept"
              active={!!deptFilter}
            >
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                disabled={departmentOptions.length === 0}
                aria-label="Filter by department"
                className={SELECT_CLASS}
              >
                <option value="" className={OPTION_CLASS}>All departments</option>
                {departmentOptions.map((d) => (
                  <option key={d} value={d} className={OPTION_CLASS}>{d}</option>
                ))}
              </select>
            </SelectWrapper>

            <SelectWrapper
              icon={<Clock className="h-3.5 w-3.5" />}
              label="Status"
              active={!!statusFilter}
            >
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as '' | TransferRequestStatus)}
                aria-label="Filter by status"
                className={SELECT_CLASS}
              >
                {STATUS_FILTER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} className={OPTION_CLASS}>{o.label}</option>
                ))}
              </select>
            </SelectWrapper>

            {anyFilterActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          {/* ── Table ── */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading transfers...
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-emerald-200 bg-white py-16 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
              <Inbox className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
              <p className="text-sm text-zinc-500">No department transfers yet.</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-emerald-200 bg-white py-16 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
              <Search className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
              <p className="text-sm text-zinc-500">No transfers match these filters.</p>
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-emerald-100/80 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-emerald-100/80 bg-emerald-50/60 text-left dark:border-emerald-950/40 dark:bg-emerald-950/30">
                      {['Employee', 'Movement', 'Requested by', 'Effective', 'Status', ''].map((h, i) => (
                        <th
                          key={i}
                          className="whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100/70 dark:divide-emerald-950/40">
                    {pageRows.map((r) => (
                      <tr key={r.id} className="hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20">
                        <td className="px-4 py-3">
                          <div className="font-medium text-zinc-800 dark:text-zinc-100">
                            {r.employee_name ?? r.employee_email}
                          </div>
                          {r.employee_name && (
                            <div className="text-[11px] text-zinc-400">{r.employee_email}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              {r.from_department}
                            </span>
                            <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                            <span className="rounded-md bg-emerald-600 px-2 py-0.5 font-semibold text-white">
                              {r.to_department}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {r.requested_by}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                          {r.effective_date ?? r.proposed_effective_date ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            {r.status === 'applied' && !r.sheet_synced && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                                title={r.sheet_sync_error ?? 'The Google Sheet was not updated'}
                              >
                                <AlertTriangle className="h-3 w-3" />
                                Sheet
                              </span>
                            )}
                            <span
                              className={cn(
                                'whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                STATUS_STYLE[r.status],
                              )}
                            >
                              {STATUS_LABEL[r.status]}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setViewing(r)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination footer */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-emerald-100/70 px-4 py-2.5 text-xs text-zinc-500 dark:border-emerald-950/40 dark:text-zinc-400">
                <span className="tabular-nums">
                  Showing {rangeStart}–{rangeEnd} of {filteredRows.length}
                  {anyFilterActive && rows.length !== filteredRows.length ? ` (filtered from ${rows.length})` : ''}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    aria-label="Previous page"
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-1 tabular-nums">
                    Page {page} of {pageCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    disabled={page >= pageCount}
                    aria-label="Next page"
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Transfer details modal (no pay data) ── */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {viewing && (
              <TransferDetailsModal
                key="transfer-details"
                row={viewing}
                reduceMotion={!!reduceMotion}
                onClose={() => setViewing(null)}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

/** The animated transfer-details modal. Kept as its own component so
 *  AnimatePresence can play its exit transition with the last-viewed row. */
function TransferDetailsModal({
  row,
  reduceMotion,
  onClose,
}: {
  row: DepartmentTransferRequestRow;
  reduceMotion: boolean;
  onClose: () => void;
}) {
  const sheetValue =
    row.status === 'applied'
      ? row.sheet_synced
        ? 'Synced to Google Sheet'
        : `Not synced${row.sheet_sync_error ? ` — ${row.sheet_sync_error}` : ''}`
      : null;

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Transfer details"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {/* Backdrop */}
      <motion.div
        className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      />

      {/* Panel */}
      <motion.div
        className="relative z-[1] flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/60 bg-white shadow-2xl shadow-emerald-950/20 ring-1 ring-black/5 dark:border-white/10 dark:bg-zinc-950 dark:shadow-black/50"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 16 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 12 }}
        transition={reduceMotion ? { duration: 0.15 } : { type: 'spring', stiffness: 380, damping: 30, mass: 0.8 }}
      >
        {/* Hero header — gradient band with avatar, name, and the movement */}
        <div className="relative overflow-hidden bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 px-5 pb-5 pt-4 text-white">
          {/* soft decorative glow */}
          <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-white/15 blur-2xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm font-bold ring-1 ring-white/40 backdrop-blur-sm">
                {initials(row.employee_name, row.employee_email)}
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold tracking-tight">
                  {row.employee_name ?? row.employee_email}
                </h2>
                <p className="truncate text-xs text-emerald-50/80">{row.employee_email}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 rounded-lg p-1.5 text-white/80 transition hover:bg-white/20 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Movement hero */}
          <div className="relative mt-4 flex items-center gap-2 rounded-xl bg-white/15 p-2.5 ring-1 ring-white/20 backdrop-blur-sm">
            <div className="min-w-0 flex-1 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-50/70">From</p>
              <p className="truncate text-sm font-semibold">{row.from_department}</p>
            </div>
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/25">
              <ArrowRight className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1 text-center">
              <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-50/70">To</p>
              <p className="truncate text-sm font-semibold">{row.to_department}</p>
            </div>
          </div>

          <div className="relative mt-3 flex items-center gap-2">
            <span className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-sm', STATUS_STYLE[row.status])}>
              {STATUS_LABEL[row.status]}
            </span>
            {row.status === 'applied' && (
              row.sheet_synced ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-medium text-white ring-1 ring-white/30">
                  <CheckCircle2 className="h-3 w-3" /> Sheet synced
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/90 px-2 py-0.5 text-[11px] font-semibold text-amber-950">
                  <AlertTriangle className="h-3 w-3" /> Sheet not synced
                </span>
              )
            )}
          </div>
        </div>

        {/* Body — grouped detail sections */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <DetailSection icon={<Users className="h-3.5 w-3.5" />} title="People">
            <DetailField label="Requested by" value={row.requested_by} />
            <DetailField label="Decided by" value={row.approver_email} />
            <DetailField label="Work email" value={row.employee_work_email} className="sm:col-span-2" />
            <DetailField label="Personal email" value={row.employee_personal_email} className="sm:col-span-2" />
          </DetailSection>

          <DetailSection icon={<CalendarClock className="h-3.5 w-3.5" />} title="Timeline">
            <DetailField label="Requested on" value={formatDateTime(row.created_at)} />
            <DetailField label="Decided on" value={row.decided_at ? formatDateTime(row.decided_at) : null} />
            <DetailField label="Proposed effective" value={row.proposed_effective_date} />
            <DetailField label="Effective date" value={row.effective_date} />
            <DetailField label="Applied on" value={row.applied_at ? formatDateTime(row.applied_at) : null} />
          </DetailSection>

          {(row.reason || row.approver_note || sheetValue) && (
            <DetailSection icon={<FileText className="h-3.5 w-3.5" />} title="Notes">
              <DetailField label="Reason" value={row.reason} className="sm:col-span-2" />
              <DetailField label="Manager note" value={row.approver_note} className="sm:col-span-2" />
              {sheetValue && <DetailField label="Sheet sync" value={sheetValue} className="sm:col-span-2" />}
            </DetailSection>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800/80">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <RefreshCcwDot className="h-3.5 w-3.5" />
            Updated {timeAgo(row.updated_at)}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={onClose}
            className="h-8 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            Close
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** A titled group of detail fields inside the modal body. */
function DetailSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
        {icon}
        {title}
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border border-zinc-100 bg-zinc-50/60 p-3.5 sm:grid-cols-2 dark:border-zinc-800/70 dark:bg-zinc-900/40">
        {children}
      </dl>
    </section>
  );
}

/** A pill wrapper around a native <select>: leading icon + label, custom caret,
 *  and an emerald accent when a value is chosen. */
function SelectWrapper({
  icon,
  label,
  active,
  children,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'group relative flex h-9 items-center gap-1.5 rounded-lg border px-2.5 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-emerald-500/20',
        active
          ? 'border-emerald-300 bg-emerald-50/80 focus-within:border-emerald-500 dark:border-emerald-700/60 dark:bg-emerald-950/30'
          : 'border-zinc-200 bg-white hover:border-zinc-300 focus-within:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:hover:border-zinc-700',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400')}>
        {icon}
      </span>
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      {children}
      <ChevronRight className="pointer-events-none absolute right-2 h-3.5 w-3.5 rotate-90 text-zinc-400" />
    </div>
  );
}

/** One KPI (movement metric) tile. */
function KpiCard({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'amber' | 'teal' | 'rose';
  icon: ReactNode;
}) {
  const styles = {
    emerald:
      'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-emerald-900 dark:border-emerald-700/40 dark:from-emerald-950/40 dark:to-zinc-950 dark:text-emerald-100',
    amber:
      'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
    teal:
      'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    rose:
      'border-rose-200 bg-gradient-to-br from-rose-50 to-white text-rose-900 dark:border-rose-700/40 dark:from-rose-950/40 dark:to-zinc-950 dark:text-rose-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
        <span className="opacity-60">{icon}</span>
      </div>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

/** One label/value row in the details modal; hidden when the value is empty. */
function DetailField({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null | undefined;
  className?: string;
}) {
  const shown = value && value.trim() ? value : '—';
  return (
    <div className={className}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-800 dark:text-zinc-100">{shown}</dd>
    </div>
  );
}
