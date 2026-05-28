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
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Users,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import React from 'react';
import DeptFilter from './DeptFilter';
import HrOnboardingForm from './HrOnboardingForm';
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

type TabFilter = 'pending' | 'ready' | 'promoted' | 'cancelled' | 'all';
type SubTab = 'pending-hires' | 'onboarding-form';

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
  const [subTab, setSubTab] = useState<SubTab>('onboarding-form');
  const [pending, setPending] = useState<HrPendingEmployeeRow[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);

  const [deptRates, setDeptRates] = useState<Map<string, { regular_rate: string | null; ot_rate: string | null }>>(new Map());

  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [tab, setTab] = useState<TabFilter>('pending');
  const [setEmailFor, setSetEmailFor] = useState<HrPendingEmployeeRow | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<HrPendingEmployeeRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HrPendingEmployeeRow | null>(null);
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

  useEffect(() => {
    void fetchPending();
    fetch('/api/hr/department-rates', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { departments?: { department: string; regular_rate: string | null; ot_rate: string | null }[] }) => {
        const m = new Map<string, { regular_rate: string | null; ot_rate: string | null }>();
        for (const d of j.departments ?? []) {
          m.set(d.department.trim().toLowerCase(), { regular_rate: d.regular_rate, ot_rate: d.ot_rate });
        }
        setDeptRates(m);
      })
      .catch(() => {/* non-critical */});
  }, [fetchPending]);

  const filteredPending = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pending.filter((r) => {
      if (tab !== 'all') {
        if (tab === 'pending' && r.status !== 'pending_work_email') return false;
        if (tab === 'ready' && r.status !== 'ready') return false;
        if (tab === 'promoted' && r.status !== 'promoted') return false;
        if (tab === 'cancelled' && r.status !== 'cancelled') return false;
      }
      if (dept && (r.department ?? '').trim() !== dept) return false;
      if (!q) return true;
      return [r.name, r.personal_email, r.work_email, r.department, r.source]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [pending, search, tab, dept]);

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
      const json = (await res.json()) as {
        error?: string;
        sheet?: { appended?: boolean; reason?: string } | null;
        hubstaff?: { ok?: boolean; error?: string } | null;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to promote');
      const sheet = json.sheet;
      const hubstaff = json.hubstaff;
      if (sheet && sheet.appended === false && sheet.reason !== 'already present in sheet') {
        toast.warning(`${row.name} added to the master list, but NOT written to the Google Sheet`, {
          description: `${sheet.reason ?? 'Sheet append failed'} — add them to the Sheet manually, or they may drop out on the next sheet sync.`,
        });
      } else if (hubstaff && hubstaff.ok === false) {
        toast.warning(`${row.name} added to the master list, but the Hubstaff invite did not fire`, {
          description: `${hubstaff.error ?? 'Invite webhook failed'} — invite them in Hubstaff manually.`,
        });
      } else {
        toast.success(`${row.name} added to the master list`, {
          description: 'Now visible across Payroll, Manager, and Orphanage views. Hubstaff invite sent.',
        });
      }
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to promote');
    } finally {
      setBusyId(null);
    }
  }

  async function sendBackToReady(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}/unpromote`, {
        method: 'POST',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to send back to Ready');
      toast.success(`${row.name} sent back to Ready`, {
        description: 'Their master-list record was kept; you can promote again after any fixes.',
      });
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to send back to Ready');
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

  async function hardDelete(row: HrPendingEmployeeRow) {
    setBusyId(row.id);
    try {
      const res = await fetch(`/api/hr/pending-employees/${row.id}?hard=true`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to delete');
      toast.success(`Deleted ${row.name}`);
      await fetchPending();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
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
              variant="outline"
              size="sm"
              className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
              onClick={() => void fetchPending()}
              disabled={pendingLoading}
            >
              <RefreshCw
                className={cn(
                  'mr-1.5 h-3.5 w-3.5',
                  pendingLoading && 'animate-spin',
                )}
              />
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* Sub-tabs */}
      <div className="-mb-2 flex flex-wrap items-center gap-1.5 border-b border-emerald-100/60 pb-2 dark:border-emerald-900/40">
        <SubTabPill
          label="Onboarding Form"
          active={subTab === 'onboarding-form'}
          onClick={() => setSubTab('onboarding-form')}
        />
        <SubTabPill
          label="Pending Hires"
          active={subTab === 'pending-hires'}
          onClick={() => setSubTab('pending-hires')}
        />
      </div>

      {subTab === 'onboarding-form' ? (
        <HrOnboardingForm />
      ) : (
      <>
      {/* Stat tiles */}
      <section className="grid gap-3 sm:grid-cols-3" aria-label="Pending hire counts">
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
            <div className="flex items-center gap-2">
              <DeptFilter rows={pending} getDept={(r) => r.department} value={dept} onChange={setDept} />
              <div className="relative w-full sm:w-60">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email…"
                  className="border-emerald-100/70 bg-white pl-9 dark:border-emerald-900/50 dark:bg-zinc-900"
                />
              </div>
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
                  ? 'No pending hires yet — use the Onboarding Form tab to stage your first one.'
                  : 'No pending hires match this filter.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-emerald-100/90 ring-1 ring-emerald-500/10 dark:border-emerald-900/60 dark:ring-emerald-400/10">
              <table className="w-full text-left text-sm sm:min-w-[860px]">
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
                          <td data-label="Name" className="px-4 py-3">
                            <div className="font-medium text-zinc-900 dark:text-zinc-100">
                              {row.name}
                            </div>
                            {row.job_description && (
                              <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
                                {row.job_description}
                              </div>
                            )}
                          </td>
                          <td data-label="Department" className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                            {row.department}
                          </td>
                          <td data-label="Personal" className="px-4 py-3 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">
                            {row.personal_email}
                          </td>
                          <td data-label="Work email" className="px-4 py-3 break-all font-mono text-xs">
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
                          <td data-label="Start" className="px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                            {formatDate(row.start_date)}
                          </td>
                          <td data-label="Rate" className="px-4 py-3 text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
                            {(() => {
                              const reg = row.regular_rate;
                              const ot = row.ot_rate;
                              const fallback = deptRates.get((row.department ?? '').trim().toLowerCase());
                              if (reg) {
                                return (
                                  <>
                                    <span>₱{reg}</span>
                                    {ot && <span className="text-zinc-400"> · OT ₱{ot}</span>}
                                  </>
                                );
                              }
                              if (fallback?.regular_rate) {
                                return (
                                  <span className="italic text-zinc-400 dark:text-zinc-500" title="Dept. typical rate — not yet confirmed for this hire">
                                    ₱{fallback.regular_rate}
                                    {fallback.ot_rate && <> · OT ₱{fallback.ot_rate}</>}
                                  </span>
                                );
                              }
                              return '—';
                            })()}
                          </td>
                          <td data-label="Status" className="px-4 py-3">
                            <div className="flex flex-col items-start gap-1">
                              {row.status !== 'pending_work_email' && (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-[10px] font-medium',
                                    row.status === 'ready' && !row.orientation_attended_at
                                      ? STATUS_BADGE['pending_work_email']
                                      : STATUS_BADGE[row.status],
                                  )}
                                >
                                  {row.status === 'ready' && !row.orientation_attended_at
                                    ? 'Awaiting orientation'
                                    : STATUS_LABEL[row.status]}
                                </Badge>
                              )}
                              {(row.status === 'ready' || row.status === 'pending_work_email') &&
                                row.orientation_attended_at && (
                                  <Badge
                                    variant="outline"
                                    className="border-emerald-300 bg-emerald-50 text-[10px] font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100"
                                    title={`Marked ${formatDate(row.orientation_attended_at)} by ${row.orientation_attended_by ?? '—'}${row.orientation_note ? ` — "${row.orientation_note}"` : ''}`}
                                  >
                                    Orientation ✓
                                  </Badge>
                                )}
                            </div>
                          </td>
                          <td data-label="Actions" className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-1.5">
                              {row.status === 'ready' && (
                                <Button
                                  size="sm"
                                  className="h-7 bg-gradient-to-r from-emerald-500 to-teal-700 px-3 text-xs text-white hover:opacity-90 disabled:opacity-60"
                                  onClick={() => void promote(row)}
                                  disabled={isBusy || !row.orientation_attended_at}
                                  title={
                                    row.orientation_attended_at
                                      ? 'Promote to master list'
                                      : 'The department manager must mark orientation attended first.'
                                  }
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
                              {row.status === 'promoted' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs text-amber-700 hover:bg-amber-50 hover:text-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
                                  onClick={() => void sendBackToReady(row)}
                                  disabled={isBusy}
                                  title="Send back to Ready (keeps the master-list record; lets you re-promote)"
                                >
                                  {isBusy ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Undo2 className="mr-1 h-3 w-3" />
                                  )}
                                  Back to Ready
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
                                  title="Cancel hire"
                                >
                                  <XCircle className="h-3 w-3" />
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
                                onClick={() => setConfirmDelete(row)}
                                disabled={isBusy}
                                title="Permanently delete this record"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
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
      </>
      )}

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

      {/* Hard delete confirm dialog */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete this record?</DialogTitle>
            <DialogDescription className="text-xs">
              <strong>{confirmDelete?.name}</strong> ({confirmDelete?.personal_email}) will be
              removed entirely — this cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(null)}
              disabled={busyId === confirmDelete?.id}
            >
              Keep
            </Button>
            <Button
              size="sm"
              className="bg-rose-600 hover:bg-rose-700"
              onClick={() => confirmDelete && void hardDelete(confirmDelete)}
              disabled={busyId === confirmDelete?.id}
            >
              {busyId === confirmDelete?.id ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const DEPT_COLORS = [
  '#10b981','#0d9488','#0891b2','#7c3aed','#db2777',
  '#ea580c','#ca8a04','#4f46e5','#16a34a','#be185d',
  '#0369a1','#6d28d9','#b45309','#047857','#9d174d',
];

function PendingDeptDonut({ data }: { data: HrPendingEmployeeRow[] }) {
  const [hovered, setHovered] = useState<string | null>(null);

  const sliceData = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data) {
      const d = (r.department ?? '—').trim() || '—';
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const total = sliceData.reduce((s, d) => s + d.count, 0);
  const SIZE = 130; const cx = SIZE / 2; const cy = SIZE / 2;
  const outerR = 56; const innerR = 33;

  function polar(deg: number, r: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function slicePath(s: number, e: number) {
    if (e - s >= 359.99) {
      const t = polar(0, outerR); const b = polar(180, outerR);
      const it = polar(0, innerR); const ib = polar(180, innerR);
      return `M ${t.x} ${t.y} A ${outerR} ${outerR} 0 1 1 ${b.x} ${b.y} A ${outerR} ${outerR} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${innerR} ${innerR} 0 1 0 ${ib.x} ${ib.y} A ${innerR} ${innerR} 0 1 0 ${it.x} ${it.y} Z`;
    }
    const large = e - s > 180 ? 1 : 0;
    const s1 = polar(s, outerR); const e1 = polar(e, outerR);
    const s2 = polar(e, innerR); const e2 = polar(s, innerR);
    return `M ${s1.x} ${s1.y} A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
  }

  let cum = 0;
  const slices = sliceData.map((d, i) => {
    const start = cum;
    cum += total > 0 ? (d.count / total) * 360 : 0;
    return { ...d, start, end: cum, color: DEPT_COLORS[i % DEPT_COLORS.length]! };
  });

  const hovSlice = slices.find((s) => s.dept === hovered);

  if (total === 0) return (
    <div className="flex h-[130px] w-[130px] items-center justify-center rounded-full border-2 border-dashed border-zinc-200 dark:border-zinc-700">
      <span className="text-[10px] text-zinc-400">No data</span>
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
        {slices.map((s, i) => (
          <motion.path
            key={s.dept}
            d={slicePath(s.start, s.end)}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity: hovered && hovered !== s.dept ? 0.28 : 1 }}
            transition={{ duration: 0.2, delay: hovered ? 0 : i * 0.04 }}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
            style={{ cursor: 'default' }}
          />
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="15" fontWeight="700" fill="#18181b">{hovSlice ? hovSlice.count : total}</text>
        <text x={cx} y={cy + 9} textAnchor="middle" fontSize="7.5" fill="#a1a1aa">{hovSlice ? hovSlice.dept.slice(0, 11) : 'pending'}</text>
      </svg>
      <div className="w-[160px] space-y-0.5">
        {slices.map((s) => (
          <div
            key={s.dept}
            className={cn('flex items-center gap-1.5 rounded px-1 py-0.5 text-[10px] transition-colors', hovered === s.dept ? 'bg-zinc-100 dark:bg-zinc-800' : '')}
            onMouseEnter={() => setHovered(s.dept)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: s.color }} />
            <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">{s.dept}</span>
            <span className="shrink-0 tabular-nums font-medium text-zinc-700 dark:text-zinc-300">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const PIPELINE_SLICES = [
  { key: 'pending'   as TabFilter, label: 'Awaiting email', color: '#f59e0b' },
  { key: 'ready'     as TabFilter, label: 'Ready',          color: '#10b981' },
  { key: 'promoted'  as TabFilter, label: 'Promoted',       color: '#0ea5e9' },
  { key: 'cancelled' as TabFilter, label: 'Cancelled',      color: '#a1a1aa' },
];

function PipelinePieChart({
  counts,
  onSliceClick,
  activeTab,
}: {
  counts: { pending: number; ready: number; promoted: number; cancelled: number };
  onSliceClick: (tab: TabFilter) => void;
  activeTab: TabFilter;
}) {
  const [hovered, setHovered] = useState<TabFilter | null>(null);
  const SIZE = 150; const cx = SIZE / 2; const cy = SIZE / 2;
  const outerR = 64; const innerR = 38;

  const total = counts.pending + counts.ready + counts.promoted + counts.cancelled;

  function polar(deg: number, r: number) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function slicePath(s: number, e: number) {
    if (e - s >= 359.99) {
      const t = polar(0, outerR); const b = polar(180, outerR);
      const it = polar(0, innerR); const ib = polar(180, innerR);
      return `M ${t.x} ${t.y} A ${outerR} ${outerR} 0 1 1 ${b.x} ${b.y} A ${outerR} ${outerR} 0 1 1 ${t.x} ${t.y} M ${it.x} ${it.y} A ${innerR} ${innerR} 0 1 0 ${ib.x} ${ib.y} A ${innerR} ${innerR} 0 1 0 ${it.x} ${it.y} Z`;
    }
    const large = e - s > 180 ? 1 : 0;
    const s1 = polar(s, outerR); const e1 = polar(e, outerR);
    const s2 = polar(e, innerR); const e2 = polar(s, innerR);
    return `M ${s1.x} ${s1.y} A ${outerR} ${outerR} 0 ${large} 1 ${e1.x} ${e1.y} L ${s2.x} ${s2.y} A ${innerR} ${innerR} 0 ${large} 0 ${e2.x} ${e2.y} Z`;
  }

  let cum = 0;
  const slices = PIPELINE_SLICES.map((s) => {
    const count = counts[s.key as keyof typeof counts] ?? 0;
    const start = cum;
    cum += total > 0 ? (count / total) * 360 : 0;
    return { ...s, count, start, end: cum };
  }).filter((s) => s.count > 0);

  const active = hovered ?? (activeTab !== 'all' ? activeTab : null);
  const activeSlice = slices.find((s) => s.key === active);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-4">
        <div className="flex h-[150px] w-[150px] items-center justify-center rounded-full border-4 border-dashed border-zinc-200 dark:border-zinc-700">
          <span className="text-[11px] text-zinc-400">No data</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={{ overflow: 'visible' }}>
        {slices.map((s, i) => (
          <motion.path
            key={s.key}
            d={slicePath(s.start, s.end)}
            fill={s.color}
            initial={{ opacity: 0 }}
            animate={{ opacity: active && active !== s.key ? 0.28 : 1 }}
            transition={{ duration: 0.2, delay: hovered ? 0 : i * 0.04 }}
            onMouseEnter={() => setHovered(s.key)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSliceClick(s.key)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fontSize="17" fontWeight="700" fill="#18181b">
          {activeSlice ? activeSlice.count : total}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fontSize="8.5" fill="#a1a1aa">
          {activeSlice ? activeSlice.label.slice(0, 12) : 'total'}
        </text>
      </svg>
      <div className="w-full space-y-0.5 px-2">
        {PIPELINE_SLICES.map((s) => {
          const count = counts[s.key as keyof typeof counts] ?? 0;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onSliceClick(s.key)}
              onMouseEnter={() => setHovered(s.key)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors',
                active === s.key ? 'bg-zinc-100 dark:bg-zinc-800' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
              )}
            >
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate text-left text-zinc-600 dark:text-zinc-400">{s.label}</span>
              <span className="shrink-0 tabular-nums font-medium text-zinc-800 dark:text-zinc-200">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubTabPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-emerald-500 to-teal-700 text-white shadow-sm shadow-emerald-600/25'
          : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
      )}
    >
      {label}
    </button>
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
