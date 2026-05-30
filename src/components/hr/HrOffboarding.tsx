'use client';

import React, { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  UserMinus,
  UserX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';
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

type OffboardReason =
  | 'resigned'
  | 'performance'
  | 'time_manipulation'
  | 'attendance'
  | 'end_of_contract'
  | 'other';

const REASON_OPTIONS: { value: OffboardReason; label: string }[] = [
  { value: 'resigned', label: 'Resigned' },
  { value: 'end_of_contract', label: 'End of contract' },
  { value: 'performance', label: 'Performance' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'time_manipulation', label: 'Time manipulation' },
  { value: 'other', label: 'Other (note required)' },
];

const PAGE_SIZE = 10;

function PaginationBar({
  page, totalPages, setPage, total, filtered,
}: {
  page: number; totalPages: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  total: number; filtered: number;
}) {
  return (
    <div className="flex items-center justify-between border-t border-emerald-100/60 px-4 py-2.5 dark:border-emerald-900/40">
      <p className="text-[11px] text-zinc-400">
        {filtered === 0 ? '0' : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, filtered)}`} of {filtered}
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

type OffboardTab = 'active' | 'offboarded';

export default function HrOffboarding() {
  const [activeTab, setActiveTab] = useState<OffboardTab>('active');

  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [rosterDept, setRosterDept] = useState('');
  const [rosterPage, setRosterPage] = useState(0);
  const [target, setTarget] = useState<EmployeeRow | null>(null);

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historySearch, setHistorySearch] = useState('');
  const [historyDept, setHistoryDept] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [restoring, setRestoring] = useState<string | null>(null);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as {
        employees?: EmployeeRow[];
        error?: string;
      };
      if (json.error) throw new Error(json.error);
      setRoster(json.employees ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load roster');
      setRoster([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/hr/offboard-history', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: HistoryRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setHistory(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load offboard history');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
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
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to restore');
      toast.success(`${row.Name ?? email} restored to active roster`);
      await Promise.all([fetchRoster(), fetchHistory()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to restore');
    } finally {
      setRestoring(null);
    }
  }, [fetchRoster, fetchHistory]);

  useEffect(() => {
    void fetchRoster();
    void fetchHistory();
  }, [fetchRoster, fetchHistory]);

  const filtered = useMemo(() => {
    setRosterPage(0);
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (rosterDept && (r.department ?? '').trim() !== rosterDept) return false;
      if (!q) return true;
      return [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [roster, search, rosterDept]);

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

  const rosterTotalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeRosterPage = Math.min(rosterPage, rosterTotalPages - 1);
  const rosterPageRows = filtered.slice(safeRosterPage * PAGE_SIZE, (safeRosterPage + 1) * PAGE_SIZE);

  const historyTotalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, historyTotalPages - 1);
  const historyPageRows = filteredHistory.slice(safeHistoryPage * PAGE_SIZE, (safeHistoryPage + 1) * PAGE_SIZE);

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
            Find an employee, click <span className="font-semibold">Offboard</span>,
            pick a reason. Their record is retained for reporting; they drop from
            payroll and manager dashboards immediately.
          </p>
        </div>
      </header>

      {/* Main card with tabs */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-3 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          {/* Tab switcher + search + refresh */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Tabs */}
            <div className="flex items-center gap-1 rounded-lg border border-emerald-100/80 bg-emerald-50/60 p-1 dark:border-emerald-900/50 dark:bg-emerald-950/30">
              <button
                type="button"
                onClick={() => setActiveTab('active')}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  activeTab === 'active' ? 'text-white' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                {activeTab === 'active' && (
                  <motion.span
                    layoutId="offboardTabPill"
                    className="absolute inset-0 rounded-md bg-gradient-to-r from-emerald-500 to-teal-700 shadow-sm"
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative flex items-center gap-1.5">
                  <UserX className="h-3.5 w-3.5" />
                  Active employees
                  <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', activeTab === 'active' ? 'bg-white/20' : 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300')}>
                    {roster.length}
                  </span>
                </span>
              </button>
              <button
                type="button"
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
                {activeTab === 'active' ? (
                  <>
                    <div className="relative w-full sm:w-64">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email…" className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900" />
                    </div>
                    <DeptFilter rows={roster} getDept={(r) => r.department} value={rosterDept} onChange={setRosterDept} />
                    <Button variant="outline" size="sm" onClick={() => void fetchRoster()} disabled={loading} className="shrink-0">
                      <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
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
            {activeTab === 'active'
              ? loading ? 'Loading roster…' : `${filtered.length} of ${roster.length} shown`
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
          {activeTab === 'active' ? (
            /* ── Active employees ── */
            loading ? (
              <div className="flex items-center justify-center py-10 text-zinc-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
                <UserX className="h-8 w-8 text-emerald-400/60" />
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {roster.length === 0 ? 'No active employees on file.' : 'No rows match your search.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
                <table className="w-full text-left text-sm sm:min-w-[720px]">
                  <thead className="sticky top-0 z-[1] bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Employee ID</th>
                      <th className="px-4 py-3 font-semibold">Name</th>
                      <th className="px-4 py-3 font-semibold">Department</th>
                      <th className="px-4 py-3 font-semibold">Work email</th>
                      <th className="px-4 py-3 font-semibold">Start</th>
                      <th className="px-4 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                    {rosterPageRows.map((r, i) => (
                      <tr key={`${r.employee_id ?? r.work_email ?? r.personal_email ?? 'row'}-${i}`} className="align-middle hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20">
                        <td data-label="Employee ID" className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">{r.employee_id ?? '—'}</td>
                        <td data-label="Name" className="px-4 py-2.5 text-zinc-900 dark:text-zinc-100">{r.name ?? '—'}</td>
                        <td data-label="Department" className="px-4 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">{r.department ?? '—'}</td>
                        <td data-label="Work email" className="break-all px-4 py-2.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">{r.work_email ?? '—'}</td>
                        <td data-label="Start" className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">{r.start_date ?? '—'}</td>
                        <td data-label="Action" className="px-4 py-2.5 text-right">
                          <Button size="sm" variant="outline" onClick={() => setTarget(r)} disabled={!r.work_email}
                            className="h-7 gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 disabled:opacity-50 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                            title={r.work_email ? `Off-board ${r.name ?? r.work_email}` : 'No work email — cannot off-board'}>
                            <UserMinus className="h-3 w-3" /> Offboard
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <PaginationBar page={safeRosterPage} totalPages={rosterTotalPages} setPage={setRosterPage} total={roster.length} filtered={filtered.length} />
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
                          <td data-label="Action" className="px-4 py-2.5 text-right">
                            <Button size="sm" variant="outline" onClick={() => void handleRestore(r)} disabled={isRestoring || !email}
                              className="h-7 gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                              {isRestoring ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                              Restore
                            </Button>
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

      <OffboardConfirmDialog
        target={target}
        onClose={() => setTarget(null)}
        onSuccess={() => {
          setTarget(null);
          void fetchRoster();
          void fetchHistory();
        }}
      />
    </div>
  );
}

function OffboardConfirmDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: EmployeeRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState<OffboardReason | ''>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the target changes (incl. close).
  useEffect(() => {
    setReason('');
    setNote('');
  }, [target?.work_email]);

  const open = !!target;
  const noteRequired = reason === 'other';
  const isValid = reason && (!noteRequired || note.trim().length > 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target?.work_email || !isValid) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/hr/offboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: target.work_email,
          reason,
          note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        webhook?: { fired: boolean; status: number | null; error: string | null };
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Failed to off-board');
      }
      const webhookOk = json.webhook?.error == null && json.webhook?.fired;
      if (webhookOk) {
        toast.success(`${target.name ?? target.work_email} off-boarded`, {
          description:
            'Removed from active rosters. Account-deactivation workflow triggered.',
        });
      } else {
        // DB update committed; only the n8n webhook hiccupped. Surface that
        // explicitly so HR knows the @simple.biz account may not be deactivated
        // yet and can re-fire / call Drew if needed.
        toast.warning(`${target.name ?? target.work_email} off-boarded — but workflow didn't fire`, {
          description: `Roster updated, but the offboarding webhook returned: ${json.webhook?.error ?? 'unknown error'}. Their account may still be active — re-run when n8n is available.`,
          duration: 8000,
        });
      }
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to off-board');
    } finally {
      setSubmitting(false);
    }
  }

  const initials = target?.name
    ? target.name.split(/[\s,]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
    : (target?.work_email?.[0]?.toUpperCase() ?? '?');

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 sm:max-w-[460px]"
      >
        {/* ── Header ── */}
        <div className="relative overflow-hidden bg-[#1a0a0a] px-5 pb-5 pt-5">
          {/* subtle grid texture */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(rgba(220,38,38,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(220,38,38,0.06) 1px, transparent 1px)',
              backgroundSize: '24px 24px',
            }}
          />
          {/* top accent bar */}
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-rose-700 via-rose-400 to-rose-700" />

          <div className="relative flex items-start gap-3.5">
            {/* initials badge */}
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-900/60 text-sm font-bold tracking-wider text-rose-200 ring-1 ring-rose-700/50">
              {initials}
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-rose-500/80">
                Offboard employee
              </p>
              <p className="mt-0.5 truncate text-[15px] font-semibold leading-snug text-zinc-100">
                {target?.name ?? target?.work_email ?? '—'}
              </p>
              {target?.name && target?.work_email && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                  {target.work_email}
                </p>
              )}
              {target?.department && (
                <span className="mt-1.5 inline-block rounded-full bg-zinc-800/80 px-2 py-0.5 text-[10px] font-medium text-zinc-400 ring-1 ring-zinc-700/50">
                  {target.department}
                </span>
              )}
            </div>

            {/* close button */}
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="mt-0.5 shrink-0 rounded-md p-1 text-zinc-600 transition-colors hover:bg-zinc-800/60 hover:text-zinc-300 disabled:opacity-40"
              aria-label="Close"
            >
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>

          <p className="relative mt-3.5 text-[11px] leading-relaxed text-zinc-500">
            This employee will be removed from active rosters. Their record is
            retained for reporting and auditing purposes.
          </p>
        </div>

        {/* ── Form ── */}
        <form onSubmit={handleSubmit} noValidate className="space-y-3.5 bg-zinc-950/60 p-5">
          {/* Reason */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Reason
              <span className="text-rose-500">*</span>
            </label>
            <Select
              value={reason}
              onValueChange={(v) => v && setReason(v as OffboardReason)}
            >
              <SelectTrigger
                className={cn(
                  'w-full border-zinc-800 bg-zinc-900/80 text-sm text-zinc-200',
                  'data-placeholder:text-zinc-600',
                  'hover:border-zinc-700 hover:bg-zinc-900',
                  'focus-visible:border-rose-700/60 focus-visible:ring-rose-700/20',
                  'data-[size=default]:h-9',
                )}
              >
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent
                side="bottom"
                alignItemWithTrigger={false}
                className="border-zinc-800 bg-zinc-900 duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
              >
                {REASON_OPTIONS.map((r) => (
                  <SelectItem
                    key={r.value}
                    value={r.value}
                    className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100"
                  >
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Note */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
              Note
              {noteRequired && <span className="text-rose-500">*</span>}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={
                noteRequired
                  ? 'Required — describe the situation'
                  : 'Optional — anything HR should remember'
              }
              className={cn(
                'w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2',
                'text-sm text-zinc-200 placeholder:text-zinc-600',
                'transition-colors focus:border-zinc-600 focus:bg-zinc-900 focus:outline-none',
              )}
            />
          </div>

          {/* Actions */}
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
              disabled={!isValid || submitting}
              className={cn(
                'flex-1 gap-1.5 border-0 bg-rose-700 text-white',
                'hover:bg-rose-600 disabled:bg-zinc-800 disabled:text-zinc-600',
                'transition-all',
              )}
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserMinus className="h-3.5 w-3.5" />
              )}
              {submitting ? 'Off-boarding...' : 'Confirm offboard'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
