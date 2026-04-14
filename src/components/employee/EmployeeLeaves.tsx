'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Loader2, Send, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';

const LEAVE_TYPES = ['Vacation', 'Sick', 'Personal', 'Bereavement', 'Other'] as const;

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return (
        <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">Pending</Badge>
      );
    case 'approved':
      return (
        <Badge className="bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">Approved</Badge>
      );
    case 'rejected':
      return <Badge className="bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200">Rejected</Badge>;
    case 'cancelled':
      return <Badge variant="outline" className="text-zinc-500">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
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
      const json = (await res.json()) as { error?: string; manager_email?: string | null };
      if (!res.ok) throw new Error(json.error || 'Request failed');
      toast.success('Leave request submitted', {
        description: json.manager_email
          ? `We've routed this to your manager (${json.manager_email}) for review. Accounting is also in the loop for payroll.`
          : 'Your manager will review this request. Accounting is also notified so payroll can plan around your time off.',
      });
      setReason('');
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">File a leave</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-500">
            Pick the dates you'll be out and the kind of leave you're taking—you can add a short reason if it helps.
            Your <strong>manager</strong> approves or declines the request. <strong>Accounting</strong> sees it too
            so they can align payroll and coverage; you don't need to email them separately.
          </p>
        </div>

        <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-white">
              <CalendarDays className="h-5 w-5 text-orange-500" />
              New request
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
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                    className="dark:bg-zinc-900"
                  />
                </div>
              </div>
              <Button
                type="submit"
                disabled={submitting}
                className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white shadow-sm"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Submit request
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card className="border-orange-100/80 shadow-sm dark:border-blue-950/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">My requests</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-zinc-500">No leave requests yet.</p>
            ) : (
              <ul className="space-y-3">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-2 rounded-lg border border-zinc-200/80 bg-white/80 p-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">{r.leave_type}</span>
                        {statusBadge(r.status)}
                      </div>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">
                        {r.start_date} → {r.end_date}
                        {r.department ? ` · ${r.department}` : ''}
                      </p>
                      {r.reason ? (
                        <p className="text-xs text-zinc-500 dark:text-zinc-500">
                          {r.reason}
                        </p>
                      ) : null}
                      {r.status !== 'pending' && r.approver_email ? (
                        <p className="text-[10px] text-zinc-400">
                          By {r.approver_email}
                          {r.approver_note ? ` — ${r.approver_note}` : ''}
                        </p>
                      ) : null}
                    </div>
                    {r.status === 'pending' && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 border-zinc-300 text-zinc-600 dark:border-zinc-600"
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
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
