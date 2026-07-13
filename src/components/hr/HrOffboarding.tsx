'use client';

import React, { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  FileX,
  Inbox,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
  UserMinus,
  UserX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import type { OffboardingQueueRow } from '@/lib/supabase/offboarding-queue';
import HrOffboardQueueProcessor from './HrOffboardQueueProcessor';
import DeptFilter from './DeptFilter';

type HistoryRow = {
  id: string;
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  Department: string | null;
  'Start Date': string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
  off_boarded_note: string | null;
};

const REASON_LABELS: Record<string, string> = {
  // Canonical (dashboard-set) reason keys.
  resigned: 'Resigned',
  end_of_contract: 'End of contract',
  performance: 'Performance',
  attendance: 'Attendance',
  time_manipulation: 'Time manipulation',
  other: 'Other',
  // Reasons that arrive from the Offboarded Google Sheet sync. Stored verbatim
  // so the column-as-typed in the sheet is preserved (no enum-shoehorning).
  Resigned: 'Resigned',
  Attendance: 'Attendance',
  Productivity: 'Productivity',
  'Policy Violation': 'Policy violation',
  'Declined Offer': 'Declined offer',
  NCNS: 'No call, no show',
  'Need to Rescind': 'Need to rescind',
  'Need to Reschedule': 'Need to reschedule',
  sheet_sync: 'From Offboarded sheet',
};

const PAGE_SIZE = 10;
const QUEUE_PAGE_SIZE = 20;

function PaginationBar({
  page, totalPages, setPage, total, filtered, pageSize = PAGE_SIZE,
}: {
  page: number; totalPages: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  total: number; filtered: number; pageSize?: number;
}) {
  return (
    <div data-readonly-allow className="flex items-center justify-between border-t border-emerald-100/60 px-4 py-2.5 dark:border-emerald-900/40">
      <p className="text-[11px] text-zinc-400">
        {filtered === 0 ? '0' : `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, filtered)}`} of {filtered}
        {filtered < total && <span className="text-zinc-300 dark:text-zinc-600"> (filtered from {total})</span>}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(0)}>
          <ChevronLeft className="h-3 w-3" /><ChevronLeft className="h-3 w-3 -ml-2" />
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft className="h-3 w-3" />
        </Button>
        <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{page + 1} / {totalPages}</span>
        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
          <ChevronRight className="h-3 w-3" />
        </Button>
        <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
          <ChevronRight className="h-3 w-3" /><ChevronRight className="h-3 w-3 -ml-2" />
        </Button>
      </div>
    </div>
  );
}

type OffboardTab = 'queue' | 'hris' | 'offboarded';

export default function HrOffboarding() {
  const [activeTab, setActiveTab] = useState<OffboardTab>('queue');

  const [history, setHistory] = useState<HistoryRow[]>(
    () => getHrTabCache<HistoryRow[]>(HR_TAB_CACHE_KEYS.offboardHistory) ?? [],
  );
  const [historyLoading, setHistoryLoading] = useState(
    () => !hasHrTabCache(HR_TAB_CACHE_KEYS.offboardHistory),
  );
  const [historySearch, setHistorySearch] = useState('');
  const [historyDept, setHistoryDept] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [removingFromSheet, setRemovingFromSheet] = useState<string | null>(null);

  // ── Manager-request queue (default sub-tab) ──
  const [queue, setQueue] = useState<OffboardingQueueRow[]>(
    () => getHrTabCache<OffboardingQueueRow[]>(HR_TAB_CACHE_KEYS.offboardQueue) ?? [],
  );
  const [queueLoading, setQueueLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.offboardQueue));
  const [queueSearch, setQueueSearch] = useState('');
  const [queuePage, setQueuePage] = useState(0);
  // ── "Offboarded by HRIS": completed queue rows, split out of the Queue tab ──
  const [hrisSearch, setHrisSearch] = useState('');
  const [hrisPage, setHrisPage] = useState(0);
  // Rows fed to the 1-by-1 processor (bulk = all pending, or a single row).
  const [processTargets, setProcessTargets] = useState<OffboardingQueueRow[] | null>(null);
  // Multi-select for batch off-boarding a chosen subset of the pending queue.
  // Kept as a plain id set so selections survive search/pagination (never pruned
  // when a row scrolls out of the filter).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // The queue row being returned to its manager (quick per-row action).
  const [returnTarget, setReturnTarget] = useState<OffboardingQueueRow | null>(null);
  // The queue row being permanently deleted (HR cleanup, any status).
  const [deleteTarget, setDeleteTarget] = useState<OffboardingQueueRow | null>(null);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/hr/offboard-history', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: HistoryRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setHistory(json.rows ?? []);
      setHrTabCache(HR_TAB_CACHE_KEYS.offboardHistory, json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load offboard history');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const fetchQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const res = await fetch('/api/offboarding-queue', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: OffboardingQueueRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setQueue(json.rows ?? []);
      setHrTabCache(HR_TAB_CACHE_KEYS.offboardQueue, json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load offboarding queue');
      setQueue([]);
    } finally {
      setQueueLoading(false);
    }
  }, []);

  const handleRestore = useCallback(async (row: HistoryRow) => {
    const email = row['Work Email'];
    if (!email) return;
    setRestoring(email);
    try {
      const res = await fetch('/api/hr/reonboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: email }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        rbac_restored?: { roles: number; departments: number; features: number };
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to restore');
      const rb = json.rbac_restored;
      const restoredCount = rb ? rb.roles + rb.departments + rb.features : 0;
      toast.success(`${row.Name ?? email} restored to active roster`, {
        description:
          restoredCount > 0
            ? `Re-granted ${rb!.roles} role${rb!.roles === 1 ? '' : 's'}, ${rb!.departments} managed dept${rb!.departments === 1 ? '' : 's'}, ${rb!.features} feature permission${rb!.features === 1 ? '' : 's'}.`
            : undefined,
      });
      await fetchHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to restore');
    } finally {
      setRestoring(null);
    }
  }, [fetchHistory]);

  const handleRemoveFromSheet = useCallback(async (row: HistoryRow) => {
    const email = row['Work Email'] ?? '';
    if (!email) return;
    setRemovingFromSheet(email);
    try {
      const res = await fetch('/api/hr/offboard-sheet-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: email,
          personal_email: row['Personal Email'] ?? '',
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        deleted?: number;
        snapshotDeleted?: number;
        reason?: string;
        error?: string;
      };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to remove from sheet');
      const removedFromList = (json.snapshotDeleted ?? 0) > 0 || (json.deleted ?? 0) > 0;
      if (removedFromList) {
        toast.success(`${row.Name ?? email} removed from the Offboarded sheet`, {
          description: "They won't reappear in this list on the next sync.",
        });
      } else {
        toast.info(`${row.Name ?? email} was not found in the sheet`, {
          description: json.reason ?? 'They may have already been removed manually.',
        });
      }
      // Refresh so the row drops from the list immediately (we already deleted
      // the snapshot row server-side — no need to wait for the next sync).
      await fetchHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove from sheet');
    } finally {
      setRemovingFromSheet(null);
    }
  }, [fetchHistory]);

  useEffect(() => {
    // Skip the initial fetch for whichever data set is already cached (tab
    // revisit) so the tables don't re-query / reload; Refresh buttons + actions
    // still force a fresh fetch and update the cache.
    if (!hasHrTabCache(HR_TAB_CACHE_KEYS.offboardHistory)) void fetchHistory();
    if (!hasHrTabCache(HR_TAB_CACHE_KEYS.offboardQueue)) void fetchQueue();
  }, [fetchHistory, fetchQueue]);

  const filteredHistory = useMemo(() => {
    setHistoryPage(0);
    const q = historySearch.trim().toLowerCase();
    return history.filter((r) => {
      if (historyDept && (r.Department ?? '').trim() !== historyDept) return false;
      if (!q) return true;
      return [r.Name, r['Work Email'], r.Department, r.off_boarded_reason, r.off_boarded_by]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [history, historySearch, historyDept]);

  const historyTotalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, historyTotalPages - 1);
  const historyPageRows = filteredHistory.slice(safeHistoryPage * PAGE_SIZE, (safeHistoryPage + 1) * PAGE_SIZE);

  // Queue: pending/processing rows are actionable; the rest are recent history.
  const pendingQueue = useMemo(
    () => queue.filter((r) => r.status === 'pending' || r.status === 'processing'),
    [queue],
  );
  // Completed rows are offboarded people — they live in the "Offboarded by HRIS"
  // tab, not the Queue, so the Queue stays cleared to open work + recent decisions.
  const filteredQueue = useMemo(() => {
    setQueuePage(0);
    const q = queueSearch.trim().toLowerCase();
    return queue.filter((r) => {
      if (r.status === 'completed') return false;
      if (!q) return true;
      return [r.employee_name, r.employee_work_email, r.employee_email, r.department, r.requested_by, r.reason]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [queue, queueSearch]);
  const queueTotalPages = Math.max(1, Math.ceil(filteredQueue.length / QUEUE_PAGE_SIZE));
  const safeQueuePage = Math.min(queuePage, queueTotalPages - 1);
  const queuePageRows = filteredQueue.slice(safeQueuePage * QUEUE_PAGE_SIZE, (safeQueuePage + 1) * QUEUE_PAGE_SIZE);
  const pendingCount = pendingQueue.length;
  // Non-completed rows still shown in the Queue (drives the sub-label + empty copy).
  const queueOpenTotal = useMemo(() => queue.filter((r) => r.status !== 'completed').length, [queue]);

  // ── Multi-select for batch off-boarding ──
  const isActionable = (r: OffboardingQueueRow) => r.status === 'pending' || r.status === 'processing';
  // The selected rows that can still be off-boarded (a selection may include a row
  // that has since been processed elsewhere — ignore those).
  const selectedActionable = useMemo(
    () => pendingQueue.filter((r) => selectedIds.has(r.id)),
    [pendingQueue, selectedIds],
  );
  // Actionable rows on the current page, for the header "select all" checkbox.
  const pageActionable = useMemo(() => queuePageRows.filter(isActionable), [queuePageRows]);
  const allPageSelected =
    pageActionable.length > 0 && pageActionable.every((r) => selectedIds.has(r.id));
  const toggleRow = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageActionable.forEach((r) => next.delete(r.id));
      else pageActionable.forEach((r) => next.add(r.id));
      return next;
    });
  const clearSelection = () => setSelectedIds(new Set());
  // Open the processor seeded with just the selected rows → HR clicks "Offboard
  // all" there to fire the single batched teardown.
  const offboardSelected = () => {
    if (selectedActionable.length === 0) return;
    setProcessTargets(selectedActionable);
    clearSelection();
  };

  // People offboarded through the HRIS queue processor (status === 'completed').
  const hrisOffboarded = useMemo(
    () => queue.filter((r) => r.status === 'completed'),
    [queue],
  );
  const filteredHris = useMemo(() => {
    setHrisPage(0);
    const q = hrisSearch.trim().toLowerCase();
    return hrisOffboarded.filter((r) => {
      if (!q) return true;
      return [r.employee_name, r.employee_work_email, r.employee_personal_email, r.employee_email, r.department, r.processed_by, r.offboard_reason ?? r.reason]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [hrisOffboarded, hrisSearch]);
  const hrisTotalPages = Math.max(1, Math.ceil(filteredHris.length / PAGE_SIZE));
  const safeHrisPage = Math.min(hrisPage, hrisTotalPages - 1);
  const hrisPageRows = filteredHris.slice(safeHrisPage * PAGE_SIZE, (safeHrisPage + 1) * PAGE_SIZE);

  // Dedupe by Personal Email so the tab badge / subline reflect unique people,
  // not raw rows. global_master_list keys on (personal_email, department), so
  // someone with dual-department assignments would otherwise inflate the count.
  function uniquePeople<T extends { 'Personal Email': string | null }>(rows: T[]): number {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = (r['Personal Email'] ?? '').trim().toLowerCase();
      if (k) seen.add(k);
    }
    return seen.size;
  }
  const historyUniqueTotal = uniquePeople(history);
  const historyUniqueFiltered = uniquePeople(filteredHistory);

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Header */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div
          className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl"
          aria-hidden
        />
        <div
          className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/20 blur-2xl"
          aria-hidden
        />
        <div className="relative flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/95">
            <UserMinus className="h-3 w-3 shrink-0" />
            Offboarding
          </div>
          <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Wrap up cleanly when people move on.
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/85">
            Managers send people here from <span className="font-semibold">My Team</span>.
            Click <span className="font-semibold">Process</span> to work through each
            request. Records are retained for reporting; people drop from payroll and
            manager dashboards immediately.
          </p>
        </div>
      </header>

      {/* Main card with tabs */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-3 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          {/* Tab switcher + search + refresh */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Tabs */}
            <div role="tablist" aria-label="Offboarding views" className="flex items-center gap-1 rounded-lg border border-emerald-100/80 bg-emerald-50/60 p-1 dark:border-emerald-900/50 dark:bg-emerald-950/30">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'queue'}
                onClick={() => setActiveTab('queue')}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'queue' ? 'text-white' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                {activeTab === 'queue' && (
                  <motion.span
                    layoutId="offboardTabPill"
                    className="absolute inset-0 rounded-md bg-gradient-to-r from-rose-500 to-rose-700 shadow-sm"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  <Inbox className="h-3.5 w-3.5" />
                  Queue
                  {pendingCount > 0 && (
                    <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', activeTab === 'queue' ? 'bg-white/20' : 'bg-rose-500 text-white')}>
                      {pendingCount}
                    </span>
                  )}
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'hris'}
                onClick={() => setActiveTab('hris')}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'hris' ? 'text-white' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                {activeTab === 'hris' && (
                  <motion.span
                    layoutId="offboardTabPill"
                    className="absolute inset-0 rounded-md bg-gradient-to-r from-rose-500 to-rose-700 shadow-sm"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  <UserX className="h-3.5 w-3.5" />
                  Offboarded by HRIS
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', activeTab === 'hris' ? 'bg-white/20' : 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300')}>
                    {hrisOffboarded.length}
                  </span>
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'offboarded'}
                onClick={() => setActiveTab('offboarded')}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'offboarded' ? 'text-white' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                {activeTab === 'offboarded' && (
                  <motion.span
                    layoutId="offboardTabPill"
                    className="absolute inset-0 rounded-md bg-gradient-to-r from-rose-500 to-rose-700 shadow-sm"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  Offboarded
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', activeTab === 'offboarded' ? 'bg-white/20' : 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300')}>
                    {historyUniqueTotal}
                  </span>
                </span>
              </button>
            </div>

            {/* Search + refresh */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="flex items-center gap-2"
              >
                {activeTab === 'queue' ? (
                  <>
                    <div className="relative w-full sm:w-64">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <Input value={queueSearch} onChange={(e) => setQueueSearch(e.target.value)} placeholder="Search name, manager…" className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900" />
                    </div>
                    {selectedActionable.length > 0 && (
                      <Button
                        size="sm"
                        onClick={offboardSelected}
                        className="shrink-0 gap-1.5 bg-rose-700 text-white hover:bg-rose-800"
                        title="Off-board just the selected people as one batch"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                        Offboard selected ({selectedActionable.length})
                      </Button>
                    )}
                    {pendingCount > 0 && (
                      <Button
                        size="sm"
                        variant={selectedActionable.length > 0 ? 'outline' : 'default'}
                        onClick={() => setProcessTargets(pendingQueue)}
                        className={cn(
                          'shrink-0 gap-1.5',
                          selectedActionable.length > 0
                            ? ''
                            : 'bg-rose-600 text-white hover:bg-rose-700',
                        )}
                        title="Step through all pending requests one by one"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Process pending ({pendingCount})
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => void fetchQueue()} disabled={queueLoading} className="shrink-0">
                      <RefreshCw className={cn('h-3.5 w-3.5', queueLoading && 'animate-spin')} />
                    </Button>
                  </>
                ) : activeTab === 'hris' ? (
                  <>
                    <div className="relative w-full sm:w-64">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <Input value={hrisSearch} onChange={(e) => setHrisSearch(e.target.value)} placeholder="Search name, email…" className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900" />
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void fetchQueue()} disabled={queueLoading} className="shrink-0">
                      <RefreshCw className={cn('h-3.5 w-3.5', queueLoading && 'animate-spin')} />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="relative w-full sm:w-56">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <Input value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Search name, reason…" className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900" />
                    </div>
                    <DeptFilter rows={history} getDept={(r) => r.Department} value={historyDept} onChange={setHistoryDept} />
                    <Button variant="outline" size="sm" onClick={() => void fetchHistory()} disabled={historyLoading} className="shrink-0">
                      <RefreshCw className={cn('h-3.5 w-3.5', historyLoading && 'animate-spin')} />
                    </Button>
                  </>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Sub-label */}
          <p className="text-xs text-muted-foreground">
            {activeTab === 'queue'
              ? queueLoading ? 'Loading queue…' : `${pendingCount} pending · ${queueOpenTotal} open request${queueOpenTotal === 1 ? '' : 's'} from managers`
              : activeTab === 'hris'
              ? queueLoading ? 'Loading…' : `${filteredHris.length} of ${hrisOffboarded.length} offboarded through HRIS`
              : historyLoading ? 'Loading…' : `${historyUniqueFiltered} of ${historyUniqueTotal} off-boarded`}
          </p>
        </CardHeader>

        <CardContent className="pt-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
          {activeTab === 'queue' ? (
            /* ── Manager-request Queue ── */
            queueLoading ? (
              <div className="flex items-center justify-center py-10 text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filteredQueue.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rose-200/80 bg-white/70 py-10 text-center dark:border-rose-900/50 dark:bg-zinc-950/40">
                <Inbox className="h-8 w-8 text-rose-300 dark:text-rose-700" />
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {queueOpenTotal === 0 ? 'The queue is clear — no open requests.' : 'No rows match your search.'}
                </p>
                <p className="max-w-md text-xs text-zinc-400">
                  Managers send people here from <span className="font-medium">My Team → List view</span>. You process them one at a time.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-rose-100/90 ring-1 ring-rose-500/10 dark:border-rose-900/60 dark:ring-rose-400/10">
                <table className="w-full text-left text-sm sm:min-w-[940px]">
                  <thead className="sticky top-0 z-[1] bg-gradient-to-r from-rose-50 via-white to-rose-50/80 text-xs text-zinc-600 dark:from-rose-950/40 dark:via-zinc-950 dark:to-rose-950/30 dark:text-zinc-400">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allPageSelected}
                          onChange={togglePage}
                          disabled={pageActionable.length === 0}
                          aria-label="Select all pending on this page"
                          className="h-4 w-4 cursor-pointer accent-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </th>
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Personal email</th>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold">Reason</th>
                      <th className="px-4 py-3 font-semibold">Requested by</th>
                      <th className="px-4 py-3 font-semibold">Requested</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rose-100/70 bg-white/85 dark:divide-rose-900/35 dark:bg-zinc-950/40">
                    {queuePageRows.map((r) => {
                      const actionable = isActionable(r);
                      const statusPill = (() => {
                        switch (r.status) {
                          case 'pending': return { label: 'Pending', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
                          case 'processing': return { label: 'Processing', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' };
                          case 'completed': return { label: 'Offboarded', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' };
                          case 'dismissed': return { label: 'Dismissed', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300' };
                          case 'returned': return { label: 'Returned to manager', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
                          default: return { label: 'Cancelled', cls: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' };
                        }
                      })();
                      return (
                        <tr key={r.id} className={cn(
                          'align-middle hover:bg-rose-50/30 dark:hover:bg-rose-950/20',
                          selectedIds.has(r.id) && 'bg-rose-50/70 dark:bg-rose-950/30',
                        )}>
                          <td data-label="Select" className="w-10 px-3 py-4">
                            {actionable ? (
                              <input
                                type="checkbox"
                                checked={selectedIds.has(r.id)}
                                onChange={() => toggleRow(r.id)}
                                aria-label={`Select ${r.employee_name ?? r.employee_email}`}
                                className="h-4 w-4 cursor-pointer accent-rose-600"
                              />
                            ) : null}
                          </td>
                          <td data-label="Employee" className="px-4 py-4">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.employee_name ?? '—'}</div>
                            <div className="break-all font-mono text-[11px] text-zinc-500">{r.employee_work_email ?? r.employee_email}</div>
                          </td>
                          <td data-label="Personal email" className="break-all px-4 py-4 font-mono text-[11px] text-zinc-500">{r.employee_personal_email ?? '—'}</td>
                          <td data-label="Department" className="px-4 py-4 text-xs text-zinc-700 dark:text-zinc-300">{r.department ?? '—'}</td>
                          <td data-label="Reason" className="px-4 py-4">
                            <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                              {REASON_LABELS[r.reason] ?? r.reason}
                            </span>
                            {r.note && (
                              <p className="mt-0.5 max-w-[200px] truncate text-[11px] text-zinc-500" title={r.note}>{r.note}</p>
                            )}
                          </td>
                          <td data-label="Requested by" className="px-4 py-4 font-mono text-[11px] text-zinc-500">{r.requested_by_name ?? r.requested_by}</td>
                          <td data-label="Requested" className="px-4 py-4 text-xs text-zinc-600 dark:text-zinc-400">
                            {r.created_at ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                          </td>
                          <td data-label="Status" className="px-4 py-4">
                            <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium', statusPill.cls)}>
                              {statusPill.label}
                            </span>
                            {(r.status === 'dismissed' || r.status === 'returned') && r.processed_note && (
                              <p className="mt-0.5 max-w-[160px] truncate text-[10px] text-zinc-500" title={r.processed_note}>{r.processed_note}</p>
                            )}
                          </td>
                          <td data-label="Action" className="px-4 py-4">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              {actionable ? (
                                <>
                                  <Button size="sm" variant="outline" onClick={() => setReturnTarget(r)}
                                    title="Send this request back to the manager for revision"
                                    className="h-7 gap-1 border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:border-amber-700/50 dark:text-amber-300 dark:hover:bg-amber-950/30">
                                    <Undo2 className="h-3 w-3" /> Return
                                  </Button>
                                  <Button size="sm" onClick={() => setProcessTargets([r])}
                                    title="Off-board this person (triggers the account-teardown automation)"
                                    className="h-7 gap-1 bg-rose-600 text-white hover:bg-rose-700">
                                    <UserMinus className="h-3 w-3" /> Process
                                  </Button>
                                </>
                              ) : (
                                <span className="text-[11px] text-zinc-400">
                                  {r.processed_by ? `by ${r.processed_by}` : '—'}
                                </span>
                              )}
                              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(r)}
                                title="Permanently remove this request from the queue"
                                className="h-7 gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/30">
                                <Trash2 className="h-3 w-3" /> Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <PaginationBar page={safeQueuePage} totalPages={queueTotalPages} setPage={setQueuePage} total={queueOpenTotal} filtered={filteredQueue.length} pageSize={QUEUE_PAGE_SIZE} />
              </div>
            )
          ) : activeTab === 'hris' ? (
            /* ── Offboarded by HRIS (completed queue rows) ── */
            queueLoading ? (
              <div className="flex items-center justify-center py-10 text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filteredHris.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rose-200/80 bg-white/70 py-10 text-center dark:border-rose-900/50 dark:bg-zinc-950/40">
                <UserX className="h-8 w-8 text-rose-300 dark:text-rose-700" />
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {hrisOffboarded.length === 0 ? 'No one has been offboarded through the queue yet.' : 'No rows match your search.'}
                </p>
                <p className="max-w-md text-xs text-zinc-400">
                  People you <span className="font-medium">Process</span> from the Queue land here once offboarded.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-rose-100/90 ring-1 ring-rose-500/10 dark:border-rose-900/60 dark:ring-rose-400/10">
                <table className="w-full text-left text-sm sm:min-w-[900px]">
                  <thead className="sticky top-0 z-[1] bg-gradient-to-r from-rose-50 via-white to-rose-50/80 text-xs text-zinc-600 dark:from-rose-950/40 dark:via-zinc-950 dark:to-rose-950/30 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Employee</th>
                      <th className="px-4 py-3 font-semibold">Personal email</th>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold">Reason</th>
                      <th className="px-4 py-3 font-semibold">Offboarded</th>
                      <th className="px-4 py-3 font-semibold">By</th>
                      <th className="px-4 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rose-100/70 bg-white/85 dark:divide-rose-900/35 dark:bg-zinc-950/40">
                    {hrisPageRows.map((r) => {
                      const reasonKey = r.offboard_reason ?? r.reason;
                      return (
                        <tr key={r.id} className="align-middle hover:bg-rose-50/30 dark:hover:bg-rose-950/20">
                          <td data-label="Employee" className="px-4 py-4">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.employee_name ?? '—'}</div>
                            <div className="break-all font-mono text-[11px] text-zinc-500">{r.employee_work_email ?? r.employee_email}</div>
                          </td>
                          <td data-label="Personal email" className="break-all px-4 py-4 font-mono text-[11px] text-zinc-500">{r.employee_personal_email ?? '—'}</td>
                          <td data-label="Department" className="px-4 py-4 text-xs text-zinc-700 dark:text-zinc-300">{r.department ?? '—'}</td>
                          <td data-label="Reason" className="px-4 py-4">
                            {reasonKey ? (
                              <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                                {REASON_LABELS[reasonKey] ?? reasonKey}
                              </span>
                            ) : '—'}
                            {r.processed_note && (
                              <p className="mt-0.5 max-w-[200px] truncate text-[11px] text-zinc-500" title={r.processed_note}>{r.processed_note}</p>
                            )}
                          </td>
                          <td data-label="Offboarded" className="px-4 py-4 text-xs text-zinc-600 dark:text-zinc-400">
                            {r.decided_at ? new Date(r.decided_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
                          </td>
                          <td data-label="By" className="px-4 py-4 font-mono text-xs text-zinc-500 dark:text-zinc-500">{r.processed_by ?? '—'}</td>
                          <td data-label="Action" className="px-4 py-4">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(r)}
                                title="Permanently remove this record from the queue"
                                className="h-7 gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/30">
                                <Trash2 className="h-3 w-3" /> Delete
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <PaginationBar page={safeHrisPage} totalPages={hrisTotalPages} setPage={setHrisPage} total={hrisOffboarded.length} filtered={filteredHris.length} />
              </div>
            )
          ) : (
            /* ── Offboarded ── */
            historyLoading ? (
              <div className="flex items-center justify-center py-10 text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filteredHistory.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
                <Clock className="h-8 w-8 text-zinc-300 dark:text-zinc-600" />
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {history.length === 0 ? 'No off-boarded employees yet.' : 'No rows match your search.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
                <table className="w-full text-left text-sm sm:min-w-[800px]">
                  <thead className="sticky top-0 z-[1] bg-gradient-to-r from-zinc-50 via-white to-zinc-50/80 text-xs text-zinc-600 dark:from-zinc-900/70 dark:via-zinc-950 dark:to-zinc-900/50 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Work email</th>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold">Reason</th>
                      <th className="px-4 py-3 font-semibold">Off-boarded</th>
                      <th className="px-4 py-3 font-semibold">By</th>
                      <th className="px-4 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100/80 bg-white/85 dark:divide-zinc-800/50 dark:bg-zinc-950/40">
                    {historyPageRows.map((r) => {
                      const email = r['Work Email'] ?? '';
                      const isRestoring = restoring === email;
                      const isRemovingFromSheet = removingFromSheet === email;
                      const anyBusy = isRestoring || isRemovingFromSheet;
                      return (
                        <tr key={r.id} className="align-middle hover:bg-zinc-50/60 dark:hover:bg-zinc-900/30">
                          <td data-label="Name" className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">{r.Name ?? '—'}</td>
                          <td data-label="Work email" className="break-all px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{email || '—'}</td>
                          <td data-label="Department" className="px-4 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">{r.Department ?? '—'}</td>
                          <td data-label="Reason" className="px-4 py-2.5">
                            {r.off_boarded_reason ? (
                              <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                                {REASON_LABELS[r.off_boarded_reason] ?? r.off_boarded_reason}
                              </span>
                            ) : '—'}
                            {r.off_boarded_note && (
                              <p className="mt-0.5 max-w-[180px] truncate text-[11px] text-zinc-500" title={r.off_boarded_note}>{r.off_boarded_note}</p>
                            )}
                          </td>
                          <td data-label="Off-boarded" className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                            {r.off_boarded_at ? new Date(r.off_boarded_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—'}
                          </td>
                          <td data-label="By" className="px-4 py-2.5 font-mono text-xs text-zinc-500 dark:text-zinc-500">{r.off_boarded_by ?? '—'}</td>
                          <td data-label="Action" className="px-4 py-2.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button size="sm" variant="outline" onClick={() => void handleRestore(r)} disabled={anyBusy || !email}
                                className="h-7 gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                                {isRestoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                Restore
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => void handleRemoveFromSheet(r)} disabled={anyBusy || !email}
                                title="Delete from the Google Sheet Offboarded tab so the next sync won't re-add them to this list"
                                className="h-7 gap-1 border-orange-300 text-orange-700 hover:bg-orange-50 hover:text-orange-800 disabled:opacity-50 dark:border-orange-700/50 dark:text-orange-300 dark:hover:bg-orange-950/30">
                                {isRemovingFromSheet ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileX className="h-3 w-3" />}
                                Remove from Sheet
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <PaginationBar page={safeHistoryPage} totalPages={historyTotalPages} setPage={setHistoryPage} total={history.length} filtered={filteredHistory.length} />
              </div>
            )
          )}
            </motion.div>
          </AnimatePresence>
        </CardContent>
      </Card>

      <HrOffboardQueueProcessor
        open={!!processTargets && processTargets.length > 0}
        items={processTargets ?? []}
        onOpenChange={(o) => { if (!o) setProcessTargets(null); }}
        onFinished={() => {
          void fetchQueue();
          void fetchHistory();
        }}
      />

      <OffboardReturnDialog
        target={returnTarget}
        onClose={() => setReturnTarget(null)}
        onSuccess={() => {
          setReturnTarget(null);
          void fetchQueue();
        }}
      />

      <OffboardQueueDeleteDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onSuccess={() => {
          setDeleteTarget(null);
          void fetchQueue();
        }}
      />
    </div>
  );
}

/** Quick "send back to manager" dialog for a single queued request. */
function OffboardReturnDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: OffboardingQueueRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const open = !!target;

  useEffect(() => {
    setReason('');
  }, [target?.id]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target || !reason.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/offboarding-queue/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'returned', note: reason.trim() }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to return request');
      toast.success(`Sent ${target.employee_name ?? target.employee_email} back to ${target.requested_by_name ?? target.requested_by}`, {
        description: 'The manager is notified and can revise & re-queue.',
      });
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to return request');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-[440px]">
        <div className="relative overflow-hidden bg-[#1a1206] px-5 pb-4 pt-5">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-amber-700 via-amber-400 to-amber-700" />
          <div className="relative flex items-start gap-3.5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-900/50 text-amber-200 ring-1 ring-amber-700/50">
              <Undo2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-500/80">
                Return to manager
              </p>
              <p className="mt-0.5 truncate text-[15px] font-semibold leading-snug text-zinc-100">
                {target?.employee_name ?? target?.employee_work_email ?? target?.employee_email ?? '—'}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                back to {target?.requested_by_name ?? target?.requested_by}
              </p>
            </div>
          </div>
          <p className="relative mt-3 text-[11px] leading-relaxed text-zinc-500">
            The request is sent back for revision (not offboarded). The manager is notified with your
            note and can adjust the reason and re-queue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 bg-zinc-950/60 p-5">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Reason for returning<span className="text-amber-500">*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder="What should the manager fix or reconsider?"
              className="w-full resize-none rounded-lg border border-amber-900/50 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 transition-colors focus:border-amber-600 focus:outline-none"
            />
          </div>
          <div className="flex gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-200"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!reason.trim() || submitting}
              className="flex-1 gap-1.5 border-0 bg-amber-600 text-white hover:bg-amber-500 disabled:bg-zinc-800 disabled:text-zinc-600"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
              {submitting ? 'Sending…' : 'Send back'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Confirm dialog for permanently removing a single queue row (HR cleanup). */
function OffboardQueueDeleteDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: OffboardingQueueRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const open = !!target;
  const isPending = target?.status === 'pending' || target?.status === 'processing';

  async function handleDelete() {
    if (!target || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/offboarding-queue/${target.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to delete request');
      toast.success(
        `Removed ${target.employee_name ?? target.employee_work_email ?? target.employee_email} from the queue`,
      );
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete request');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-[440px]">
        <div className="relative overflow-hidden bg-[#1a0a0a] px-5 pb-4 pt-5">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-rose-700 via-rose-400 to-rose-700" />
          <div className="relative flex items-start gap-3.5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-900/50 text-rose-200 ring-1 ring-rose-700/50">
              <Trash2 className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-500/80">
                Delete request
              </p>
              <p className="mt-0.5 truncate text-[15px] font-semibold leading-snug text-zinc-100">
                {target?.employee_name ?? target?.employee_work_email ?? target?.employee_email ?? '—'}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                requested by {target?.requested_by_name ?? target?.requested_by}
              </p>
            </div>
          </div>
          <p className="relative mt-3 text-[11px] leading-relaxed text-zinc-500">
            This permanently removes the request from the queue and cannot be undone. It does
            not off-board anyone
            {isPending
              ? " — and the manager isn't notified, so use Return or Process instead if this person still needs handling."
              : '.'}
          </p>
        </div>

        <div className="flex gap-2 bg-zinc-950/60 p-5">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 border-zinc-800 bg-transparent text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/50 hover:text-zinc-200"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleDelete()}
            disabled={submitting}
            className="flex-1 gap-1.5 border-0 bg-rose-700 text-white hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600"
          >
            {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {submitting ? 'Deleting…' : 'Delete request'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
