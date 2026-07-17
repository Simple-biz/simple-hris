'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  ClipboardCheck,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import ManagerTransferDialog from '@/components/manager/ManagerTransferDialog';
import type {
  DepartmentTransferRequestRow,
  TransferRequestStatus,
} from '@/lib/supabase/department-transfer-requests';

interface Props {
  /** Departments this manager can pull people INTO (their managed depts). */
  myDepartments: string[];
  /** Whether the viewer may INITIATE a transfer ("Request transfer in"). Managers
   *  can — but only for people OUTSIDE their own departments (enforced server-side);
   *  admins are unrestricted. */
  canInitiate: boolean;
}

type SubTab = 'release' | 'mine' | 'done';

const STATUS_STYLE: Record<TransferRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  applied: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};
const STATUS_LABEL: Record<TransferRequestStatus, string> = {
  pending: 'Awaiting release',
  approved: 'Released — scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

/** Compact relative time, e.g. "just now", "5m ago", "3d ago", then a date. */
function timeAgo(iso: string | null): string {
  if (!iso) return '';
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

/** Full local date+time for the hover tooltip. */
function fullStamp(iso: string | null): string | undefined {
  if (!iso) return undefined;
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Manager → Transfers tab. Three sub-tabs behind an animated segmented control:
 *   • Release requests — incoming; where THIS manager owns the SOURCE department.
 *     Release locks the requester's proposed effective date and applies the move.
 *   • My requests — the manager's own outbox (status + cancel-while-pending).
 *   • Done — resolved release requests on their team (released/declined/applied/
 *     cancelled). A read-only record so past decisions aren't lost once acted on.
 * "Request transfer in" (the pull-in picker) lives in the header, always available.
 */
export default function ManagerTransfers({ myDepartments, canInitiate }: Props) {
  const [incoming, setIncoming] = useState<DepartmentTransferRequestRow[]>([]);
  const [outgoing, setOutgoing] = useState<DepartmentTransferRequestRow[]>([]);
  const [done, setDone] = useState<DepartmentTransferRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineNote, setDeclineNote] = useState('');
  const [sub, setSub] = useState<SubTab>('release');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // `silent` refreshes (live Realtime events, the poll backstop, tab refocus)
  // update the three lists in place without flashing the full-page spinner, so
  // a co-manager's or admin's action shows up live and stale cards can't linger.
  const load = useCallback((opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    Promise.all([
      fetch('/api/department-transfers?scope=incoming', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
      fetch('/api/department-transfers?scope=outgoing', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
      fetch('/api/department-transfers?scope=done', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] })),
    ])
      .then(
        ([inc, out, dn]: [
          { rows?: DepartmentTransferRequestRow[] },
          { rows?: DepartmentTransferRequestRow[] },
          { rows?: DepartmentTransferRequestRow[] },
        ]) => {
          setIncoming(inc.rows ?? []);
          setOutgoing(out.rows ?? []);
          setDone(dn.rows ?? []);
        },
      )
      .finally(() => {
        if (!opts?.silent) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep all three sub-tabs live: a request being released/declined/applied (by a
  // co-manager, an admin, or from another tab) fires a Realtime event -> in-place
  // refresh. The 60s poll + focus refresh are the backstop if Realtime drops.
  useLiveRefresh({
    tables: ['department_transfer_requests'],
    onRefresh: () => load({ silent: true }),
    channel: 'manager-transfers',
    pollMs: 60_000,
  });

  const decide = async (row: DepartmentTransferRequestRow, action: 'release' | 'decline') => {
    if (action === 'decline' && !declineNote.trim()) {
      toast.error('Add a reason for declining.');
      return;
    }
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/department-transfers/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: action === 'decline' ? declineNote.trim() : null }),
      });
      const json = (await res.json()) as {
        error?: string;
        released?: boolean;
        applied?: boolean;
      };
      // 409 = this request was already decided (by the apply cron, a co-manager
      // of the source department, or another tab). The card on screen is stale —
      // reconcile the list instead of leaving it clickable and erroring again.
      if (res.status === 409) {
        toast.info('This request was already handled — refreshing the list.');
        setDeclineFor(null);
        setDeclineNote('');
        load({ silent: true });
        return;
      }
      // A release that went through counts as DECIDED even if the immediate
      // department move failed (a common master-list matching miss). The row is
      // no longer pending, so it must leave the Release-requests queue — reconcile
      // the list and warn, rather than throwing on `json.error` (which used to
      // skip the refresh and leave the now-stale card lingering in the tab).
      if (action === 'release' && json.released) {
        if (json.applied === false) {
          toast.warning(
            json.error ||
              `Released ${row.employee_name ?? row.employee_email}, but the department move needs a manual apply.`,
          );
        } else {
          toast.success(`${row.employee_name ?? row.employee_email} moved to ${row.to_department}`);
        }
        setDeclineFor(null);
        setDeclineNote('');
        load({ silent: true });
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success(action === 'release' ? 'Transfer released' : 'Transfer declined');
      setDeclineFor(null);
      setDeclineNote('');
      load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const cancelOwn = async (row: DepartmentTransferRequestRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/department-transfers/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const json = (await res.json()) as { error?: string };
      // 409 = already decided elsewhere (released/declined/applied). Reconcile.
      if (res.status === 409) {
        toast.info('This request was already handled — refreshing the list.');
        load({ silent: true });
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success('Request withdrawn');
      load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const applyNow = async (row: DepartmentTransferRequestRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/department-transfers/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' }),
      });
      const json = (await res.json()) as { error?: string; sheet_synced?: boolean };
      if (res.status === 409) {
        toast.info('This request was already handled — refreshing the list.');
        load({ silent: true });
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success(
        json.sheet_synced === false
          ? `${row.employee_name ?? row.employee_email} moved to ${row.to_department} (Sheet not synced — retry in Accounting)`
          : `${row.employee_name ?? row.employee_email} moved to ${row.to_department}`,
      );
      load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const deleteRequest = async (row: DepartmentTransferRequestRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/department-transfers/${row.id}`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success('Request deleted');
      setConfirmDeleteId(null);
      load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const canRequest = canInitiate && myDepartments.length > 0;
  const sortedOutgoing = useMemo(
    () => [...outgoing].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [outgoing],
  );

  // Two-click delete control (avoids accidental record deletion). Reused across
  // the release / my-requests / done lists.
  const renderDeleteControl = (row: DepartmentTransferRequestRow) =>
    confirmDeleteId === row.id ? (
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void deleteRequest(row)}
          disabled={busyId === row.id}
          className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
        >
          {busyId === row.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Delete?
        </button>
        <button
          type="button"
          onClick={() => setConfirmDeleteId(null)}
          className="text-[11px] text-zinc-400 hover:underline"
        >
          Cancel
        </button>
      </span>
    ) : (
      <button
        type="button"
        onClick={() => setConfirmDeleteId(row.id)}
        disabled={busyId === row.id}
        title="Delete this transfer request record"
        aria-label="Delete request"
        className="text-zinc-400 transition-colors hover:text-rose-600 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-rose-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    );

  const TABS: { id: SubTab; label: string; count: number; icon: typeof Inbox }[] = [
    { id: 'release', label: 'Release requests', count: incoming.length, icon: Inbox },
    { id: 'mine', label: 'My requests', count: sortedOutgoing.length, icon: Send },
    { id: 'done', label: 'Done', count: done.length, icon: ClipboardCheck },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-blue-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-blue-950/40 dark:bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ArrowRightLeft className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              Transfers
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Request people from other teams, and release the ones other managers ask for.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="h-8 gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            {canRequest && (
              <Button
                type="button"
                size="sm"
                onClick={() => setDialogOpen(true)}
                className="h-8 gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                Request transfer in
              </Button>
            )}
          </div>
        </div>

        {/* Segmented sub-tab control with a sliding pill indicator */}
        <div
          role="tablist"
          aria-label="Transfer views"
          className="mt-3.5 inline-flex rounded-xl border border-zinc-200/80 bg-zinc-100/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/60"
        >
          {TABS.map((t) => {
            const active = sub === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSub(t.id)}
                className={cn(
                  'relative z-10 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200',
                  active
                    ? 'text-blue-700 dark:text-blue-300'
                    : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="mgr-transfer-subtab-pill"
                    className="absolute inset-0 -z-10 rounded-lg bg-white shadow-sm ring-1 ring-black/[0.04] dark:bg-zinc-950 dark:ring-white/10"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
                <Icon className="h-3.5 w-3.5" />
                {t.label}
                {t.count > 0 && (
                  <span
                    className={cn(
                      'ml-0.5 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums',
                      t.id === 'release'
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
                        : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
                    )}
                  >
                    {t.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="mx-auto w-full max-w-3xl">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading transfers...
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={sub}
                initial={{ opacity: 0, x: sub === 'release' ? -10 : 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: sub === 'release' ? 10 : -10 }}
                transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                className="space-y-3"
              >
                {sub === 'release' ? (
                  incoming.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-blue-200 bg-white py-14 text-center dark:border-blue-950/40 dark:bg-[#0d1117]">
                      <Inbox className="h-7 w-7 text-blue-300 dark:text-blue-800" />
                      <p className="text-sm text-zinc-500">No one is asking to take a member of your team.</p>
                    </div>
                  ) : (
                    incoming.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-2xl border border-amber-200/70 bg-white p-4 shadow-sm dark:border-amber-500/20 dark:bg-zinc-950"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-zinc-900 dark:text-white">
                              {r.employee_name ?? r.employee_email}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                              <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                {r.from_department}
                              </span>
                              <ArrowRight className="h-3 w-3 text-zinc-400" />
                              <span className="rounded bg-blue-600 px-1.5 py-0.5 font-semibold text-white">
                                {r.to_department}
                              </span>
                              {r.proposed_effective_date && (
                                <span className="text-zinc-500 dark:text-zinc-400">
                                  · effective {r.proposed_effective_date}
                                </span>
                              )}
                            </div>
                            <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
                              Requested by <span className="font-medium text-zinc-700 dark:text-zinc-300">{r.requested_by}</span>
                              {r.reason ? <> · &ldquo;{r.reason}&rdquo;</> : null}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2">
                            <span className="text-[11px] text-zinc-400" title={fullStamp(r.created_at)}>
                              {timeAgo(r.created_at)}
                            </span>
                            <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void decide(r, 'release')}
                              disabled={busyId === r.id}
                              className="h-8 gap-1.5 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                            >
                              {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              Release
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setDeclineFor(declineFor === r.id ? null : r.id);
                                setDeclineNote('');
                              }}
                              disabled={busyId === r.id}
                              className="h-8 gap-1.5 border-rose-200 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
                            >
                              <X className="h-3.5 w-3.5" />
                              Decline
                            </Button>
                            </div>
                            <div className="mt-0.5">{renderDeleteControl(r)}</div>
                          </div>
                        </div>

                        {declineFor === r.id && (
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                            <input
                              type="text"
                              autoFocus
                              value={declineNote}
                              onChange={(e) => setDeclineNote(e.target.value)}
                              placeholder="Reason for declining (sent to the requester)"
                              className="h-8 flex-1 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-rose-300 focus:outline-none focus:ring-1 focus:ring-rose-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                            />
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => void decide(r, 'decline')}
                              disabled={busyId === r.id}
                              className="h-8 gap-1.5 bg-rose-600 text-xs text-white hover:bg-rose-700"
                            >
                              Confirm decline
                            </Button>
                          </div>
                        )}
                      </div>
                    ))
                  )
                ) : sub === 'mine' ? (
                  sortedOutgoing.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-blue-200 bg-white py-14 text-center dark:border-blue-950/40 dark:bg-[#0d1117]">
                    <Send className="h-7 w-7 text-blue-300 dark:text-blue-800" />
                    <p className="text-sm text-zinc-500">You haven&rsquo;t requested any transfers yet.</p>
                    {canRequest && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setDialogOpen(true)}
                        className="mt-1 h-8 gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Request transfer in
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-blue-100/80 bg-white dark:border-blue-950/40 dark:bg-zinc-950">
                    <div className="divide-y divide-blue-100/70 dark:divide-blue-950/40">
                      {sortedOutgoing.map((r) => (
                        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                              {r.employee_name ?? r.employee_email}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                              <span>{r.from_department}</span>
                              <ArrowRight className="h-3 w-3" />
                              <span>{r.to_department}</span>
                              {(r.effective_date || r.proposed_effective_date) && (
                                <span className="text-zinc-400">
                                  · eff {r.effective_date ?? r.proposed_effective_date}
                                </span>
                              )}
                              {(() => {
                                const stamp =
                                  r.status === 'applied'
                                    ? r.applied_at ?? r.decided_at ?? r.created_at
                                    : r.decided_at ?? r.created_at;
                                const label =
                                  r.status === 'applied'
                                    ? 'applied'
                                    : r.decided_at
                                      ? 'decided'
                                      : 'requested';
                                return (
                                  <span className="text-zinc-400" title={fullStamp(stamp)}>
                                    · {label} {timeAgo(stamp)}
                                  </span>
                                );
                              })()}
                              {r.status === 'rejected' && r.approver_note ? (
                                <span className="text-rose-500">· &ldquo;{r.approver_note}&rdquo;</span>
                              ) : null}
                              {r.status === 'pending' &&
                                (r.pending_with && r.pending_with.length > 0 ? (
                                  <span
                                    className="text-amber-600 dark:text-amber-400"
                                    title="Whose release we're waiting on"
                                  >
                                    · waiting on {r.pending_with.join(', ')}
                                  </span>
                                ) : (
                                  <span
                                    className="font-medium text-rose-600 dark:text-rose-400"
                                    title={`No manager is assigned to ${r.from_department}, so no one can release this. Ask an admin to assign one (or to apply it directly).`}
                                  >
                                    · no manager on {r.from_department} — ask an admin
                                  </span>
                                ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                STATUS_STYLE[r.status],
                              )}
                            >
                              {STATUS_LABEL[r.status]}
                            </span>
                            {r.status === 'pending' && (
                              <button
                                type="button"
                                onClick={() => void cancelOwn(r)}
                                disabled={busyId === r.id}
                                className="text-[11px] font-medium text-zinc-500 hover:text-rose-600 hover:underline disabled:opacity-50 dark:text-zinc-400"
                              >
                                Withdraw
                              </button>
                            )}
                            {r.status === 'approved' && (
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void applyNow(r)}
                                disabled={busyId === r.id}
                                className="h-7 gap-1.5 bg-emerald-600 text-[11px] text-white hover:bg-emerald-700"
                                title="Apply this released transfer now (moves the department + writes the Sheet)"
                              >
                                {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                Apply now
                              </Button>
                            )}
                            {renderDeleteControl(r)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  )
                ) : (
                  done.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-blue-200 bg-white py-14 text-center dark:border-blue-950/40 dark:bg-[#0d1117]">
                      <ClipboardCheck className="h-7 w-7 text-blue-300 dark:text-blue-800" />
                      <p className="text-sm text-zinc-500">
                        Released and declined requests for your team will show up here.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-2xl border border-blue-100/80 bg-white dark:border-blue-950/40 dark:bg-zinc-950">
                      <div className="divide-y divide-blue-100/70 dark:divide-blue-950/40">
                        {done.map((r) => (
                          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                                {r.employee_name ?? r.employee_email}
                              </div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                                <span>{r.from_department}</span>
                                <ArrowRight className="h-3 w-3" />
                                <span>{r.to_department}</span>
                                {(r.effective_date || r.proposed_effective_date) && (
                                  <span className="text-zinc-400">
                                    · eff {r.effective_date ?? r.proposed_effective_date}
                                  </span>
                                )}
                                <span className="text-zinc-400">· requested by {r.requested_by}</span>
                                {(() => {
                                  const stamp =
                                    r.status === 'applied'
                                      ? r.applied_at ?? r.decided_at ?? r.updated_at
                                      : r.decided_at ?? r.updated_at;
                                  const label = r.status === 'applied' ? 'applied' : 'decided';
                                  return (
                                    <span className="text-zinc-400" title={fullStamp(stamp)}>
                                      · {label} {timeAgo(stamp)}
                                    </span>
                                  );
                                })()}
                                {r.status === 'rejected' && r.approver_note ? (
                                  <span className="text-rose-500">· &ldquo;{r.approver_note}&rdquo;</span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span
                                className={cn(
                                  'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                  STATUS_STYLE[r.status],
                                )}
                              >
                                {STATUS_LABEL[r.status]}
                              </span>
                              {renderDeleteControl(r)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                )}
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

      {canRequest && (
        <ManagerTransferDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          myDepartments={myDepartments}
          onSubmitted={() => load()}
        />
      )}
    </div>
  );
}
