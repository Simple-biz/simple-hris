'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { normEmail } from '@/lib/email/norm-email';
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
  Undo2,
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
import { DISPUTE_ACTOR_ROLES, disputeGrantsPabForgiveness } from '@/lib/supabase/pab-day-disputes';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';

const PAGE_SIZE = 15;

function formatHours(hours: number | null | undefined): string | null {
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
  pending_orphanage_manager: { label: 'Awaiting orphanage review', className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400' },
  orphanage_manager_approved: { label: 'Awaiting accounting', className: 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-300' },
  orphanage_manager_denied: { label: 'Orph. mgr denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
  approved: { label: 'Approved', className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  accounting_approved: { label: 'Accounting approved', className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  denied: { label: 'Denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
  accounting_denied: { label: 'Accounting denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
};

export default function PabDisputeQueue() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');
  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setCurrentUser(normalized);
        return;
      }
      const e = sessionStorage.getItem(SESSION_EMAIL_KEY);
      setCurrentUser(e ? e.trim().toLowerCase() : null);
    } catch { /* ignore */ }
  }, [emailFromQuery]);
  useEffect(() => {
    if (!currentUser) { setCanApprove(false); return; }
    let cancelled = false;
    fetch(`/api/employee-roles?email=${encodeURIComponent(currentUser)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((j: { rows?: { role: string }[] }) => {
        if (cancelled) return;
        const roles = (j.rows ?? []).map(r => r.role);
        setCanApprove(roles.some(r => DISPUTE_ACTOR_ROLES.includes(r)));
      })
      .catch(() => { if (!cancelled) setCanApprove(false); });
    return () => { cancelled = true; };
  }, [currentUser]);

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
  const [revokeForgivenessOpen, setRevokeForgivenessOpen] = useState(false);

  const [returnToOrphanageRow, setReturnToOrphanageRow] = useState<PabDayDisputeRow | null>(null);
  const [returnNote, setReturnNote] = useState('');
  const [returning, setReturning] = useState(false);

  const openEdit = useCallback((row: PabDayDisputeRow) => {
    setEditDialog(row);
    const denied =
      row.status === 'denied' ||
      row.status === 'accounting_denied' ||
      row.status === 'orphanage_manager_denied';
    setEditStatus(denied ? 'denied' : 'approved');
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
      params.set('limit', '500');
      if (statusFilter === 'pending') {
        params.set('awaiting_accounting', '1');
      } else if (statusFilter === 'approved') {
        params.append('status', 'approved');
        params.append('status', 'accounting_approved');
      } else if (statusFilter === 'denied') {
        params.append('status', 'denied');
        params.append('status', 'orphanage_manager_denied');
        params.append('status', 'accounting_denied');
      }
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

  const pendingCount = useMemo(
    () => disputes.filter((d) => d.status === 'pending' || d.status === 'orphanage_manager_approved').length,
    [disputes],
  );
  const approvedCount = useMemo(
    () => disputes.filter((d) => d.status === 'approved' || d.status === 'accounting_approved').length,
    [disputes],
  );
  const deniedCount = useMemo(
    () =>
      disputes.filter(
        (d) =>
          d.status === 'denied' ||
          d.status === 'orphanage_manager_denied' ||
          d.status === 'accounting_denied',
      ).length,
    [disputes],
  );

  const handleEdit = useCallback(async () => {
    if (!editDialog) return;
    setEditing(true);
    try {
      const hrs = parseInt(editHrs, 10);
      const mins = parseInt(editMins, 10);
      const safeHrs = Number.isFinite(hrs) && hrs >= 0 ? hrs : 0;
      const safeMins = Number.isFinite(mins) && mins >= 0 ? mins : 0;
      const totalHours = safeHrs + safeMins / 60;
      // Empty inputs → no override (fall back to Hubstaff). Explicit 0 → zero-out the day.
      const hasInput = editHrs.trim() !== '' || editMins.trim() !== '';
      const isOrphan = editDialog.reason === 'orphanage_visit';
      const overrideToSend =
        isOrphan
          ? null
          : editStatus === 'approved' && hasInput
            ? totalHours
            : null;
      const res = await fetch(`/api/pab-disputes/${editDialog.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          status: editStatus,
          decided_by: currentUser ?? '',
          decision_note: editNote.trim() || null,
          override_hours: overrideToSend,
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

  const handleRevokeForgiveness = useCallback(async () => {
    if (!editDialog) return;
    setEditing(true);
    try {
      const res = await fetch(`/api/pab-disputes/${editDialog.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          status: 'denied',
          decided_by: currentUser ?? '',
          decision_note: editNote.trim() || null,
          override_hours: null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('PAB forgiveness revoked — dispute marked denied');
      setRevokeForgivenessOpen(false);
      setEditDialog(null);
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke forgiveness');
    } finally {
      setEditing(false);
    }
  }, [editDialog, editNote, currentUser, fetchDisputes]);

  const handleDecide = useCallback(async () => {
    if (!decideDialog) return;
    setDeciding(true);
    try {
      const hrs = parseInt(overrideHrs, 10);
      const mins = parseInt(overrideMins, 10);
      const safeHrs = Number.isFinite(hrs) && hrs >= 0 ? hrs : 0;
      const safeMins = Number.isFinite(mins) && mins >= 0 ? mins : 0;
      const totalHours = safeHrs + safeMins / 60;
      // Empty inputs → no override (fall back to Hubstaff). Explicit 0 → zero-out the day.
      const hasInput = overrideHrs.trim() !== '' || overrideMins.trim() !== '';
      const isOrphan = decideDialog.dispute.reason === 'orphanage_visit';
      const overrideToSend =
        isOrphan
          ? null
          : decideDialog.action === 'approve' && hasInput
            ? totalHours
            : null;
      const res = await fetch(`/api/pab-disputes/${decideDialog.dispute.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: decideDialog.action,
          decided_by: currentUser ?? '',
          decision_note: decisionNote.trim() || null,
          override_hours: overrideToSend,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success(decideDialog.action === 'approve' ? 'Dispute approved' : 'Dispute denied');
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

  const handleReturnToOrphanage = useCallback(async () => {
    if (!returnToOrphanageRow) return;
    setReturning(true);
    try {
      const res = await fetch(`/api/pab-disputes/${returnToOrphanageRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'return_to_orphanage',
          decided_by: currentUser ?? '',
          decision_note: returnNote.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      toast.success('Returned to Orphanage queue for re-review');
      setReturnToOrphanageRow(null);
      setReturnNote('');
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to return dispute');
    } finally {
      setReturning(false);
    }
  }, [returnToOrphanageRow, returnNote, currentUser, fetchDisputes]);

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
              Approval queue for short-day disputes. Any Accounting user can approve or deny.
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
            Signed in as <span className="font-semibold">{currentUser}</span>. Any Accounting user can approve or deny.
          </>
        ) : (
          <>
            You can review disputes but not act on them. Approve, Deny, Return, and Edit require payroll_coordinator,
            payroll_manager, finance, hr_coordinator, or admin in employee_roles.
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
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Set hours</TableHead>
                  <TableHead className="text-zinc-600 dark:text-zinc-400">Decision</TableHead>
                  <TableHead className="min-w-[220px] text-right text-zinc-600 dark:text-zinc-400">Action</TableHead>
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
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {d.reason === 'orphanage_visit' ? (
                        <span className="text-[10px] text-zinc-400" title="Uses logged Hubstaff time">
                          Hubstaff
                        </span>
                      ) : formatHours(d.override_hours) ? (
                        <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                          {formatHours(d.override_hours)}
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
                    <TableCell className="min-w-[220px] text-right align-top">
                      {d.status === 'pending' || d.status === 'orphanage_manager_approved' ? (
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canApprove}
                            title={!canApprove ? 'Requires payroll_coordinator, payroll_manager, finance, hr_coordinator, or admin' : undefined}
                            className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400"
                            onClick={() => {
                              setDecideDialog({ dispute: d, action: 'approve' });
                              setDecisionNote('');
                              setOverrideHrs('');
                              setOverrideMins('');
                            }}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canApprove}
                            title={!canApprove ? 'Requires payroll_coordinator, payroll_manager, finance, hr_coordinator, or admin' : undefined}
                            className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                            onClick={() => { setDecideDialog({ dispute: d, action: 'deny' }); setDecisionNote(''); setOverrideHrs(''); setOverrideMins(''); }}
                          >
                            Deny
                          </Button>
                          {d.reason === 'orphanage_visit' && d.status === 'orphanage_manager_approved' && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canApprove}
                              title={!canApprove ? 'Requires payroll_coordinator, payroll_manager, finance, hr_coordinator, or admin' : 'Send back to Orphanage managers'}
                              className="h-7 border-amber-300 px-2 text-[11px] text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-700 dark:text-amber-300"
                              onClick={() => {
                                setReturnToOrphanageRow(d);
                                setReturnNote('');
                              }}
                            >
                              <Undo2 className="mr-1 h-3 w-3" />
                              Return
                            </Button>
                          )}
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canApprove}
                          title={!canApprove ? 'Requires payroll_coordinator, payroll_manager, finance, hr_coordinator, or admin' : undefined}
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
      {decideDialog && (
        <Dialog open onOpenChange={() => { setDecideDialog(null); setDecisionNote(''); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {decideDialog.action === 'deny' ? 'Deny dispute' : 'Approve dispute'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {decideDialog.dispute.work_email} — {decideDialog.dispute.dispute_date} — {reasonLabel(decideDialog.dispute.reason)}
                {decideDialog.dispute.reason === 'orphanage_visit' && decideDialog.action === 'approve' && (
                  <span className="mt-1 block text-[10px] text-zinc-500">
                    Orphanage visits keep Hubstaff hours — no manual hour entry. Final calendar forgiveness applies after Accounting approves.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {decideDialog.action === 'approve' && decideDialog.dispute.reason !== 'orphanage_visit' && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Set total hours for this day</Label>
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
                    Replaces Hubstaff hours for this day. E.g. set 7h to make the PAB calendar show 7h for this date, regardless of what Hubstaff logged. Original Hubstaff data stays untouched.
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
                {decideDialog.action === 'deny' ? 'Deny' : 'Approve'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Edit dialog */}
      {editDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setEditDialog(null);
              setRevokeForgivenessOpen(false);
            }
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Edit dispute decision</DialogTitle>
              <DialogDescription className="text-xs">
                {editDialog.work_email} — {editDialog.dispute_date} — {reasonLabel(editDialog.reason)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {disputeGrantsPabForgiveness(editDialog) && (
                <div className="space-y-2 rounded-md border border-amber-200/90 bg-amber-50/80 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/25">
                  <p className="text-[11px] leading-snug text-amber-950 dark:text-amber-100/95">
                    This dispute currently <span className="font-semibold">forgives the PAB short-day</span> for this date
                    {editDialog.reason === 'orphanage_visit'
                      ? ' (and may affect the day after per orphanage rules).'
                      : '.'}{' '}
                    Revoking removes that forgiveness and marks the dispute <span className="font-medium">denied</span>.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canApprove || editing}
                    title={!canApprove ? 'Requires payroll_coordinator, payroll_manager, finance, hr_coordinator, or admin' : undefined}
                    className="h-8 w-full border-rose-300 text-[11px] text-rose-800 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-200 dark:hover:bg-rose-950/40"
                    onClick={() => setRevokeForgivenessOpen(true)}
                  >
                    Revoke PAB forgiveness
                  </Button>
                </div>
              )}
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
              {editStatus === 'approved' && editDialog.reason !== 'orphanage_visit' && (() => {
                const prevHours = editDialog.override_hours ?? 0;
                const hrs = parseInt(editHrs, 10);
                const mins = parseInt(editMins, 10);
                const safeHrs = Number.isFinite(hrs) && hrs >= 0 ? hrs : 0;
                const safeMins = Number.isFinite(mins) && mins >= 0 ? mins : 0;
                const nextHours = safeHrs + safeMins / 60;
                const deltaHours = nextHours - prevHours;
                const hasChange = Math.abs(deltaHours) > 1 / 3600; // more than 1 sec diff
                const prevLabel = formatHours(prevHours) ?? '—';
                const nextLabel = formatHours(nextHours) ?? '—';
                const deltaLabel = formatHours(Math.abs(deltaHours));
                return (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Set total hours for this day</Label>
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
                    {/* Before → after preview */}
                    <div className="rounded-md border border-zinc-200 bg-zinc-50/60 px-2.5 py-2 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/40">
                      <div className="flex items-center justify-between gap-2 font-mono">
                        <span className="text-zinc-500">Before</span>
                        <span className={cn('font-semibold', prevHours > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-400')}>
                          {prevHours > 0 ? prevLabel : 'uses Hubstaff'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 font-mono">
                        <span className="text-zinc-500">After</span>
                        <span className={cn('font-semibold', nextHours > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-400')}>
                          {nextHours > 0 ? nextLabel : 'uses Hubstaff'}
                        </span>
                      </div>
                      {hasChange && (
                        <div className="mt-1 flex items-center justify-between gap-2 border-t border-zinc-200 pt-1 font-mono dark:border-zinc-800">
                          <span className="text-zinc-500">Change</span>
                          <span
                            className={cn(
                              'font-semibold',
                              deltaHours > 0
                                ? 'text-emerald-700 dark:text-emerald-400'
                                : 'text-rose-700 dark:text-rose-400',
                            )}
                          >
                            {deltaHours > 0 ? '+' : '−'}{deltaLabel}
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-500">
                      {prevHours > 0 && nextHours === 0
                        ? `Saving will clear the override — the PAB calendar will use Hubstaff hours for this day again.`
                        : 'Click "Clear" then Save to remove the override entirely. Employee calendar updates on save.'}
                    </p>
                  </div>
                );
              })()}
              {editStatus === 'approved' && editDialog.reason === 'orphanage_visit' && (
                <p className="rounded-md border border-zinc-200 bg-zinc-50/80 px-2.5 py-2 text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                  Orphanage visits do not use hour overrides — PAB uses logged time and orphanage forgiveness rules.
                </p>
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

      {revokeForgivenessOpen && editDialog && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setRevokeForgivenessOpen(false);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Revoke PAB forgiveness?</DialogTitle>
              <DialogDescription className="text-xs">
                {editDialog.work_email} — {editDialog.dispute_date}. The employee’s calendar will no longer treat this day
                as forgiven; the dispute will be recorded as <span className="font-medium">denied</span>.
                {editDialog.reason === 'orphanage_visit' && (
                  <span className="mt-1 block">Orphanage day-after rules also stop applying from this dispute.</span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label className="text-xs">Note (optional)</Label>
              <textarea
                value={editNote}
                onChange={e => setEditNote(e.target.value)}
                rows={2}
                placeholder="Reason for revoking…"
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => setRevokeForgivenessOpen(false)} disabled={editing}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-rose-600 hover:bg-rose-700"
                onClick={() => void handleRevokeForgiveness()}
                disabled={editing}
              >
                {editing && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Revoke forgiveness
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {returnToOrphanageRow && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) {
              setReturnToOrphanageRow(null);
              setReturnNote('');
            }
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Return to Orphanage queue?</DialogTitle>
              <DialogDescription className="text-xs">
                {returnToOrphanageRow.work_email} — {returnToOrphanageRow.dispute_date}. The dispute goes back to
                Orphanage Manager review (not final denied). Use when documentation needs another pass.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label className="text-xs">Note to Orphanage managers (optional)</Label>
              <textarea
                value={returnNote}
                onChange={(e) => setReturnNote(e.target.value)}
                rows={3}
                placeholder="e.g. Need signed roster or confirmation of visit date."
                className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReturnToOrphanageRow(null);
                  setReturnNote('');
                }}
                disabled={returning}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700"
                onClick={() => void handleReturnToOrphanage()}
                disabled={returning}
              >
                {returning && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Return to Orphanage
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
