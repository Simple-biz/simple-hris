'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Ban,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Eye,
  Inbox,
  LayoutDashboard,
  Loader2,
  Pencil,
  Percent,
  Plus,
  RefreshCw,
  Search,
  Send,
  SendHorizonal,
  Trash2,
  TrendingUp,
  X,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import ManagerTransferDialog from '@/components/manager/ManagerTransferDialog';
import { TransferExportMenu, TransferKpiCard } from '@/components/transfers/TransferToolbar';
import { MANAGER_PDF_THEME, type TransferExportSource } from '@/lib/transfers/transfers-export';
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

type SubTab = 'release' | 'mine' | 'done' | 'summary';

/** Rows shown per page in each queue view. Charts/KPIs still read the full lists;
 *  only the visible queue is paginated so a long history (Done can hold 300 rows)
 *  stays scannable. */
const PAGE_SIZE = 10;

/** Stable empty list for the Summary tab, which has no queue to paginate.
 *  Module-level so the pagination effect doesn't see a new array each render. */
const NO_ROWS: DepartmentTransferRequestRow[] = [];

/** Outcome a Done-tab KPI card narrows the table to. Mirrors the four statuses
 *  a resolved row can hold — Done never contains `pending`. */
type DoneFilter = 'applied' | 'approved' | 'rejected' | 'cancelled';

const DONE_FILTER_LABEL: Record<DoneFilter, string> = {
  applied: 'Applied',
  approved: 'Released, scheduled',
  rejected: 'Declined',
  cancelled: 'Withdrawn',
};

const STATUS_STYLE: Record<TransferRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  applied: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};
const STATUS_LABEL: Record<TransferRequestStatus, string> = {
  pending: 'Awaiting release',
  approved: 'Released, scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

/** Per-status visual anchor for the Done table: the status icon carried inside
 *  the pill, and the tint for that row's decided-at stamp. Reuses the same hues
 *  as {@link STATUS_STYLE} (amber/sky/emerald/rose/zinc) so the pill, the icon,
 *  and the timestamp read as one color language. */
const STATUS_META: Record<TransferRequestStatus, { icon: typeof CheckCircle2; text: string }> = {
  pending: { icon: CalendarClock, text: 'text-amber-700 dark:text-amber-300' },
  approved: { icon: CalendarClock, text: 'text-sky-700 dark:text-sky-300' },
  applied: { icon: CheckCircle2, text: 'text-emerald-700 dark:text-emerald-300' },
  rejected: { icon: XCircle, text: 'text-rose-700 dark:text-rose-300' },
  cancelled: { icon: Ban, text: 'text-zinc-500 dark:text-zinc-400' },
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
  },
  blue: {
    chip: 'bg-blue-100 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300',
    value: 'text-blue-600 dark:text-blue-300',
  },
  emerald: {
    chip: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    value: 'text-emerald-600 dark:text-emerald-300',
  },
  violet: {
    chip: 'bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    value: 'text-violet-600 dark:text-violet-300',
  },
} as const;

/** One compact stat tile on the Summary dashboard. Clickable when `onClick`
 *  jumps to its matching queue view. `value` is pre-formatted by the caller so
 *  a tile can read as a count ("7") or a rate ("82%"). */
function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  accent,
  onClick,
  title,
}: {
  label: string;
  value: number | string;
  hint: string;
  icon: typeof Inbox;
  accent: keyof typeof STAT_ACCENT;
  onClick?: () => void;
  title?: string;
}) {
  const a = STAT_ACCENT[accent];
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      whileHover={onClick ? { y: -2 } : undefined}
      whileTap={onClick ? { scale: 0.98 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl border bg-white p-3 text-left shadow-sm transition-colors dark:bg-zinc-950',
        'border-zinc-200/80 dark:border-zinc-800/80',
        onClick ? 'cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-700' : 'cursor-default',
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

/**
 * One label/value row in the View dialog. Label left, value right — the detail
 * -sheet pattern, which stays readable at a narrow modal width where a
 * two-column grid would crush long emails. Renders an em-dash for empty values
 * so the row keeps its rhythm instead of collapsing.
 *
 * Labels and the empty-value dash sit at zinc-600 / zinc-400, measured at
 * 7.1:1 and 7.0:1 against this dialog's gradient surface. The muted zinc-400
 * default that reads as "elegant" only manages 2.5:1 in light mode and fails
 * AA outright — this app targets WCAG AA in both themes.
 */
function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right text-xs font-medium text-zinc-800 dark:text-zinc-100">
        {value || <span className="font-normal text-zinc-600 dark:text-zinc-400">—</span>}
      </dd>
    </div>
  );
}

/**
 * A titled group of rows. The heading is sentence-case with weight contrast
 * rather than another tier of tracked small-caps: the field labels already own
 * the uppercase register, and stacking four all-caps eyebrows down one modal
 * turns the whole surface into noise.
 */
function DetailSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Inbox;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-1 flex items-center gap-1.5 border-b border-zinc-200/80 pb-1.5 text-[12px] font-semibold text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
        <Icon className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
        {title}
      </h4>
      <dl className="divide-y divide-zinc-100/80 dark:divide-zinc-800/60">{children}</dl>
    </section>
  );
}

/** Free-text block (reason / approver note) — given room to read rather than
 *  squeezed into a value cell. The inset ring gives it an edge without adding
 *  another border weight to the stack. */
function DetailNote({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string | null;
  tone?: 'neutral' | 'rose';
}) {
  if (!value) return null;
  return (
    <div className="pt-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p
        className={cn(
          'mt-1 rounded-lg px-2.5 py-2 text-xs leading-relaxed ring-1 ring-inset',
          tone === 'rose'
            ? 'bg-rose-50/70 text-rose-800 ring-rose-200/70 dark:bg-rose-500/10 dark:text-rose-200 dark:ring-rose-500/20'
            : 'bg-zinc-50 text-zinc-700 ring-zinc-200/70 dark:bg-zinc-900/60 dark:text-zinc-200 dark:ring-zinc-700/50',
        )}
      >
        {value}
      </p>
    </div>
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
 * Manager → Transfers tab — a full-width workspace. Four sub-tabs behind an
 * animated segmented control, one view at a time so the dashboard never competes
 * with the work queues:
 *
 *   • Summary — the landing view. KPI cards (including the transfer rate), the
 *     activity trend, the pipeline donut, and the busiest routes. Each KPI card
 *     is a jump-link into the queue it summarises.
 *   • Release requests — incoming; where THIS manager owns the SOURCE department.
 *     Release locks the requester's proposed effective date and applies the move.
 *   • My requests — the manager's own outbox (status + cancel-while-pending).
 *   • Done — resolved release requests on their team (released/declined/applied/
 *     cancelled) as a table, with View / Edit / Delete per row. A record, so past
 *     decisions aren't lost once acted on.
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
  // Summary is the landing view — the overview the queues hang off. The
  // "Awaiting your release" count still rides on the Release requests tab, so
  // the action queue announces itself without being the default.
  const [sub, setSub] = useState<SubTab>('summary');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Done-tab row actions: View opens a read-only detail sheet; Edit opens the
  // correctable paperwork (effective date / reason / note). Both track the row
  // by ID and re-read it from `done` on every render, so a live refresh (or
  // another manager's action) updates an open dialog instead of leaving it
  // showing a stale snapshot — and closes it outright if the row is deleted.
  const [viewRowId, setViewRowId] = useState<string | null>(null);
  const [editRowId, setEditRowId] = useState<string | null>(null);
  const [editEffective, setEditEffective] = useState('');
  const [editReason, setEditReason] = useState('');
  const [editNote, setEditNote] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  // Done-tab toolbar: free-text search + a single click-to-filter KPI card.
  const [doneQuery, setDoneQuery] = useState('');
  const [doneFilter, setDoneFilter] = useState<DoneFilter | null>(null);
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

  /** Seed the Edit dialog from the row being corrected. */
  const openEdit = (row: DepartmentTransferRequestRow) => {
    setEditRowId(row.id);
    // Seed ONLY from the LOCKED date. Falling back to proposed_effective_date
    // here would silently promote a non-binding proposal into the locked
    // effective date the moment anyone opened Edit to fix a typo in the reason —
    // on a declined/withdrawn record that invents a transfer date that never
    // happened, and payroll prorates rate changes off this field.
    setEditEffective(row.effective_date ?? '');
    setEditReason(row.reason ?? '');
    setEditNote(row.approver_note ?? '');
  };

  const saveEdit = async () => {
    if (!editRow) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/department-transfers/${editRow.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          effective_date: editEffective || null,
          reason: editReason,
          note: editNote,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      toast.success('Transfer record updated');
      setEditRowId(null);
      load({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save changes');
    } finally {
      setSavingEdit(false);
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

  // ── Done tab: KPIs, search + filter, export ────────────────────────────────

  // Counts over ALL resolved rows (not the filtered view) — a stable read that
  // doesn't shift as you narrow the search.
  const doneKpis = useMemo(() => {
    let applied = 0;
    let scheduled = 0;
    let declined = 0;
    let withdrawn = 0;
    for (const r of done) {
      if (r.status === 'applied') applied += 1;
      else if (r.status === 'approved') scheduled += 1;
      else if (r.status === 'rejected') declined += 1;
      else if (r.status === 'cancelled') withdrawn += 1;
    }
    return { applied, scheduled, declined, withdrawn };
  }, [done]);

  // Search matches the person (name + email), both departments, the requester,
  // the releaser, the status wording, and the free-text reason/note — so a
  // manager can find a record by whatever they happen to remember about it.
  const filteredDone = useMemo(() => {
    const q = doneQuery.trim().toLowerCase();
    if (!q && !doneFilter) return done;
    return done.filter((r) => {
      if (doneFilter && r.status !== doneFilter) return false;
      if (!q) return true;
      const hay = [
        r.employee_name,
        r.employee_email,
        r.employee_work_email,
        r.from_department,
        r.to_department,
        r.requested_by,
        r.approver_email,
        r.reason,
        r.approver_note,
        STATUS_LABEL[r.status],
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [done, doneQuery, doneFilter]);

  // Human-facing description of the active filter, threaded into the export's
  // provenance preamble so a saved file records what it was scoped to.
  const doneFilterLabel = useMemo(() => {
    const parts: string[] = [];
    if (doneFilter) parts.push(DONE_FILTER_LABEL[doneFilter]);
    if (doneQuery.trim()) parts.push(`matching "${doneQuery.trim()}"`);
    return parts.length ? parts.join(' · ') : 'All resolved transfers';
  }, [doneFilter, doneQuery]);

  // The export lib keys the releaser off `decided_by`; this list stores it as
  // `approver_email`. Map across, and drop the rate column — catalog rates are
  // resolved on the Accounting side only.
  const doneExportRows = useMemo<TransferExportSource[]>(
    () =>
      filteredDone.map((r) => ({
        employee_name: r.employee_name,
        employee_email: r.employee_email,
        from_department: r.from_department,
        to_department: r.to_department,
        status: r.status,
        requested_by: r.requested_by,
        decided_by: r.approver_email,
        effective_date: r.effective_date,
        proposed_effective_date: r.proposed_effective_date,
        sheet_synced: r.sheet_synced,
        created_at: r.created_at,
      })),
    [filteredDone],
  );

  // The live row behind each open dialog. Null (→ dialog closes) once the row
  // no longer exists, e.g. another manager deleted it while you had it open.
  const viewRow = useMemo(
    () => (viewRowId ? (done.find((r) => r.id === viewRowId) ?? null) : null),
    [done, viewRowId],
  );
  const editRow = useMemo(
    () => (editRowId ? (done.find((r) => r.id === editRowId) ?? null) : null),
    [done, editRowId],
  );

  const doneHasFilter = doneQuery.trim().length > 0 || doneFilter !== null;
  const clearDoneFilters = () => {
    setDoneQuery('');
    setDoneFilter(null);
  };
  const toggleDoneFilter = (f: DoneFilter) => setDoneFilter((cur) => (cur === f ? null : f));

  // The full list backing the active view — the source of truth for pagination.
  // Summary has no queue, so it pages over nothing.
  const activeList =
    sub === 'release'
      ? incoming
      : sub === 'mine'
        ? sortedOutgoing
        : sub === 'done'
          ? filteredDone
          : NO_ROWS;

  // Reset to page 1 whenever the view, its length, or the Done tab's search /
  // KPI filter changes — so a tab switch (or a live refresh that shrinks the
  // list) never strands you on an empty page, and narrowing the search always
  // lands on the first result even when the row COUNT happens to be unchanged.
  useEffect(() => {
    setPage(1);
  }, [sub, activeList.length, doneQuery, doneFilter]);

  // Disarm a pending two-click delete whenever the row it belongs to could have
  // left the screen (page turn, search, filter, tab switch). Without this the
  // armed row returns already-armed when you navigate back, so the next single
  // click deletes it — exactly what the two-click guard exists to prevent.
  useEffect(() => {
    setConfirmDeleteId(null);
  }, [sub, page, doneQuery, doneFilter]);

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
    () => (sub === 'done' ? filteredDone.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : []),
    [sub, filteredDone, safePage],
  );

  // ── Chart data, all derived from the loaded lists (no extra fetch) ──────────

  // Every row this manager can see, deduped by id across the three scoped lists.
  const allRows = useMemo(() => {
    const byId = new Map<string, DepartmentTransferRequestRow>();
    for (const r of [...incoming, ...outgoing, ...done]) if (!byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()];
  }, [incoming, outgoing, done]);

  // Four at-a-glance KPIs from the already-loaded lists (no extra fetch):
  //   • Awaiting your release — incoming still pending; this manager's action queue.
  //   • My requests in flight — outgoing not yet resolved (pending + released/scheduled).
  //   • Applied this month    — team transfers that actually landed since the 1st.
  //   • Transfer rate         — of every request that has REACHED an outcome,
  //     the share that actually moved someone. Denominator is applied + declined
  //     + withdrawn; still-open work (pending/scheduled) is excluded so the rate
  //     can't be dragged down by requests that simply haven't been decided yet.
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

    const appliedTotal = allRows.filter((r) => r.status === 'applied').length;
    const declinedTotal = allRows.filter((r) => r.status === 'rejected').length;
    const withdrawnTotal = allRows.filter((r) => r.status === 'cancelled').length;
    const resolvedTotal = appliedTotal + declinedTotal + withdrawnTotal;
    const transferRate = resolvedTotal > 0 ? Math.round((appliedTotal / resolvedTotal) * 100) : null;

    return {
      awaitingRelease,
      myInFlight,
      myScheduled,
      appliedThisMonth,
      appliedTotal,
      declinedTotal,
      withdrawnTotal,
      resolvedTotal,
      transferRate,
    };
  }, [incoming, outgoing, done, allRows]);

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
    // Summary leads — it's the overview the queues hang off. A dashboard, not a
    // queue, so it carries no count badge.
    { id: 'summary', label: 'Summary', count: 0, icon: LayoutDashboard },
    { id: 'release', label: 'Release requests', count: incoming.length, icon: Inbox },
    { id: 'mine', label: 'My requests', count: sortedOutgoing.length, icon: Send },
    { id: 'done', label: 'Done', count: done.length, icon: ClipboardCheck },
  ];

  // ── Done tab toolbar ───────────────────────────────────────────────────────
  // Four click-to-filter KPI cards over the resolved record, a search box, and a
  // CSV / Excel / PDF export of whatever is currently in view. Mirrors the
  // Accounting → Transfers toolbar, in this tab's blue.
  const doneToolbar = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TransferKpiCard
          label="Applied"
          value={doneKpis.applied}
          hint={doneFilter === 'applied' ? 'Filtering · click to clear' : 'Completed department moves'}
          tone="emerald"
          onClick={() => toggleDoneFilter('applied')}
          active={doneFilter === 'applied'}
        />
        <TransferKpiCard
          label="Scheduled"
          value={doneKpis.scheduled}
          hint={doneFilter === 'approved' ? 'Filtering · click to clear' : 'Released, not yet applied'}
          tone="sky"
          onClick={() => toggleDoneFilter('approved')}
          active={doneFilter === 'approved'}
        />
        <TransferKpiCard
          label="Declined"
          value={doneKpis.declined}
          hint={doneFilter === 'rejected' ? 'Filtering · click to clear' : 'Release refused'}
          tone="rose"
          onClick={() => toggleDoneFilter('rejected')}
          active={doneFilter === 'rejected'}
        />
        <TransferKpiCard
          label="Withdrawn"
          value={doneKpis.withdrawn}
          hint={doneFilter === 'cancelled' ? 'Filtering · click to clear' : 'Pulled by the requester'}
          tone="zinc"
          onClick={() => toggleDoneFilter('cancelled')}
          active={doneFilter === 'cancelled'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* basis-full below sm: the search takes its own row rather than
            shrinking to a few characters once the count + Clear + Export
            controls appear beside it on a phone. */}
        <div className="relative min-w-0 basis-full sm:max-w-md sm:basis-0 sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            value={doneQuery}
            onChange={(e) => setDoneQuery(e.target.value)}
            placeholder="Search people, departments, requester…"
            aria-label="Search resolved transfers"
            className="h-9 w-full rounded-xl border border-blue-100 bg-white pl-9 pr-9 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200/60 dark:border-blue-950/40 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:ring-blue-500/20"
          />
          {doneQuery && (
            <button
              type="button"
              onClick={() => setDoneQuery('')}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {doneHasFilter && (
          <>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {filteredDone.length.toLocaleString()} of {done.length.toLocaleString()}
            </span>
            <button
              type="button"
              onClick={clearDoneFilters}
              className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
            >
              Clear filters
            </button>
          </>
        )}
        <div className="ml-auto">
          <TransferExportMenu
            rows={doneExportRows}
            total={done.length}
            filterLabel={doneFilterLabel}
            title="Team Transfers"
            eyebrow="MANAGER - RESOLVED TEAM TRANSFERS"
            fileBase="team-transfers"
            includeRateChange={false}
            pdfTheme={MANAGER_PDF_THEME}
            accent="blue"
          />
        </div>
      </div>
    </div>
  );

  // ── Summary dashboard ──────────────────────────────────────────────────────
  // Lives in its own sub-tab so the work queues stay uncluttered. KPI cards on
  // top, then the Activity trend full width, then Pipeline and Busiest routes
  // side by side. Collapses to one column on narrow screens. Each KPI card is a
  // jump-link into the queue it summarises.
  const analytics = (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
        />
        <StatTile
          label="Applied this month"
          value={kpis.appliedThisMonth}
          hint="Transfers completed since the 1st"
          icon={CheckCircle2}
          accent="emerald"
          // Land on Done scoped to Applied. Without setting the filter
          // explicitly the tab would keep whatever search/filter was left
          // behind — so a non-zero tile could open an empty table.
          onClick={() => {
            setDoneQuery('');
            setDoneFilter('applied');
            setSub('done');
          }}
        />
        <StatTile
          label="Transfer rate"
          value={kpis.transferRate === null ? '—' : `${kpis.transferRate}%`}
          hint={
            kpis.transferRate === null
              ? 'No decided requests yet'
              : `${kpis.appliedTotal} of ${kpis.resolvedTotal} decided moved`
          }
          icon={Percent}
          accent="violet"
          title={
            kpis.transferRate === null
              ? 'Share of decided transfer requests that actually moved someone. Nothing has been decided yet.'
              : `${kpis.appliedTotal} applied vs ${kpis.declinedTotal} declined and ${kpis.withdrawnTotal} withdrawn. Requests still pending or scheduled are not counted.`
          }
          // The rate spans every outcome, so open Done unfiltered.
          onClick={() => {
            clearDoneFilters();
            setSub('done');
          }}
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

        {/* Segmented sub-tab control with a sliding pill indicator. Four tabs
            outgrow a phone, so the strip scrolls sideways rather than wrapping. */}
        <div className="-mx-1 mt-3.5 overflow-x-auto px-1 pb-0.5">
        <div
          role="tablist"
          aria-label="Transfer views"
          className="inline-flex rounded-xl border border-zinc-200/80 bg-zinc-100/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/60"
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
                  'relative z-10 inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-200',
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
      </div>

      {/* Body: one view at a time. The three work queues each get the full width
          (capped to a readable measure — the rows are compact); Summary gets the
          whole area to itself so the dashboard never competes with the queue. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {sub === 'summary' ? (
          <motion.div
            key="summary"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="min-w-0"
          >
            {analytics}
          </motion.div>
        ) : (
          // Done is a wide table — let it use the room. The two card queues stay
          // capped to a readable measure.
          <div className={cn('w-full min-w-0', sub !== 'done' && 'mx-auto max-w-4xl')}>
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
                                {formatDeptLabel(r.from_department)}
                              </span>
                              <ArrowRight className="h-3 w-3 shrink-0 text-zinc-400" />
                              <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 font-semibold text-white">
                                {formatDeptLabel(r.to_department)}
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
                                  <span>{formatDeptLabel(r.from_department)}</span>
                                  <ArrowRight className="h-3 w-3" />
                                  <span>{formatDeptLabel(r.to_department)}</span>
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
                        Resolved transfers show up here once released, applied, declined, or cancelled.
                      </p>
                    </div>
                  ) : (
                    <>
                    {doneToolbar}
                    {filteredDone.length === 0 ? (
                      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-blue-200 bg-white py-14 text-center dark:border-blue-950/40 dark:bg-[#0d1117]">
                        <Search className="h-7 w-7 text-blue-300 dark:text-blue-800" />
                        <p className="text-sm text-zinc-500">No transfers match this view.</p>
                        <button
                          type="button"
                          onClick={clearDoneFilters}
                          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Clear filters
                        </button>
                      </div>
                    ) : (
                    <>
                    {/* Done is a record, not a work queue — a plain table (same
                        shape as the MESA tables, in the Transfers blue) reads
                        faster across many rows and has room for the fields the
                        card layout hid: who decided it, and the locked effective
                        date. Below 640px the global responsive-table CSS stacks
                        each row into a labelled card (see data-label). */}
                    <div className="overflow-hidden rounded-2xl border border-blue-100/80 bg-white dark:border-blue-950/40 dark:bg-zinc-950">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-blue-100/80 bg-blue-50/40 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
                            <tr>
                              <th className="px-4 py-2.5">Employee</th>
                              <th className="px-4 py-2.5">Move</th>
                              <th className="px-4 py-2.5">Status</th>
                              <th className="px-4 py-2.5">Effective</th>
                              <th className="px-4 py-2.5">Requested by</th>
                              <th className="px-4 py-2.5">Decided by</th>
                              <th className="px-4 py-2.5 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-blue-100/60 dark:divide-blue-900/40">
                            {pageDone.map((r) => {
                              const meta = STATUS_META[r.status];
                              const StatusIcon = meta.icon;
                              const decidedStamp =
                                r.status === 'applied'
                                  ? r.applied_at ?? r.decided_at ?? r.updated_at
                                  : r.decided_at ?? r.updated_at;
                              // The locked date once released; until then the
                              // requester's proposal, flagged as not yet binding.
                              const effLocked = !!r.effective_date;
                              const effDate = r.effective_date ?? r.proposed_effective_date;
                              const sheetFailed = r.status === 'applied' && r.sheet_synced === false;
                              return (
                                <tr
                                  key={r.id}
                                  className="transition-colors hover:bg-blue-50/40 dark:hover:bg-blue-950/20"
                                >
                                  <td className="px-4 py-3" data-label="Employee">
                                    <div className="font-medium text-zinc-900 dark:text-zinc-100">
                                      {r.employee_name ?? r.employee_email}
                                    </div>
                                    {r.employee_name && (
                                      <div className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                        {r.employee_email}
                                      </div>
                                    )}
                                  </td>

                                  <td className="px-4 py-3" data-label="Move">
                                    <span className="inline-flex items-center gap-1.5">
                                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                        {formatDeptLabel(r.from_department)}
                                      </span>
                                      <ArrowRight className="h-3 w-3 shrink-0 text-zinc-400" />
                                      <span className="rounded bg-blue-600 px-1.5 py-0.5 font-medium text-white">
                                        {formatDeptLabel(r.to_department)}
                                      </span>
                                    </span>
                                  </td>

                                  <td className="px-4 py-3" data-label="Status">
                                    <span
                                      className={cn(
                                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                        STATUS_STYLE[r.status],
                                      )}
                                    >
                                      <StatusIcon className="h-3 w-3" />
                                      {STATUS_LABEL[r.status]}
                                    </span>
                                    {sheetFailed && (
                                      <div
                                        className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                                        title={r.sheet_sync_error ?? 'The Google Sheet write-back failed.'}
                                      >
                                        <AlertTriangle className="h-3 w-3" />
                                        Sheet not synced
                                      </div>
                                    )}
                                  </td>

                                  <td className="px-4 py-3" data-label="Effective">
                                    {effDate ? (
                                      <>
                                        <div className="tabular-nums text-zinc-700 dark:text-zinc-200">
                                          {effDate}
                                        </div>
                                        {!effLocked && (
                                          <div className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                                            proposed
                                          </div>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-zinc-400 dark:text-zinc-600">—</span>
                                    )}
                                  </td>

                                  <td className="px-4 py-3" data-label="Requested by">
                                    <div className="truncate text-zinc-700 dark:text-zinc-200">
                                      {r.requested_by}
                                    </div>
                                    <div
                                      className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500"
                                      title={fullStamp(r.created_at)}
                                    >
                                      {timeAgo(r.created_at)}
                                    </div>
                                  </td>

                                  <td className="px-4 py-3" data-label="Decided by">
                                    {r.approver_email ? (
                                      <div className="truncate text-zinc-700 dark:text-zinc-200">
                                        {r.approver_email}
                                      </div>
                                    ) : (
                                      <div className="text-zinc-400 dark:text-zinc-600">
                                        {r.status === 'cancelled' ? 'Withdrawn' : '—'}
                                      </div>
                                    )}
                                    <div
                                      className={cn('mt-0.5 text-[11px]', meta.text)}
                                      title={fullStamp(decidedStamp)}
                                    >
                                      {timeAgo(decidedStamp)}
                                    </div>
                                  </td>

                                  <td className="px-4 py-3 text-right" data-label="Actions">
                                    {confirmDeleteId === r.id ? (
                                      <span className="inline-flex items-center justify-end gap-2">
                                        <button
                                          type="button"
                                          onClick={() => void deleteRequest(r)}
                                          disabled={busyId === r.id}
                                          className="inline-flex items-center gap-1 font-semibold text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
                                        >
                                          {busyId === r.id ? (
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                          ) : (
                                            <Trash2 className="h-3 w-3" />
                                          )}
                                          Confirm
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmDeleteId(null)}
                                          className="text-zinc-400 hover:underline"
                                        >
                                          Cancel
                                        </button>
                                      </span>
                                    ) : (
                                      <span className="inline-flex items-center justify-end gap-3">
                                        <button
                                          type="button"
                                          onClick={() => setViewRowId(r.id)}
                                          className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline dark:text-blue-400"
                                        >
                                          <Eye className="h-3 w-3" />
                                          View
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => openEdit(r)}
                                          className="inline-flex items-center gap-1 font-medium text-zinc-600 hover:underline dark:text-zinc-300"
                                        >
                                          <Pencil className="h-3 w-3" />
                                          Edit
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => setConfirmDeleteId(r.id)}
                                          disabled={busyId === r.id}
                                          className="inline-flex items-center gap-1 font-medium text-zinc-500 hover:text-rose-600 hover:underline disabled:opacity-50 dark:text-zinc-400 dark:hover:text-rose-400"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                          Delete
                                        </button>
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <Paginator
                      page={safePage}
                      pageCount={pageCount}
                      total={filteredDone.length}
                      from={pageStart}
                      to={pageEnd}
                      onPage={setPage}
                      noun="records"
                    />
                    </>
                    )}
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        )}
      </div>

      {canRequest && (
        <ManagerTransferDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          myDepartments={myDepartments}
          onSubmitted={() => load()}
        />
      )}

      {/* View — the whole record, grouped into the four questions you actually
          ask of a transfer: who moved, who asked, who decided, and did the
          downstream write land. Everything the table can't fit lives here. */}
      <Dialog open={!!viewRow} onOpenChange={(o) => !o && setViewRowId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Transfer record
            </DialogTitle>
            <DialogDescription>
              The full history of this move, including what the table doesn&rsquo;t show.
            </DialogDescription>
          </DialogHeader>

          {viewRow &&
            (() => {
              const meta = STATUS_META[viewRow.status];
              const StatusIcon = meta.icon;
              const effLocked = !!viewRow.effective_date;
              const effDate = viewRow.effective_date ?? viewRow.proposed_effective_date;
              return (
                <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
                  {/* Banner — who, the move, and the outcome at a glance. The
                      hatch is the record's one material moment: a woven
                      hairline weave that gives the header a surface to sit on
                      without adding colour weight. */}
                  <div className="record-hatch overflow-hidden rounded-xl bg-blue-50/60 p-3 ring-1 ring-inset ring-blue-200/70 dark:bg-blue-950/25 dark:ring-blue-900/50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-zinc-900 dark:text-white">
                          {viewRow.employee_name ?? viewRow.employee_email}
                        </div>
                        <div className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                          {viewRow.employee_email}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          STATUS_STYLE[viewRow.status],
                        )}
                      >
                        <StatusIcon className="h-3 w-3" />
                        {STATUS_LABEL[viewRow.status]}
                      </span>
                    </div>

                    <div className="mt-3 flex items-center gap-1.5 text-[11px]">
                      <span className="min-w-0 truncate rounded bg-white/90 px-1.5 py-0.5 font-medium text-zinc-700 ring-1 ring-inset ring-zinc-200/80 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700/60">
                        {formatDeptLabel(viewRow.from_department)}
                      </span>
                      <ArrowRight className="h-3 w-3 shrink-0 text-blue-500 dark:text-blue-400" />
                      <span className="min-w-0 truncate rounded bg-blue-600 px-1.5 py-0.5 font-semibold text-white">
                        {formatDeptLabel(viewRow.to_department)}
                      </span>
                    </div>

                    {effDate && (
                      <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        Effective {effDate}
                        {/* "locked" inherits the line's colour; "proposed" is
                            the exception worth flagging, so it takes amber-800
                            (6.1:1 here — amber-700 measured 4.3:1 and fails). */}
                        <span
                          className={
                            effLocked ? undefined : 'font-medium text-amber-800 dark:text-amber-400'
                          }
                        >
                          ({effLocked ? 'locked' : 'proposed'})
                        </span>
                      </div>
                    )}
                  </div>

                  <DetailSection title="Request" icon={Send}>
                    <DetailRow label="Requested by" value={viewRow.requested_by} />
                    <DetailRow label="Requested at" value={fullStamp(viewRow.created_at) ?? null} />
                  </DetailSection>
                  <DetailNote label="Reason" value={viewRow.reason} />

                  <DetailSection title="Decision" icon={ClipboardCheck}>
                    <DetailRow
                      label="Decided by"
                      value={
                        viewRow.approver_email ??
                        (viewRow.status === 'cancelled' ? 'Withdrawn by the requester' : null)
                      }
                    />
                    <DetailRow label="Decided at" value={fullStamp(viewRow.decided_at) ?? null} />
                    {viewRow.applied_at && (
                      <DetailRow label="Applied at" value={fullStamp(viewRow.applied_at) ?? null} />
                    )}
                  </DetailSection>
                  <DetailNote
                    label="Approver note"
                    value={viewRow.approver_note}
                    tone={
                      viewRow.status === 'rejected' || viewRow.status === 'cancelled' ? 'rose' : 'neutral'
                    }
                  />

                  <DetailSection title="Employee contact" icon={Inbox}>
                    <DetailRow
                      label="Personal email"
                      value={viewRow.employee_personal_email ?? viewRow.employee_email}
                    />
                    <DetailRow label="Work email" value={viewRow.employee_work_email} />
                  </DetailSection>

                  {viewRow.status === 'applied' && (
                    <>
                      <DetailSection title="Downstream sync" icon={RefreshCw}>
                        <DetailRow
                          label="Google Sheet"
                          value={viewRow.sheet_synced ? 'Synced' : 'Not synced'}
                        />
                      </DetailSection>
                      <DetailNote label="Sync error" value={viewRow.sheet_sync_error} tone="rose" />
                    </>
                  )}
                </div>
              );
            })()}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const r = viewRow;
                setViewRowId(null);
                if (r) openEdit(r);
              }}
              className="gap-1.5"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button type="button" size="sm" onClick={() => setViewRowId(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit — correctable paperwork only. Status and the departments are
          deliberately absent: the move has already been written to the master
          list, so editing them here would desync the record from reality. */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRowId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              Edit transfer record
            </DialogTitle>
            <DialogDescription>
              {editRow?.employee_name ?? editRow?.employee_email} — {formatDeptLabel(editRow?.from_department)} →{' '}
              {formatDeptLabel(editRow?.to_department)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                <CalendarClock className="h-3.5 w-3.5" />
                Effective date
              </label>
              <DatePicker
                value={editEffective}
                onChange={setEditEffective}
                className="h-9 text-sm focus-visible:border-blue-300 focus-visible:ring-blue-200 dark:bg-zinc-900"
              />
              <p className="mt-1 text-[11px] text-zinc-400">
                Payroll prorates the rate change from this date, so it still matters after the move
                has been applied.
                {!editRow?.effective_date && editRow?.proposed_effective_date && (
                  <>
                    {' '}
                    This transfer has no locked date — the requester proposed{' '}
                    <strong className="text-zinc-500 dark:text-zinc-300">
                      {editRow.proposed_effective_date}
                    </strong>
                    .
                  </>
                )}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Reason
              </label>
              <textarea
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                rows={2}
                placeholder="Why this transfer was requested"
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Approver note
              </label>
              <textarea
                value={editNote}
                onChange={(e) => setEditNote(e.target.value)}
                rows={2}
                placeholder="The decline / withdrawal note shown to the requester"
                className="w-full rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              />
            </div>

            <p className="rounded-lg bg-zinc-50 px-2.5 py-2 text-[11px] leading-snug text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              Status and departments aren&rsquo;t editable — the move is already written to the
              master list. To reverse a transfer, raise a new one in the other direction.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditRowId(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void saveEdit()}
              disabled={savingEdit}
              className="gap-1.5 bg-blue-600 text-white hover:bg-blue-700"
            >
              {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
