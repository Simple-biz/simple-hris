'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SmoothSelect } from '@/components/ui/smooth-select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';
import { LEAVE_DELETE_ROLES } from '@/lib/supabase/leave-requests';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

const PAGE_SIZE = 15;

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'cancelled';

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return 0;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
}

function formatDateRange(start: string, end: string): string {
  if (start === end) return start;
  const sDate = new Date(start);
  const eDate = new Date(end);
  if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) return `${start} - ${end}`;
  const sameMonth =
    sDate.getUTCFullYear() === eDate.getUTCFullYear() &&
    sDate.getUTCMonth() === eDate.getUTCMonth();
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  if (sameMonth) {
    return `${fmt.format(sDate)} - ${eDate.getUTCDate()}`;
  }
  return `${fmt.format(sDate)} - ${fmt.format(eDate)}`;
}

export default function LeaveRequestsPanel() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => {
    try {
      const e = sessionStorage.getItem(SESSION_EMAIL_KEY);
      setCurrentUser(e ? e.trim().toLowerCase() : null);
    } catch {
      /* ignore */
    }
  }, []);

  // Resolve admin/payroll_manager privilege so the trash button only appears for those roles.
  useEffect(() => {
    if (!currentUser) {
      setCanDelete(false);
      return;
    }
    let cancelled = false;
    fetch(`/api/employee-roles?email=${encodeURIComponent(currentUser)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { rows?: { role: string }[] }) => {
        if (cancelled) return;
        const roles = (j.rows ?? []).map((r) => r.role);
        setCanDelete(roles.some((r) => LEAVE_DELETE_ROLES.includes(r)));
      })
      .catch(() => {
        if (!cancelled) setCanDelete(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  const [rows, setRows] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);

  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [selected, setSelected] = useState<LeaveRequestRow | null>(null);
  const [approverEmail, setApproverEmail] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<LeaveRequestRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try {
      const res = await fetch('/api/leave-requests?scope=all', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: LeaveRequestRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setRows(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed');
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const stats = useMemo(() => ({
    total: rows.length,
    pending: rows.filter((r) => r.status === 'pending').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!q) return true;
      const blob = [
        r.employee_name ?? '',
        r.employee_email,
        r.department ?? '',
        r.leave_type,
        r.reason ?? '',
        r.manager_email ?? '',
        r.start_date,
        r.end_date,
      ]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [rows, statusFilter, searchQuery]);

  useEffect(() => { setPage(0); }, [statusFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const handleRefresh = async () => {
    await load(false);
    toast.success('Refreshed leave requests');
  };

  function openDialog(row: LeaveRequestRow, a: 'approve' | 'reject') {
    setSelected(row);
    setAction(a);
    setNote('');
    setApproverEmail(currentUser ?? '');
  }

  async function confirmAction() {
    if (!selected?.id) return;
    const em = approverEmail.trim();
    if (!em) {
      toast.error('Enter your work email - you must be a configured approver.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/leave-requests/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'approve' ? 'approve' : 'reject',
          approver_email: em,
          approver_note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Update failed');
      toast.success(action === 'approve' ? 'Leave approved' : 'Leave rejected');
      setSelected(null);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget?.id) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/leave-requests/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Delete failed');
      toast.success('Leave request deleted');
      setDeleteTarget(null);
      await load(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-teal-50/30 to-emerald-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-6xl space-y-5">

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-100 to-emerald-100 text-teal-700 ring-1 ring-teal-100 dark:from-teal-950/60 dark:to-emerald-950/40 dark:text-teal-300 dark:ring-teal-900/60">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-teal-700 dark:text-teal-300">
              Time off
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Leave Requests
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Review and action employee time-off requests. Approvers must match the configured manager/accounting list.
            </p>
          </div>
        </div>

        {/* Signed-in banner */}
        <div className="rounded-lg border border-teal-100/80 bg-teal-50/40 px-3.5 py-2 text-xs text-teal-800 dark:border-teal-900/40 dark:bg-teal-950/20 dark:text-teal-300">
          {currentUser ? (
            <>
              Signed in as <span className="font-semibold">{currentUser}</span>. This email is used to
              verify your approver access when confirming actions.
            </>
          ) : (
            <>Not signed in - you will need to type an approver email manually when actioning a request.</>
          )}
        </div>

        {/* Stats */}
        <div className="grid gap-3 sm:grid-cols-4">
          <StatCard label="Total" value={stats.total} tone="zinc" />
          <StatCard label="Pending" value={stats.pending} tone="amber" />
          <StatCard label="Approved" value={stats.approved} tone="teal" />
          <StatCard label="Rejected" value={stats.rejected} tone="rose" />
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, email, department, type..."
              className="h-9 border-zinc-200 bg-white pl-9 text-sm focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-zinc-400" />
            <SmoothSelect
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              triggerClassName="w-40"
              options={[
                { value: 'all', label: 'All statuses' },
                { value: 'pending', label: 'Pending' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
                { value: 'cancelled', label: 'Cancelled' },
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
                {rows.length === 0 ? 'No leave requests yet.' : 'No results match your filters.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-teal-100/80 bg-teal-50/40 text-[11px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-900/40 dark:bg-teal-950/30 dark:text-teal-300">
                    <tr>
                      <th className="px-4 py-2.5">Employee</th>
                      <th className="px-4 py-2.5">Department</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Dates</th>
                      <th className="px-4 py-2.5">Manager</th>
                      <th className="px-4 py-2.5 text-right">Status</th>
                      <th className="px-4 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/40">
                    {pageRows.map((r) => {
                      const days = daysBetween(r.start_date, r.end_date);
                      return (
                        <tr
                          key={r.id}
                          className="transition-colors hover:bg-teal-50/40 dark:hover:bg-teal-950/20"
                        >
                          <td className="px-4 py-3" data-label="Employee">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {r.employee_name ?? '-'}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
                              {r.employee_email}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400" data-label="Department">
                            {r.department || '-'}
                          </td>
                          <td className="px-4 py-3" data-label="Type">
                            <Badge
                              variant="outline"
                              className="border-teal-200 bg-teal-50 text-[10.5px] font-semibold uppercase tracking-wide text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/15 dark:text-teal-200"
                            >
                              {r.leave_type}
                            </Badge>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-zinc-700 dark:text-zinc-300" data-label="Dates">
                            <div className="tabular-nums">{formatDateRange(r.start_date, r.end_date)}</div>
                            <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                              {days} day{days === 1 ? '' : 's'}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-mono text-[11px] text-zinc-600 dark:text-zinc-400" data-label="Manager">
                            {r.manager_email ?? '-'}
                          </td>
                          <td className="px-4 py-3 text-right" data-label="Status">
                            <StatusBadge status={r.status} />
                          </td>
                          <td className="px-4 py-3 text-right" data-label="Action">
                            {r.status === 'pending' ? (
                              <div className="flex justify-end gap-1">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openDialog(r, 'approve')}
                                  className="h-7 border-teal-200 bg-teal-50/60 px-2 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 dark:border-teal-700/50 dark:bg-teal-950/30 dark:text-teal-300 dark:hover:bg-teal-950/60"
                                >
                                  Approve
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openDialog(r, 'reject')}
                                  className="h-7 border-rose-200 bg-rose-50/60 px-2 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                                >
                                  Reject
                                </Button>
                                {canDelete && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    title="Permanently delete this request"
                                    className="h-7 w-7 border-zinc-200 p-0 text-rose-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-rose-400 dark:hover:border-rose-800 dark:hover:bg-rose-950/40"
                                    onClick={() => setDeleteTarget(r)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center justify-end gap-1.5">
                                {r.approver_email ? (
                                  <span
                                    className="text-[11px] text-zinc-400"
                                    title={r.approver_note ?? undefined}
                                  >
                                    by {r.approver_email.split('@')[0]}
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-zinc-400">-</span>
                                )}
                                {canDelete && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    title="Permanently delete this request"
                                    className="h-7 w-7 shrink-0 border-zinc-200 p-0 text-rose-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-rose-400 dark:hover:border-rose-800 dark:hover:bg-rose-950/40"
                                    onClick={() => setDeleteTarget(r)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && filtered.length > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t border-teal-100/80 px-5 py-2.5 dark:border-teal-900/40">
                <p className="text-[11px] text-zinc-400">
                  {safePage * PAGE_SIZE + 1}-{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of{' '}
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

      {/* Decide modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-600 dark:text-teal-400">
                  {action === 'approve' ? 'Approve Leave' : 'Reject Leave'}
                </p>
                <h3 className="mt-0.5 text-base font-bold text-zinc-900 dark:text-white">
                  Review - {selected.employee_name ?? selected.employee_email}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <InfoRow label="Email" value={selected.employee_email} />
              {selected.department && <InfoRow label="Department" value={selected.department} />}
              <InfoRow label="Type" value={selected.leave_type} />
              <InfoRow
                label="Dates"
                value={`${formatDateRange(selected.start_date, selected.end_date)} (${daysBetween(selected.start_date, selected.end_date)} day${daysBetween(selected.start_date, selected.end_date) === 1 ? '' : 's'})`}
              />
              {selected.reason && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Reason</p>
                  <p className="mt-1 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{selected.reason}</p>
                </div>
              )}
              <div>
                <label htmlFor="approver-email" className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Your work email
                </label>
                <Input
                  id="approver-email"
                  type="email"
                  value={approverEmail}
                  onChange={(e) => setApproverEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="mt-1 h-9 font-mono text-xs focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
                />
              </div>
              <div>
                <label htmlFor="approver-note" className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Note {action === 'reject' ? '(recommended)' : '(optional)'}
                </label>
                <textarea
                  id="approver-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  placeholder={
                    action === 'approve'
                      ? 'Optional message to the employee...'
                      : 'Explain why the request was rejected...'
                  }
                  className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelected(null)}
                disabled={saving}
              >
                Cancel
              </Button>
              {action === 'reject' ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() => void confirmAction()}
                  className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300 dark:hover:bg-rose-950/60"
                  variant="outline"
                >
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <XCircle className="mr-1.5 h-3.5 w-3.5" />}
                  Reject
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() => void confirmAction()}
                  className="bg-teal-600 text-white hover:bg-teal-700 dark:bg-teal-600 dark:hover:bg-teal-500"
                >
                  {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
                  Approve
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Admin delete confirmation */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950/60">
                <Trash2 className="size-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-sm">Delete leave request</DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">
                  This permanently removes the record. Cannot be undone.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {deleteTarget && (
            <div className="space-y-1.5 text-[12.5px] text-zinc-700 dark:text-zinc-300">
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Employee</span>{' '}
                <span className="font-medium">
                  {deleteTarget.employee_name ?? deleteTarget.employee_email}
                </span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Type</span>{' '}
                <span className="font-medium">{deleteTarget.leave_type}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Dates</span>{' '}
                <span className="font-medium">
                  {formatDateRange(deleteTarget.start_date, deleteTarget.end_date)}
                </span>{' '}
                <span className="text-[11px] text-zinc-500">
                  ({daysBetween(deleteTarget.start_date, deleteTarget.end_date)}d)
                </span>
              </p>
              {deleteTarget.approver_email && (
                <p className="mt-2 rounded-md border border-amber-200/60 bg-amber-50/70 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  Already actioned by{' '}
                  <span className="font-medium">{deleteTarget.approver_email}</span>. Deleting wipes the
                  row; the deletion is recorded as <code className="font-mono">leave.admin_deleted</code> in the
                  audit log.
                </p>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={deleting}
              onClick={() => void confirmDelete()}
              className="gap-1.5 bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
            >
              {deleting ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="h-3 w-3" />
                  Delete
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  if (status === 'rejected') {
    return (
      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/15 dark:text-rose-200">
        <XCircle className="mr-1 h-3 w-3" />Rejected
      </Badge>
    );
  }
  if (status === 'cancelled') {
    return (
      <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10.5px] font-semibold uppercase tracking-wide text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300">
        Cancelled
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
