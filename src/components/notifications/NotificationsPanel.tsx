'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, CheckCircle2, Lock, Unlock, AlertTriangle, PartyPopper, BadgeDollarSign, MessagesSquare, X, Search, ChevronLeft, ChevronRight, ArrowRight, Receipt, Info, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { AppView } from '@/lib/rbac/views';
import {
  resolveNotificationAction,
  type NotificationActionTarget,
} from '@/lib/notifications/notification-actions';
import { PayStubModal } from '@/components/paystub/PayStubModal';

interface EmployeeNotification {
  id: string;
  type: 'rate.change' | 'promotion' | string;
  tone: 'positive' | 'neutral' | string;
  title: string;
  message: string;
  details: {
    before?: { regular_rate?: string | number | null; ot_rate?: string | number | null };
    after?:  { regular_rate?: string | number | null; ot_rate?: string | number | null };
    before_title?: string | null;
    after_title?: string | null;
    submitted_at?: string | null;
    /** For onboarding.submitted: the hr_onboarding_submissions.id to open. */
    submission_id?: string | null;
    /** For offboarding.requested: the offboarding_queue row id(s) this alert covers. */
    request_ids?: string[] | null;
    /** For payroll.paid: the pay-week file whose stub the "Open Pay Stub" button opens. */
    source_file?: string | null;
  } | null;
  read_at: string | null;
  created_at: string;
}

/** Live status of an offboarding_queue row, keyed by its id (HR panel only). */
interface QueueStatusInfo {
  status: 'pending' | 'processing' | 'completed' | 'dismissed' | 'returned' | 'cancelled';
  processed_by: string | null;
  decided_at: string | null;
  employee_name: string | null;
}

/**
 * Past-tense outcome phrase for a terminal offboarding-queue status, rendered as
 * "Already {phrase}" on a request notification whose queue row has since been
 * actioned. Only terminal statuses appear here — pending/processing keep the
 * live "Review request" call-to-action instead.
 */
const OFFBOARD_ACTIONED_PHRASE: Record<string, string> = {
  completed: 'offboarded',
  dismissed: 'dismissed',
  returned: 'returned to the manager',
  cancelled: 'withdrawn by the manager',
};

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
  } catch {
    return '';
  }
}

function formatRate(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

interface NotificationsPanelProps {
  viewerEmail?: string | null;
  accent?: 'orange' | 'blue' | 'emerald' | 'yellow' | 'zinc' | 'pink';
  /**
   * Whether the viewer can delete (dismiss) notifications. Deleting is an
   * "edit" action, so dashboards that enforce per-feature RBAC pass the result
   * of `canEditFeature(perms, view, 'notifications')` here. Defaults to `true`
   * so dashboards that don't yet load feature permissions keep working.
   */
  canDelete?: boolean;
  /** When true, silently backfills notifications for already-submitted
   *  onboarding forms before the first fetch. Pass on HR/admin panels. */
  backfillOnboarding?: boolean;
  /**
   * The dashboard this panel is mounted in. Used with {@link onNavigate} to
   * decide whether an actionable notification (e.g. a new onboarding
   * submission) can render a "jump to it" button here.
   */
  view?: AppView;
  /**
   * Called when the viewer clicks an actionable notification's button. The host
   * dashboard drives its own tab/sub-tab state to the target and opens the
   * referenced entity. Omit to render notifications as read-only cards.
   */
  onNavigate?: (target: NotificationActionTarget) => void;
}

function formatLockedAt(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return null;
  }
}

export default function NotificationsPanel({
  viewerEmail,
  accent = 'orange',
  canDelete = true,
  backfillOnboarding = false,
  view,
  onNavigate,
}: NotificationsPanelProps) {
  const { state: lockState, loading } = useDispatchLock();
  const [items, setItems] = useState<EmployeeNotification[]>([]);
  const [itemsLoading, setItemsLoading] = useState<boolean>(!!viewerEmail);
  // Live status of the offboarding_queue rows referenced by any
  // `offboarding.requested` notification, so the card can tell HR when the
  // request has already been actioned (offboarded / dismissed / returned /
  // withdrawn) rather than dangling a stale "Review request" button.
  const [queueStatus, setQueueStatus] = useState<Record<string, QueueStatusInfo>>({});
  // Pay-week file for the paystub modal opened from a "Salary Paid" card (null = closed).
  const [paystubFile, setPaystubFile] = useState<string | null>(null);

  const normEmail = useMemo(
    () => (viewerEmail ? viewerEmail.trim().toLowerCase() : null),
    [viewerEmail],
  );

  const refetch = useCallback(async () => {
    if (!normEmail) return;
    try {
      // Scope the fetch to this dashboard so a multi-dashboard user only sees
      // the notifications that belong here (the server filters by view).
      const params = new URLSearchParams({ email: normEmail });
      if (view) params.set('view', view);
      const res = await fetch(
        `/api/employee-notifications?${params.toString()}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { notifications?: EmployeeNotification[] };
      setItems(json.notifications ?? []);
    } catch {
      /* keep prior list */
    } finally {
      setItemsLoading(false);
    }
  }, [normEmail, view]);

  useEffect(() => {
    if (backfillOnboarding) {
      // Silently backfill notifications for any submitted onboarding forms that
      // were never notified (e.g. submissions predating this feature). Runs once
      // on mount; idempotent on the server side.
      void fetch('/api/hr/backfill-onboarding-notifications', { method: 'POST' })
        .then(() => refetch())
        .catch(() => refetch());
    } else {
      void refetch();
    }
  }, [backfillOnboarding, refetch]);

  // Realtime: refetch on any insert/update for this recipient.
  useEffect(() => {
    if (!normEmail) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`employee-notifications-${normEmail}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'employee_notifications',
          filter: `recipient_email=eq.${normEmail}`,
        },
        () => { void refetch(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [normEmail, refetch]);

  // Mark unread as read once the panel has displayed them. Scope this to the
  // notifications actually shown here (by id) rather than every unread row for
  // the email — otherwise opening one dashboard would clear the unread badges
  // of the user's other dashboards, whose notifications aren't shown here.
  useEffect(() => {
    if (!normEmail) return;
    const unreadIds = items.filter(n => !n.read_at).map(n => n.id);
    if (unreadIds.length === 0) return;
    const t = window.setTimeout(() => {
      void fetch('/api/employee-notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: unreadIds }),
      });
    }, 2000);
    return () => window.clearTimeout(t);
  }, [items, normEmail]);

  // Every offboarding_queue id referenced by an offboarding.requested alert.
  const offboardIds = useMemo(() => {
    const set = new Set<string>();
    for (const n of items) {
      if (n.type !== 'offboarding.requested') continue;
      const ids = n.details?.request_ids;
      if (Array.isArray(ids)) ids.forEach((x) => { if (typeof x === 'string') set.add(x); });
    }
    return Array.from(set).sort();
  }, [items]);
  const offboardIdsKey = offboardIds.join(',');

  // Resolve the live queue status for those rows. Gated to the HR dashboard —
  // it's the only panel wired with `view` + `onNavigate` (so the only one that
  // renders offboarding action buttons), and the offboarding-queue endpoint is
  // HR/admin/manager-only. Refetches whenever the referenced id set changes.
  useEffect(() => {
    if (view !== 'hr' || offboardIdsKey === '') return;
    let cancelled = false;
    void fetch('/api/offboarding-queue', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { rows?: Array<QueueStatusInfo & { id: string }> }) => {
        if (cancelled) return;
        const map: Record<string, QueueStatusInfo> = {};
        for (const row of json.rows ?? []) {
          map[row.id] = {
            status: row.status,
            processed_by: row.processed_by ?? null,
            decided_at: row.decided_at ?? null,
            employee_name: row.employee_name ?? null,
          };
        }
        setQueueStatus(map);
      })
      .catch(() => { /* leave prior statuses; card falls back to the CTA */ });
    return () => { cancelled = true; };
  }, [view, offboardIdsKey]);

  /**
   * Summarize the queue rows behind one offboarding.requested notification.
   * Returns `null` when no referenced row is known yet (status not loaded) so
   * the card keeps its default "Review request" button. When every known row is
   * terminal, `resolved` is true and the card shows the outcome instead.
   */
  const summarizeOffboard = useCallback(
    (ids: string[]): { resolved: boolean; phrase: string; by: string | null; at: string | null } | null => {
      const infos = ids.map((id) => queueStatus[id]).filter(Boolean) as QueueStatusInfo[];
      if (infos.length === 0) return null;
      const hasActionable = infos.some((i) => i.status === 'pending' || i.status === 'processing');
      if (hasActionable) return { resolved: false, phrase: '', by: null, at: null };
      const distinct = new Set(infos.map((i) => i.status));
      const phrase = distinct.size === 1 ? (OFFBOARD_ACTIONED_PHRASE[[...distinct][0]] ?? 'handled') : 'handled';
      // Attribute to the most recent decision (who/when).
      const latest = infos.reduce((a, b) => ((b.decided_at ?? '') > (a.decided_at ?? '') ? b : a));
      return { resolved: true, phrase, by: latest.processed_by, at: latest.decided_at };
    },
    [queueStatus],
  );

  const unreadCount = items.filter(n => !n.read_at).length + (lockState.locked ? 1 : 0);
  const hasAny = items.length > 0 || lockState.locked;

  const handleDelete = useCallback(async (id: string) => {
    // Optimistic removal; refetch will reconcile if the API rejects (e.g. the
    // server denies the delete on a permission / ownership check).
    setItems(prev => prev.filter(n => n.id !== id));
    try {
      const res = await fetch(`/api/employee-notifications?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) void refetch();
    } catch {
      void refetch();
    }
  }, [refetch]);

  // Click-through: mark this one read (best-effort — the panel is about to
  // unmount as the dashboard switches tabs) and hand the target to the host.
  // URL-based targets (`href`) are routed here directly, so hosts don't need
  // an onNavigate handler for cross-page jumps like the /tickets board.
  const router = useRouter();
  const handleNavigate = useCallback(
    (id: string, target: NotificationActionTarget) => {
      if (normEmail) {
        void fetch('/api/employee-notifications', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id] }),
        }).catch(() => {});
      }
      if (target.href) {
        router.push(target.href);
        return;
      }
      onNavigate?.(target);
    },
    [normEmail, onNavigate, router],
  );

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((n) =>
      [n.title, n.message].some((s) => s?.toLowerCase().includes(q)),
    );
  }, [items, search]);

  // Reset to page 0 whenever search or items change.
  useEffect(() => { setPage(0); }, [search, items.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const [clearing, setClearing] = useState(false);
  const handleClearAll = useCallback(async () => {
    if (!normEmail || items.length === 0) return;
    setClearing(true);
    const ids = items.map(n => n.id);
    setItems([]);
    try {
      await fetch('/api/employee-notifications/clear-all', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normEmail, ids }),
      });
    } catch {
      void refetch();
    } finally {
      setClearing(false);
    }
  }, [normEmail, items, refetch]);

  const ring: Record<typeof accent, string> = {
    orange: 'ring-orange-200 dark:ring-orange-900/40',
    blue: 'ring-blue-200 dark:ring-blue-900/40',
    emerald: 'ring-emerald-200 dark:ring-emerald-900/40',
    yellow: 'ring-yellow-200 dark:ring-yellow-900/40',
    zinc: 'ring-zinc-200 dark:ring-zinc-800',
    pink: 'ring-pink-200 dark:ring-pink-900/40',
  };

  const iconBg: Record<typeof accent, string> = {
    orange: 'bg-orange-50 dark:bg-orange-950/30',
    blue: 'bg-blue-50 dark:bg-blue-950/30',
    emerald: 'bg-emerald-50 dark:bg-emerald-950/30',
    yellow: 'bg-yellow-50 dark:bg-yellow-950/30',
    zinc: 'bg-zinc-100 dark:bg-zinc-800/60',
    pink: 'bg-pink-50 dark:bg-pink-950/30',
  };

  const iconColor: Record<typeof accent, string> = {
    orange: 'text-orange-400 dark:text-orange-500',
    blue: 'text-blue-400 dark:text-blue-500',
    emerald: 'text-emerald-400 dark:text-emerald-500',
    yellow: 'text-yellow-400 dark:text-yellow-500',
    zinc: 'text-zinc-400 dark:text-zinc-500',
    pink: 'text-pink-400 dark:text-pink-500',
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-100 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-[#0d1117]">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-zinc-400 dark:text-zinc-500" />
          <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
            Notifications
          </h1>
          {unreadCount > 0 && (
            <span className="ml-1 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400">
              {unreadCount} active
            </span>
          )}
          {items.length > 0 && canDelete && (
            <button
              onClick={handleClearAll}
              disabled={clearing}
              className="ml-auto inline-flex items-center rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-[11px] font-medium text-zinc-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 transition-colors duration-150 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-red-800 dark:hover:bg-red-950/30 dark:hover:text-red-400"
            >
              {clearing ? 'Clearing…' : 'Clear all'}
            </button>
          )}
        </div>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
          System alerts, approvals, and activity updates.
        </p>
        {items.length > 0 && (
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notifications…"
              className="h-8 w-full rounded-md border border-zinc-200 bg-zinc-50 pl-8 pr-3 text-xs text-zinc-800 placeholder-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200 dark:placeholder-zinc-500 dark:focus:border-zinc-500"
            />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-50/60 dark:bg-[#0d1117]">
        {(loading || itemsLoading) ? (
          /* Loading skeleton */
          <div className="space-y-3 px-4 py-5 sm:px-6">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-xl border border-zinc-100 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 h-8 w-8 shrink-0 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-2/3 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                    <div className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800" />
                    <div className="h-2.5 w-3/4 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (items.length > 0 || lockState.locked) ? (
          <div className="space-y-4 px-4 py-5 sm:px-6">
            {lockState.locked && (
            <>
            <div className="overflow-hidden rounded-xl border border-amber-200/80 bg-white shadow-sm dark:border-amber-900/40 dark:bg-zinc-900/80">
              {/* Coloured top stripe */}
              <div className="h-1 w-full bg-gradient-to-r from-amber-400 to-orange-500" />

              <div className="p-4 sm:p-5">
                <div className="flex items-start gap-3.5">
                  {/* Icon */}
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-50 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900/50">
                    <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Title row */}
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                        Payroll Processing Started
                      </p>
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10.5px] font-semibold text-red-700 dark:bg-red-950/50 dark:text-red-400">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                        Active
                      </span>
                    </div>

                    {/* Body */}
                    <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                      Payroll is currently being processed. The following actions are
                      temporarily paused:
                    </p>

                    {/* Paused items list */}
                    <ul className="mt-2.5 space-y-1.5">
                      {[
                        'Bank account changes',
                        'Leave request filing',
                        'PAB issue submissions',
                      ].map((item) => (
                        <li
                          key={item}
                          className="flex items-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-500"
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />
                          {item}
                        </li>
                      ))}
                    </ul>

                    {/* Meta — time only. Operator identity is intentionally
                        hidden so other roles can't see who started processing. */}
                    {lockState.lockedAt && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                        <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">
                          {formatLockedAt(lockState.lockedAt)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <p className="mt-3 px-1 text-[11.5px] text-zinc-400 dark:text-zinc-600">
              This notification will clear automatically when processing is complete.
            </p>
            </>
            )}

            {filtered.length === 0 && search.trim() && (
              <p className="py-6 text-center text-xs text-zinc-400">No notifications match &ldquo;{search}&rdquo;.</p>
            )}
            {pageItems.map((n) => {
              const positive = n.tone === 'positive';
              const isRate = n.type === 'rate.change';
              const isPayrollStart = n.type === 'payroll.processing_started';
              const isPayrollStop  = n.type === 'payroll.processing_stopped';
              const isPayroll = isPayrollStart || isPayrollStop;
              // Ticket cards (replies, assignments) wear the board's
              // red-and-black theme: black surface, solid red accents —
              // deliberately flat, no gradients.
              const isTicket = n.type === 'ticket.replied' || n.type === 'ticket.assigned';
              // Cards that carry an "Open Pay Stub" button opening the statement
              // in a modal: Payment Dispatch marked this person paid
              // (payroll.paid), or Accounting uploaded a new week whose pay is now
              // ready to view (payroll.available). Both key the modal on
              // details.source_file.
              const isPaidStub = n.type === 'payroll.paid';
              const isAvailableStub = n.type === 'payroll.available';
              const isStubCard = isPaidStub || isAvailableStub;
              const paidStubFile =
                isStubCard && typeof n.details?.source_file === 'string'
                  ? n.details.source_file
                  : null;

              const stripe = isTicket
                ? 'bg-red-600'
                : isPayrollStart
                ? 'bg-gradient-to-r from-amber-400 to-orange-500'
                : isPayrollStop
                  ? 'bg-gradient-to-r from-zinc-300 to-zinc-400 dark:from-zinc-600 dark:to-zinc-500'
                  : positive
                    ? 'bg-gradient-to-r from-emerald-400 to-teal-500'
                    : 'bg-gradient-to-r from-zinc-300 to-zinc-400 dark:from-zinc-700 dark:to-zinc-600';
              const ringCls = isTicket
                ? 'border-red-900/70'
                : isPayrollStart
                ? 'border-amber-200/80 dark:border-amber-900/40'
                : isPayrollStop
                  ? 'border-zinc-200 dark:border-zinc-800'
                  : positive
                    ? 'border-emerald-200/80 dark:border-emerald-900/40'
                    : 'border-zinc-200 dark:border-zinc-800';
              const iconWrap = isTicket
                ? 'bg-red-950 ring-red-900/70'
                : isPayrollStart
                ? 'bg-amber-50 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-900/50'
                : isPayrollStop
                  ? 'bg-zinc-100 ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700'
                  : positive
                    ? 'bg-emerald-50 ring-emerald-200 dark:bg-emerald-950/30 dark:ring-emerald-900/50'
                    : 'bg-zinc-100 ring-zinc-200 dark:bg-zinc-800/60 dark:ring-zinc-700';
              const iconCls = isTicket
                ? 'text-red-500'
                : isPayrollStart
                ? 'text-amber-600 dark:text-amber-400'
                : isPayrollStop
                  ? 'text-zinc-500 dark:text-zinc-400'
                  : positive
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-zinc-500 dark:text-zinc-400';
              // kpi.scored wears the Trophy so it reads as the same thing as the
              // employee's KPI Results tab (which is where the number lives).
              const Icon = n.type === 'kpi.scored' ? Trophy : isAvailableStub ? Receipt : isPaidStub ? BadgeDollarSign : isTicket ? MessagesSquare : isPayrollStart ? Lock : isPayrollStop ? Unlock : positive ? PartyPopper : BadgeDollarSign;
              // Resolve whenever the host declared its view; keep the action
              // only if we can actually act on it (self-routed href, or a
              // host-provided tab navigator).
              const resolved = view
                ? resolveNotificationAction(view, n.type, n.details as Record<string, unknown> | null)
                : null;
              const action = resolved && (resolved.href || onNavigate) ? resolved : null;
              // For an offboarding request, check whether its queue row has since
              // been actioned so we can detail the outcome instead of the CTA.
              const offboardResolution =
                n.type === 'offboarding.requested' && Array.isArray(n.details?.request_ids)
                  ? summarizeOffboard(
                      (n.details!.request_ids as unknown[]).filter((x): x is string => typeof x === 'string'),
                    )
                  : null;
              const beforeReg = n.details?.before?.regular_rate;
              const afterReg  = n.details?.after?.regular_rate;
              const beforeOt  = n.details?.before?.ot_rate;
              const afterOt   = n.details?.after?.ot_rate;
              const beforeTitle = n.details?.before_title ?? null;
              const afterTitle  = n.details?.after_title ?? null;
              const showTitleRow = !!(beforeTitle || afterTitle);

              return (
                <div
                  key={n.id}
                  className={cn(
                    'overflow-hidden rounded-xl border bg-white shadow-sm dark:bg-zinc-900/80',
                    ringCls,
                    !n.read_at &&
                      (isTicket
                        ? 'ring-1 ring-red-900/40'
                        : 'ring-1 ring-emerald-200/50 dark:ring-emerald-900/30'),
                    // Red-and-black ticket card: black in both themes.
                    isTicket && 'bg-zinc-950 dark:bg-zinc-950',
                  )}
                >
                  <div className={cn('h-1 w-full', stripe)} />
                  <div className="p-4 sm:p-5">
                    <div className="flex items-start gap-3.5">
                      <div className={cn(
                        'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1',
                        iconWrap,
                      )}>
                        <Icon className={cn('h-4 w-4', iconCls)} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p
                            className={cn(
                              'text-[14px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100',
                              isTicket && 'text-zinc-50',
                            )}
                          >
                            {n.title}
                          </p>
                          {!n.read_at && (
                            <span
                              className={cn(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold',
                                isTicket
                                  ? 'bg-red-500/15 text-red-400'
                                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
                              )}
                            >
                              New
                            </span>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => void handleDelete(n.id)}
                              aria-label="Delete notification"
                              title="Delete notification"
                              className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                        <p
                          className={cn(
                            'mt-1.5 text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400',
                            isTicket && 'text-zinc-300',
                          )}
                        >
                          {n.message}
                        </p>

                        {/* Bonuses land later in the cycle, so the freshly
                            uploaded week is hours-only at first — say so before
                            anyone panics at a "low" number. payroll.paid cards
                            deliberately don't carry this (bonuses are in by
                            mark-paid). Render-side so every existing card shows
                            it too; remove here when uploads include bonuses. */}
                        {isAvailableStub && (
                          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-200/80 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>
                              Bonuses aren&rsquo;t added yet — this first figure is mostly your
                              hours. Bonuses are applied later in the cycle, before payout.
                            </span>
                          </div>
                        )}

                        {action && offboardResolution?.resolved ? (
                          /* Queue row already actioned — detail the outcome; the
                             viewer can still jump to the queue to see the record. */
                          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2 text-[12px] dark:border-zinc-800 dark:bg-zinc-900/40">
                            <span className="inline-flex items-center gap-1.5 font-semibold text-zinc-700 dark:text-zinc-300">
                              <CheckCircle2 className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
                              Already {offboardResolution.phrase}
                            </span>
                            {offboardResolution.by && (
                              <span className="text-zinc-500 dark:text-zinc-500">by {offboardResolution.by}</span>
                            )}
                            {offboardResolution.at && (
                              <span className="text-zinc-400 dark:text-zinc-600">· {formatRelative(offboardResolution.at)}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleNavigate(n.id, action)}
                              className="group ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                            >
                              View request
                              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                            </button>
                          </div>
                        ) : action ? (
                          <button
                            type="button"
                            onClick={() => handleNavigate(n.id, action)}
                            className={cn(
                              'group mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2',
                              isTicket
                                ? 'border-red-700 bg-red-600 text-white hover:border-red-600 hover:bg-red-500 focus-visible:ring-red-500/50'
                                : 'border-blue-900 bg-blue-900 text-white hover:border-blue-800 hover:bg-blue-800 focus-visible:ring-blue-500/50 dark:border-blue-800/80 dark:bg-blue-950 dark:text-blue-100 dark:hover:border-blue-700 dark:hover:bg-blue-900',
                            )}
                          >
                            {action.label}
                            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                          </button>
                        ) : null}

                        {paidStubFile && (
                          <button
                            type="button"
                            onClick={() => setPaystubFile(paidStubFile)}
                            className="group mt-3 inline-flex items-center gap-1.5 rounded-lg border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:border-emerald-500 hover:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 dark:border-emerald-700 dark:bg-emerald-700 dark:hover:border-emerald-600 dark:hover:bg-emerald-600"
                          >
                            <Receipt className="h-3.5 w-3.5" />
                            Open Pay Stub
                            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                          </button>
                        )}

                        {isRate && (
                          <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-zinc-100 bg-zinc-50/60 p-3 text-[12px] dark:border-zinc-800 dark:bg-zinc-900/40">
                            <div>
                              <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">Regular</div>
                              <div className="mt-0.5 font-medium text-zinc-700 dark:text-zinc-300">
                                ₱{formatRate(beforeReg)} <span className="text-zinc-400">→</span>{' '}
                                <span className={positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-900 dark:text-zinc-100'}>
                                  ₱{formatRate(afterReg)}
                                </span>
                              </div>
                            </div>
                            <div>
                              <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">Overtime</div>
                              <div className="mt-0.5 font-medium text-zinc-700 dark:text-zinc-300">
                                ₱{formatRate(beforeOt)} <span className="text-zinc-400">→</span>{' '}
                                <span className={positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-900 dark:text-zinc-100'}>
                                  ₱{formatRate(afterOt)}
                                </span>
                              </div>
                            </div>
                            {showTitleRow && (
                              <div className="col-span-2">
                                <div className="text-[10.5px] uppercase tracking-wide text-zinc-400">Title</div>
                                <div className="mt-0.5 font-medium text-zinc-700 dark:text-zinc-300">
                                  {beforeTitle || '—'} <span className="text-zinc-400">→</span>{' '}
                                  <span className={positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-900 dark:text-zinc-100'}>
                                    {afterTitle || '—'}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        <div
                          className={cn(
                            'mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800',
                            isTicket && 'border-zinc-800',
                          )}
                        >
                          <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500">
                            {formatRelative(n.details?.submitted_at ?? n.created_at)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {totalPages > 1 && (
              <div data-readonly-allow className="flex items-center justify-between border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <p className="text-[11px] text-zinc-400">
                  {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPage(0)}
                    disabled={safePage === 0}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="h-3 w-3 -ml-2" />
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </button>
                  <span className="min-w-[3.5rem] text-center text-[11px] text-zinc-500">
                    {safePage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setPage(totalPages - 1)}
                    disabled={safePage >= totalPages - 1}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="h-3 w-3 -ml-2" />
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center gap-5 px-6 py-16 text-center">
            <div
              className={cn(
                'flex h-16 w-16 items-center justify-center rounded-full ring-1',
                iconBg[accent],
                ring[accent],
              )}
            >
              <Bell className={cn('h-7 w-7', iconColor[accent])} strokeWidth={1.5} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                <CheckCheck className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" />
                All caught up
              </div>
              <p className="max-w-xs text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-500">
                No notifications right now. Approvals, issues, and system alerts
                will appear here when they arrive.
              </p>
            </div>
            {/* Ghost skeleton */}
            <div className="mt-2 w-full max-w-sm space-y-2.5 opacity-25">
              {[80, 60, 70].map((w, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700" />
                  <div className="flex-1 space-y-1.5">
                    <div
                      className="h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800"
                      style={{ width: `${w}%` }}
                    />
                    <div className="h-2 w-1/3 rounded-full bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <PayStubModal
        open={paystubFile !== null}
        sourceFile={paystubFile}
        onClose={() => setPaystubFile(null)}
      />
    </div>
  );
}
