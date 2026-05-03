'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

const STATUS_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  pending: {
    label: 'Pending',
    className:
      'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400',
  },
  approved: {
    label: 'Approved',
    className:
      'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  rejected: {
    label: 'Rejected',
    className:
      'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400',
  },
  cancelled: {
    label: 'Cancelled',
    className:
      'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
  },
};

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
  if (isNaN(sDate.getTime()) || isNaN(eDate.getTime())) return `${start} → ${end}`;
  const sameMonth =
    sDate.getUTCFullYear() === eDate.getUTCFullYear() &&
    sDate.getUTCMonth() === eDate.getUTCMonth();
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  if (sameMonth) {
    return `${fmt.format(sDate)} – ${eDate.getUTCDate()}`;
  }
  return `${fmt.format(sDate)} – ${fmt.format(eDate)}`;
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [selected, setSelected] = useState<LeaveRequestRow | null>(null);
  const [approverEmail, setApproverEmail] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<LeaveRequestRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
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
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingCount = useMemo(() => rows.filter((r) => r.status === 'pending').length, [rows]);
  const approvedCount = useMemo(() => rows.filter((r) => r.status === 'approved').length, [rows]);
  const rejectedCount = useMemo(() => rows.filter((r) => r.status === 'rejected').length, [rows]);

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

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  useEffect(() => {
    setPage(1);
  }, [statusFilter, searchQuery]);

  function openDialog(row: LeaveRequestRow, a: 'approve' | 'reject') {
    setSelected(row);
    setAction(a);
    setNote('');
    setApproverEmail(currentUser ?? '');
    setDialogOpen(true);
  }

  async function confirmAction() {
    if (!selected?.id) return;
    const em = approverEmail.trim();
    if (!em) {
      toast.error('Enter your work email — you must be a configured approver.');
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
      setDialogOpen(false);
      setSelected(null);
      await load();
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
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-emerald-50/30 to-teal-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      {/* Header */}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 shadow-sm shadow-emerald-500/20 dark:from-emerald-600 dark:to-teal-700">
            <CalendarDays className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              Leave requests
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Review and action employee time-off requests. Approvers must match the configured manager/accounting list.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0"
        >
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Signed-in banner */}
      <div className="shrink-0 rounded-md border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300">
        {currentUser ? (
          <>
            Signed in as <span className="font-semibold">{currentUser}</span>. This email will be used
            to verify your approver access when confirming actions.
          </>
        ) : (
          <>Not signed in — you'll need to type an approver email manually when actioning a request.</>
        )}
      </div>

      {/* Summary cards */}
      <div className="flex shrink-0 gap-3">
        <Card className="flex-1 border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <Clock className="h-4 w-4 text-amber-500" />
            <div>
              <p className="text-lg font-bold leading-tight text-amber-700 dark:text-amber-400">
                {pendingCount}
              </p>
              <p className="text-[10px] text-amber-600/70 dark:text-amber-500/70">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1 border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <div>
              <p className="text-lg font-bold leading-tight text-emerald-700 dark:text-emerald-400">
                {approvedCount}
              </p>
              <p className="text-[10px] text-emerald-600/70 dark:text-emerald-500/70">Approved</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1 border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <XCircle className="h-4 w-4 text-rose-500" />
            <div>
              <p className="text-lg font-bold leading-tight text-rose-700 dark:text-rose-400">
                {rejectedCount}
              </p>
              <p className="text-[10px] text-rose-600/70 dark:text-rose-500/70">Rejected</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
        <div className="max-w-md flex-1 space-y-1.5">
          <Label htmlFor="leave-search" className="text-xs text-zinc-600 dark:text-zinc-500">
            Search
          </Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              id="leave-search"
              placeholder="Employee, email, department, type..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
            />
          </div>
        </div>
        <div className="w-full space-y-1.5 sm:w-44">
          <Label htmlFor="leave-status" className="text-xs text-zinc-600 dark:text-zinc-500">
            Status
          </Label>
          <select
            id="leave-status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Table / states */}
      {loading ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-4 border-b border-zinc-200 bg-gradient-to-r from-emerald-50/95 to-teal-50/60 px-3 py-2 dark:border-zinc-800 dark:from-emerald-950/40 dark:to-teal-950/40">
              {['w-28', 'w-20', 'w-20', 'w-24', 'w-32', 'w-16', 'ml-auto w-20'].map((w, i) => (
                <div
                  key={i}
                  className={cn('h-3 animate-pulse rounded bg-zinc-300/80 dark:bg-zinc-700/80', w)}
                />
              ))}
            </div>
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 px-3 py-3">
                  <div className="flex min-w-[10rem] flex-1 flex-col gap-1">
                    <div
                      className="h-3.5 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                      style={{ animationDelay: `${i * 40}ms` }}
                    />
                    <div className="h-2.5 w-44 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
                  </div>
                  <div className="h-3 w-16 shrink-0 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-5 w-20 shrink-0 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
                  <div className="h-3 w-28 shrink-0 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                  <div className="h-3 w-32 shrink-0 animate-pulse rounded bg-zinc-200/70 dark:bg-zinc-800/70" />
                  <div className="h-5 w-16 shrink-0 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
                  <div className="ml-auto h-7 w-28 shrink-0 animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800" />
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">
            {rows.length === 0
              ? 'No leave requests yet.'
              : 'No requests match your filters.'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="flex shrink-0 items-center justify-between text-xs text-zinc-600 dark:text-zinc-500">
            <span>
              Showing{' '}
              <span className="font-mono">
                {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}
              </span>{' '}
              of <span className="font-mono">{filtered.length}</span>
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="px-2 font-mono">
                {safePage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-emerald-50/95 to-teal-50/60 backdrop-blur-sm dark:from-emerald-950/80 dark:to-teal-950/70">
                <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Employee</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Dept</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Type</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Dates</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Manager</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Status</TableHead>
                  <TableHead className="w-[160px] text-right text-zinc-600 dark:text-zinc-400">
                    Action
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => {
                  const days = daysBetween(r.start_date, r.end_date);
                  return (
                    <TableRow
                      key={r.id}
                      className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
                    >
                      <TableCell className="align-top">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {r.employee_name ?? '—'}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                            {r.employee_email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {r.department ? (
                          <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0 text-[11px] font-medium text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-400">
                            {r.department}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant="outline"
                          className="border-teal-300 bg-teal-50 text-[10px] text-teal-800 dark:border-teal-700 dark:bg-teal-950/40 dark:text-teal-400"
                        >
                          {r.leave_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-top text-xs text-zinc-700 dark:text-zinc-300">
                        <div className="flex flex-col gap-0.5">
                          <span className="tabular-nums">{formatDateRange(r.start_date, r.end_date)}</span>
                          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                            {days} day{days === 1 ? '' : 's'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="align-top font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                        {r.manager_email ?? '—'}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge
                          variant="outline"
                          className={cn('text-[10px]', STATUS_BADGE[r.status]?.className)}
                        >
                          {STATUS_BADGE[r.status]?.label ?? r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="align-top text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          {r.status === 'pending' ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400"
                                onClick={() => openDialog(r, 'approve')}
                              >
                                <Check className="mr-1 h-3 w-3" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-400"
                                onClick={() => openDialog(r, 'reject')}
                              >
                                <X className="mr-1 h-3 w-3" />
                                Reject
                              </Button>
                              {canDelete && (
                                <Button
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
                            <div className="flex items-end justify-end gap-1.5">
                              {r.approver_email ? (
                                <div
                                  className="flex flex-col items-end gap-0.5 text-[10px] text-zinc-500 dark:text-zinc-400"
                                  title={r.approver_note ?? undefined}
                                >
                                  <span className="font-mono">{r.approver_email}</span>
                                  {r.approver_note && (
                                    <span className="max-w-[160px] truncate italic">{r.approver_note}</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-[10px] text-zinc-400">—</span>
                              )}
                              {canDelete && (
                                <Button
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
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Decide dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {action === 'approve' ? 'Approve leave' : 'Reject leave'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selected?.employee_name ?? selected?.employee_email} —{' '}
              {selected && formatDateRange(selected.start_date, selected.end_date)} —{' '}
              {selected?.leave_type}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {selected?.reason && (
              <div className="rounded-md border border-zinc-200 bg-zinc-50/60 px-2.5 py-2 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-300">
                <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Reason
                </div>
                {selected.reason}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="approver-email" className="text-xs">
                Your work email
              </Label>
              <Input
                id="approver-email"
                type="email"
                value={approverEmail}
                onChange={(e) => setApproverEmail(e.target.value)}
                placeholder="you@company.com"
                className="h-9 font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="approver-note" className="text-xs">
                Note {action === 'reject' ? '(recommended)' : '(optional)'}
              </Label>
              <textarea
                id="approver-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={
                  action === 'approve'
                    ? 'Optional message to the employee…'
                    : 'Explain why the request was rejected…'
                }
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => void confirmAction()}
              className={
                action === 'approve'
                  ? 'bg-emerald-600 hover:bg-emerald-700'
                  : 'bg-rose-600 hover:bg-rose-700'
              }
            >
              {saving && <RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />}
              {action === 'approve' ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Status</span>{' '}
                <span className="font-medium">
                  {STATUS_BADGE[deleteTarget.status]?.label ?? deleteTarget.status}
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
                  Deleting…
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
