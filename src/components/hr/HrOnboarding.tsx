'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  ClipboardList,
  Loader2,
  Mail,
  MailQuestion,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import AddPersonDialog from './AddPersonDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type {
  HrPendingEmployeeRow,
  HrPendingStatus,
} from '@/lib/supabase/hr-pending-employees';
import type { EmployeeRow } from '@/lib/supabase/employees';

type TabFilter = 'pending' | 'ready' | 'promoted' | 'cancelled' | 'all';

const STATUS_LABEL: Record<HrPendingStatus, string> = {
  pending_work_email: 'Awaiting work email',
  ready: 'Ready to promote',
  promoted: 'Promoted',
  cancelled: 'Cancelled',
};

const STATUS_BADGE: Record<HrPendingStatus, string> = {
  pending_work_email:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/35 dark:text-amber-100',
  ready:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
  promoted:
    'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100',
  cancelled:
    'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function HrOnboarding() {
  const [pending, setPending] = useState<HrPendingEmployeeRow[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [roster, setRoster] = useState<EmployeeRow[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<TabFilter>('pending');
  const [addOpen, setAddOpen] = useState(false);
  const [setEmailFor, setSetEmailFor] = useState<HrPendingEmployeeRow | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<HrPendingEmployeeRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const fetchPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await fetch('/api/hr/pending-employees', { cache: 'no-store' });
      const json = (await res.json()) as {
        rows?: HrPendingEmployeeRow[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load');
      setPending(json.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load pending hires');
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  }, []);

  const fetchRoster = useCallback(async () => {
    setRosterLoading(true);
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
      setRosterLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPending();
    void fetchRoster();
  }, [fetchPending, fetchRoster]);

  const filteredPending = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pending.filter((r) => {
      if (tab !== 'all') {
        if (tab === 'pending' && r.status !== 'pending_work_email') return false;
        if (tab === 'ready' && r.status !== 'ready') return false;
        if (tab === 'promoted' && r.status !== 'promoted') return false;
        if (tab === 'cancelled' && r.status !== 'cancelled') return false;
      }
      if (!q) return true;
      return [r.name, r.personal_email, r.work_email, r.department, r.source]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [pending, search, tab]);

  const filteredRoster = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((r) =>
      [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    );
  }, [roster, search]);

  const counts = useMemo(() => {
    const c = {
      pending: 0,
      ready: 0,
      promoted: 0,
      cancelled: 0,
    };
    for (const r of pending) {
      if (r.status === 'pending_work_email') c.pending += 1;
      else if (r.status === 'ready') c.ready += 1;
      else if (r.status === 'promoted') c.promoted += 1;
      else if (r.status === 'cancelled') c.cancelled += 1;
    }
    return c;
  }, [pending]);

  async function promote(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}/promote`, {
        method: 'POST',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to promote');
      toast.success(`${row.name} added to the master list`, {
        description: 'Now visible across Payroll, Manager, and Orphanage views.',
      });
      await Promise.all([fetchPending(), fetchRoster()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to promote');
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to cancel');
      toast.success(`Cancelled ${row.name}`);
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel');
    } finally {
      setBusyId(null);
      setConfirmCancel(null);
    }
  }

  async function saveWorkEmail(row: HrPendingEmployeeRow, workEmail: string) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email: workEmail.trim() || null }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to save');
      toast.success(`Work email saved for ${row.name}`);
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusyId(null);
      setSetEmailFor(null);
    }
  }

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
      {/* Hero header */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-teal-300/20 blur-2xl" aria-hidden />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/95">
              <Users className="h-3 w-3 shrink-0" />
              Onboarding
            </div>
            <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Stage new hires before they hit the master list.
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              Add interview-stage hires here. Once Payroll provides the @simple.biz
              work email and orientation is confirmed, promote the row — it lands
              in the Global Master List and flows into every other dashboard.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="lg"
              className="h-11 border-0 bg-white px-5 font-semibold text-emerald-700 shadow-md shadow-black/10 hover:bg-white/90 dark:bg-zinc-100 dark:text-emerald-800 dark:hover:bg-white"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add person
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
              onClick={() => {
                void fetchPending();
                void fetchRoster();
              }}
              disabled={pendingLoading || rosterLoading}
            >
              <RefreshCw
                className={cn(
                  'mr-1.5 h-3.5 w-3.5',
                  (pendingLoading || rosterLoading) && 'animate-spin',
                )}
              />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Stat tiles */}
      <section className="grid gap-3 sm:grid-cols-4" aria-label="Pending hire counts">
        <StatTile
          label="Awaiting work email"
          value={counts.pending}
          icon={MailQuestion}
          accent="amber"
          onClick={() => setTab('pending')}
          active={tab === 'pending'}
        />
        <StatTile
          label="Ready to promote"
          value={counts.ready}
          icon={CheckCircle2}
          accent="emerald"
          onClick={() => setTab('ready')}
          active={tab === 'ready'}
        />
        <StatTile
          label="Promoted"
          value={counts.promoted}
          icon={ClipboardList}
          accent="sky"
          onClick={() => setTab('promoted')}
          active={tab === 'promoted'}
        />
        <StatTile
          label="Active roster"
          value={roster.length}
          icon={Users}
          accent="teal"
          onClick={() => setTab('all')}
          active={tab === 'all'}
        />
      </section>

      {/* Pending hires card */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/30 to-white shadow-md ring-1 ring-emerald-500/8 dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/12 dark:to-zinc-950 dark:ring-emerald-400/10">
        <CardHeader className="flex flex-col gap-1 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25">
                  <ClipboardList className="h-4 w-4" />
                </div>
                <CardTitle className="text-base font-semibold">
                  Pending hires queue
                </CardTitle>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                New hires staged from this dashboard. Promote a row to copy it into the master list.
              </p>
            </div>
            <div className="relative w-full sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, dept…"
                className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
              />
            </div>
          </div>

          {/* Tab pills */}
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <TabPill label="Awaiting email" count={counts.pending} active={tab === 'pending'} onClick={() => setTab('pending')} />
            <TabPill label="Ready" count={counts.ready} active={tab === 'ready'} onClick={() => setTab('ready')} />
            <TabPill label="Promoted" count={counts.promoted} active={tab === 'promoted'} onClick={() => setTab('promoted')} />
            <TabPill label="Cancelled" count={counts.cancelled} active={tab === 'cancelled'} onClick={() => setTab('cancelled')} />
            <TabPill label="All" count={pending.length} active={tab === 'all'} onClick={() => setTab('all')} />
          </div>
        </CardHeader>

        <CardContent className="pt-4">
          {pendingLoading ? (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading pending hires…
            </div>
          ) : filteredPending.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-10 text-center dark:border-emerald-900/50 dark:bg-zinc-950/40">
              <Users className="h-8 w-8 text-emerald-400/60" />
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {pending.length === 0
                  ? 'No pending hires yet — click “Add person” to stage your first one.'
                  : 'No pending hires match this filter.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Personal</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Start</th>
                    <th className="px-4 py-3 font-semibold">Rate</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                  <AnimatePresence initial={false}>
                    {filteredPending.map((row) => {
                      const isBusy = busyId === row.id;
                      return (
                        <motion.tr
                          key={row.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.18 }}
                          className="align-top transition-colors hover:bg-emerald-50/35 dark:hover:bg-emerald-950/25"
                        >
                          <td className="px-4 py-3">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {row.name}
                            </div>
                            {row.job_description && (
                              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                                {row.job_description}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {row.department}
                          </td>
                          <td className="px-4 py-3 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                            {row.personal_email}
                          </td>
                          <td className="px-4 py-3 break-all font-mono text-xs">
                            {row.work_email ? (
                              <span className="text-zinc-800 dark:text-zinc-200">
                                {row.work_email}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setSetEmailFor(row)}
                                className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
                              >
                                <Mail className="h-3 w-3" /> Set work email
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                            {formatDate(row.start_date)}
                          </td>
                          <td className="px-4 py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                            {row.regular_rate ? (
                              <>
                                <span>₱{row.regular_rate}</span>
                                {row.ot_rate && (
                                  <span className="text-zinc-400"> · OT ₱{row.ot_rate}</span>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px] font-medium',
                                STATUS_BADGE[row.status],
                              )}
                            >
                              {STATUS_LABEL[row.status]}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              {row.status === 'ready' && (
                                <Button
                                  size="sm"
                                  className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90 disabled:opacity-60"
                                  onClick={() => void promote(row)}
                                  disabled={isBusy}
                                >
                                  {isBusy ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="mr-1 h-3 w-3" />
                                  )}
                                  Promote
                                </Button>
                              )}
                              {row.status === 'pending_work_email' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setSetEmailFor(row)}
                                  disabled={isBusy}
                                >
                                  <Pencil className="mr-1 h-3 w-3" /> Edit
                                </Button>
                              )}
                              {(row.status === 'ready' ||
                                row.status === 'pending_work_email') && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                  onClick={() => setConfirmCancel(row)}
                                  disabled={isBusy}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </motion.tr>
                      );
                    })}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Active roster card */}
      <Card className="border-emerald-100/80 bg-gradient-to-br from-white via-emerald-50/20 to-white shadow-sm dark:border-emerald-950/55 dark:from-zinc-950 dark:via-emerald-950/8 dark:to-zinc-950">
        <CardHeader className="flex flex-col gap-1 border-b border-emerald-100/60 pb-4 dark:border-emerald-900/40">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-emerald-700 text-white shadow-sm shadow-emerald-600/25">
              <Users className="h-4 w-4" />
            </div>
            <CardTitle className="text-base font-semibold">
              Active roster
            </CardTitle>
            <Badge variant="outline" className="ml-auto text-[10px]">
              {filteredRoster.length} of {roster.length}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Live view of <code className="rounded bg-zinc-100 px-1 py-px text-[10.5px] dark:bg-zinc-800">active_employees</code> — same data Payroll, Manager, and Orphanage read.
          </p>
        </CardHeader>
        <CardContent className="pt-4">
          {rosterLoading ? (
            <div className="flex items-center justify-center py-10 text-zinc-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading roster…
            </div>
          ) : filteredRoster.length === 0 ? (
            <div className="rounded-xl border border-dashed border-emerald-200/80 bg-white/70 py-8 text-center text-sm text-zinc-500 dark:border-emerald-900/50 dark:bg-zinc-950/40">
              {roster.length === 0
                ? 'No active employees on file. Run a master list import or promote pending hires above.'
                : 'No roster rows match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full min-w-[680px] text-left text-sm">
                <thead className="sticky top-0 z-[1] bg-gradient-to-r from-emerald-50 via-white to-emerald-50/80 text-xs text-zinc-600 dark:from-emerald-950/50 dark:via-zinc-950 dark:to-emerald-950/40 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Employee ID</th>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Department</th>
                    <th className="px-4 py-3 font-semibold">Work email</th>
                    <th className="px-4 py-3 font-semibold">Start</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100/70 bg-white/85 dark:divide-emerald-900/35 dark:bg-zinc-950/40">
                  {filteredRoster.slice(0, 200).map((r, i) => (
                    <tr
                      key={`${r.work_email ?? r.personal_email ?? 'row'}-${i}`}
                      className="align-top hover:bg-emerald-50/30 dark:hover:bg-emerald-950/20"
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
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredRoster.length > 200 && (
                <div className="border-t border-emerald-100/60 px-4 py-2 text-center text-[11px] text-zinc-500 dark:border-emerald-900/40 dark:text-zinc-500">
                  Showing first 200 of {filteredRoster.length} — refine the search to narrow.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Person dialog */}
      <AddPersonDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => void fetchPending()}
      />

      {/* Set work email dialog */}
      <SetWorkEmailDialog
        row={setEmailFor}
        onClose={() => setSetEmailFor(null)}
        onSubmit={(email) => setEmailFor && void saveWorkEmail(setEmailFor, email)}
        busy={busyId === setEmailFor?.id}
      />

      {/* Cancel confirm dialog */}
      <Dialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Cancel pending hire?</DialogTitle>
            <DialogDescription className="text-xs">
              {confirmCancel?.name} ({confirmCancel?.personal_email}) will be marked
              cancelled. The row stays in the audit log but won't appear in the
              ready/awaiting buckets anymore.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCancel(null)}
              disabled={busyId === confirmCancel?.id}
            >
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmCancel && void cancel(confirmCancel)}
              disabled={busyId === confirmCancel?.id}
            >
              {busyId === confirmCancel?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <XCircle className="mr-1 h-3 w-3" />
              )}
              Cancel hire
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TabPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1.5 text-[10px] tabular-nums',
          active
            ? 'bg-white/20 text-white'
            : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
  accent,
  active,
  onClick,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  accent: 'amber' | 'emerald' | 'sky' | 'teal';
  active?: boolean;
  onClick?: () => void;
}) {
  const accentMap = {
    amber: 'from-amber-400 to-amber-600 shadow-amber-500/30',
    emerald: 'from-emerald-500 to-teal-700 shadow-emerald-500/30',
    sky: 'from-sky-500 to-sky-700 shadow-sky-500/30',
    teal: 'from-teal-500 to-emerald-700 shadow-emerald-500/30',
  } as const;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 overflow-hidden rounded-xl border bg-white/90 px-4 py-3.5 text-left ring-1 backdrop-blur-sm transition-all hover:shadow-md dark:bg-zinc-950/75',
        active
          ? 'border-emerald-300 ring-emerald-500/20 dark:border-emerald-700 dark:ring-emerald-400/20'
          : 'border-emerald-100/80 ring-emerald-500/5 hover:border-emerald-200 dark:border-emerald-950/50 dark:ring-emerald-400/10',
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md',
          accentMap[accent],
        )}
      >
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-500">
          {label}
        </div>
        <div className="mt-0.5 text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
          {value}
        </div>
      </div>
    </button>
  );
}

function SetWorkEmailDialog({
  row,
  onClose,
  onSubmit,
  busy,
}: {
  row: HrPendingEmployeeRow | null;
  onClose: () => void;
  onSubmit: (email: string) => void;
  busy: boolean;
}) {
  const [val, setVal] = useState('');
  useEffect(() => {
    setVal(row?.work_email ?? '');
  }, [row]);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Set work email</DialogTitle>
          <DialogDescription className="text-xs">
            Once Payroll mints {row?.name}'s @simple.biz address, paste it here.
            The row will flip to “Ready to promote”.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Work email</Label>
          <Input
            type="email"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder="namel@simple.biz"
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-gradient-to-r from-emerald-500 to-teal-700 text-white hover:opacity-90"
            onClick={() => onSubmit(val)}
            disabled={busy}
          >
            {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Mail className="mr-1 h-3 w-3" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
