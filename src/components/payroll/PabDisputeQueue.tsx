'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { normEmail } from '@/lib/email/norm-email';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Clock,
  Eye,
  Gavel,
  Landmark,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SmoothSelect } from '@/components/ui/smooth-select';
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
import {
  DISPUTE_ACTOR_ROLES,
  DISPUTE_DELETE_ROLES,
  disputeGrantsPabForgiveness,
  isOrphanageStyleReason,
} from '@/lib/supabase/pab-day-disputes';
import type { BankPreferredRequestRow } from '@/lib/supabase/bank-preferred-requests';
import {
  bankPreferredLabelForProcessor,
  isWiresPreferred,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';

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

/** Human label for a Bank Preferred processor id ('None' for a first-time set). */
function bankLabel(v: string | null): string {
  if (!v) return 'None';
  return bankPreferredLabelForProcessor(v as ProcessorId) || v;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400' },
  superseded: { label: 'Superseded', className: 'border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-400' },
  pending_orphanage_manager: { label: 'Awaiting orphanage review', className: 'border-amber-400 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-400' },
  orphanage_manager_approved: { label: 'Awaiting accounting', className: 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-600 dark:bg-sky-950/40 dark:text-sky-300' },
  orphanage_manager_denied: { label: 'Orph. mgr denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
  approved: { label: 'Approved', className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  accounting_approved: { label: 'Accounting approved', className: 'border-emerald-400 bg-emerald-50 text-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400' },
  denied: { label: 'Denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
  accounting_denied: { label: 'Accounting denied', className: 'border-rose-400 bg-rose-50 text-rose-700 dark:border-rose-600 dark:bg-rose-950/40 dark:text-rose-400' },
};

/** MESA-style KPI card — gradient tint, uppercase label, big mono value, and a
 *  faint corner icon. Tones stay on the accounting indigo/violet theme (plus the
 *  usual amber/emerald/rose status semantics) — no green/teal accent. */
function StatCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'indigo' | 'amber' | 'emerald' | 'rose';
  icon: LucideIcon;
}) {
  const styles = {
    indigo:
      'border-indigo-200 bg-gradient-to-br from-indigo-50 to-white text-indigo-900 dark:border-indigo-700/40 dark:from-indigo-950/40 dark:to-zinc-950 dark:text-indigo-100',
    amber:
      'border-amber-200 bg-gradient-to-br from-amber-50 to-white text-amber-900 dark:border-amber-700/40 dark:from-amber-950/40 dark:to-zinc-950 dark:text-amber-100',
    emerald:
      'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white text-emerald-900 dark:border-emerald-700/40 dark:from-emerald-950/40 dark:to-zinc-950 dark:text-emerald-100',
    rose:
      'border-rose-200 bg-gradient-to-br from-rose-50 to-white text-rose-900 dark:border-rose-700/40 dark:from-rose-950/40 dark:to-zinc-950 dark:text-rose-100',
  }[tone];
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border p-4 shadow-sm',
        'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none',
        styles,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
        <Icon className="h-4 w-4 opacity-40 transition-all duration-200 group-hover:scale-110 group-hover:opacity-70" aria-hidden />
      </div>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

/** One row of the merged Issues table — a PAB short-day dispute or a Bank
 *  Preferred change request. Both are a yes/no for Accounting. */
type IssueRow =
  | { kind: 'dispute'; dispute: PabDayDisputeRow }
  | { kind: 'bank'; request: BankPreferredRequestRow };

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="mt-0.5 break-words text-sm text-zinc-800 dark:text-zinc-200">{value}</p>
    </div>
  );
}

export default function PabDisputeQueue() {
  const [currentUser, setCurrentUser] = useState<string | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;
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
    if (!currentUser) { setCanApprove(false); setCanDelete(false); return; }
    let cancelled = false;
    fetch(`/api/employee-roles?email=${encodeURIComponent(currentUser)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then((j: { rows?: { role: string }[] }) => {
        if (cancelled) return;
        const roles = (j.rows ?? []).map(r => r.role);
        setCanApprove(roles.some(r => DISPUTE_ACTOR_ROLES.includes(r)));
        setCanDelete(roles.some(r => DISPUTE_DELETE_ROLES.includes(r)));
      })
      .catch(() => { if (!cancelled) { setCanApprove(false); setCanDelete(false); } });
    return () => { cancelled = true; };
  }, [currentUser]);

  // Default filter is 'pending'; seed disputes + spinner from that filter's
  // cached snapshot so re-opening the tab paints instantly.
  const [disputes, setDisputes] = useState<PabDayDisputeRow[]>(
    () => getTabCache<PabDayDisputeRow[]>(TAB_CACHE_KEYS.pabDisputes('pending')) ?? [],
  );
  // Bank Preferred change requests live in the same table (merged 2026-09-01,
  // they're a yes/no like every other issue). Cached per filter like disputes.
  const [bankRequests, setBankRequests] = useState<BankPreferredRequestRow[]>(
    () => getTabCache<BankPreferredRequestRow[]>(TAB_CACHE_KEYS.bankPreferredRequests('pending')) ?? [],
  );
  const [bankError, setBankError] = useState<string | null>(null);
  const [reasonCodes, setReasonCodes] = useState<PabDisputeReasonCode[]>(
    () => getTabCache<PabDisputeReasonCode[]>(TAB_CACHE_KEYS.pabReasonCodes) ?? [],
  );
  const [loading, setLoading] = useState(!hasTabCache(TAB_CACHE_KEYS.pabDisputes('pending')));
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

  const [deleteTarget, setDeleteTarget] = useState<PabDayDisputeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [approvingId, setApprovingId] = useState<string | null>(null);

  // Read-only detail modal (the "View" action) — opens over the table.
  const [viewTarget, setViewTarget] = useState<PabDayDisputeRow | null>(null);

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
    const cacheKey = TAB_CACHE_KEYS.pabDisputes(statusFilter);
    const bankCacheKey = TAB_CACHE_KEYS.bankPreferredRequests(statusFilter);
    const cached = getTabCache<PabDayDisputeRow[]>(cacheKey);
    const cachedBank = getTabCache<BankPreferredRequestRow[]>(bankCacheKey);
    if (cached) {
      // Paint the cached rows for this filter immediately (covers switching
      // filters too) and revalidate quietly without a spinner.
      setDisputes(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    if (cachedBank) setBankRequests(cachedBank);

    // Bank Preferred requests load alongside the disputes; a failure on one
    // never blanks the other (each keeps its cached rows).
    const bankPromise = (async () => {
      try {
        const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`;
        const res = await fetch(`/api/bank-preferred-requests${qs}`, { cache: 'no-store' });
        const json = (await res.json()) as { rows?: BankPreferredRequestRow[]; error?: string | null };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load Bank Preferred requests');
        const rows = json.rows ?? [];
        setTabCache(bankCacheKey, rows);
        setBankRequests(rows);
        setBankError(null);
      } catch (e) {
        if (!hasTabCache(bankCacheKey)) setBankRequests([]);
        setBankError(e instanceof Error ? e.message : 'Failed to load Bank Preferred requests');
      }
    })();

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
      const rows = (json.rows ?? []) as PabDayDisputeRow[];
      setTabCache(cacheKey, rows);
      setDisputes(rows);
    } catch {
      // Keep the cached rows on a background-refresh failure.
      if (!hasTabCache(cacheKey)) setDisputes([]);
    } finally {
      await bankPromise;
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { fetchDisputes(); }, [fetchDisputes]);

  // Approve/deny a Bank Preferred change request. The PATCH is the real gate —
  // it re-checks the 1:1 rule against the employee's LIVE receiving bank and
  // fails closed, so the row never pre-judges approvability (advisory only).
  const [bankActingId, setBankActingId] = useState<string | null>(null);
  const decideBankRequest = useCallback(
    async (row: BankPreferredRequestRow, status: 'approved' | 'denied') => {
      setBankActingId(row.id);
      try {
        const res = await fetch(`/api/bank-preferred-requests/${row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Action failed');
        toast.success(
          status === 'approved'
            ? `Approved — ${bankLabel(row.to_value)} is now active for ${row.employee_name || row.work_email}.`
            : `Denied ${row.employee_name || row.work_email}'s Bank Preferred change.`,
        );
        fetchDisputes();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Action failed');
      } finally {
        setBankActingId(null);
      }
    },
    [fetchDisputes],
  );

  const handleApprove = useCallback(async (d: PabDayDisputeRow) => {
    setApprovingId(d.id);
    try {
      const res = await fetch(`/api/pab-disputes/${d.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', decided_by: currentUser ?? '' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');
      toast.success('Issue approved');
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to approve issue');
    } finally {
      setApprovingId(null);
    }
  }, [currentUser, fetchDisputes]);

  useEffect(() => {
    fetch('/api/app-settings?key=pab_dispute_reason_codes', { cache: 'no-store' })
      .then(r => r.json())
      .then((json: { value: string | null }) => {
        try {
          const codes = JSON.parse(json.value ?? '[]') as PabDisputeReasonCode[];
          const next = Array.isArray(codes) ? codes : [];
          setTabCache(TAB_CACHE_KEYS.pabReasonCodes, next);
          setReasonCodes(next);
        } catch {
          if (!hasTabCache(TAB_CACHE_KEYS.pabReasonCodes)) setReasonCodes([]);
        }
      })
      .catch(() => {
        if (!hasTabCache(TAB_CACHE_KEYS.pabReasonCodes)) setReasonCodes([]);
      });
  }, []);

  const reasonLabel = useCallback((code: string) => {
    return reasonCodes.find(r => r.code === code)?.label ?? code;
  }, [reasonCodes]);

  const filtered = useMemo<IssueRow[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const bank: IssueRow[] = bankRequests
      .filter(r => {
        if (!q) return true;
        const blob = [r.work_email, r.employee_name ?? '', bankLabel(r.from_value), bankLabel(r.to_value), r.reviewed_by ?? '', 'bank preferred'].join(' ').toLowerCase();
        return blob.includes(q);
      })
      .map(r => ({ kind: 'bank' as const, request: r }));
    const disp: IssueRow[] = disputes
      .filter(d => {
        if (!q) return true;
        const blob = [d.work_email, d.reason, d.dispute_date, d.explanation ?? '', d.decided_by ?? ''].join(' ').toLowerCase();
        return blob.includes(q);
      })
      .map(d => ({ kind: 'dispute' as const, dispute: d }));
    // Bank rows first — a pending request holds the employee's payout routing
    // until it's decided (same slot they occupied as a card above the table).
    return [...bank, ...disp];
  }, [disputes, bankRequests, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  useEffect(() => { setPage(1); }, [searchQuery, statusFilter]);

  const pendingCount = useMemo(
    () =>
      disputes.filter((d) => d.status === 'pending' || d.status === 'orphanage_manager_approved').length +
      bankRequests.filter((r) => r.status === 'pending').length,
    [disputes, bankRequests],
  );
  const approvedCount = useMemo(
    () =>
      disputes.filter((d) => d.status === 'approved' || d.status === 'accounting_approved').length +
      bankRequests.filter((r) => r.status === 'approved').length,
    [disputes, bankRequests],
  );
  const deniedCount = useMemo(
    () =>
      disputes.filter(
        (d) =>
          d.status === 'denied' ||
          d.status === 'orphanage_manager_denied' ||
          d.status === 'accounting_denied',
      ).length +
      bankRequests.filter((r) => r.status === 'denied').length,
    [disputes, bankRequests],
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
      const isOrphan = isOrphanageStyleReason(editDialog.reason);
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
      toast.success('Issue updated');
      setEditDialog(null);
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update issue');
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
      toast.success('PAB forgiveness revoked — issue marked denied');
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
      const isOrphan = isOrphanageStyleReason(decideDialog.dispute.reason);
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
      toast.success(decideDialog.action === 'approve' ? 'Issue approved' : 'Issue denied');
      setDecideDialog(null);
      setDecisionNote('');
      setOverrideHrs('');
      setOverrideMins('');
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to process issue');
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
      toast.error(e instanceof Error ? e.message : 'Failed to return issue');
    } finally {
      setReturning(false);
    }
  }, [returnToOrphanageRow, returnNote, currentUser, fetchDisputes]);

  const handleAdminDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/pab-disputes/${deleteTarget.id}?mode=admin`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      toast.success('Issue deleted');
      setDeleteTarget(null);
      fetchDisputes();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete issue');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, fetchDisputes]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-gradient-to-br from-white via-indigo-50/40 to-violet-50/20 p-4 sm:p-5 dark:bg-none dark:bg-[#0d1117]">
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-sm shadow-indigo-500/20 dark:from-indigo-600 dark:to-violet-700">
            <Gavel className="h-5 w-5 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
              Issues
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Approval queue for short-day issues and Bank Preferred changes. Any Accounting user can approve or deny.
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
            You can review issues but not act on them. Approve, Deny, Return, and Edit require accounting,
            hr_coordinator, or admin in employee_roles.
          </>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total" value={disputes.length + bankRequests.length} tone="indigo" icon={ClipboardList} />
        <StatCard label="Pending" value={pendingCount} tone="amber" icon={Clock} />
        <StatCard label="Approved" value={approvedCount} tone="emerald" icon={CheckCircle2} />
        <StatCard label="Denied" value={deniedCount} tone="rose" icon={XCircle} />
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
          <Label className="text-xs text-zinc-600 dark:text-zinc-500">Status</Label>
          <SmoothSelect
            aria-label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
            triggerClassName="w-full sm:w-44"
            options={[
              { value: 'all', label: 'All' },
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'denied', label: 'Denied' },
            ]}
          />
        </div>
      </div>

      {/* Bank Preferred rows failed to refresh — the dispute rows still stand. */}
      {bankError && (
        <div className="shrink-0 rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          Bank Preferred change requests couldn&apos;t be refreshed: {bankError}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading issues...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
          <AlertCircle className="h-8 w-8 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">
            {disputes.length === 0 && bankRequests.length === 0 ? 'No issues filed yet.' : 'No issues match your filters.'}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
          <div data-readonly-allow className="flex shrink-0 items-center justify-between text-xs text-zinc-600 dark:text-zinc-500">
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
          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-indigo-100 shadow-sm dark:border-indigo-900/40">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-indigo-50/85 backdrop-blur-sm dark:bg-indigo-950/40">
                <TableRow className="border-indigo-100 hover:bg-transparent dark:border-indigo-900/40">
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Employee</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Date</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Reason</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Explanation</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Status</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Set hours</TableHead>
                  <TableHead className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Decision</TableHead>
                  <TableHead className="min-w-[260px] text-right text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                  if (row.kind === 'bank') {
                    const r = row.request;
                    const acting = bankActingId === r.id;
                    // ADVISORY only, under the 1:1 rule (2026-08-31 PM): whether a
                    // wallet send-from is approvable depends on the employee's LIVE
                    // receiving bank, which this row does not carry. The approve
                    // PATCH is the real gate (re-checks live, fails closed) — so the
                    // row hints at a rail change but never disables Approve.
                    const railChange = isWiresPreferred(r.from_value) !== isWiresPreferred(r.to_value);
                    return (
                      <TableRow key={`bank-${r.id}`} className="border-indigo-100/70 transition-colors hover:bg-indigo-50/50 dark:border-indigo-900/30 dark:hover:bg-indigo-950/20">
                        <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300" title={r.employee_name ?? undefined}>
                          {r.work_email}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-zinc-700 dark:text-zinc-300">
                          {new Date(r.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="gap-1 border-amber-300 bg-amber-50 text-[10px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            <Landmark className="h-3 w-3" />
                            Bank Preferred
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-[200px] align-top text-xs text-zinc-600 dark:text-zinc-400">
                          <div className="flex items-center gap-1.5">
                            <span className="rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                              {bankLabel(r.from_value)}
                            </span>
                            <ArrowRight className="h-3 w-3 shrink-0 text-zinc-400" />
                            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                              {bankLabel(r.to_value)}
                            </span>
                          </div>
                          {railChange && (
                            <p className="mt-1 text-[10px] font-medium leading-snug text-amber-600 dark:text-amber-400">
                              Rail change — approval is checked against the live receiving bank (1:1 rule).
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px]', STATUS_BADGE[r.status]?.className)}>
                            {STATUS_BADGE[r.status]?.label ?? r.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <span className="text-[10px] text-zinc-400">—</span>
                        </TableCell>
                        <TableCell className="text-xs text-zinc-500 dark:text-zinc-400">
                          {r.reviewed_by ? (
                            <div className="flex flex-col gap-0.5">
                              <span>{r.reviewed_by}</span>
                              {r.review_notes && <span className="text-[10px] italic">{r.review_notes}</span>}
                            </div>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="min-w-[260px] text-right align-top">
                          {r.status === 'pending' ? (
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={acting}
                                className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400"
                                title={
                                  railChange
                                    ? 'The save verifies the sending rail against this employee’s live receiving bank and refuses a mismatch.'
                                    : undefined
                                }
                                onClick={() => void decideBankRequest(r, 'approved')}
                              >
                                {acting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Approve'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={acting}
                                className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                                onClick={() => void decideBankRequest(r, 'denied')}
                              >
                                Deny
                              </Button>
                            </div>
                          ) : (
                            <span className="text-[10px] text-zinc-400">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  }
                  const d = row.dispute;
                  return (
                  <TableRow key={d.id} className="border-indigo-100/70 transition-colors hover:bg-indigo-50/50 dark:border-indigo-900/30 dark:hover:bg-indigo-950/20">
                    <TableCell className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{d.work_email}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-zinc-700 dark:text-zinc-300">{d.dispute_date}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[10px]">{reasonLabel(d.reason)}</Badge>
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-xs text-zinc-600 dark:text-zinc-400',
                        isOrphanageStyleReason(d.reason)
                          ? 'min-w-[240px] max-w-[320px] whitespace-pre-line align-top'
                          : 'max-w-[200px] truncate',
                      )}
                      title={d.explanation ?? ''}
                    >
                      {isOrphanageStyleReason(d.reason) && d.explanation ? (
                        <div className="space-y-1">
                          <Badge
                            variant="outline"
                            className="border-pink-200 bg-pink-50 text-[9px] text-pink-700 dark:border-pink-800/60 dark:bg-pink-950/40 dark:text-pink-300"
                          >
                            Manager note
                          </Badge>
                          <p className="leading-snug">{d.explanation}</p>
                        </div>
                      ) : (
                        d.explanation || '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Badge variant="outline" className={cn('text-[10px]', STATUS_BADGE[d.status]?.className)}>
                          {STATUS_BADGE[d.status]?.label ?? d.status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {isOrphanageStyleReason(d.reason) ? (
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
                    <TableCell className="min-w-[260px] text-right align-top">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-indigo-200 px-2 text-[11px] text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                          title="View details"
                          onClick={() => setViewTarget(d)}
                        >
                          <Eye className="mr-1 h-3 w-3" />
                          View
                        </Button>
                        {d.status === 'pending' || d.status === 'orphanage_manager_approved' ? (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canApprove || approvingId === d.id}
                              title={!canApprove ? 'Requires accounting, hr_coordinator, or admin' : undefined}
                              className="h-7 border-emerald-300 px-2 text-[11px] text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400"
                              onClick={() => void handleApprove(d)}
                            >
                              {approvingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Approve'}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canApprove}
                              title={!canApprove ? 'Requires accounting, hr_coordinator, or admin' : undefined}
                              className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                              onClick={() => { setDecideDialog({ dispute: d, action: 'deny' }); setDecisionNote(''); setOverrideHrs(''); setOverrideMins(''); }}
                            >
                              Deny
                            </Button>
                            {isOrphanageStyleReason(d.reason) && d.status === 'orphanage_manager_approved' && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canApprove}
                                title={!canApprove ? 'Requires accounting, hr_coordinator, or admin' : 'Send back to Orphanage managers'}
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
                            <Button
                              size="sm"
                              variant="outline"
                              disabled
                              title="Issue must be approved before it can be revoked"
                              className="h-7 border-zinc-200 px-2 text-[11px] text-zinc-400 opacity-50 dark:border-zinc-700 dark:text-zinc-600"
                            >
                              Revoke
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canApprove}
                              title={!canApprove ? 'Requires accounting, hr_coordinator, or admin' : undefined}
                              className="h-7 border-zinc-300 px-2 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300"
                              onClick={() => openEdit(d)}
                            >
                              <Pencil className="mr-1 h-3 w-3" />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!canDelete}
                              title={!canDelete ? 'Requires admin or accounting' : 'Revoke this issue'}
                              className="h-7 border-rose-300 px-2 text-[11px] text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-700 dark:text-rose-400"
                              onClick={() => setDeleteTarget(d)}
                            >
                              Revoke
                            </Button>
                          </>
                        )}

                        {canDelete && (
                          <Button
                            size="sm"
                            variant="outline"
                            title="Permanently delete this issue (admin / accounting only)"
                            className="h-7 w-7 border-zinc-200 p-0 text-rose-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-600 dark:border-zinc-700 dark:text-rose-400 dark:hover:border-rose-800 dark:hover:bg-rose-950/40"
                            onClick={() => setDeleteTarget(d)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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

      {/* View details modal — smooth backdrop fade + card zoom/slide-in */}
      {viewTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px] animate-in fade-in duration-200 ease-out motion-reduce:animate-none"
          onClick={() => setViewTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Issue details"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200 ease-out dark:border-zinc-800 dark:bg-zinc-950 motion-reduce:animate-none"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-500/20 dark:from-indigo-600 dark:to-violet-700">
                  <Gavel className="h-4 w-4" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
                    {reasonLabel(viewTarget.reason)}
                  </p>
                  <h3 className="mt-0.5 truncate font-mono text-sm font-bold text-zinc-900 dark:text-white">
                    {viewTarget.work_email}
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewTarget(null)}
                aria-label="Close"
                className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="space-y-3.5 px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <InfoRow label="Date" value={viewTarget.dispute_date} />
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Status</p>
                  <div className="mt-1">
                    <Badge variant="outline" className={cn('text-[10px]', STATUS_BADGE[viewTarget.status]?.className)}>
                      {STATUS_BADGE[viewTarget.status]?.label ?? viewTarget.status}
                    </Badge>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Set hours</p>
                <p className="mt-0.5 text-sm text-zinc-800 dark:text-zinc-200">
                  {isOrphanageStyleReason(viewTarget.reason)
                    ? 'Uses logged Hubstaff time'
                    : formatHours(viewTarget.override_hours) ?? '—'}
                </p>
              </div>

              {viewTarget.explanation && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Explanation</p>
                  <p className="mt-1 whitespace-pre-line break-words text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {viewTarget.explanation}
                  </p>
                </div>
              )}

              {viewTarget.decided_by && <InfoRow label="Decided by" value={viewTarget.decided_by} />}

              {viewTarget.decision_note && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Decision note</p>
                  <p className="mt-1 break-words text-sm italic leading-relaxed text-zinc-700 dark:text-zinc-300">
                    {viewTarget.decision_note}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
              <Button variant="outline" size="sm" onClick={() => setViewTarget(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Decide confirmation dialog */}
      {decideDialog && (
        <Dialog open onOpenChange={() => { setDecideDialog(null); setDecisionNote(''); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">
                {decideDialog.action === 'deny' ? 'Deny issue' : 'Approve issue'}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {decideDialog.dispute.work_email} — {decideDialog.dispute.dispute_date} — {reasonLabel(decideDialog.dispute.reason)}
                {isOrphanageStyleReason(decideDialog.dispute.reason) && decideDialog.action === 'approve' && (
                  <span className="mt-1 block text-[10px] text-zinc-500">
                    Manager-submitted issues keep Hubstaff hours — no manual hour entry. Final calendar forgiveness applies after Accounting approves.
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {decideDialog.action === 'approve' && !isOrphanageStyleReason(decideDialog.dispute.reason) && (
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
              <DialogTitle className="text-sm">Edit issue decision</DialogTitle>
              <DialogDescription className="text-xs">
                {editDialog.work_email} — {editDialog.dispute_date} — {reasonLabel(editDialog.reason)}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {disputeGrantsPabForgiveness(editDialog) && (
                <div className="space-y-2 rounded-md border border-amber-200/90 bg-amber-50/80 px-3 py-2.5 dark:border-amber-900/60 dark:bg-amber-950/25">
                  <p className="text-[11px] leading-snug text-amber-950 dark:text-amber-100/95">
                    This issue currently <span className="font-semibold">forgives the PAB short-day</span> for this date.
                    Revoking removes that forgiveness and marks the issue <span className="font-medium">denied</span>.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canApprove || editing}
                    title={!canApprove ? 'Requires accounting, hr_coordinator, or admin' : undefined}
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
              {editStatus === 'approved' && !isOrphanageStyleReason(editDialog.reason) && (() => {
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
              {editStatus === 'approved' && isOrphanageStyleReason(editDialog.reason) && (
                <p className="rounded-md border border-zinc-200 bg-zinc-50/80 px-2.5 py-2 text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
                  Manager-submitted issues ({reasonLabel(editDialog.reason)}) do not use hour overrides — PAB uses logged Hubstaff time, the day flips green on Accounting approval.
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
                as forgiven; the issue will be recorded as <span className="font-medium">denied</span>.
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
                {returnToOrphanageRow.work_email} — {returnToOrphanageRow.dispute_date}. The issue goes back to
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

      {/* Admin delete confirmation */}
      {deleteTarget && (
        <Dialog open onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950/60">
                  <Trash2 className="size-4 text-rose-600 dark:text-rose-400" />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-sm">Delete issue</DialogTitle>
                  <DialogDescription className="mt-0.5 text-xs">
                    This permanently removes the record. Cannot be undone.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="space-y-2 text-[12.5px] text-zinc-700 dark:text-zinc-300">
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Employee</span>{' '}
                <span className="font-medium">{deleteTarget.work_email}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Date</span>{' '}
                <span className="font-medium">{deleteTarget.dispute_date}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Reason</span>{' '}
                <span className="font-medium">{reasonLabel(deleteTarget.reason)}</span>
              </p>
              <p>
                <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Status</span>{' '}
                <span className="font-medium">
                  {STATUS_BADGE[deleteTarget.status]?.label ?? deleteTarget.status}
                </span>
              </p>
              {deleteTarget.decided_by && (
                <p className="rounded-md border border-amber-200/60 bg-amber-50/70 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  This issue was already decided by{' '}
                  <span className="font-medium">{deleteTarget.decided_by}</span>. Deleting it removes the audit trail
                  on the row itself; the deletion is logged separately as <code className="font-mono">pab_dispute.admin_deleted</code>.
                </p>
              )}
            </div>
            <DialogFooter>
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
                onClick={handleAdminDelete}
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
      )}
    </div>
  );
}
