'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  HeartCrack,
  History as HistoryIcon,
  Loader2,
  MoreHorizontal,
  Plane,
  Send,
  ShieldCheck,
  Thermometer,
  Trash2,
  User,
  Users,
  XCircle,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
type LeaveTypeMeta = {
  value: string;
  label: string;
  hint: string;
  icon: typeof Plane;
  iconClass: string;
};

const LEAVE_TYPES: LeaveTypeMeta[] = [
  {
    value: 'Vacation',
    label: 'Vacation',
    hint: 'Planned time off',
    icon: Plane,
    iconClass: 'text-sky-500',
  },
  {
    value: 'Sick',
    label: 'Sick',
    hint: 'Not feeling well',
    icon: Thermometer,
    iconClass: 'text-rose-500',
  },
  {
    value: 'Personal',
    label: 'Personal',
    hint: 'Personal matters',
    icon: User,
    iconClass: 'text-violet-500',
  },
  {
    value: 'Bereavement',
    label: 'Bereavement',
    hint: 'Loss of a loved one',
    icon: HeartCrack,
    iconClass: 'text-zinc-500',
  },
  {
    value: 'Other',
    label: 'Other',
    hint: 'Something else',
    icon: MoreHorizontal,
    iconClass: 'text-amber-500',
  },
];

function leaveTypeMeta(value: string): LeaveTypeMeta {
  return LEAVE_TYPES.find((t) => t.value === value) ?? LEAVE_TYPES[LEAVE_TYPES.length - 1];
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'cancelled';
type SubTab = 'new' | 'requests';

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return (
        <Badge className="border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/50 dark:text-amber-200">
          Pending
        </Badge>
      );
    case 'approved':
      return (
        <Badge className="border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/50 dark:text-emerald-200">
          Approved
        </Badge>
      );
    case 'rejected':
      return (
        <Badge className="border-red-300 bg-red-100 text-red-800 dark:border-red-700/60 dark:bg-red-950/50 dark:text-red-200">
          Rejected
        </Badge>
      );
    case 'cancelled':
      return (
        <Badge variant="outline" className="text-zinc-500 dark:text-zinc-400">
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function splitManagers(value: string | null | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function daysBetween(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1);
}

export default function EmployeeLeaves({
  employeeEmail,
  employeeName,
  department,
}: {
  employeeEmail: string;
  employeeName: string | null;
  department: string | null;
}) {
  const [rows, setRows] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [leaveType, setLeaveType] = useState<string>('Vacation');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [subTab, setSubTab] = useState<SubTab>('new');
  const reduceMotion = useReducedMotion();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/leave-requests?employee_email=${encodeURIComponent(employeeEmail)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: LeaveRequestRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setRows(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load leave history');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [employeeEmail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!startDate || !endDate) {
      toast.error('Choose start and end dates.');
      return;
    }
    if (new Date(endDate) < new Date(startDate)) {
      toast.error('End date must be on or after the start date.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/leave-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_email: employeeEmail,
          employee_name: employeeName?.trim() || null,
          department: department?.trim() || null,
          start_date: startDate,
          end_date: endDate,
          leave_type: leaveType,
          reason: reason.trim() || null,
        }),
      });
      const json = (await res.json()) as {
        error?: string;
        manager_email?: string | null;
        manager_emails?: string[] | null;
      };
      if (!res.ok) throw new Error(json.error || 'Request failed');

      const managers = (json.manager_emails ?? []).filter(Boolean);
      const description =
        managers.length === 0
          ? 'No department manager is configured yet — accounting will follow up.'
          : managers.length === 1
            ? `Sent to your manager (${managers[0]}). Any single approval clears the request.`
            : `Sent to ${managers.length} ${formatDeptLabel(department)} managers. Any one approval clears the request.`;
      toast.success('Leave request submitted', { description });

      setReason('');
      setStartDate('');
      setEndDate('');
      await load();
      setSubTab('requests');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(id: string) {
    setCancellingId(id);
    try {
      const res = await fetch(`/api/leave-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', employee_email: employeeEmail }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Cancel failed');
      toast.success('Request cancelled');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setCancellingId(null);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/leave-requests/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_email: employeeEmail }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Delete failed');
      toast.success('Request removed');
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const r of rows) {
      if (r.status in c) c[r.status as keyof typeof c]++;
    }
    return c;
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (statusFilter === 'all') return rows;
    return rows.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const today = new Date().toISOString().slice(0, 10);

  const contentTransition = { duration: reduceMotion ? 0.12 : 0.28, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        {/* Sub-tab switcher */}
        <div
          role="tablist"
          aria-label="Leave sections"
          className="relative inline-flex items-center gap-1 self-start rounded-lg border border-orange-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-blue-950/60 dark:bg-zinc-900/60"
        >
          <SubTabButton
            active={subTab === 'new'}
            onClick={() => setSubTab('new')}
            icon={CalendarPlus}
            label="New request"
          />
          <SubTabButton
            active={subTab === 'requests'}
            onClick={() => setSubTab('requests')}
            icon={HistoryIcon}
            label="My requests"
            count={rows.length}
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={subTab}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, filter: 'blur(2px)' }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, filter: 'blur(2px)' }}
            transition={contentTransition}
            className="space-y-6"
          >
            {subTab === 'new' ? (
              <>
                <LeaveHero
                  eyebrow="Time off & leave"
                  title="File a leave request"
                  subtitle="Pick the dates you'll be out and the kind of leave. We route it to the right people automatically — you don't need to chase anyone down."
                  department={department}
                />

                <Section
                  icon={CalendarDays}
                  eyebrow="Your request"
                  title="Dates, type, and a short reason"
                >
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="leave-type">Leave type</Label>
                        <LeaveTypeSelect value={leaveType} onChange={setLeaveType} />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="leave-reason">Reason (optional)</Label>
                        <Input
                          id="leave-reason"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Short note for your manager"
                          className="dark:bg-zinc-900"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="leave-start">Start date</Label>
                        <DatePicker
                          id="leave-start"
                          min={today}
                          value={startDate}
                          onChange={setStartDate}
                          required
                          className="dark:bg-zinc-900"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="leave-end">End date</Label>
                        <DatePicker
                          id="leave-end"
                          min={startDate || today}
                          value={endDate}
                          onChange={setEndDate}
                          required
                          className="dark:bg-zinc-900"
                        />
                      </div>
                    </div>

                    <Button
                      type="submit"
                      disabled={submitting}
                      className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm transition-shadow hover:from-orange-500 hover:to-orange-700 hover:shadow-md"
                    >
                      {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Submit request
                    </Button>
                  </form>
                </Section>

                <Section
                  icon={ShieldCheck}
                  eyebrow="How approval works"
                  title="Where your request goes"
                >
                  <div className="grid gap-2 sm:grid-cols-3">
                    <InfoRow
                      icon={Users}
                      title={`Sent to your ${formatDeptLabel(department) || 'department'} managers`}
                      body="Everyone who manages your department sees it at the same time."
                    />
                    <InfoRow
                      icon={CheckCircle2}
                      title="One approval clears it"
                      body="Any single manager can approve — no need for a yes from all of them."
                    />
                    <InfoRow
                      icon={FileText}
                      title="Accounting is looped in"
                      body="No extra step on your side once a manager approves."
                    />
                  </div>
                </Section>
              </>
            ) : (
              <>
                <LeaveHero
                  eyebrow="Time off & leave"
                  title="Your leave requests"
                  subtitle="Everything you've filed, with live status. Tap a total below to filter, and cancel anything that's still pending."
                  department={department}
                />

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <SummaryTile
                    icon={<Clock className="h-4 w-4 text-amber-500" />}
                    label="Pending"
                    value={counts.pending}
                    tone="amber"
                    active={statusFilter === 'pending'}
                    onClick={() => setStatusFilter(statusFilter === 'pending' ? 'all' : 'pending')}
                  />
                  <SummaryTile
                    icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                    label="Approved"
                    value={counts.approved}
                    tone="emerald"
                    active={statusFilter === 'approved'}
                    onClick={() => setStatusFilter(statusFilter === 'approved' ? 'all' : 'approved')}
                  />
                  <SummaryTile
                    icon={<XCircle className="h-4 w-4 text-rose-500" />}
                    label="Rejected"
                    value={counts.rejected}
                    tone="rose"
                    active={statusFilter === 'rejected'}
                    onClick={() => setStatusFilter(statusFilter === 'rejected' ? 'all' : 'rejected')}
                  />
                  <SummaryTile
                    icon={<CalendarDays className="h-4 w-4 text-zinc-400" />}
                    label="Cancelled"
                    value={counts.cancelled}
                    tone="zinc"
                    active={statusFilter === 'cancelled'}
                    onClick={() => setStatusFilter(statusFilter === 'cancelled' ? 'all' : 'cancelled')}
                  />
                </div>

                <Section
                  icon={HistoryIcon}
                  eyebrow="History"
                  title={statusFilter === 'all' ? 'All requests' : `${statusFilter[0].toUpperCase()}${statusFilter.slice(1)} requests`}
                  action={
                    statusFilter !== 'all' ? (
                      <button
                        type="button"
                        onClick={() => setStatusFilter('all')}
                        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-orange-600 transition-colors hover:bg-orange-50 hover:text-orange-700 dark:text-orange-400 dark:hover:bg-orange-950/40"
                      >
                        Clear filter
                      </button>
                    ) : undefined
                  }
                >
                  {loading ? (
                    <RequestsSkeleton />
                  ) : filteredRows.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-8 text-center">
                      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-500 ring-1 ring-orange-100 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900/50">
                        <CalendarDays className="h-6 w-6" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {rows.length === 0 ? 'No leave requests yet' : `No ${statusFilter} requests`}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                          {rows.length === 0
                            ? "File your first request and it'll show up here with live status."
                            : 'Nothing matches this filter right now.'}
                        </p>
                      </div>
                      {rows.length === 0 ? (
                        <Button
                          type="button"
                          onClick={() => setSubTab('new')}
                          className="mt-1 gap-1.5 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm hover:from-orange-500 hover:to-orange-700"
                        >
                          File a leave
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button type="button" variant="outline" onClick={() => setStatusFilter('all')}>
                          Clear filter
                        </Button>
                      )}
                    </div>
                  ) : (
                    <ul className="space-y-3">
                      {filteredRows.map((r) => {
                        const managers = splitManagers(r.manager_email);
                        const days = daysBetween(r.start_date, r.end_date);
                        const meta = leaveTypeMeta(r.leave_type);
                        const TypeIcon = meta.icon;
                        const canDelete = r.status === 'cancelled' || r.status === 'rejected';
                        return (
                          <li
                            key={r.id}
                            className="flex flex-col gap-2 rounded-xl border border-zinc-200/80 bg-white/80 p-3.5 transition-colors hover:border-orange-200 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-blue-900/60 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="flex items-center gap-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                                  <TypeIcon className={cn('h-3.5 w-3.5', meta.iconClass)} />
                                  {r.leave_type}
                                </span>
                                {statusBadge(r.status)}
                                <span className="text-[11px] text-zinc-500 dark:text-zinc-500">
                                  · {days} day{days === 1 ? '' : 's'}
                                </span>
                              </div>
                              <p className="font-mono text-xs text-zinc-700 tabular-nums dark:text-zinc-300">
                                {r.start_date} → {r.end_date}
                                {r.department ? (
                                  <span className="ml-2 text-zinc-400">· {r.department}</span>
                                ) : null}
                              </p>
                              {r.reason ? (
                                <p className="text-xs italic text-zinc-500 dark:text-zinc-400">
                                  &ldquo;{r.reason}&rdquo;
                                </p>
                              ) : null}
                              {r.status === 'pending' && managers.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-1 pt-1">
                                  <Users className="h-3 w-3 text-zinc-400" />
                                  <span className="text-[10px] uppercase tracking-wide text-zinc-400">
                                    Awaiting any of:
                                  </span>
                                  {managers.map((m) => (
                                    <span
                                      key={m}
                                      className="rounded-full bg-orange-50 px-2 py-px font-mono text-[10px] text-orange-800 dark:bg-blue-950/40 dark:text-orange-300"
                                    >
                                      {m}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {r.status !== 'pending' && r.approver_email ? (
                                <p className="text-[10px] text-zinc-400">
                                  Decided by <span className="font-mono">{r.approver_email}</span>
                                  {r.approver_note ? ` — ${r.approver_note}` : ''}
                                </p>
                              ) : null}
                            </div>
                            {r.status === 'pending' && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="shrink-0 gap-1.5 border-zinc-300 text-zinc-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 dark:border-zinc-600 dark:hover:border-rose-700 dark:hover:bg-rose-950/30"
                                disabled={cancellingId === r.id}
                                onClick={() => void handleCancel(r.id)}
                              >
                                {cancellingId === r.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <XCircle className="h-3.5 w-3.5" />
                                )}
                                Cancel
                              </Button>
                            )}
                            {canDelete && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label="Delete request"
                                title="Remove from your list"
                                className="shrink-0 gap-1.5 self-start text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/30 dark:hover:text-rose-400 sm:self-center"
                                disabled={deletingId === r.id}
                                onClick={() => void handleDelete(r.id)}
                              >
                                {deletingId === r.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                                Delete
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Section>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function LeaveHero({
  eyebrow,
  title,
  subtitle,
  department,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  department: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-orange-100/80 bg-gradient-to-br from-orange-50/70 via-white to-blue-50/40 p-5 shadow-sm dark:border-blue-950/60 dark:from-orange-950/25 dark:via-[#0d1117] dark:to-blue-950/20 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl dark:text-white">
            {title}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            {subtitle}
          </p>
        </div>
        {department && (
          <Badge
            variant="outline"
            className="shrink-0 border-orange-200 bg-orange-50 text-orange-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-orange-300"
          >
            {formatDeptLabel(department)}
          </Badge>
        )}
      </div>
    </div>
  );
}

function SubTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-orange-50/70 hover:text-orange-700 dark:text-zinc-400 dark:hover:bg-orange-950/30 dark:hover:text-orange-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="leave-subtab-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-orange-500 to-orange-600 shadow-sm"
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
        {typeof count === 'number' && count > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums',
              active
                ? 'bg-white/25 text-white'
                : 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300',
            )}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

function Section({
  icon: Icon,
  eyebrow,
  title,
  children,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3 px-1">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-amber-100/70 text-orange-600 ring-1 ring-orange-100 dark:from-orange-950/60 dark:to-amber-950/40 dark:text-orange-300 dark:ring-orange-900/60">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700 dark:text-orange-300">
            {eyebrow}
          </p>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-white">{title}</h3>
        </div>
        {action}
      </div>
      <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
        <CardContent className="p-4 sm:p-5">{children}</CardContent>
      </Card>
    </section>
  );
}

function InfoRow({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full flex-col gap-1.5 rounded-lg border border-zinc-100 bg-white p-3 dark:border-zinc-800/80 dark:bg-zinc-900/40">
      <div className="flex items-start gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-300">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <p className="min-w-0 text-[13px] font-semibold leading-snug text-zinc-900 dark:text-white">
          {title}
        </p>
      </div>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}

function RequestsSkeleton() {
  return (
    <ul className="space-y-3">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="rounded-xl border border-zinc-200/70 bg-white/70 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/40"
        >
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <div
              className="h-3.5 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
              style={{ animationDelay: `${i * 90}ms` }}
            />
            <div className="h-4 w-16 animate-pulse rounded-full bg-zinc-200/70 dark:bg-zinc-800/70" />
          </div>
          <div className="mt-2.5 h-3 w-44 animate-pulse rounded bg-zinc-200/60 dark:bg-zinc-800/60" />
        </li>
      ))}
    </ul>
  );
}

function LeaveTypeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);
  const selected = leaveTypeMeta(value);
  const SelectedIcon = selected.icon;

  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const gap = 6;
    const estPanelHeight = LEAVE_TYPES.length * 48 + 8;
    const spaceBelow = window.innerHeight - rect.bottom;
    const up = spaceBelow < estPanelHeight + gap && rect.top > spaceBelow;
    setPos({
      top: up ? rect.top - gap : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      up,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'flex h-10 w-full items-center gap-2.5 rounded-md border bg-white px-3 text-left text-sm transition-colors dark:bg-zinc-900',
          open
            ? 'border-orange-300 ring-2 ring-orange-200/70 dark:border-blue-700 dark:ring-blue-900/50'
            : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700',
        )}
      >
        <SelectedIcon className={cn('h-4 w-4 shrink-0', selected.iconClass)} />
        <span className="flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">
          {selected.label}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>

      {mounted && pos
        ? createPortal(
            <ul
              ref={panelRef}
              role="listbox"
              aria-hidden={!open}
              style={{
                position: 'fixed',
                top: pos.up ? undefined : pos.top,
                bottom: pos.up ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                width: pos.width,
              }}
              className={cn(
                'z-50 max-h-[60vh] overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-xl will-change-[opacity,transform] transition-[opacity,transform] motion-reduce:transition-none dark:border-zinc-700 dark:bg-zinc-900',
                pos.up ? 'origin-bottom' : 'origin-top',
                open
                  ? 'pointer-events-auto translate-y-0 scale-100 opacity-100 duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)]'
                  : cn(
                      'pointer-events-none scale-[0.98] opacity-0 duration-[140ms] ease-[cubic-bezier(0.4,0,1,1)]',
                      pos.up ? 'translate-y-1' : '-translate-y-1',
                    ),
              )}
            >
              {LEAVE_TYPES.map((t, i) => {
                const Icon = t.icon;
                const active = t.value === value;
                return (
                  <li key={t.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={open ? 0 : -1}
                      onClick={() => {
                        onChange(t.value);
                        setOpen(false);
                      }}
                      style={{ transitionDelay: open ? `${i * 14}ms` : '0ms' }}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-sm transition-[transform,background-color] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                        open
                          ? 'translate-y-0 duration-200'
                          : cn('duration-[140ms]', pos.up ? 'translate-y-1' : '-translate-y-1'),
                        active
                          ? 'bg-orange-50 dark:bg-blue-950/40'
                          : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60',
                      )}
                    >
                      <Icon className={cn('h-4 w-4 shrink-0', t.iconClass)} />
                      <span className="flex-1">
                        <span className="block font-medium text-zinc-900 dark:text-zinc-100">
                          {t.label}
                        </span>
                        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                          {t.hint}
                        </span>
                      </span>
                      {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-orange-500" />}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}

function SummaryTile({
  icon,
  label,
  value,
  tone,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: 'amber' | 'emerald' | 'rose' | 'zinc';
  active: boolean;
  onClick: () => void;
}) {
  const toneClass: Record<typeof tone, string> = {
    amber:
      'border-amber-200 bg-amber-50/60 hover:border-amber-300 dark:border-amber-900/60 dark:bg-amber-950/30',
    emerald:
      'border-emerald-200 bg-emerald-50/60 hover:border-emerald-300 dark:border-emerald-900/60 dark:bg-emerald-950/30',
    rose:
      'border-rose-200 bg-rose-50/60 hover:border-rose-300 dark:border-rose-900/60 dark:bg-rose-950/30',
    zinc:
      'border-zinc-200 bg-zinc-50/60 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40',
  };
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 rounded-xl border p-3 text-left transition-all duration-200',
        toneClass[tone],
        active
          ? 'ring-2 ring-orange-300 dark:ring-orange-500/50'
          : 'hover:-translate-y-0.5 hover:shadow-sm',
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 ring-1 ring-black/5 dark:bg-black/20 dark:ring-white/5">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-mono text-lg font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100">
          {value}
        </p>
        <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </p>
      </div>
    </button>
  );
}
