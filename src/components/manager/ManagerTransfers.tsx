'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  SendHorizonal,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import ManagerTransferDialog from '@/components/manager/ManagerTransferDialog';
import { PayoutTrendChart, type ChartPoint } from '@/components/ceo/financial-chart';
import { StatusDonut, FlowBars, type DonutSegment, type FlowRow } from '@/components/manager/transfer-charts';
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

/** Rows shown per page in each queue view. Charts/KPIs still read the full lists;
 *  only the visible queue is paginated so a long history (Done can hold 300 rows)
 *  stays scannable. */
const PAGE_SIZE = 15;

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

/** Solid arc colors for the donut — chosen to read in both themes. Keyed to
 *  the pipeline stage, not the raw DB status. */
const DONUT_COLOR = {
  awaiting: '#f59e0b', // amber
  scheduled: '#0ea5e9', // sky
  applied: '#10b981', // emerald
  declined: '#f43f5e', // rose
} as const;

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

/** Monday-anchored start of the ISO week containing `d`, at local midnight. */
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon=0 … Sun=6
  x.setDate(x.getDate() - dow);
  return x;
}

/** Accent palettes for the compact stat tiles — icon chip + value tint, tuned
 *  for both themes. */
const STAT_ACCENT = {
  amber: {
    chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    value: 'text-amber-600 dark:text-amber-300',
    ring: 'ring-amber-400/50 dark:ring-amber-500/40',
  },
  blue: {
    chip: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    value: 'text-blue-600 dark:text-blue-300',
    ring: 'ring-blue-400/50 dark:ring-blue-500/40',
  },
  emerald: {
    chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    value: 'text-emerald-600 dark:text-emerald-300',
    ring: 'ring-emerald-400/50 dark:ring-emerald-500/40',
  },
} as const;

/** One compact stat tile in the analytics rail. Clickable when `onClick` jumps
 *  to its matching queue view. */
function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  onClick,
  active,
}: {
  label: string;
  value: number;
  hint: string;
  icon: typeof Inbox;
  accent: keyof typeof STAT_ACCENT;
  onClick?: () => void;
  active?: boolean;
}) {
  const a = STAT_ACCENT[accent];
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      whileHover={onClick ? { y: -2 } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      aria-pressed={onClick ? !!active : undefined}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition-colors dark:bg-zinc-950',
        'border-zinc-200/80 dark:border-zinc-800/80',
        onClick ? 'cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-700' : 'cursor-default',
        active && cn('ring-1 ring-inset', a.ring),
      )}
    >
      <span className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', a.chip)}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className={cn('text-2xl font-bold leading-none tabular-nums tracking-tight', a.value)}>
            {value}
          </span>
        </span>
        <span className="mt-1 block truncate text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">
          {label}
        </span>
        <span className="block truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
          {hint}
        </span>
      </span>
    </motion.button>
  );
}

/** A titled panel in the analytics rail. */
function Panel({
  title,
  subtitle,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  icon?: typeof Inbox;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800/80 dark:bg-zinc-950',
        className,
      )}
    >
      <header className="mb-3 flex items-center gap-2">
        {Icon && (
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
          {subtitle && (
            <p className="text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          )}
        </div>
      </header>
      {children}
    </section>
  );
}

/** Queue paginator — page N of M, with prev/next and a range read-out. Renders
 *  nothing when everything fits on one page, so short lists stay uncluttered. */
function Paginator({
  page,
  pageCount,
  total,
  from,
  to,
  onPage,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
  onPage: (p: number) => void;
  noun: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
      <span className="text-[12px] text-zinc-500 dark:text-zinc-400">
        Showing <span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-200">{from}–{to}</span>{' '}
        of <span className="font-medium tabular-nums text-zinc-700 dark:text-zinc-200">{total}</span> {noun}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-1.5 text-[12px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Manager → Transfers tab — a full-width workspace. The left column is the work
 * queue (three sub-tabs behind an animated segmented control); the right rail is
 * live analytics (activity trend, pipeline donut, busiest routes, stat tiles).
 *
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
  // 1-based page index for the active queue view. Reset whenever the sub-tab
  // changes so a switch always lands on page 1 (see the effect below).
  const [page, setPage] = useState(1);

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
      const json = (await res.json()) as {
        error?: string;
        sheet_synced?: boolean;
        cancelled?: boolean;
        already_in_target?: boolean;
      };
      if (res.status === 409) {
        toast.info('This request was already handled — refreshing the list.');
        load({ silent: true });
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      const who = row.employee_name ?? row.employee_email;
      if (json.cancelled) {
        // Employee isn't on the active roster — the request was retired, not applied.
        toast.warning(`${who} isn't on the active roster — request cleared (off-boarded or email changed).`);
      } else if (json.already_in_target) {
        toast.success(`${who} is already in ${row.to_department} — marked applied.`);
      } else {
        toast.success(
          json.sheet_synced === false
            ? `${who} moved to ${row.to_department} (Sheet not synced — retry in Accounting)`
            : `${who} moved to ${row.to_department}`,
        );
      }
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

  // The full list backing the active view — the source of truth for pagination.
  const activeList = sub === 'release' ? incoming : sub === 'mine' ? sortedOutgoing : done;

  // Reset to page 1 whenever the view or its length changes, so a tab switch
  // (or a live refresh that shrinks the list) never strands you on an empty page.
  useEffect(() => {
    setPage(1);
  }, [sub, activeList.length]);

  // Clamp the requested page into range, then slice. `pageStart`/`pageEnd` are the
  // 1-based bounds shown in the paginator's "Showing X–Y of N" read-out.
  const pageCount = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageStart = activeList.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const pageEnd = Math.min(safePage * PAGE_SIZE, activeList.length);
  const pageIncoming = useMemo(
    () => (sub === 'release' ? incoming.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : []),
    [sub, incoming, safePage],
  );
  const pageOutgoing = useMemo(
    () => (sub === 'mine' ? sortedOutgoing.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : []),
    [sub, sortedOutgoing, safePage],
  );
  const pageDone = useMemo(
    () => (sub === 'done' ? done.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : []),
    [sub, done, safePage],
  );

  // Three at-a-glance KPIs from the already-loaded lists (no extra fetch):
  //   • Awaiting your release — incoming still pending; this manager's action queue.
  //   • My requests in flight — outgoing not yet resolved (pending + released/scheduled).
  //   • Applied this month     — team transfers that actually landed since the 1st.
  const kpis = useMemo(() => {
    const awaitingRelease = incoming.filter((r) => r.status === 'pending').length;
    const myInFlight = outgoing.filter(
      (r) => r.status === 'pending' || r.status === 'approved',
    ).length;
    const myScheduled = outgoing.filter((r) => r.status === 'approved').length;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const isThisMonth = (iso: string | null) =>
      !!iso && new Date(iso).getTime() >= monthStart;
    // Applied transfers can surface in either list (my own outbox once applied,
    // or a release I acted on that shows in Done) — dedupe by id before counting.
    const appliedThisMonth = new Set(
      [...outgoing, ...done]
        .filter((r) => r.status === 'applied' && isThisMonth(r.applied_at ?? r.decided_at))
        .map((r) => r.id),
    ).size;

    return { awaitingRelease, myInFlight, myScheduled, appliedThisMonth };
  }, [incoming, outgoing, done]);

  // ── Chart data, all derived from the loaded lists (no extra fetch) ──────────

  // Every row this manager can see, deduped by id across the three scoped lists.
  const allRows = useMemo(() => {
    const byId = new Map<string, DepartmentTransferRequestRow>();
    for (const r of [...incoming, ...outgoing, ...done]) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  }, [incoming, outgoing, done]);

  // Pipeline donut: the whole visible book of work by stage. `approved` reads as
  // "Scheduled"; `cancelled` folds into "Declined" (both are closed-not-applied).
  const donutSegments = useMemo<DonutSegment[]>(() => {
    let awaiting = 0;
    let scheduled = 0;
    let applied = 0;
    let declined = 0;
    for (const r of allRows) {
      if (r.status === 'pending') awaiting += 1;
      else if (r.status === 'approved') scheduled += 1;
      else if (r.status === 'applied') applied += 1;
      else declined += 1; // rejected + cancelled
    }
    return [
      { key: 'awaiting', label: 'Awaiting release', value: awaiting, color: DONUT_COLOR.awaiting },
      { key: 'scheduled', label: 'Scheduled', value: scheduled, color: DONUT_COLOR.scheduled },
      { key: 'applied', label: 'Applied', value: applied, color: DONUT_COLOR.applied },
      { key: 'declined', label: 'Declined / withdrawn', value: declined, color: DONUT_COLOR.declined },
    ];
  }, [allRows]);

  // Activity trend: transfers requested per ISO week over the last 8 weeks. Uses
  // created_at (when the request was raised) — the honest "activity" signal.
  const trendPoints = useMemo<ChartPoint[]>(() => {
    const WEEKS = 8;
    const now = new Date();
    const thisWeek = weekStart(now);
    const buckets: { start: Date; count: number }[] = [];
    for (let i = WEEKS - 1; i >= 0; i--) {
      const s = new Date(thisWeek);
      s.setDate(s.getDate() - i * 7);
      buckets.push({ start: s, count: 0 });
    }
    const firstStart = buckets[0]!.start.getTime();
    for (const r of allRows) {
      if (!r.created_at) continue;
      const t = weekStart(new Date(r.created_at)).getTime();
      if (t < firstStart) continue;
      const idx = Math.round((t - firstStart) / (7 * 86_400_000));
      if (idx >= 0 && idx < buckets.length) buckets[idx]!.count += 1;
    }
    return buckets.map((b) => {
      const end = new Date(b.start);
      end.setDate(end.getDate() + 6);
      const short = b.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const full = `${short} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      return { label: short, fullLabel: full, value: b.count };
    });
  }, [allRows]);

  const trendHasData = useMemo(() => trendPoints.some((p) => p.value > 0), [trendPoints]);

  // Busiest routes: applied moves grouped by from → to, most-traded first.
  const flowRows = useMemo<FlowRow[]>(() => {
    const counts = new Map<string, FlowRow>();
    for (const r of allRows) {
      if (r.status !== 'applied') continue;
      const key = `${r.from_department}→${r.to_department}`;
      const cur = counts.get(key);
      if (cur) cur.count += 1;
      else counts.set(key, { from: r.from_department, to: r.to_department, count: 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [allRows]);

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

  // ── Analytics area (wide, right of the queue) ──────────────────────────────
  // KPI cards in a row on top, then the Activity trend full width, then Pipeline
  // and Busiest routes side by side. Everything collapses to one column on narrow
  // screens, where this whole area sits beneath the queue.
  const analytics = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Awaiting your release"
          value={kpis.awaitingRelease}
          hint={
            kpis.awaitingRelease === 0
              ? 'No pending requests on your team'
              : 'Requests to release from your team'
          }
          icon={Inbox}
          accent="amber"
          onClick={() => setSub('release')}
          active={sub === 'release'}
        />
        <StatTile
          label="My requests in flight"
          value={kpis.myInFlight}
          hint={
            kpis.myScheduled > 0
              ? `${kpis.myScheduled} released & scheduled`
              : 'Pending & released transfers'
          }
          icon={SendHorizonal}
          accent="blue"
          onClick={() => setSub('mine')}
          active={sub === 'mine'}
        />
        <StatTile
          label="Applied this month"
          value={kpis.appliedThisMonth}
          hint="Transfers completed since the 1st"
          icon={CheckCircle2}
          accent="emerald"
          onClick={() => setSub('done')}
          active={sub === 'done'}
        />
      </div>

      <Panel title="Activity" subtitle="Requests raised, last 8 weeks" icon={TrendingUp}>
        {trendHasData ? (
          <PayoutTrendChart
            points={trendPoints}
            selectedIndex={null}
            accent="sky"
            height={220}
            yTicks={4}
            formatValue={(v) => `${v}`}
            formatTooltip={(p) => `${p.value} ${p.value === 1 ? 'request' : 'requests'}`}
          />
        ) : (
          <div className="flex h-[220px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-200 text-center dark:border-zinc-800">
            <TrendingUp className="h-5 w-5 text-zinc-300 dark:text-zinc-700" />
            <p className="text-[12px] text-zinc-400 dark:text-zinc-500">
              No transfer activity in the last 8 weeks.
            </p>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Pipeline"
          subtitle="Every transfer you can see, by stage"
          icon={ArrowRightLeft}
        >
          <StatusDonut segments={donutSegments} />
        </Panel>

        <Panel title="Busiest routes" subtitle="Applied moves by department" icon={ArrowRight}>
          <FlowBars rows={flowRows} />
        </Panel>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — full width */}
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
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            {canRequest && (
              <Button
                type="button"
                size="sm"
                onClick={() => setDialogOpen(true)}
                className="h-8 gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
              >
                <Plus className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Request transfer in</span>
                <span className="sm:hidden">Request</span>
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

      {/* Body: a NARROW work-queue column on the LEFT (compact rows need little
          width), and a WIDE analytics area on the RIGHT so the charts get room.
          Stacks with the queue on top on narrow screens. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,500px)_minmax(0,1fr)]">
          {/* QUEUE — left (narrow) */}
          <div className="order-1 min-w-0">
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
                      <>
                      <div className="overflow-hidden rounded-2xl border border-amber-200/70 bg-white dark:border-amber-500/20 dark:bg-zinc-950">
                        <div className="divide-y divide-amber-100/70 dark:divide-amber-500/10">
                        {pageIncoming.map((r) => (
                          <div key={r.id} className="px-3 py-2.5">
                            {/* Line 1 — name + timestamp + actions (name never crushed) */}
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">
                                {r.employee_name ?? r.employee_email}
                              </span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <span className="text-[11px] text-zinc-400" title={fullStamp(r.created_at)}>
                                  {timeAgo(r.created_at)}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  onClick={() => void decide(r, 'release')}
                                  disabled={busyId === r.id}
                                  className="h-7 gap-1 bg-emerald-600 px-2.5 text-[11px] text-white hover:bg-emerald-700"
                                >
                                  {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
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
                                  className="h-7 gap-1 border-rose-200 px-2.5 text-[11px] text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300"
                                >
                                  <X className="h-3 w-3" />
                                  Decline
                                </Button>
                                {renderDeleteControl(r)}
                              </div>
                            </div>
                            {/* Line 2 — move chips + meta */}
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px]">
                              <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                {r.from_department}
                              </span>
                              <ArrowRight className="h-3 w-3 shrink-0 text-zinc-400" />
                              <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 font-semibold text-white">
                                {r.to_department}
                              </span>
                              <span className="min-w-0 truncate text-zinc-400 dark:text-zinc-500">
                                {r.proposed_effective_date ? `· eff ${r.proposed_effective_date} ` : ''}
                                · by {r.requested_by}
                                {r.reason ? ` · “${r.reason}”` : ''}
                              </span>
                            </div>

                            {declineFor === r.id && (
                              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
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
                        ))}
                        </div>
                      </div>
                      <Paginator
                        page={safePage}
                        pageCount={pageCount}
                        total={incoming.length}
                        from={pageStart}
                        to={pageEnd}
                        onPage={setPage}
                        noun="requests"
                      />
                      </>
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
                      <>
                      <div className="overflow-hidden rounded-2xl border border-blue-100/80 bg-white dark:border-blue-950/40 dark:bg-zinc-950">
                        <div className="divide-y divide-blue-100/70 dark:divide-blue-950/40">
                          {pageOutgoing.map((r) => (
                            <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                              <div className="min-w-0">
                                <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
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
                                  {(r.status === 'rejected' || r.status === 'cancelled') && r.approver_note ? (
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
                      <Paginator
                        page={safePage}
                        pageCount={pageCount}
                        total={sortedOutgoing.length}
                        from={pageStart}
                        to={pageEnd}
                        onPage={setPage}
                        noun="requests"
                      />
                      </>
                    )
                  ) : done.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-blue-200 bg-white py-14 text-center dark:border-blue-950/40 dark:bg-[#0d1117]">
                      <ClipboardCheck className="h-7 w-7 text-blue-300 dark:text-blue-800" />
                      <p className="text-sm text-zinc-500">
                        Released and declined requests for your team will show up here.
                      </p>
                    </div>
                  ) : (
                    <>
                    <div className="overflow-hidden rounded-2xl border border-blue-100/80 bg-white dark:border-blue-950/40 dark:bg-zinc-950">
                      <div className="divide-y divide-blue-100/70 dark:divide-blue-950/40">
                        {pageDone.map((r) => (
                          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
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
                                {(r.status === 'rejected' || r.status === 'cancelled') && r.approver_note ? (
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
                    <Paginator
                      page={safePage}
                      pageCount={pageCount}
                      total={done.length}
                      from={pageStart}
                      to={pageEnd}
                      onPage={setPage}
                      noun="records"
                    />
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {/* ANALYTICS — wide right area. Below the queue on narrow screens. */}
          <aside className="order-2 min-w-0">
            {analytics}
          </aside>
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
