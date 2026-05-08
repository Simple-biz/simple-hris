'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Clock,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  UserMinus,
  UserX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { EmployeeRow } from '@/lib/supabase/employees';

type HistoryRow = {
  id: string;
  Name: string | null;
  'Work Email': string | null;
  'Personal Email': string | null;
  Department: string | null;
  'Start Date': string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
  off_boarded_note: string | null;
};

const REASON_LABELS: Record<string, string> = {
  resigned: 'Resigned',
  end_of_contract: 'End of contract',
  performance: 'Performance',
  attendance: 'Attendance',
  time_manipulation: 'Time manipulation',
  other: 'Other',
};

type OffboardReason =
  | 'resigned'
  | 'performance'
  | 'time_manipulation'
  | 'attendance'
  | 'end_of_contract'
  | 'other';

const REASON_OPTIONS: { value: OffboardReason; label: string }[] = [
  { value: 'resigned', label: 'Resigned' },
  { value: 'end_of_contract', label: 'End of contract' },
  { value: 'performance', label: 'Performance' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'time_manipulation', label: 'Time manipulation' },
  { value: 'other', label: 'Other (note required)' },
];

export default function HrOffboarding() {
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<EmployeeRow | null>(null);

  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historySearch, setHistorySearch] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);

  const fetchRoster = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as {
        employees?: EmployeeRow[];
        error?: string;
      };
      if (json.error) throw new Error(json.error);
      setRoster(json.employees ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load roster');
      setRoster([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch('/api/hr/offboard-history', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: HistoryRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setHistory(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load offboard history');
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const handleRestore = useCallback(async (row: HistoryRow) => {
    const email = row['Work Email'];
    if (!email) return;
    setRestoring(email);
    try {
      const res = await fetch('/api/hr/reonboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: email }),
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to restore');
      toast.success(`${row.Name ?? email} restored to active roster`);
      await Promise.all([fetchRoster(), fetchHistory()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to restore');
    } finally {
      setRestoring(null);
    }
  }, [fetchRoster, fetchHistory]);

  useEffect(() => {
    void fetchRoster();
    void fetchHistory();
  }, [fetchRoster, fetchHistory]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((r) =>
      [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [roster, search]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    return history.filter((r) =>
      [r.Name, r['Work Email'], r.Department, r.off_boarded_reason, r.off_boarded_by]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [history, historySearch]);

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Header */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div
          className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl"
          aria-hidden
        />
        <div
          className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/20 blur-2xl"
          aria-hidden
        />
        <div className="relative flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/95">
            <UserMinus className="h-3 w-3 shrink-0" />
            Offboarding
          </div>
          <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
            Wrap up cleanly when people move on.
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/85">
            Find an employee, click <span className="font-semibold">Offboard</span>,
            pick a reason. Their record is retained for reporting; they drop from
            payroll and manager dashboards immediately.
          </p>
        </div>
      </header>

      {/* Roster card */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-2 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
                <UserX className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">
                  Active employees
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {loading
                    ? 'Loading roster…'
                    : `${filtered.length} of ${roster.length} shown`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, dept…"
                  className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchRoster()}
                disabled={loading}
                className="shrink-0"
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    loading && 'animate-spin',
                  )}
                />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
              <UserX className="h-8 w-8 text-emerald-400/60" />
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {roster.length === 0
                  ? 'No active employees on file.'
                  : 'No rows match your search.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Employee ID</th>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Start</th>
                    <th className="px-4 py-3 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                  {filtered.slice(0, 200).map((r, i) => (
                    <tr
                      key={`${r.work_email ?? r.personal_email ?? i}-${i}`}
                      className="align-middle hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20"
                    >
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                        {r.employee_id ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-zinc-900 dark:text-zinc-100">
                        {r.name ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">
                        {r.department ?? '—'}
                      </td>
                      <td className="break-all px-4 py-2.5 font-mono text-xs text-zinc-700 dark:text-zinc-300">
                        {r.work_email ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                        {r.start_date ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setTarget(r)}
                          disabled={!r.work_email}
                          className="h-7 gap-1 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-800 disabled:opacity-50 dark:border-rose-700/50 dark:text-rose-300 dark:hover:bg-rose-950/30"
                          title={
                            r.work_email
                              ? `Off-board ${r.name ?? r.work_email}`
                              : 'No work email — cannot off-board'
                          }
                        >
                          <UserMinus className="h-3 w-3" />
                          Offboard
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 200 && (
                <div className="border-t border-emerald-100/60 px-4 py-2 text-center text-[11px] text-zinc-500 dark:border-emerald-900/40 dark:text-zinc-500">
                  Showing first 200 of {filtered.length} — refine the search to narrow.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Offboard history card */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-2 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-zinc-500 to-zinc-700 text-white shadow-sm shadow-zinc-600/25">
                <Clock className="h-4 w-4" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold">
                  Offboard history
                </CardTitle>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {historyLoading
                    ? 'Loading…'
                    : `${filteredHistory.length} of ${history.length} off-boarded`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Search name, reason…"
                  className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchHistory()}
                disabled={historyLoading}
                className="shrink-0"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', historyLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          {historyLoading ? (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
              <Clock className="h-8 w-8 text-zinc-300 dark:text-zinc-600" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {history.length === 0 ? 'No off-boarded employees yet.' : 'No rows match your search.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-gradient-to-r from-zinc-50 via-white to-zinc-50/80 text-xs text-zinc-600 dark:from-zinc-900/70 dark:via-zinc-950 dark:to-zinc-900/50 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Reason</th>
                    <th className="px-4 py-3 font-semibold">Off-boarded</th>
                    <th className="px-4 py-3 font-semibold">By</th>
                    <th className="px-4 py-3 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100/80 bg-white/85 dark:divide-zinc-800/50 dark:bg-zinc-950/40">
                  {filteredHistory.slice(0, 200).map((r) => {
                    const email = r['Work Email'] ?? '';
                    const isRestoring = restoring === email;
                    return (
                      <tr
                        key={r.id}
                        className="align-middle hover:bg-zinc-50/60 dark:hover:bg-zinc-900/30"
                      >
                        <td className="px-4 py-2.5 font-medium text-zinc-900 dark:text-zinc-100">
                          {r.Name ?? '—'}
                        </td>
                        <td className="break-all px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                          {email || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">
                          {r.Department ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          {r.off_boarded_reason ? (
                            <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                              {REASON_LABELS[r.off_boarded_reason] ?? r.off_boarded_reason}
                            </span>
                          ) : '—'}
                          {r.off_boarded_note && (
                            <p className="mt-0.5 max-w-[180px] truncate text-[11px] text-zinc-500" title={r.off_boarded_note}>
                              {r.off_boarded_note}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-zinc-600 dark:text-zinc-400">
                          {r.off_boarded_at
                            ? new Date(r.off_boarded_at).toLocaleDateString('en-PH', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                              })
                            : '—'}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-zinc-500 dark:text-zinc-500">
                          {r.off_boarded_by ?? '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleRestore(r)}
                            disabled={isRestoring || !email}
                            className="h-7 gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 disabled:opacity-50 dark:border-emerald-700/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                          >
                            {isRestoring ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3" />
                            )}
                            Restore
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredHistory.length > 200 && (
                <div className="border-t border-zinc-100/60 px-4 py-2 text-center text-[11px] text-zinc-500 dark:border-zinc-800/40 dark:text-zinc-500">
                  Showing first 200 of {filteredHistory.length} — refine the search to narrow.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <OffboardConfirmDialog
        target={target}
        onClose={() => setTarget(null)}
        onSuccess={() => {
          setTarget(null);
          void fetchRoster();
          void fetchHistory();
        }}
      />
    </div>
  );
}

function OffboardConfirmDialog({
  target,
  onClose,
  onSuccess,
}: {
  target: EmployeeRow | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState<OffboardReason | ''>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever the target changes (incl. close).
  useEffect(() => {
    setReason('');
    setNote('');
  }, [target?.work_email]);

  const open = !!target;
  const noteRequired = reason === 'other';
  const isValid = reason && (!noteRequired || note.trim().length > 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!target?.work_email || !isValid) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/hr/offboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_email: target.work_email,
          reason,
          note: note.trim() || null,
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        webhook?: { fired: boolean; status: number | null; error: string | null };
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? 'Failed to off-board');
      }
      const webhookOk = json.webhook?.error == null && json.webhook?.fired;
      if (webhookOk) {
        toast.success(`${target.name ?? target.work_email} off-boarded`, {
          description:
            'Removed from active rosters. Account-deactivation workflow triggered.',
        });
      } else {
        // DB update committed; only the n8n webhook hiccupped. Surface that
        // explicitly so HR knows the @simple.biz account may not be deactivated
        // yet and can re-fire / call Drew if needed.
        toast.warning(`${target.name ?? target.work_email} off-boarded — but workflow didn't fire`, {
          description: `Roster updated, but the offboarding webhook returned: ${json.webhook?.error ?? 'unknown error'}. Their account may still be active — re-run when n8n is available.`,
          duration: 8000,
        });
      }
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to off-board');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-500 to-rose-700 text-white">
              <UserMinus className="h-4 w-4" />
            </span>
            Offboard employee
          </DialogTitle>
          <DialogDescription className="text-xs">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              {target?.name ?? target?.work_email}
            </span>{' '}
            will be marked off-boarded and removed from active rosters. Their
            record is retained for reporting.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Reason <span className="text-rose-500">*</span>
            </Label>
            <Select
              value={reason}
              onValueChange={(v) => v && setReason(v as OffboardReason)}
            >
              <SelectTrigger className="w-full data-[size=default]:h-9">
                <SelectValue placeholder="Pick a reason" />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              Note {noteRequired && <span className="text-rose-500">*</span>}
            </Label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder={
                noteRequired
                  ? 'Required when reason is "Other"'
                  : 'Optional — anything HR should remember.'
              }
              className={cn(
                'w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm placeholder:text-muted-foreground',
                'focus:border-emerald-500 focus:outline-none focus:ring-3 focus:ring-emerald-500/20',
                'dark:bg-input/30',
              )}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!isValid || submitting}
              className="gap-1.5 bg-gradient-to-br from-rose-500 to-rose-700 text-white hover:from-rose-500 hover:to-rose-600 disabled:opacity-50"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <UserMinus className="h-3.5 w-3.5" />
              )}
              {submitting ? 'Off-boarding…' : 'Confirm offboard'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
