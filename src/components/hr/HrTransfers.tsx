'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  Clock,
  Inbox,
  Loader2,
  RefreshCw,
  X,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  DepartmentTransferRequestRow,
  TransferRequestStatus,
} from '@/lib/supabase/department-transfer-requests';

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

const STATUS_STYLE: Record<TransferRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

export default function HrTransfers() {
  const [rows, setRows] = useState<DepartmentTransferRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/department-transfers', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: DepartmentTransferRequestRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transfer requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const pending = useMemo(() => rows.filter((r) => r.status === 'pending'), [rows]);
  const decided = useMemo(() => rows.filter((r) => r.status !== 'pending'), [rows]);

  const decide = async (row: DepartmentTransferRequestRow, decision: 'approved' | 'rejected') => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/department-transfers/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: notes[row.id]?.trim() || null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success(
        decision === 'approved'
          ? `${row.employee_name ?? row.employee_email} moved to ${row.to_department}`
          : 'Transfer request rejected',
      );
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

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
              Approve or reject manager requests to move employees between departments.
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
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {/* Source-of-truth reminder */}
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12px] leading-snug text-amber-800 dark:border-amber-500/30 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Approving updates the department in the HRIS immediately. Remember to also update the
              master <strong>Google Sheet</strong> so the next sync keeps the new department.
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading transfer requests...
            </div>
          ) : error ? (
            <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
              {error}
            </div>
          ) : (
            <>
              {/* Pending */}
              <section className="space-y-3">
                <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  <Clock className="h-4 w-4 text-amber-500" />
                  Pending
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                    {pending.length}
                  </span>
                </h2>

                {pending.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-emerald-200 bg-white py-12 text-center dark:border-emerald-950/40 dark:bg-[#0d1117]">
                    <Inbox className="h-7 w-7 text-emerald-300 dark:text-emerald-800" />
                    <p className="text-sm text-zinc-500">No pending transfer requests.</p>
                  </div>
                ) : (
                  pending.map((r) => (
                    <div
                      key={r.id}
                      className="rounded-2xl border border-emerald-100/80 bg-white p-4 shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-zinc-900 dark:text-white">
                            {r.employee_name ?? r.employee_email}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              {r.from_department}
                            </span>
                            <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                            <span className="rounded-md bg-emerald-600 px-2 py-0.5 font-semibold text-white">
                              {r.to_department}
                            </span>
                          </div>
                        </div>
                        <span className="text-[11px] text-zinc-400">{timeAgo(r.created_at)}</span>
                      </div>

                      <p className="mt-2 text-[12px] text-zinc-500 dark:text-zinc-400">
                        Requested by <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.requested_by}</span>
                        {r.reason ? <> &middot; &ldquo;{r.reason}&rdquo;</> : null}
                      </p>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          type="text"
                          value={notes[r.id] ?? ''}
                          onChange={(e) => setNotes((p) => ({ ...p, [r.id]: e.target.value }))}
                          placeholder="Optional note (sent to the manager)"
                          className="h-8 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-300 focus:outline-none focus:ring-1 focus:ring-emerald-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void decide(r, 'approved')}
                            disabled={busyId === r.id}
                            className="h-8 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                          >
                            {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void decide(r, 'rejected')}
                            disabled={busyId === r.id}
                            className="h-8 gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
                          >
                            <X className="h-3.5 w-3.5" />
                            Reject
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* History */}
              {decided.length > 0 && (
                <section className="space-y-3">
                  <h2 className="px-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">History</h2>
                  <div className="overflow-hidden rounded-2xl border border-emerald-100/80 bg-white dark:border-emerald-950/40 dark:bg-zinc-950">
                    <div className="divide-y divide-emerald-100/70 dark:divide-emerald-950/40">
                      {decided.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                              {r.employee_name ?? r.employee_email}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                              <span>{r.from_department}</span>
                              <ArrowRight className="h-3 w-3" />
                              <span>{r.to_department}</span>
                              {r.approver_email ? <span className="text-zinc-400">&middot; by {r.approver_email}</span> : null}
                            </div>
                          </div>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize',
                              STATUS_STYLE[r.status],
                            )}
                          >
                            {r.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
