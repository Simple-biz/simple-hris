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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

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

// Module-level cache — cleared on Refresh.
let cachedRequests: MesaRequest[] | null = null;

export default function AccountingMesa() {
  const [rows, setRows] = useState<MesaRequest[]>(() => cachedRequests ?? []);
  const [loading, setLoading] = useState(cachedRequests === null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<MesaRequestStatus | ''>('');
  const [filterType, setFilterType] = useState<MesaRequestType | ''>('');
  const [page, setPage] = useState(0);
  const [reviewTarget, setReviewTarget] = useState<MesaRequest | null>(null);
  const [reviewNotes, setReviewNotes] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const res = await fetch('/api/mesa-requests', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { rows?: MesaRequest[] };
      const data = json.rows ?? [];
      cachedRequests = data;
      setRows(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load MESA requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (cachedRequests !== null) return;
    void load(true);
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
    cachedRequests = null;
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
      toast.success(`Request ${status}`);
      setReviewTarget(null);
      cachedRequests = null;
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setReviewing(false);
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
              MESA Requests
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Review employee opt-in, opt-out, disbursement, and return requests submitted through the portal.
            </p>
          </div>
        </div>

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
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as MesaRequestStatus | '')}
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
            </select>
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as MesaRequestType | '')}
              className="h-9 rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs font-medium text-zinc-700 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300"
            >
              <option value="">All types</option>
              <option value="opt_in">Opt-in</option>
              <option value="opt_out">Opt-out</option>
              <option value="disbursement">Disbursement</option>
              <option value="return">Return</option>
            </select>
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
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => openReview(r)}
                              className="h-7 border-teal-200 bg-teal-50/60 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                            >
                              Review
                            </Button>
                          ) : (
                            <span className="text-[11px] text-zinc-400">
                              {r.reviewed_by ? `by ${r.reviewed_by.split('@')[0]}` : '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
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
      </div>

      {/* Review modal */}
      {reviewTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
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
