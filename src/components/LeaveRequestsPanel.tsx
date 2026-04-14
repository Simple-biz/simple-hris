'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, X, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import type { LeaveRequestRow } from '@/lib/supabase/leave-requests';

function statusBadge(status: string) {
  switch (status) {
    case 'pending':
      return <Badge className="bg-amber-100 text-amber-900 dark:bg-amber-950/50">Pending</Badge>;
    case 'approved':
      return <Badge className="bg-emerald-100 text-emerald-900 dark:bg-emerald-950/50">Approved</Badge>;
    case 'rejected':
      return <Badge className="bg-red-100 text-red-800 dark:bg-red-950/50">Rejected</Badge>;
    case 'cancelled':
      return <Badge variant="outline">Cancelled</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function LeaveRequestsPanel() {
  const [rows, setRows] = useState<LeaveRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending'>('pending');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  const [selected, setSelected] = useState<LeaveRequestRow | null>(null);
  const [approverEmail, setApproverEmail] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/leave-requests?scope=all', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: LeaveRequestRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error || 'Failed to load');
      setRows(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = rows.filter((r) => (filter === 'pending' ? r.status === 'pending' : true));

  function openDialog(row: LeaveRequestRow, a: 'approve' | 'reject') {
    setSelected(row);
    setAction(a);
    setNote('');
    setDialogOpen(true);
  }

  async function confirmAction() {
    if (!selected?.id) return;
    const em = approverEmail.trim();
    if (!em) {
      toast.error('Enter your work email — you must be a configured approver.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/leave-requests/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'approve' ? 'approve' : 'reject',
          approver_email: em,
          approver_note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error || 'Update failed');
      toast.success(action === 'approve' ? 'Leave approved' : 'Leave rejected');
      setDialogOpen(false);
      setSelected(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 p-6 dark:bg-none dark:bg-[#0d1117]">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 overflow-hidden">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Leave requests</h2>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-500">
            Department managers approve by default (see <span className="font-mono text-xs">leave_department_managers_json</span>).
            Accounting can use <span className="font-mono text-xs">leave_accounting_notify_emails</span> or{' '}
            <span className="font-mono text-xs">leave_approver_emails</span>. Enter <strong>your</strong> email
            when approving so access can be verified.
          </p>
        </div>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-orange-100/80 dark:border-blue-950/60">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
            <CardTitle className="text-lg">Queue</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as 'all' | 'pending')}
                className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <option value="pending">Pending only</option>
                <option value="all">All</option>
              </select>
              <Button type="button" variant="outline" size="sm" className="gap-1" onClick={() => void load()}>
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto p-0 sm:p-6 pt-0">
            {loading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-center text-sm text-zinc-500 py-8">No leave requests.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[800px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-zinc-200 bg-orange-50/50 text-left dark:border-zinc-800 dark:bg-blue-950/30">
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Employee</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Dept</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Type</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Dates</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Manager</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Status</th>
                      <th className="p-3 font-medium text-zinc-600 dark:text-zinc-400">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-zinc-100 hover:bg-zinc-50/80 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
                      >
                        <td className="p-3">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.employee_name ?? '—'}</div>
                          <div className="font-mono text-xs text-zinc-500">{r.employee_email}</div>
                        </td>
                        <td className="p-3 text-zinc-700 dark:text-zinc-300">{r.department ?? '—'}</td>
                        <td className="p-3">{r.leave_type}</td>
                        <td className="p-3 whitespace-nowrap tabular-nums text-zinc-600 dark:text-zinc-400">
                          {r.start_date} → {r.end_date}
                        </td>
                        <td className="p-3 font-mono text-xs text-zinc-600">{r.manager_email ?? '—'}</td>
                        <td className="p-3">{statusBadge(r.status)}</td>
                        <td className="p-3">
                          {r.status === 'pending' ? (
                            <div className="flex flex-wrap gap-1">
                              <Button
                                type="button"
                                size="sm"
                                className="h-8 gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                                onClick={() => openDialog(r, 'approve')}
                              >
                                <Check className="h-3.5 w-3.5" />
                                Approve
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1 border-red-300 text-red-600"
                                onClick={() => openDialog(r, 'reject')}
                              >
                                <X className="h-3.5 w-3.5" />
                                Reject
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-zinc-400">
                              {r.approver_email ?? '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{action === 'approve' ? 'Approve leave' : 'Reject leave'}</DialogTitle>
            <DialogDescription>
              {selected?.employee_name} ({selected?.leave_type}) {selected?.start_date} – {selected?.end_date}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="approver-email">Your work email</Label>
              <Input
                id="approver-email"
                type="email"
                value={approverEmail}
                onChange={(e) => setApproverEmail(e.target.value)}
                placeholder="you@company.com"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="approver-note">Note (optional)</Label>
              <Input
                id="approver-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Message to employee"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button type="button" disabled={saving} onClick={() => void confirmAction()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
