'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  HeartHandshake,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  Search,
  Inbox,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Undo2,
  Trash2,
  ClipboardList,
  Wallet,
  PiggyBank,
  Building2,
  Eye,
  CalendarClock,
  ArrowDownCircle,
  ArrowUpCircle,
  Users,
  UserPlus,
  UserMinus,
  StickyNote,
} from 'lucide-react';
import { motion } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { clearTabCache, getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import type { MesaLedgerEvent, MesaMemberSummary } from '@/lib/mesa/ledger';
import type { EmployeeRow } from '@/lib/supabase/employees';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';

type MesaView = 'requests' | 'all-members' | 'active-members';

/** Peso, two decimals — follows the app-wide money convention. */
const formatPHP = (n: number) =>
  `₱${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type MesaRequestType = 'opt_in' | 'opt_out' | 'disbursement' | 'return';
export type MesaRequestStatus = 'pending' | 'approved' | 'denied';

interface MesaRequest {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  request_type: MesaRequestType;
  fpu_date: string | null;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  status: MesaRequestStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  dispatched_at: string | null;
  created_at: string;
}

interface MesaNote {
  id: string;
  member_email: string;
  body: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
}

const PAGE_SIZE = 15;

const TYPE_LABELS: Record<MesaRequestType, string> = {
  opt_in: 'Opt-in',
  opt_out: 'Opt-out',
  disbursement: 'Disbursement',
  return: 'Return',
};

const TYPE_COLORS: Record<MesaRequestType, string> = {
  opt_in: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200',
  opt_out: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300',
  disbursement: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  return: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/40 dark:bg-violet-500/15 dark:text-violet-200',
};

export default function AccountingMesa() {
  const [view, setView] = useState<MesaView>('requests');
  const [rows, setRows] = useState<MesaRequest[]>(
    () => getTabCache<MesaRequest[]>(TAB_CACHE_KEYS.mesaRequests) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaRequests));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<MesaRequestStatus | ''>('');
  const [filterType, setFilterType] = useState<MesaRequestType | ''>('');
  const [page, setPage] = useState(0);
  const [reviewTarget, setReviewTarget] = useState<MesaRequest | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MesaRequest | null>(null);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      // Accounting only handles money-related requests.
      // Opt-in requests are routed to HR.
      const params = new URLSearchParams();
      ['opt_out', 'disbursement', 'return'].forEach((t) => params.append('request_type', t));
      const res = await fetch(`/api/mesa-requests?${params}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: MesaRequest[] };
      const data = (json.rows ?? []).filter(
        (r) => r.request_type === 'opt_out' || r.request_type === 'disbursement' || r.request_type === 'return',
      );
      setTabCache(TAB_CACHE_KEYS.mesaRequests, data);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load MESA requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // Revalidate on every mount, but only show the full spinner when there's
    // no cached data to paint — a warm cache refreshes quietly in the
    // background so switching back to this tab feels instant.
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaRequests));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterStatus && r.status !== filterStatus) return false;
      if (filterType && r.request_type !== filterType) return false;
      if (q) {
        return (
          r.work_email.toLowerCase().includes(q) ||
          r.full_name.toLowerCase().includes(q) ||
          r.department.toLowerCase().includes(q) ||
          (r.disbursement_reason ?? '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rows, query, filterStatus, filterType]);

  useEffect(() => { setPage(0); }, [query, filterStatus, filterType]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const stats = useMemo(() => ({
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    denied: rows.filter((r) => r.status === 'denied').length,
  }), [rows]);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaRequests);
    await load(false);
    toast.success('Refreshed MESA requests');
  };

  const openReview = (r: MesaRequest) => {
    setReviewTarget(r);
    setReviewNotes('');
  };

  const submitReview = async (status: 'approved' | 'denied') => {
    if (!reviewTarget) return;
    setReviewing(true);
    try {
      const res = await fetch(`/api/mesa-requests/${reviewTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, review_notes: reviewNotes.trim() || null }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      // On an approved opt-out, unenroll the member so the Payroll Wizard MESA
      // column stops applying the -PHP100 deduction. (Disbursement/return keep
      // the member enrolled — those withdraw/return funds, not membership.)
      if (status === 'approved' && reviewTarget.request_type === 'opt_out') {
        try {
          await fetch('/api/toggle-mesa-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workEmail: reviewTarget.work_email,
              mesaMember: false,
              name: reviewTarget.full_name,
            }),
          });
        } catch {
          toast.error('Approved, but could not auto-unenroll from MESA — please toggle manually in Rates.');
        }
      }
      toast.success(`Request ${status}`);
      setReviewTarget(null);
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewing(false);
    }
  };

  // Revoke a prior decision — reverts the request to pending. For a previously
  // approved opt-out, re-enroll the member so the MESA -PHP100 deduction resumes.
  const revokeRequest = async (r: MesaRequest) => {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/mesa-requests/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      if (r.status === 'approved' && r.request_type === 'opt_out') {
        try {
          await fetch('/api/toggle-mesa-member', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workEmail: r.work_email, mesaMember: true, name: r.full_name }),
          });
        } catch {
          toast.error('Revoked, but could not re-enroll in MESA — please toggle manually in Rates.');
        }
      }
      toast.success('Decision revoked — request is pending again');
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Revoke failed');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      const res = await fetch(`/api/mesa-requests/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success('Request deleted');
      setDeleteTarget(null);
      clearTabCache(TAB_CACHE_KEYS.mesaRequests);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/30 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-6xl space-y-5">

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-100 to-emerald-100 text-teal-700 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
            <HeartHandshake className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
              Medical Emergency Savings Account
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              MESA — Disbursements &amp; Changes
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              {view === 'requests'
                ? 'Opt-out, disbursement, and return requests submitted by members. Opt-in requests are handled by HR.'
                : view === 'all-members'
                ? 'Every current employee, with a temporary manual Opt In / Opt Out until members self-serve from the Employee Dashboard.'
                : 'Employees currently enrolled in MESA, with their contribution, match, and balance to date.'}
            </p>
          </div>
        </div>

        {/* View switcher */}
        <div
          role="tablist"
          aria-label="MESA sections"
          className="relative inline-flex items-center gap-1 self-start rounded-lg border border-teal-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-teal-900/40 dark:bg-zinc-900/60"
        >
          <ViewTabButton active={view === 'requests'} onClick={() => setView('requests')} icon={ClipboardList} label="Requests" />
          <ViewTabButton active={view === 'all-members'} onClick={() => setView('all-members')} icon={Users} label="All Members" />
          <ViewTabButton active={view === 'active-members'} onClick={() => setView('active-members')} icon={Wallet} label="MESA Active Members" />
        </div>

        {view === 'all-members' ? (
          <MesaAllMembers />
        ) : view === 'active-members' ? (
          <MesaActiveMembers />
        ) : (
        <>
        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Total" value={stats.total} tone="zinc" />
          <StatCard label="Pending" value={stats.pending} tone="amber" />
          <StatCard label="Approved" value={stats.approved} tone="teal" />
          <StatCard label="Denied" value={stats.denied} tone="rose" />
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email, department..."
              className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-zinc-400" />
            <SmoothSelect
              aria-label="Filter by status"
              value={filterStatus}
              onChange={(v) => setFilterStatus(v as MesaRequestStatus | '')}
              triggerClassName="w-36"
              options={[
                { value: '', label: 'All statuses' },
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'denied', label: 'Denied' },
              ]}
            />
            <SmoothSelect
              aria-label="Filter by type"
              value={filterType}
              onChange={(v) => setFilterType(v as MesaRequestType | '')}
              triggerClassName="w-36"
              options={[
                { value: '', label: 'All types' },
                { value: 'opt_out', label: 'Opt-out' },
                { value: 'disbursement', label: 'Disbursement' },
                { value: 'return', label: 'Return' },
              ]}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || loading}
            className="gap-1.5"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {/* Table */}
        <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
          <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
            <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
              {loading ? 'Loading...' : `${filtered.length} request${filtered.length === 1 ? '' : 's'}`}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <SkeletonRows count={6} />
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                <Inbox className="h-6 w-6 text-zinc-400" />
                {rows.length === 0 ? 'No MESA requests yet.' : 'No results match your filters.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                    <tr>
                      <th className="px-4 py-2.5">Employee</th>
                      <th className="px-4 py-2.5">Department</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Details</th>
                      <th className="px-4 py-2.5 text-right">Amount</th>
                      <th className="px-4 py-2.5 text-right">Status</th>
                      <th className="px-4 py-2.5 text-right">Submitted</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                    {pageRows.map((r) => (
                      <tr
                        key={r.id}
                        className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20"
                      >
                        <td className="px-4 py-3" data-label="Employee">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.full_name}</div>
                          <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                            {r.work_email}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                          {r.department}
                        </td>
                        <td className="px-4 py-3" data-label="Type">
                          <Badge
                            variant="outline"
                            className={cn('text-[10.5px] font-semibold uppercase tracking-wide', TYPE_COLORS[r.request_type])}
                          >
                            {TYPE_LABELS[r.request_type]}
                          </Badge>
                        </td>
                        <td className="max-w-[180px] px-4 py-3" data-label="Details">
                          {r.request_type === 'opt_in' && r.fpu_date && (
                            <span className="text-zinc-600 dark:text-zinc-400">FPU: {r.fpu_date}</span>
                          )}
                          {r.request_type === 'disbursement' && (
                            <div>
                              <div className="font-medium text-zinc-700 dark:text-zinc-300">{r.disbursement_reason}</div>
                              {r.explanation && (
                                <div className="mt-0.5 line-clamp-2 text-zinc-500 dark:text-zinc-500">
                                  {r.explanation}
                                </div>
                              )}
                            </div>
                          )}
                          {r.request_type === 'return' && r.explanation && (
                            <span className="line-clamp-2 text-zinc-500 dark:text-zinc-500">{r.explanation}</span>
                          )}
                          {(r.request_type === 'opt_out' || (!r.fpu_date && !r.disbursement_reason && !r.explanation)) && (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-zinc-700 dark:text-zinc-300" data-label="Amount">
                          {r.amount_needed != null
                            ? `PHP ${r.amount_needed.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right" data-label="Status">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-500" data-label="Submitted">
                          {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 text-right" data-label="Action">
                          {r.status === 'pending' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => openReview(r)}
                                className="h-7 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                              >
                                Review
                              </Button>
                              <button
                                type="button"
                                title="Delete request"
                                disabled={busyId === r.id}
                                onClick={() => setDeleteTarget(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40 dark:border-zinc-700 dark:hover:border-rose-700/50 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-[11px] text-zinc-400">
                                {r.reviewed_by ? `by ${r.reviewed_by.split('@')[0]}` : '—'}
                              </span>
                              <button
                                type="button"
                                title={r.dispatched_at ? 'Already paid out — cannot revoke' : 'Revoke decision (back to pending)'}
                                disabled={busyId === r.id || !!r.dispatched_at}
                                onClick={() => revokeRequest(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700 dark:hover:border-amber-700/50 dark:hover:bg-amber-950/30 dark:hover:text-amber-400"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title={r.dispatched_at ? 'Already paid out — cannot delete' : 'Delete request'}
                                disabled={busyId === r.id || !!r.dispatched_at}
                                onClick={() => setDeleteTarget(r)}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 text-zinc-400 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30 dark:border-zinc-700 dark:hover:border-rose-700/50 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && filtered.length > PAGE_SIZE && (
              <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
                <p className="text-[11px] text-zinc-400">
                  {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of{' '}
                  {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        </>
        )}
      </div>

      {/* Review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                  {TYPE_LABELS[reviewTarget.request_type]} Request
                </p>
                <h3 className="mt-0.5 text-base font-bold text-zinc-900 dark:text-white">
                  Review — {reviewTarget.full_name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReviewTarget(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <InfoRow label="Email" value={reviewTarget.work_email} />
              <InfoRow label="Department" value={reviewTarget.department} />
              {reviewTarget.fpu_date && <InfoRow label="FPU Completed" value={reviewTarget.fpu_date} />}
              {reviewTarget.disbursement_reason && <InfoRow label="Reason" value={reviewTarget.disbursement_reason} />}
              {reviewTarget.explanation && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Explanation</p>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{reviewTarget.explanation}</p>
                </div>
              )}
              {reviewTarget.amount_needed != null && (
                <InfoRow
                  label="Amount Requested"
                  value={`PHP ${reviewTarget.amount_needed.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                />
              )}
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Review Notes (optional)
                </label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  rows={3}
                  placeholder="Add a note for the employee..."
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setReviewTarget(null)}
                disabled={reviewing}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={reviewing}
                onClick={() => submitReview('denied')}
                className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                variant="outline"
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Deny
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={reviewing}
                onClick={() => submitReview('approved')}
                className="bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                Approve
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-start gap-3 px-5 py-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">Delete this request?</h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {TYPE_LABELS[deleteTarget.request_type]} request from{' '}
                  <span className="font-medium text-zinc-800 dark:text-zinc-200">{deleteTarget.full_name}</span>.
                  This permanently removes it and cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
                disabled={busyId === deleteTarget.id}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busyId === deleteTarget.id}
                onClick={confirmDelete}
                className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-500"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'approved') {
    return (
      <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200">
        <CheckCircle2 className="mr-1 h-3 w-3" />Approved
      </Badge>
    );
  }
  if (status === 'denied') {
    return (
      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200">
        <XCircle className="mr-1 h-3 w-3" />Denied
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200">
      <Clock className="mr-1 h-3 w-3" />Pending
    </Badge>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: 'teal' | 'zinc' | 'amber' | 'rose' }) {
  const styles = {
    teal: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    amber: 'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
    rose: 'border-rose-200 bg-gradient-to-br from-rose-50 to-white text-rose-900 dark:border-rose-700/40 dark:from-rose-950/40 dark:to-zinc-950 dark:text-rose-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-4 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-3 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-teal-100/60 dark:bg-teal-900/30" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      ))}
    </div>
  );
}

// ── View switcher pill ───────────────────────────────────────────────────────

function ViewTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  layoutId = 'accounting-mesa-view-pill',
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Distinct per independent tab group — two groups sharing one id (e.g. the
   *  outer switcher and a modal's tabs open at the same time) would fight
   *  each other for the same framer-motion layout animation. */
  layoutId?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-teal-50/70 hover:text-teal-700 dark:text-zinc-400 dark:hover:bg-teal-950/40 dark:hover:text-teal-200',
      )}
    >
      {active && (
        <motion.span
          layoutId={layoutId}
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
    </button>
  );
}

// ── Shared roster join (Global Master List × MESA enrollment × ledger) ─────
//
// Both tabs below are grounded in the current employee roster (not just the
// mesa_ledger backfill), so someone with no ledger history yet — a brand-new
// hire, or someone opted in today — still shows up. Mirrors the join
// HrMesa.tsx's MesaEligibleList already does (roster × employee_hourly_rates
// .mesa_member × mesa_ledger), minus its mesa_member=true pre-filter.

interface MesaRosterRow {
  key: string;
  name: string;
  workEmail: string | null;
  personalEmail: string | null;
  department: string | null;
  mesaMember: boolean;
  mesaMemberSince: string | null;
  ledger: MesaMemberSummary | null;
}

async function fetchMesaRoster(): Promise<MesaRosterRow[]> {
  const [employeesRes, ratesRes, ledgerRes] = await Promise.all([
    fetch('/api/employees', { cache: 'no-store' }),
    fetch('/api/employee-hourly-rates', { cache: 'no-store' }),
    fetch('/api/mesa-ledger', { cache: 'no-store' }),
  ]);
  if (!employeesRes.ok) throw new Error(`employees HTTP ${employeesRes.status}`);
  if (!ratesRes.ok) throw new Error(`rates HTTP ${ratesRes.status}`);
  const employeesJson = (await employeesRes.json()) as { employees?: EmployeeRow[] };
  const ratesJson = (await ratesRes.json()) as { rows?: EmployeeHourlyRateRow[] };
  // Ledger is best-effort — a failure here shouldn't blank out the roster.
  const ledgerJson = ledgerRes.ok
    ? ((await ledgerRes.json()) as { members?: MesaMemberSummary[] })
    : { members: [] };

  const ledgerByEmail = new Map<string, MesaMemberSummary>();
  for (const m of ledgerJson.members ?? []) {
    if (m.email) ledgerByEmail.set(m.email.toLowerCase(), m);
  }
  const rateByEmail = new Map<string, EmployeeHourlyRateRow>();
  for (const r of ratesJson.rows ?? []) {
    const we = r.work_email?.toLowerCase().trim();
    const pe = r.personal_email?.toLowerCase().trim();
    if (we) rateByEmail.set(we, r);
    if (pe) rateByEmail.set(pe, r);
  }

  return (employeesJson.employees ?? [])
    .map((e) => {
      const we = e.work_email?.toLowerCase().trim() || null;
      const pe = e.personal_email?.toLowerCase().trim() || null;
      if (!we && !pe) return null; // nothing to key an enrollment toggle on
      const rate = (we && rateByEmail.get(we)) || (pe && rateByEmail.get(pe)) || null;
      const ledger = (we && ledgerByEmail.get(we)) || (pe && ledgerByEmail.get(pe)) || null;
      return {
        key: we || pe!,
        name: e.name ?? we ?? pe!,
        workEmail: e.work_email ?? null,
        personalEmail: e.personal_email ?? null,
        department: e.department ?? rate?.department ?? null,
        mesaMember: rate?.mesa_member === true,
        mesaMemberSince: rate?.mesa_member_since ?? null,
        ledger,
      } as MesaRosterRow;
    })
    .filter((r): r is MesaRosterRow => r !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stub summary for a roster row with no mesa_ledger history yet, so the
 *  View drill-down (which fetches its own data by email anyway) always has a
 *  valid starting shape to render before that fetch resolves. */
function rosterRowToSummary(row: MesaRosterRow): MesaMemberSummary {
  if (row.ledger) return row.ledger;
  return {
    email: row.workEmail ?? row.personalEmail ?? '',
    name: row.name,
    department: row.department,
    status: null,
    isActive: row.mesaMember,
    contributed: 0,
    matched: 0,
    deposited: 0,
    disbursed: 0,
    balance: 0,
    depositCount: 0,
    disbursementCount: 0,
    firstDeposit: null,
    lastDeposit: null,
    lastDisbursement: null,
  };
}

const BALANCES_PAGE_SIZE = 20;

// ── All Members ──────────────────────────────────────────────────────────────
//
// Every current employee (Global Master List), with a temporary manual
// Opt In / Opt Out — a stopgap so Accounting can enroll/unenroll anyone right
// now, before employees self-serve via the Employee Dashboard's MESA Request
// tab (EmployeeMesa.tsx), which goes through the mesa_requests review queue.
// Remove this direct-toggle path once that's the primary way members join.

function MesaAllMembers() {
  const [rows, setRows] = useState<MesaRosterRow[]>(
    () => getTabCache<MesaRosterRow[]>(TAB_CACHE_KEYS.mesaAllMembers) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaAllMembers));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [viewTarget, setViewTarget] = useState<MesaRosterRow | null>(null);
  const [toggleTarget, setToggleTarget] = useState<MesaRosterRow | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const data = await fetchMesaRoster();
      setTabCache(TAB_CACHE_KEYS.mesaAllMembers, data);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load employee roster');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaAllMembers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.workEmail ?? '').toLowerCase().includes(q) ||
        (r.department ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  useEffect(() => { setPage(0); }, [query]);

  const enrolledCount = useMemo(() => rows.filter((r) => r.mesaMember).length, [rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / BALANCES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * BALANCES_PAGE_SIZE, (safePage + 1) * BALANCES_PAGE_SIZE);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaAllMembers);
    await load(false);
    toast.success('Refreshed employee roster');
  };

  const confirmToggle = async () => {
    if (!toggleTarget) return;
    const nextMesaMember = !toggleTarget.mesaMember;
    setToggling(true);
    try {
      const res = await fetch('/api/toggle-mesa-member', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workEmail: toggleTarget.workEmail ?? undefined,
          personalEmail: toggleTarget.workEmail ? undefined : toggleTarget.personalEmail ?? undefined,
          mesaMember: nextMesaMember,
          name: toggleTarget.name,
        }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      toast.success(
        nextMesaMember ? `${toggleTarget.name} opted in to MESA` : `${toggleTarget.name} opted out of MESA`,
      );
      setToggleTarget(null);
      clearTabCache(TAB_CACHE_KEYS.mesaAllMembers);
      clearTabCache(TAB_CACHE_KEYS.mesaActiveMembers);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update MESA enrollment');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Employees" value={rows.length} tone="zinc" />
        <StatCard label="Enrolled in MESA" value={enrolledCount} tone="teal" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, department..."
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading ? 'Loading employees...' : `${filtered.length} employee${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <SkeletonRows count={8} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0 ? 'No employees found.' : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">Email</th>
                    <th className="px-4 py-2.5 text-right">Status</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {pageRows.map((r) => (
                    <tr key={r.key} className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20">
                      <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100" data-label="Name">
                        {r.name}
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                        {r.department ? (
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3 text-zinc-400" />{r.department}</span>
                        ) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-zinc-500 dark:text-zinc-500" data-label="Email">
                        {r.workEmail ?? r.personalEmail ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Status">
                        {r.mesaMember ? (
                          <Badge variant="outline" className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200">
                            <CheckCircle2 className="mr-1 h-3 w-3" />Active member
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-zinc-300 bg-zinc-50 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300">
                            Not enrolled
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Actions">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setViewTarget(r)}
                            className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                          >
                            <Eye className="h-3 w-3" />
                            View
                          </Button>
                          {r.mesaMember ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setToggleTarget(r)}
                              className="h-7 gap-1 border-amber-200 bg-amber-50/60 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/60"
                            >
                              <UserMinus className="h-3 w-3" />
                              Opt Out
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setToggleTarget(r)}
                              className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                            >
                              <UserPlus className="h-3 w-3" />
                              Opt In
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > BALANCES_PAGE_SIZE && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
              <p className="text-[11px] text-zinc-400">
                {safePage * BALANCES_PAGE_SIZE + 1}–{Math.min((safePage + 1) * BALANCES_PAGE_SIZE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                  <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {viewTarget && (
        <MesaMemberDetail member={rosterRowToSummary(viewTarget)} onClose={() => setViewTarget(null)} />
      )}

      {/* Opt In / Opt Out confirmation — direct enrollment toggle, bypassing
          the mesa_requests review queue. Temporary bridge (see comment above). */}
      {toggleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
            <div className="flex items-start gap-3 px-5 py-5">
              <div className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                toggleTarget.mesaMember
                  ? 'bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400'
                  : 'bg-teal-100 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400',
              )}>
                {toggleTarget.mesaMember ? <UserMinus className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                  {toggleTarget.mesaMember ? 'Opt out of MESA?' : 'Opt in to MESA?'}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {toggleTarget.mesaMember
                    ? <>Stops the ₱100 weekly deduction for <span className="font-medium text-zinc-800 dark:text-zinc-200">{toggleTarget.name}</span> going forward.</>
                    : <>Starts the ₱100 weekly deduction (+ ₱300 Simple.biz match) for <span className="font-medium text-zinc-800 dark:text-zinc-200">{toggleTarget.name}</span>, effective today.</>}
                  {' '}This is a direct enrollment change — it does not go through the request queue.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button type="button" variant="outline" size="sm" onClick={() => setToggleTarget(null)} disabled={toggling}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={toggling}
                onClick={confirmToggle}
                className={cn(
                  toggleTarget.mesaMember
                    ? 'bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500'
                    : 'bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500',
                )}
              >
                {toggleTarget.mesaMember ? <UserMinus className="mr-1.5 h-3.5 w-3.5" /> : <UserPlus className="mr-1.5 h-3.5 w-3.5" />}
                {toggleTarget.mesaMember ? 'Opt Out' : 'Opt In'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MESA Active Members ──────────────────────────────────────────────────────
//
// Employees currently enrolled (employee_hourly_rates.mesa_member = true),
// roster-grounded so a brand-new enrollee shows up at ₱0 even before their
// first ledger row lands. Financial rollup comes from mesa_ledger when
// present. Read-only here — enrollment changes happen on the All Members tab
// (temporary) or via the mesa_requests review queue.

function MesaActiveMembers() {
  const [rows, setRows] = useState<MesaRosterRow[]>(
    () => getTabCache<MesaRosterRow[]>(TAB_CACHE_KEYS.mesaActiveMembers) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.mesaActiveMembers));
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [viewTarget, setViewTarget] = useState<MesaRosterRow | null>(null);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const data = (await fetchMesaRoster()).filter((r) => r.mesaMember);
      setTabCache(TAB_CACHE_KEYS.mesaActiveMembers, data);
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load MESA balances');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(!hasTabCache(TAB_CACHE_KEYS.mesaActiveMembers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.workEmail ?? '').toLowerCase().includes(q) ||
        (r.department ?? '').toLowerCase().includes(q),
    );
  }, [rows, query]);

  useEffect(() => { setPage(0); }, [query]);

  const totals = useMemo(() => {
    let contributed = 0, matched = 0, disbursed = 0, balance = 0;
    for (const r of rows) {
      if (!r.ledger) continue;
      contributed += r.ledger.contributed;
      matched += r.ledger.matched;
      disbursed += r.ledger.disbursed;
      balance += r.ledger.balance;
    }
    return { contributed, matched, disbursed, balance };
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / BALANCES_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * BALANCES_PAGE_SIZE, (safePage + 1) * BALANCES_PAGE_SIZE);

  const handleRefresh = async () => {
    clearTabCache(TAB_CACHE_KEYS.mesaActiveMembers);
    await load(false);
    toast.success('Refreshed MESA balances');
  };

  const fmtSince = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BalanceStat icon={PiggyBank} label="Members contributed" value={formatPHP(totals.contributed)} tone="zinc" />
        <BalanceStat icon={HeartHandshake} label="Simple.biz matched" value={formatPHP(totals.matched)} tone="teal" />
        <BalanceStat icon={Wallet} label="Total balance" value={formatPHP(totals.balance)} tone="teal" />
        <BalanceStat icon={CheckCircle2} label="Enrolled members" value={String(rows.length)} tone="amber" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email, department..."
            className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
          />
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || loading} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card className="overflow-hidden border-teal-100/80 shadow-sm dark:border-teal-900/40">
        <CardHeader className="border-b border-teal-100/80 bg-teal-50/30 px-5 py-3 dark:border-teal-900/40 dark:bg-teal-950/20">
          <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
            {loading ? 'Loading balances...' : `${filtered.length} member${filtered.length === 1 ? '' : 's'}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <SkeletonRows count={8} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
              <Inbox className="h-6 w-6 text-zinc-400" />
              {rows.length === 0 ? 'No MESA members enrolled yet.' : 'No results match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                  <tr>
                    <th className="px-4 py-2.5">Member</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5 text-right">Contributed</th>
                    <th className="px-4 py-2.5 text-right">Matched</th>
                    <th className="px-4 py-2.5 text-right">Disbursed</th>
                    <th className="px-4 py-2.5 text-right">Balance</th>
                    <th className="px-4 py-2.5 text-right">Member since</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                  {pageRows.map((r) => (
                    <tr key={r.key} className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20">
                      <td className="px-4 py-3" data-label="Member">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.name}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">{r.workEmail ?? r.personalEmail}</div>
                      </td>
                      <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                        {r.department ? (
                          <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3 text-zinc-400" />{r.department}</span>
                        ) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-zinc-700 dark:text-zinc-300" data-label="Contributed">
                        {formatPHP(r.ledger?.contributed ?? 0)}
                        <div className="text-[10px] font-normal text-zinc-400">{r.ledger?.depositCount ?? 0} wk{(r.ledger?.depositCount ?? 0) === 1 ? '' : 's'}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-teal-700 dark:text-teal-300" data-label="Matched">
                        {formatPHP(r.ledger?.matched ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300" data-label="Disbursed">
                        {(r.ledger?.disbursed ?? 0) > 0 ? formatPHP(r.ledger!.disbursed) : <span className="text-zinc-400">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-white" data-label="Balance">
                        {formatPHP(r.ledger?.balance ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-500 dark:text-zinc-400" data-label="Member since">
                        {fmtSince(r.mesaMemberSince)}
                      </td>
                      <td className="px-4 py-3 text-right" data-label="Actions">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setViewTarget(r)}
                          className="h-7 gap-1 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                        >
                          <Eye className="h-3 w-3" />
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length > BALANCES_PAGE_SIZE && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
              <p className="text-[11px] text-zinc-400">
                {safePage * BALANCES_PAGE_SIZE + 1}–{Math.min((safePage + 1) * BALANCES_PAGE_SIZE, filtered.length)} of {filtered.length}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage(0)} aria-label="First page">
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page">
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <span className="min-w-[4rem] text-center text-[11px] text-zinc-500">{safePage + 1} / {totalPages}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} aria-label="Next page">
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)} aria-label="Last page">
                  <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {viewTarget && (
        <MesaMemberDetail member={rosterRowToSummary(viewTarget)} onClose={() => setViewTarget(null)} />
      )}
    </div>
  );
}

// Drill-down modal: a member's full MESA history — contribution timeline,
// request history, and internal notes. Fetches /api/mesa-ledger,
// /api/mesa-requests, and /api/mesa-notes (all ?email=) in parallel on open.
function MesaMemberDetail({
  member,
  onClose,
}: {
  member: MesaMemberSummary;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<MesaLedgerEvent[]>([]);
  const [summary, setSummary] = useState<MesaMemberSummary>(member);
  const [requests, setRequests] = useState<MesaRequest[]>([]);
  const [notes, setNotes] = useState<MesaNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'timeline' | 'requests' | 'notes'>('timeline');
  const [noteBody, setNoteBody] = useState('');
  const [postingNote, setPostingNote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const email = encodeURIComponent(member.email);
    Promise.all([
      fetch(`/api/mesa-ledger?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { summary: member, events: [] }))
        .catch(() => ({ summary: member, events: [] })) as Promise<{
        summary?: MesaMemberSummary | null;
        events?: MesaLedgerEvent[];
      }>,
      fetch(`/api/mesa-requests?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })) as Promise<{ rows?: MesaRequest[] }>,
      fetch(`/api/mesa-notes?email=${email}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { notes: [] }))
        .catch(() => ({ notes: [] })) as Promise<{ notes?: MesaNote[] }>,
    ])
      .then(([ledgerJson, requestsJson, notesJson]) => {
        if (cancelled) return;
        if (ledgerJson.summary) setSummary(ledgerJson.summary);
        setEvents(ledgerJson.events ?? []);
        setRequests(requestsJson.rows ?? []);
        setNotes(notesJson.notes ?? []);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [member.email, member]);

  // Build a unified, newest-first timeline of deposits and disbursements,
  // carrying along each event's frozen legacy notes (if any).
  const lines = useMemo(() => {
    const out: {
      key: string;
      date: string | null;
      kind: 'deposit' | 'disbursement';
      you: number;
      company: number;
      total: number;
      label: string | null;
      notes: string | null;
      additionalNotes: string | null;
    }[] = [];
    for (const e of events) {
      if ((e.total_daily_deposit_php ?? 0) > 0 && e.deposit_date) {
        out.push({
          key: `d-${e.id}`,
          date: e.deposit_date,
          kind: 'deposit',
          you: e.worker_contribution_php ?? 0,
          company: e.simple_match_php ?? 0,
          total: e.total_daily_deposit_php ?? 0,
          label: null,
          notes: e.notes,
          additionalNotes: e.additional_notes,
        });
      }
      if ((e.disbursement_amount_php ?? 0) > 0 && e.disbursement_date) {
        out.push({
          key: `x-${e.id}`,
          date: e.disbursement_date,
          kind: 'disbursement',
          you: 0,
          company: 0,
          total: -(e.disbursement_amount_php ?? 0),
          label: e.disbursement_type || 'Disbursement',
          notes: e.notes,
          additionalNotes: e.additional_notes,
        });
      }
    }
    out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return out;
  }, [events]);

  const submitNote = async () => {
    const trimmed = noteBody.trim();
    if (!trimmed) return;
    setPostingNote(true);
    try {
      const res = await fetch('/api/mesa-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_email: member.email, body: trimmed }),
      });
      const j = (await res.json()) as { note?: MesaNote; error?: string };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.note) setNotes((prev) => [j.note!, ...prev]);
      setNoteBody('');
      toast.success('Note added');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add note');
    } finally {
      setPostingNote(false);
    }
  };

  const fmtDate = (d: string | null) =>
    d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px] animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out motion-reduce:animate-none">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
              MESA contribution history
            </p>
            <h3 className="mt-0.5 truncate text-base font-bold text-zinc-900 dark:text-white">
              {summary.name ?? summary.email}
            </h3>
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
              {summary.email}
              {summary.department ? ` · ${summary.department}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 gap-3 border-b border-zinc-100 px-5 py-4 sm:grid-cols-4 dark:border-zinc-800/80">
          <DetailStat label="Contributed" value={formatPHP(summary.contributed)} sub={`${summary.depositCount} wk${summary.depositCount === 1 ? '' : 's'}`} />
          <DetailStat label="Simple.biz matched" value={formatPHP(summary.matched)} sub="3× match" accent />
          <DetailStat label="Disbursed" value={summary.disbursed > 0 ? formatPHP(summary.disbursed) : '—'} sub={summary.disbursementCount > 0 ? `${summary.disbursementCount}×` : 'none'} />
          <DetailStat label="Balance" value={formatPHP(summary.balance)} sub="current" strong />
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-zinc-100 px-5 py-2.5 text-[11px] text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" /> First deposit: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.firstDeposit)}</span></span>
          <span className="inline-flex items-center gap-1">Last deposit: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.lastDeposit)}</span></span>
          {summary.lastDisbursement && (
            <span className="inline-flex items-center gap-1">Last disbursement: <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtDate(summary.lastDisbursement)}</span></span>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-zinc-100 px-5 py-2 dark:border-zinc-800/80">
          <div
            role="tablist"
            aria-label="Member detail sections"
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <ViewTabButton active={tab === 'timeline'} onClick={() => setTab('timeline')} icon={Wallet} label={`Timeline (${lines.length})`} layoutId="mesa-detail-tab-pill" />
            <ViewTabButton active={tab === 'requests'} onClick={() => setTab('requests')} icon={ClipboardList} label={`Requests (${requests.length})`} layoutId="mesa-detail-tab-pill" />
            <ViewTabButton active={tab === 'notes'} onClick={() => setTab('notes')} icon={StickyNote} label={`Notes (${notes.length})`} layoutId="mesa-detail-tab-pill" />
          </div>
        </div>

        {/* Tab content */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === 'timeline' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="space-y-2 p-5">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                  ))}
                </div>
              ) : lines.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  <Inbox className="h-6 w-6 text-zinc-400" />
                  No recorded deposits or disbursements.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-zinc-100 bg-zinc-50/95 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-900/95 dark:text-zinc-400">
                    <tr>
                      <th className="px-5 py-2">Date</th>
                      <th className="px-4 py-2">Type</th>
                      <th className="px-4 py-2 text-right">You</th>
                      <th className="px-4 py-2 text-right">Simple.biz</th>
                      <th className="px-5 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                    {lines.map((l) => (
                      <React.Fragment key={l.key}>
                        <tr className={cn(l.kind === 'disbursement' && 'bg-amber-50/40 dark:bg-amber-500/5')}>
                          <td className="px-5 py-2 font-medium text-zinc-700 dark:text-zinc-300" data-label="Date">{fmtDate(l.date)}</td>
                          <td className="px-4 py-2" data-label="Type">
                            {l.kind === 'deposit' ? (
                              <span className="inline-flex items-center gap-1 text-teal-700 dark:text-teal-300">
                                <ArrowDownCircle className="h-3 w-3" /> Deposit
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                                <ArrowUpCircle className="h-3 w-3" /> {l.label}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400" data-label="You">
                            {l.kind === 'deposit' ? formatPHP(l.you) : '—'}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-zinc-600 dark:text-zinc-400" data-label="Simple.biz">
                            {l.kind === 'deposit' ? formatPHP(l.company) : '—'}
                          </td>
                          <td className={cn('px-5 py-2 text-right font-semibold tabular-nums', l.total < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-900 dark:text-white')} data-label="Amount">
                            {l.total < 0 ? `−${formatPHP(Math.abs(l.total))}` : formatPHP(l.total)}
                          </td>
                        </tr>
                        {(l.notes || l.additionalNotes) && (
                          <tr className={cn(l.kind === 'disbursement' && 'bg-amber-50/40 dark:bg-amber-500/5')}>
                            <td colSpan={5} className="px-5 pb-2 text-[11px] italic text-zinc-500 dark:text-zinc-500">
                              {l.notes && <div>Note: {l.notes}</div>}
                              {l.additionalNotes && <div>Additional: {l.additionalNotes}</div>}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {tab === 'requests' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="space-y-2 p-5">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                  ))}
                </div>
              ) : requests.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  <Inbox className="h-6 w-6 text-zinc-400" />
                  No MESA requests from this member yet.
                </div>
              ) : (
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                  {requests.map((r) => (
                    <div key={r.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className={cn('text-[10.5px] font-semibold uppercase tracking-wide', TYPE_COLORS[r.request_type])}>
                            {TYPE_LABELS[r.request_type]}
                          </Badge>
                          <StatusBadge status={r.status} />
                        </div>
                        <span className="text-[11px] text-zinc-400">
                          {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                      {r.amount_needed != null && (
                        <p className="mt-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">{formatPHP(r.amount_needed)}</p>
                      )}
                      {r.disbursement_reason && (
                        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{r.disbursement_reason}</p>
                      )}
                      {r.explanation && (
                        <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-500">{r.explanation}</p>
                      )}
                      {r.status !== 'pending' && r.review_notes && (
                        <p className="mt-1 text-xs italic text-zinc-500 dark:text-zinc-500">Review: {r.review_notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'notes' && (
            <>
              <div className="border-b border-zinc-100 p-4 dark:border-zinc-800/80">
                <textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value.slice(0, 500))}
                  rows={3}
                  placeholder="Add an internal note about this member..."
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[11px] text-zinc-400">{noteBody.length}/500 characters</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!noteBody.trim() || postingNote}
                    onClick={submitNote}
                    className="h-7 bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
                  >
                    Add note
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="space-y-2 p-5">
                    {[1, 2].map((i) => (
                      <div key={i} className="h-9 w-full animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
                    ))}
                  </div>
                ) : notes.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                    <Inbox className="h-6 w-6 text-zinc-400" />
                    No notes yet — add the first one above.
                  </div>
                ) : (
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
                    {notes.map((n) => (
                      <div key={n.id} className="px-5 py-3">
                        <p className="text-sm text-zinc-700 dark:text-zinc-300">{n.body}</p>
                        <p className="mt-1 text-[11px] text-zinc-400">
                          {n.author_name ?? n.author_email} · {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <span className="text-[11px] text-zinc-400">
            {loading
              ? 'Loading…'
              : tab === 'timeline'
              ? `${lines.length} event${lines.length === 1 ? '' : 's'}`
              : tab === 'requests'
              ? `${requests.length} request${requests.length === 1 ? '' : 's'}`
              : `${notes.length} note${notes.length === 1 ? '' : 's'}`}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function DetailStat({
  label,
  value,
  sub,
  accent,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10.5px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className={cn(
        'mt-0.5 truncate font-mono text-base font-bold tabular-nums',
        accent ? 'text-teal-700 dark:text-teal-300' : strong ? 'text-zinc-900 dark:text-white' : 'text-zinc-800 dark:text-zinc-200',
      )}>
        {value}
      </p>
      {sub && <p className="truncate text-[10px] text-zinc-400">{sub}</p>}
    </div>
  );
}

function BalanceStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: 'teal' | 'zinc' | 'amber';
}) {
  const styles = {
    teal: 'border-teal-200 bg-gradient-to-br from-teal-50 to-white text-teal-900 dark:border-teal-700/40 dark:from-teal-950/40 dark:to-zinc-950 dark:text-teal-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
    amber: 'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${styles}`}>
      <div className="flex items-center gap-1.5 opacity-70">
        <Icon className="h-3.5 w-3.5" />
        <p className="text-[11px] font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-1 font-mono text-xl font-bold tabular-nums">{value}</p>
    </div>
  );
}
