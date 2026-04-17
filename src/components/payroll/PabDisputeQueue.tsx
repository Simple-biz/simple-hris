'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Gavel,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { PabDayDisputeRow, PabDisputeReasonCode } from '@/lib/supabase/pab-day-disputes';
import { DISPUTE_APPROVERS, isDisputeApprover } from '@/lib/supabase/pab-day-disputes';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

const PAGE_SIZE = 15;

function formatAddedTime(hours: number | null | undefined): string | null {
  if (hours == null || hours <= 0) return null;
  const totalMins = Math.round(hours * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400' },
  approved: { label: 'Approved', className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  denied: { label: 'Denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
};

export default function PabDisputeQueue() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  useEffect(() => {
    try {
      const e = sessionStorage.getItem(SESSION_EMAIL_KEY);
      setCurrentUser(e ? e.trim().toLowerCase() : null);
    } catch { /* ignore */ }
  }, []);
  const canApprove = isDisputeApprover(currentUser);

  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>([]);
  const [reasonCodes, setReasonCodes] = useState<PabDisputeReasonCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'denied'>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  const [decideDialog, setDecideDialog] = useState<{ dispute: PabDayDisputeRow; action: 'approve' | 'deny' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [overrideHrs, setOverrideHrs] = useState('');
  const [overrideMins, setOverrideMins] = useState('');
  const [deciding, setDeciding] = useState(false);

  const [editDialog, setEditDialog] = useState<PabDayDisputeRow | null>(null);
  const [editStatus, setEditStatus] = useState<'approved' | 'denied'>('approved');
  const [editNote, setEditNote] = useState('');
  const [editHrs, setEditHrs] = useState('');
  const [editMins, setEditMins] = useState('');
  const [editing, setEditing] = useState(false);

  const openEdit = useCallback((row: PabDayDisputeRow) => {
    setEditDialog(row);
    setEditStatus(row.status === 'denied' ? 'denied' : 'approved');
    setEditNote(row.decision_note ?? '');
    const oh = row.override_hours ?? 0;
    const totalMins = Math.round(oh * 60);
    setEditHrs(totalMins > 0 ? String(Math.floor(totalMins / 60)) : '');
    setEditMins(totalMins > 0 ? String(totalMins % 60) : '');
  }, []);

  const fetchDisputes = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      params.set('limit', '500');
      const res = await fetch(`/api/pab-disputes?${params}`, { cache: 'no-store' });
      const json = await res.json();
      setDisputes(json.rows ?? []);
    } catch {
      setDisputes([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchDisputes(); }, [fetchDisputes]);

  useEffect(() => {
    fetch('/api/app-settings?key=pab_dispute_reason_codes', { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { value: string | null }) => {
        try {
          const codes = JSON.parse(json.value ?? '[]') as PabDisputeReasonCode[];
          setReasonCodes(Array.isArray(codes) ? codes : []);
        } catch { setReasonCodes([]); }
      })
      .catch(() => setReasonCodes([]));
  }, []);

  const reasonLabel = useCallback((code: string) => {
    return reasonCodes.find(r => r.code === code)?.label ?? code;
  }, [reasonCodes]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return disputes;
    return disputes.filter(d => {
      const blob = [d.work_email, d.reason, d.dispute_date, d.explanation ?? '', d.decided_by ?? ''].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }, [disputes, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [searchQuery, statusFilter]);

  const pendingCount = useMemo(() => disputes.filter(d => d.status === 'pending').length, [disputes]);
  const approvedCount = useMemo(() => disputes.filter(d => d.status === 'approved').length, [disputes]);
  const deniedCount = useMemo(() => disputes.filter(d => d.status === 'denied').length, [disputes]);

  const handleEdit = useCallback(async () => {
    if (!editDialog) return;
    setEditing(true);
    try {
      const hrs = parseInt(editHrs, 10);
      const mins = parseInt(editMins, 10);
      const safeHrs = Number.isFinite(hrs) && hrs >= 0 ? hrs : 0;
      const safeMins = Number.isFinite(mins) && mins >= 0 ? mins : 0;
      const totalHours = safeHrs + safeMins / 60;
      const res = await fetch(`/api/pab-disputes/${editDialog.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          status: editStatus,
          decided_by: currentUser ?? '',
          decision_note: editNote.trim() || null,
          override_hours: editStatus === 'approved' && totalHours > 0 ? totalHours : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('Dispute updated');
      setEditDialog(null);
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update dispute');
    } finally {
      setEditing(false);
    }
  }, [editDialog, editStatus, editNote, editHrs, editMins, currentUser, fetchDisputes]);

  const handleDecide = useCallback(async () => {
    if (!decideDialog) return;
    setDeciding(true);
    try {
      const hrs = parseInt(overrideHrs, 10);
      const mins = parseInt(overrideMins, 10);
      const safeHrs = Number.isFinite(hrs) && hrs >= 0 ? hrs : 0;
      const safeMins = Number.isFinite(mins) && mins >= 0 ? mins : 0;
      const totalHours = safeHrs + safeMins / 60;
      const res = await fetch(`/api/pab-disputes/${decideDialog.dispute.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: decideDialog.action,
          decided_by: currentUser ?? '',
          decision_note: decisionNote.trim() || null,
          override_hours: decideDialog.action === 'approve' && totalHours > 0 ? totalHours : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      const stage = json?.stage as 'first' | 'final' | null | undefined;
      if (decideDialog.action === 'approve' && stage === 'first') {
        toast.success('First approval recorded — needs a second approver to finalize');
      } else if (decideDialog.action === 'approve') {
        toast.success('Dispute approved');
      } else {
        toast.success('Dispute denied');
      }
      setDecideDialog(null);
      setDecisionNote('');
      setOverrideHrs('');
      setOverrideMins('');
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to process dispute');
    } finally {
      setDeciding(false);
    }
  }, [decideDialog, decisionNote, overrideHrs, overrideMins, currentUser, fetchDisputes]);

  const handleRevokeFirst = useCallback(async (row: PabDayDisputeRow) => {
    try {
      const res = await fetch(`/api/pab-disputes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'revoke_first', decided_by: currentUser ?? '' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('First approval revoked');
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke');
    }
  }, [currentUser, fetchDisputes]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-indigo-50/40 to-violet-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm shadow-indigo-500/20 dark:from-indigo-600 dark:to-violet-700">
            <Gavel className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              PAB Disputes
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Two-tier approval queue for short-day disputes. Carla and Fran both must approve before a day is forgiven.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDisputes} disabled={loading} className="shrink-0">
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Approver identity banner */}
      <div
        className={cn(
          'shrink-0 rounded-md border px-3 py-2 text-xs',
          canApprove
            ? 'border-indigo-200 bg-indigo-50/50 text-indigo-800 dark:border-indigo-900/60 dark:bg-indigo-950/20 dark:text-indigo-300'
            : 'border-amber-200 bg-amber-50/50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300',
        )}
      >
        {canApprove ? (
          <>
            Signed in as <span className="font-semibold">{currentUser}</span>. Approvals need two distinct approvers:{' '}
            <span className="font-mono">{DISPUTE_APPROVERS.join(', ')}</span>. Deny is single-step.
          </>
        ) : (
          <>
            You can review disputes but not act on them. Only{' '}
            <span className="font-mono">{DISPUTE_APPROVERS.join(', ')}</span> can approve, deny, or edit.
          </>
        )}
      </div>

      {/* Summary cards */}
      <div className="flex shrink-0 gap-3">
        <Card className="flex-1 border-amber-200 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <Clock className="h-4 w-4 text-amber-500" />
            <div>
              <p className="text-lg font-bold text-amber-700 dark:text-amber-400">{pendingCount}</p>
              <p className="text-[10px] text-amber-600/70 dark:text-amber-500/70">Pending</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1 border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <div>
              <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{approvedCount}</p>
              <p className="text-[10px] text-emerald-600/70 dark:text-emerald-500/70">Approved</p>
            </div>
          </CardContent>
        </Card>
        <Card className="flex-1 border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20">
          <CardContent className="flex items-center gap-2 p-3">
            <XCircle className="h-4 w-4 text-rose-500" />
            <div>
              <p className="text-lg font-bold text-rose-700 dark:text-rose-400">{deniedCount}</p>
              <p className="text-[10px] text-rose-600/70 dark:text-rose-500/70">Denied</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-end">
        <div className="max-w-md flex-1 space-y-1.5">
          <Label htmlFor="dispute-search" className="text-xs text-zinc-600 dark:text-zinc-500">Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
            <Input
              id="dispute-search"
              placeholder="Email, reason, date..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-9 border-zinc-200 bg-white pl-9 text-zinc-900 placeholder:text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
            />
          </div>
        </div>
        <div className="w-full space-y-1.5 sm:w-44">
          <Label htmlFor="dispute-status" className="text-xs text-zinc-600 dark:text-zinc-500">Status</Label>
          <select
            id="dispute-status"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
            className="h-9 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-200"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading disputes...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">
            {disputes.length === 0 ? 'No disputes filed yet.' : 'No disputes match your filters.'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div className="flex shrink-0 items-center justify-between text-xs text-zinc-600 dark:text-zinc-500">
            <span>
              Showing <span className="font-mono">{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}</span> of <span className="font-mono">{filtered.length}</span>
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-8" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <span className="px-2 font-mono">{safePage} / {totalPages}</span>
              <Button variant="outline" size="sm" className="h-8" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-gradient-to-r from-orange-50/95 to-blue-50/60 backdrop-blur-sm dark:from-blue-950/90 dark:to-blue-950/70">
                <TableRow className="border-zinc-200 hover:bg-transparent dark:border-zinc-800">
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Employee</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Date</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Reason</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Explanation</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Status</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Added time</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Decision</TableHead>
                  <TableHead className="w-[140px] text-right text-zinc-600 dark:text-zinc-400">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map(d => (
                  <TableRow key={d.id} className="border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40">
                    <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{d.work_email}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-zinc-700 dark:text-zinc-300">{d.dispute_date}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{reasonLabel(d.reason)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs text-zinc-600 dark:text-zinc-400" title={d.explanation ?? ''}>
                      {d.explanation || '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_BADGE[d.status]?.className)}>
                          {STATUS_BADGE[d.status]?.label ?? d.status}
                        </Badge>
                        {d.status === 'pending' && d.first_approved_by && (
                          <span className="font-mono text-[9px] text-indigo-600 dark:text-indigo-400" title={`First approved by ${d.first_approved_by}`}>
                            1/2 · {d.first_approved_by.split('@')[0]}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {formatAddedTime(d.override_hours) ? (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                          +{formatAddedTime(d.override_hours)}
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-400">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-zinc-500 dark:text-zinc-400">
                      {d.decided_by ? (
                        <div className="flex flex-col gap-0.5">
                          <span>{d.decided_by}</span>
                          {d.decision_note && <span className="text-[10px] italic">{d.decision_note}</span>}
                        </div>
                      ) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.status === 'pending' ? (() => {
                        const firstLower = d.first_approved_by?.trim().toLowerCase() ?? null;
                        const iAmFirst = !!firstLower && firstLower === currentUser;
                        const approveLabel = !d.first_approved_by
                          ? 'Approve'
                          : iAmFirst
                            ? 'Awaiting 2nd'
                            : 'Finalize';
                        const approveDisabled = !canApprove || iAmFirst;
                        const approveTooltip = !canApprove
                          ? 'Only Carla or Fran can approve'
                          : iAmFirst
                            ? 'You already cast the first approval — the other approver must finalize'
                            : undefined;
                        return (
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={approveDisabled}
                              title={approveTooltip}
                              className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400"
                              onClick={() => {
                                setDecideDialog({ dispute: d, action: 'approve' });
                                setDecisionNote(d.first_approved_note ?? '');
                                const oh = d.first_approved_override_hours ?? 0;
                                const totalMins = Math.round(oh * 60);
                                setOverrideHrs(totalMins > 0 ? String(Math.floor(totalMins / 60)) : '');
                                setOverrideMins(totalMins > 0 ? String(totalMins % 60) : '');
                              }}
                            >
                              {approveLabel}
                            </Button>
                            {iAmFirst && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-amber-300 px-2 text-[11px] text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
                                onClick={() => handleRevokeFirst(d)}
                                title="Revoke your first approval"
                              >
                                Revoke
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canApprove}
                              title={!canApprove ? 'Only Carla or Fran can deny' : undefined}
                              className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                              onClick={() => { setDecideDialog({ dispute: d, action: 'deny' }); setDecisionNote(''); setOverrideHrs(''); setOverrideMins(''); }}
                            >
                              Deny
                            </Button>
                          </div>
                        );
                      })() : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canApprove}
                          title={!canApprove ? 'Only Carla or Fran can edit' : undefined}
                          className="h-7 border-zinc-300 px-2 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                          onClick={() => openEdit(d)}
                        >
                          <Pencil className="mr-1 h-3 w-3" />
                          Edit
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Decide confirmation dialog */}
      {decideDialog && (() => {
        const firstBy = decideDialog.dispute.first_approved_by;
        const isFinalizing = decideDialog.action === 'approve' && !!firstBy;
        const title = decideDialog.action === 'deny'
          ? 'Deny dispute'
          : isFinalizing
            ? 'Finalize approval (2/2)'
            : 'Cast first approval (1/2)';
        return (
        <Dialog open onOpenChange={() => { setDecideDialog(null); setDecisionNote(''); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">{title}</DialogTitle>
              <DialogDescription className="text-xs">
                {decideDialog.dispute.work_email} — {decideDialog.dispute.dispute_date} — {reasonLabel(decideDialog.dispute.reason)}
                {isFinalizing && (
                  <span className="mt-1 block rounded-md border border-indigo-200 bg-indigo-50/60 px-2 py-1 text-[10px] text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/20 dark:text-indigo-300">
                    First approved by <span className="font-semibold">{firstBy}</span>
                    {decideDialog.dispute.first_approved_override_hours != null && decideDialog.dispute.first_approved_override_hours > 0 && (
                      <> · proposed +{formatAddedTime(decideDialog.dispute.first_approved_override_hours)}</>
                    )}
                    . You can adjust and confirm, or deny instead.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {decideDialog.action === 'approve' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Additional time (e.g. time at orphanage)</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="16"
                        placeholder="0"
                        value={overrideHrs}
                        onChange={e => setOverrideHrs(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">hrs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="59"
                        placeholder="0"
                        value={overrideMins}
                        onChange={e => setOverrideMins(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">mins</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Added on top of Hubstaff-logged time for PAB. E.g. 6h 30m Hubstaff + 0h 30m added = 7h total. Original Hubstaff data stays untouched.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Decision note (optional)</Label>
                <textarea
                  value={decisionNote}
                  onChange={e => setDecisionNote(e.target.value)}
                  rows={2}
                  placeholder="Optional note..."
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => setDecideDialog(null)} disabled={deciding}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleDecide}
                disabled={deciding}
                className={decideDialog.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}
              >
                {deciding && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                {decideDialog.action === 'deny'
                  ? 'Deny'
                  : isFinalizing
                    ? 'Finalize approval'
                    : 'Cast first approval'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        );
      })()}

      {/* Edit dialog */}
      {editDialog && (
        <Dialog open onOpenChange={() => setEditDialog(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Edit dispute decision</DialogTitle>
              <DialogDescription className="text-xs">
                {editDialog.work_email} — {editDialog.dispute_date} — {reasonLabel(editDialog.reason)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Status</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={editStatus === 'approved' ? 'default' : 'outline'}
                    onClick={() => setEditStatus('approved')}
                    className={cn('flex-1 h-8 text-xs', editStatus === 'approved' && 'bg-emerald-600 hover:bg-emerald-700')}
                  >
                    Approved
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={editStatus === 'denied' ? 'default' : 'outline'}
                    onClick={() => setEditStatus('denied')}
                    className={cn('flex-1 h-8 text-xs', editStatus === 'denied' && 'bg-rose-600 hover:bg-rose-700')}
                  >
                    Denied
                  </Button>
                </div>
              </div>
              {editStatus === 'approved' && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Additional time</Label>
                    {formatAddedTime(editDialog.override_hours) && (
                      <span className="font-mono text-[10px] text-zinc-500">
                        On record: <span className="font-semibold text-emerald-700 dark:text-emerald-400">+{formatAddedTime(editDialog.override_hours)}</span>
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="16"
                        placeholder="0"
                        value={editHrs}
                        onChange={e => setEditHrs(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">hrs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        max="59"
                        placeholder="0"
                        value={editMins}
                        onChange={e => setEditMins(e.target.value)}
                        className="h-9 w-20 text-sm"
                      />
                      <span className="text-xs text-zinc-500">mins</span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => { setEditHrs(''); setEditMins(''); }}
                      disabled={!editHrs && !editMins}
                      className="h-9 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:border-zinc-200 disabled:text-zinc-400 dark:border-rose-700 dark:text-rose-400"
                    >
                      Clear
                    </Button>
                  </div>
                  <p className="text-[10px] text-zinc-500">
                    Click "Clear" then Save to remove the added time entirely. Employee calendar updates on save.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="text-xs">Decision note</Label>
                <textarea
                  value={editNote}
                  onChange={e => setEditNote(e.target.value)}
                  rows={2}
                  placeholder="Optional note…"
                  className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditDialog(null)} disabled={editing}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleEdit}
                disabled={editing}
                className={editStatus === 'approved' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}
              >
                {editing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
