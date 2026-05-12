'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Loader2, RotateCcw, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * Shape returned by `/api/manager/pending-hires`. Subset of
 * `HrPendingEmployeeRow` — keep in sync with `src/lib/supabase/hr-pending-employees.ts`.
 */
type PendingHireRow = {
  id: number;
  created_at: string;
  name: string;
  personal_email: string;
  work_email: string | null;
  department: string;
  job_description: string | null;
  start_date: string | null;
  status: 'pending_work_email' | 'ready' | 'promoted' | 'cancelled';
  orientation_attended_at: string | null;
  orientation_attended_by: string | null;
  orientation_note: string | null;
};

interface NewlyHiredPanelProps {
  viewerEmail: string | null;
  teamGate:
    | { kind: 'loading' }
    | { kind: 'elevated' }
    | { kind: 'department'; departments: string[] }
    | { kind: 'error'; message: string };
}

function fmtLongDate(raw: string | null): string {
  if (!raw) return '—';
  const isoOnly = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const d = new Date(`${isoOnly}T00:00:00`);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function NewlyHiredPanel({ viewerEmail, teamGate }: NewlyHiredPanelProps) {
  const [rows, setRows] = useState<PendingHireRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<number, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/manager/pending-hires', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: PendingHireRow[]; error?: string | null };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load newly hired list');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reload if the dept assignments arrive after first mount (the page first
  // renders with teamGate kind=loading; once it resolves we re-hit the API).
  useEffect(() => {
    if (teamGate.kind === 'loading') return;
    void refresh();
  }, [teamGate.kind, refresh]);

  async function markAttended(id: number) {
    setBusyId(id);
    try {
      const note = (noteDraft[id] ?? '').trim();
      const res = await fetch(`/api/manager/pending-hires/${id}/orientation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note || null }),
      });
      const json = (await res.json()) as { row?: PendingHireRow; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success('Orientation marked as attended');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark orientation');
    } finally {
      setBusyId(null);
    }
  }

  async function unmarkAttended(id: number) {
    if (!confirm('Clear the orientation attendance for this hire?')) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/manager/pending-hires/${id}/orientation`, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      toast.success('Orientation cleared');
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to clear orientation');
    } finally {
      setBusyId(null);
    }
  }

  if (teamGate.kind === 'loading' || loading) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading newly hired roster…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-rose-100/80 bg-gradient-to-br from-white to-rose-50/40 ring-1 ring-rose-500/10 dark:border-rose-950/50">
        <CardContent className="py-8 text-center text-sm text-rose-700 dark:text-rose-300">{error}</CardContent>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card className="border-blue-100/70 bg-gradient-to-br from-white to-blue-50/40 ring-1 ring-blue-500/10 dark:border-blue-950/50 dark:from-zinc-950 dark:to-blue-950/15">
        <CardContent className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-700 text-white shadow-md shadow-blue-500/25">
            <UserPlus className="h-6 w-6" />
          </div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No newly hired employees</p>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
            When HR adds a new hire to a department you manage, they&apos;ll show up here. Mark their
            orientation as attended to unblock HR from promoting them to the master list.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Pending hires routed to your departments. Tap <strong>Mark orientation attended</strong> once
        the employee has shown up for orientation. HR cannot promote them to the master list until
        you do.
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((r) => {
          const attended = !!r.orientation_attended_at;
          const isBusy = busyId === r.id;
          return (
            <Card
              key={r.id}
              className={cn(
                'overflow-hidden border ring-1 transition-colors',
                attended
                  ? 'border-emerald-200/80 bg-gradient-to-br from-white to-emerald-50/50 ring-emerald-500/10 dark:border-emerald-900/50 dark:from-zinc-950 dark:to-emerald-950/20'
                  : 'border-amber-200/80 bg-gradient-to-br from-white to-amber-50/40 ring-amber-500/10 dark:border-amber-900/50 dark:from-zinc-950 dark:to-amber-950/15',
              )}
            >
              <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white">{r.name}</span>
                    <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
                      {r.department}
                    </span>
                    {attended ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-800/70 dark:bg-emerald-950/30 dark:text-emerald-300">
                        <CheckCircle2 className="h-3 w-3" /> Orientation attended
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300">
                        <ClipboardCheck className="h-3 w-3" /> Awaiting orientation
                      </span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {r.personal_email}
                    {r.work_email ? ` · ${r.work_email}` : ' · work email pending'}
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    Added {fmtLongDate(r.created_at)}
                    {r.start_date ? ` · start ${fmtLongDate(r.start_date)}` : ''}
                    {r.job_description ? ` · ${r.job_description}` : ''}
                  </div>
                  {attended && (
                    <div className="text-[11px] text-emerald-700 dark:text-emerald-300">
                      Marked {fmtLongDate(r.orientation_attended_at)} by{' '}
                      <span className="font-mono">{r.orientation_attended_by ?? '—'}</span>
                      {r.orientation_note ? (
                        <>
                          {' '}— <span className="italic text-zinc-600 dark:text-zinc-400">&ldquo;{r.orientation_note}&rdquo;</span>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                  {!attended && (
                    <input
                      type="text"
                      value={noteDraft[r.id] ?? ''}
                      onChange={(e) => setNoteDraft((s) => ({ ...s, [r.id]: e.target.value }))}
                      placeholder="Optional note"
                      className="h-7 w-full rounded-md border border-zinc-200 bg-white px-2 text-xs text-zinc-800 placeholder:text-zinc-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-200 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200 sm:w-[200px]"
                      disabled={isBusy}
                    />
                  )}
                  {attended ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                      onClick={() => unmarkAttended(r.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      Clear
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 gap-1.5 bg-gradient-to-r from-blue-600 to-blue-800 text-white hover:from-blue-700 hover:to-blue-900"
                      onClick={() => markAttended(r.id)}
                      disabled={isBusy}
                    >
                      {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardCheck className="h-3 w-3" />}
                      Mark orientation attended
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {viewerEmail && (
        <p className="text-[10px] italic text-zinc-400 dark:text-zinc-500">
          Signed in as <span className="font-mono">{viewerEmail}</span> — attendance markers are
          attributed to this email.
        </p>
      )}
    </div>
  );
}
