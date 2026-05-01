'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Send,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';

const LEAVE_TYPES = ['Vacation', 'Sick', 'Personal', 'Bereavement', 'Other'] as const;

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'cancelled';

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

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
            : `Sent to ${managers.length} ${department ?? ''} managers. Any one approval clears the request.`;
      toast.success('Leave request submitted', { description });

      setReason('');
      setStartDate('');
      setEndDate('');
      await load();
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <header>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Leaves
            </h2>
            {department && (
              <Badge
                variant="outline"
                className="border-orange-200 bg-orange-50 text-orange-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-orange-300"
              >
                {department}
              </Badge>
            )}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
            Pick the dates you'll be out, the kind of leave, and a short reason if it helps.
            Requests go to <strong>your department's managers</strong> — any single one of them
            can approve. Accounting is looped in automatically.
          </p>
        </header>

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

        <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-white">
              <CalendarDays className="h-5 w-5 text-orange-500" />
              File a leave
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="leave-type">Leave type</Label>
                  <select
                    id="leave-type"
                    value={leaveType}
                    onChange={(e) => setLeaveType(e.target.value)}
                    className={cn(
                      'h-10 w-full rounded-md border border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900',
                    )}
                  >
                    {LEAVE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
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
                  <Input
                    id="leave-start"
                    type="date"
                    min={today}
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    required
                    className="dark:bg-zinc-900"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="leave-end">End date</Label>
                  <Input
                    id="leave-end"
                    type="date"
                    min={startDate || today}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                    className="dark:bg-zinc-900"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50/60 px-3 py-2 text-[11px] leading-relaxed text-blue-900 dark:border-blue-950/60 dark:bg-blue-950/30 dark:text-blue-200">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-blue-500 dark:text-blue-400" />
                <span>
                  Goes to your <strong>{department || 'department'}</strong> managers — only{' '}
                  <strong>one approval</strong> is needed.
                </span>
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm hover:from-orange-500 hover:to-orange-700"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Submit request
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">
              My requests
            </CardTitle>
            {statusFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="text-xs font-medium text-orange-600 hover:text-orange-700 dark:text-orange-400"
              >
                Clear filter
              </button>
            )}
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : filteredRows.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">
                {rows.length === 0
                  ? 'No leave requests yet.'
                  : `No ${statusFilter} requests.`}
              </p>
            ) : (
              <ul className="space-y-3">
                {filteredRows.map((r) => {
                  const managers = splitManagers(r.manager_email);
                  const days = daysBetween(r.start_date, r.end_date);
                  return (
                    <li
                      key={r.id}
                      className="flex flex-col gap-2 rounded-lg border border-zinc-200/80 bg-white/80 p-3 transition-colors hover:border-orange-200 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-blue-900/60 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
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
                            “{r.reason}”
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
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
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
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-lg border p-2.5 text-left transition-all',
        toneClass[tone],
        active && 'ring-2 ring-orange-300 dark:ring-orange-500/50',
      )}
    >
      {icon}
      <div className="min-w-0">
        <p className="font-mono text-base font-bold leading-tight tabular-nums text-zinc-900 dark:text-zinc-100">
          {value}
        </p>
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </p>
      </div>
    </button>
  );
}
