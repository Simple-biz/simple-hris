'use client';

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { useSearchParams } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { motion } from 'motion/react';
import {
  CheckCircle2,
  ClipboardList,
  HeartHandshake,
  Inbox,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { toast, Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ViewSwitcher from '@/components/rbac/ViewSwitcher';
import CreateOrphanageStyleDisputeDialog, {
  type EmployeeOption,
} from '@/components/orphanage/CreateOrphanageStyleDisputeDialog';
import {
  fetchHoursByEmployee,
  type HubstaffHoursByEmployee,
} from '@/lib/hubstaff/fetch-hours-by-employee';
import {
  fetchOrphanageOverlap,
  type DisputesByEmployee,
} from '@/lib/pab-disputes/fetch-orphanage-overlap';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { normEmail } from '@/lib/email/norm-email';
import type { PabDayDisputeRow, PabDisputeStatus } from '@/lib/supabase/pab-day-disputes';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function formatVerifiedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Labels + badge styling for orphanage receipt-log rows (`verified` bucket from `/api/orphanage-disputes`). */
function orphanReceiptStatusMeta(status: PabDisputeStatus): {
  label: string;
  badgeClass: string;
} {
  switch (status) {
    case 'orphanage_manager_approved':
      return {
        label: 'With Accounting',
        badgeClass:
          'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/45 dark:text-sky-100',
      };
    case 'accounting_approved':
    case 'approved':
      return {
        label: status === 'approved' ? 'Accounting approved (legacy)' : 'Accounting approved',
        badgeClass:
          'border-emerald-400/90 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-100',
      };
    case 'accounting_denied':
      return {
        label: 'Accounting denied',
        badgeClass:
          'border-rose-400/90 bg-rose-50 text-rose-950 dark:border-rose-800 dark:bg-rose-950/35 dark:text-rose-100',
      };
    case 'orphanage_manager_denied':
      return {
        label: 'Denied — manager',
        badgeClass:
          'border-orange-400/85 bg-orange-50 text-orange-950 dark:border-orange-800 dark:bg-orange-950/35 dark:text-orange-100',
      };
    case 'denied':
      return {
        label: 'Denied (legacy)',
        badgeClass:
          'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200',
      };
    default:
      return {
        label: status,
        badgeClass: 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
      };
  }
}

export default function OrphanageApp() {
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get('email');
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);
  const [rows, setRows] = useState<PabDayDisputeRow[]>([]);
  const [verifiedRows, setVerifiedRows] = useState<PabDayDisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [verifiedSearch, setVerifiedSearch] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ row: PabDayDisputeRow; action: 'approve' | 'deny' } | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [employeeOptions, setEmployeeOptions] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [hoursByEmployee, setHoursByEmployee] = useState<HubstaffHoursByEmployee>(new Map());
  const [hoursLoading, setHoursLoading] = useState(true);
  const [disputesByEmployee, setDisputesByEmployee] = useState<DisputesByEmployee>(new Map());
  const [disputesByEmployeeLoading, setDisputesByEmployeeLoading] = useState(true);

  // Pre-fetch the roster on mount. Backed by /api/employee-rate-profiles/summary which
  // does a heavy server-side merge; warming it here means the dialog opens instantly.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/employee-rate-profiles/summary', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: { profiles?: EmployeeOption[] }) => {
        if (cancelled) return;
        const active = (json.profiles ?? []).filter((p) => !p.suspended);
        setEmployeeOptions(active);
      })
      .catch(() => {
        if (!cancelled) setEmployeeOptions([]);
      })
      .finally(() => {
        if (!cancelled) setEmployeesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Pre-fetch + parse Hubstaff hours so the calendar's red days are ready as soon as
  // the user picks a person inside the dialog. Walks every source file in parallel and
  // builds a per-employee daily-seconds map.
  useEffect(() => {
    const ac = new AbortController();
    fetchHoursByEmployee({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setHoursByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setHoursLoading(false);
      });
    return () => ac.abort();
  }, []);

  // Pre-fetch the existing-orphanage-disputes map so the dialog's calendar shows
  // already-forgiven (green) / pending (amber) / denied (red-disabled) cells instead
  // of letting the user re-pick days that already have a row on file.
  useEffect(() => {
    const ac = new AbortController();
    fetchOrphanageOverlap({ signal: ac.signal })
      .then((map) => {
        if (!ac.signal.aborted) setDisputesByEmployee(map);
      })
      .finally(() => {
        if (!ac.signal.aborted) setDisputesByEmployeeLoading(false);
      });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    try {
      const q = emailFromQuery?.trim() ?? '';
      if (q && isPlausibleEmail(q)) {
        const normalized = normEmail(q) ?? q.toLowerCase();
        sessionStorage.setItem(SESSION_EMAIL_KEY, normalized);
        setViewerEmail(normalized);
        return;
      }
      setViewerEmail(sessionStorage.getItem(SESSION_EMAIL_KEY));
    } catch {
      setViewerEmail(null);
    }
  }, [emailFromQuery]);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/orphanage-disputes', { cache: 'no-store' });
      const json = (await res.json()) as {
        pending?: PabDayDisputeRow[];
        verified?: PabDayDisputeRow[];
        error?: string;
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load queue');
      setRows(json.pending ?? []);
      setVerifiedRows(json.verified ?? []);
    } catch (e) {
      setRows([]);
      setVerifiedRows([]);
      toast.error(e instanceof Error ? e.message : 'Could not load orphanage queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.work_email, row.dispute_date, row.explanation ?? '', row.created_by ?? '', row.decision_note ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const filteredVerified = useMemo(() => {
    const q = verifiedSearch.trim().toLowerCase();
    if (!q) return verifiedRows;
    return verifiedRows.filter((row) =>
      [
        row.work_email,
        row.dispute_date,
        row.explanation ?? '',
        row.decided_by ?? '',
        row.decision_note ?? '',
        row.status,
        orphanReceiptStatusMeta(row.status).label,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }, [verifiedRows, verifiedSearch]);

  const awaitingAccountingCount = useMemo(
    () => verifiedRows.filter((r) => r.status === 'orphanage_manager_approved').length,
    [verifiedRows],
  );

  const runDecide = useCallback(async () => {
    if (!confirm || !viewerEmail) return;
    const row = confirm.row;
    const action = confirm.action;
    const noteTrimmed = decisionNote.trim() || null;
    setActingId(row.id);
    setConfirm(null);
    setDecisionNote('');
    try {
      const res = await fetch(`/api/pab-disputes/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action === 'approve' ? 'orphanage_manager_approve' : 'orphanage_manager_deny',
          decided_by: viewerEmail,
          decision_note: noteTrimmed,
        }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed');
      if (action === 'approve') {
        toast.success('Verified — sent to Accounting for final payroll approval.', {
          description: `Logged under ${viewerEmail} · ${formatVerifiedAt(new Date().toISOString())}`,
        });
      } else {
        toast.success('Dispute denied.');
      }
      await fetchRows();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update dispute');
    } finally {
      setActingId(null);
    }
  }, [confirm, viewerEmail, decisionNote, fetchRows]);

  const reviewerFirst =
    viewerEmail?.includes('@') === true
      ? (viewerEmail.split('@')[0]!.replace(/[._-]/g, ' ').split(' ')[0] ?? '')
      : '';
  const greeting =
    reviewerFirst.length > 0
      ? reviewerFirst.charAt(0).toUpperCase() + reviewerFirst.slice(1).toLowerCase()
      : 'there';

  return (
    <div className="flex h-dvh max-h-dvh overflow-hidden bg-white text-zinc-900 dark:bg-[#0d1117] dark:text-zinc-100">
      <aside className="flex w-64 shrink-0 flex-col border-r border-pink-100 bg-gradient-to-b from-white to-pink-50/50 p-5 dark:border-pink-950/50 dark:from-[#0d1117] dark:to-pink-950/10">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-pink-500 text-white">
            <HeartHandshake className="h-5 w-5" />
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-pink-600 dark:text-pink-400">
              Orphanage
            </p>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Manager review</p>
          </div>
        </div>

        <nav className="space-y-1">
          <button className="flex w-full items-center gap-3 rounded-md bg-pink-100 px-3 py-2 text-sm font-medium text-pink-900 dark:bg-pink-950/40 dark:text-pink-100">
            <HeartHandshake className="h-4 w-4" />
            Dispute queue
          </button>
        </nav>

        <div className="mt-auto border-t border-pink-100 pt-4 dark:border-pink-950/50">
          <ViewSwitcher email={viewerEmail} currentView="orphanage" />
          <div className="mb-3 rounded-md border border-pink-100 bg-white/70 px-3 py-2 dark:border-pink-950/50 dark:bg-pink-950/10">
            <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{viewerEmail ?? 'Not signed in'}</p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Orphanage Manager</p>
          </div>
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-zinc-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-zinc-400"
            onClick={() => {
              try { sessionStorage.removeItem(SESSION_EMAIL_KEY); } catch { /* ignore */ }
              void signOut({ callbackUrl: '/login' });
            }}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-white via-pink-50/40 to-rose-50/25 text-zinc-900 dark:from-black dark:via-pink-950/25 dark:to-black dark:text-zinc-100">
        <CreateOrphanageStyleDisputeDialog
          open={createDialogOpen}
          onOpenChange={setCreateDialogOpen}
          onSubmitSuccess={() => void fetchRows()}
          employees={employeeOptions}
          employeesLoading={employeesLoading}
          hoursByEmployee={hoursByEmployee}
          hoursLoading={hoursLoading}
          disputesByEmployee={disputesByEmployee}
          disputesLoading={disputesByEmployeeLoading}
        />

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:gap-8 lg:px-8 lg:pt-8">
            <header className="relative overflow-hidden rounded-2xl border border-pink-100/90 bg-gradient-to-br from-pink-600 via-rose-600 to-zinc-900 px-5 py-7 text-white shadow-lg shadow-pink-600/20 dark:border-pink-900/50 dark:from-pink-700 dark:via-rose-900 dark:to-black sm:px-7">
              <div
                className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/15 blur-3xl"
                aria-hidden
              />
              <div
                className="absolute -bottom-12 left-8 h-32 w-32 rounded-full bg-rose-300/25 blur-2xl"
                aria-hidden
              />
              <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-pink-100/95">
                    <Sparkles className="h-3 w-3 shrink-0" />
                    Orphanage manager
                  </div>
                  <h1 className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
                    Hi {greeting}, your dispute queue at a glance.
                  </h1>
                  <p className="max-w-2xl text-sm leading-relaxed text-pink-100/85">
                    Verify visits with one click — Hub hours stay as logged; optional notes land in the receipt log.
                    Accounting still gives final payroll forgiveness.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    size="lg"
                    className="h-12 border-0 bg-white/95 px-7 text-base font-semibold text-pink-700 shadow-md shadow-black/10 hover:bg-white dark:bg-zinc-100 dark:text-rose-800 dark:hover:bg-white [&_svg]:size-[1.15rem]"
                    onClick={() => setCreateDialogOpen(true)}
                  >
                    <Plus className="mr-2 shrink-0" />
                    Create disputes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-white/35 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20 hover:text-white"
                    onClick={() => void fetchRows()}
                    disabled={loading}
                  >
                    <RefreshCw
                      className={loading ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'}
                    />
                    Refresh
                  </Button>
                </div>
              </div>
            </header>

            <section className="grid gap-3 sm:grid-cols-3">
              <OrphanStatTile
                label="Awaiting review"
                value={rows.length}
                hint={
                  rows.length === 0
                    ? 'Queue is clear'
                    : filtered.length !== rows.length
                      ? `${filtered.length} match your search`
                      : 'Needs your verify or deny'
                }
                icon={HeartHandshake}
                accent="pink"
              />
              <OrphanStatTile
                label="Receipt log"
                value={verifiedRows.length}
                hint={
                  verifiedRows.length === 0
                    ? 'Nothing in the log yet'
                    : filteredVerified.length !== verifiedRows.length
                      ? `${filteredVerified.length} match search · ${awaitingAccountingCount} with Accounting`
                      : `${awaitingAccountingCount} awaiting Accounting · ${verifiedRows.length - awaitingAccountingCount} finalized`
                }
                icon={ClipboardList}
                accent="rose-deep"
              />
              <OrphanStatTile
                label="Hour source"
                value="Hubstaff"
                hint="Forgiveness only — no edits to tracked time."
                icon={CheckCircle2}
                accent="mono"
              />
            </section>

            <Card className="border-pink-100/80 bg-gradient-to-br from-white to-pink-50/55 shadow-md shadow-pink-500/5 ring-1 ring-pink-500/10 dark:border-pink-950/55 dark:from-zinc-950 dark:to-pink-950/25 dark:ring-pink-400/10">
              <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                  <CardTitle className="text-base font-semibold">Awaiting your review</CardTitle>
                  {!loading && rows.length > 0 ? (
                    <span className="text-xs font-medium text-pink-600/90 dark:text-pink-400/90">
                      {filtered.length === rows.length
                        ? `Showing all ${rows.length}`
                        : `Showing ${filtered.length} of ${rows.length}`}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Approve to route to Accounting or deny with optional context.
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 pt-4">
                <div className="relative max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search email, date, or note..."
                    className="border-pink-100/70 bg-white/90 pl-9 dark:border-pink-900/50 dark:bg-zinc-900/70"
                  />
                </div>

                {loading ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-pink-200/80 bg-pink-50/40 py-16 text-center dark:border-pink-900/50 dark:bg-pink-950/20">
                    <Loader2 className="h-8 w-8 animate-spin text-pink-500" aria-hidden />
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">Loading queue…</p>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-pink-200/80 bg-gradient-to-b from-white to-pink-50/30 py-14 text-center dark:border-pink-900/55 dark:from-zinc-950 dark:to-pink-950/15">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-pink-500 to-rose-600 text-white shadow-md shadow-pink-500/30">
                      <Inbox className="h-6 w-6" />
                    </div>
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                      {rows.length === 0
                        ? 'No orphanage disputes awaiting manager review.'
                        : 'No rows match your search.'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-pink-100/90 ring-1 ring-pink-500/10 dark:border-pink-900/60 dark:ring-pink-400/10">
                    <table className="w-full min-w-[720px] text-left text-sm">
                      <thead className="sticky top-0 z-[1] bg-gradient-to-r from-pink-50 via-white to-pink-50/80 text-xs text-zinc-600 dark:from-pink-950/50 dark:via-zinc-950 dark:to-pink-950/40 dark:text-zinc-400">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Employee</th>
                          <th className="px-4 py-3 font-semibold">Date</th>
                          <th className="px-4 py-3 font-semibold">Explanation</th>
                          <th className="px-4 py-3 font-semibold">Status</th>
                          <th className="px-4 py-3 text-right font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pink-100/70 bg-white/80 dark:divide-pink-900/35 dark:bg-zinc-950/40">
                        {filtered.map((row) => (
                          <tr
                            key={row.id}
                            className="align-top transition-colors hover:bg-pink-50/35 dark:hover:bg-pink-950/25"
                          >
                            <td className="whitespace-normal break-all px-4 py-3 font-mono text-xs">
                              {row.work_email}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-zinc-800 dark:text-zinc-200">
                              {row.dispute_date}
                            </td>
                            <td className="max-w-md px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                              <p>{row.explanation || 'No explanation provided'}</p>
                              {row.decision_note ? (
                                <p className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/90 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-200">
                                  <span className="font-semibold text-amber-800 dark:text-amber-300">
                                    Accounting:{' '}
                                  </span>
                                  {row.decision_note}
                                </p>
                              ) : null}
                            </td>
                            <td className="px-4 py-3">
                              <Badge
                                variant="outline"
                                className="border-amber-300 bg-amber-50 text-[10px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                              >
                                Manager review
                              </Badge>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button
                                  size="sm"
                                  className="h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-700"
                                  disabled={actingId === row.id}
                                  onClick={() => {
                                    setDecisionNote('');
                                    setConfirm({ row, action: 'approve' });
                                  }}
                                >
                                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 border-rose-300 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
                                  disabled={actingId === row.id}
                                  onClick={() => {
                                    setDecisionNote('');
                                    setConfirm({ row, action: 'deny' });
                                  }}
                                >
                                  <XCircle className="mr-1 h-3.5 w-3.5" />
                                  Deny
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-pink-100/80 bg-gradient-to-br from-white via-pink-50/30 to-white shadow-md ring-1 ring-pink-500/8 dark:border-pink-950/55 dark:from-zinc-950 dark:via-pink-950/12 dark:to-zinc-950 dark:ring-pink-400/10">
              <CardHeader className="flex flex-col gap-1 border-b border-pink-100/60 pb-4 dark:border-pink-900/40">
                <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      Receipt log — manager & Accounting outcomes
                    </CardTitle>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Every dispute after manager review stays here — with Accounting pending, Accounting approved, or Accounting denied —
                      newest activity first ({awaitingAccountingCount} still with Accounting).
                    </p>
                  </div>
                  {!loading && verifiedRows.length > 0 ? (
                    <span className="shrink-0 text-xs font-medium text-pink-600/90 dark:text-pink-400/90">
                      {filteredVerified.length === verifiedRows.length
                        ? `${verifiedRows.length} in log`
                        : `${filteredVerified.length} of ${verifiedRows.length}`}
                    </span>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 pt-4">
                <div className="relative max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                  <Input
                    value={verifiedSearch}
                    onChange={(e) => setVerifiedSearch(e.target.value)}
                    placeholder="Search by email, note, status, or date..."
                    className="border-pink-100/70 bg-white/90 pl-9 disabled:opacity-60 dark:border-pink-900/50 dark:bg-zinc-900/70"
                    disabled={loading}
                  />
                </div>
                {loading ? null : filteredVerified.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-pink-200/80 bg-white/70 py-10 text-center dark:border-pink-900/50 dark:bg-zinc-950/40">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {verifiedRows.length === 0
                        ? 'No disputes in this log yet — approvals and Accounting decisions will appear here.'
                        : 'No rows match your search.'}
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-pink-100/90 ring-1 ring-pink-500/10 dark:border-pink-900/60 dark:ring-pink-400/10">
                    <table className="w-full min-w-[720px] text-left text-sm">
                      <thead className="sticky top-0 z-[1] bg-gradient-to-r from-pink-50 via-white to-pink-50/80 text-xs text-zinc-600 dark:from-pink-950/50 dark:via-zinc-950 dark:to-pink-950/40 dark:text-zinc-400">
                        <tr>
                          <th className="px-4 py-3 font-semibold">Employee</th>
                          <th className="px-4 py-3 font-semibold">Visit date</th>
                          <th className="px-4 py-3 font-semibold">Status</th>
                          <th className="px-4 py-3 font-semibold">Last action by</th>
                          <th className="px-4 py-3 font-semibold">Last action at</th>
                          <th className="px-4 py-3 font-semibold">Note</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-pink-100/70 bg-white/80 dark:divide-pink-900/35 dark:bg-zinc-950/40">
                        {filteredVerified.map((row) => {
                          const st = orphanReceiptStatusMeta(row.status);
                          return (
                            <tr
                              key={row.id}
                              className="align-top transition-colors hover:bg-pink-50/35 dark:hover:bg-pink-950/25"
                            >
                              <td className="whitespace-normal break-all px-4 py-3 font-mono text-xs">
                                {row.work_email}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3">{row.dispute_date}</td>
                              <td className="whitespace-normal px-4 py-3">
                                <Badge
                                  variant="outline"
                                  className={cn('text-[10px] font-medium', st.badgeClass)}
                                >
                                  {st.label}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-xs text-zinc-700 dark:text-zinc-300">
                                {row.decided_by ?? '—'}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                                {formatVerifiedAt(row.decided_at)}
                              </td>
                              <td className="max-w-[220px] px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400">
                                {row.decision_note || '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </motion.div>
      </main>
      <Toaster position="top-right" />

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setDecisionNote('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {confirm?.action === 'deny' ? 'Deny orphanage dispute?' : 'Verify for Accounting?'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {confirm && (
                <>
                  {confirm.row.work_email} · {confirm.row.dispute_date}
                  <br />
                  No hour changes — PAB still uses Hubstaff time with orphanage rules after Accounting approves.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Optional note (appears in the receipt log)</Label>
            <textarea
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              rows={3}
              placeholder="e.g. Confirmed with team lead, visit day matches schedule."
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirm(null);
                setDecisionNote('');
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className={
                confirm?.action === 'deny'
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700'
              }
              onClick={() => void runDecide()}
            >
              {confirm?.action === 'deny' ? 'Deny' : 'Verify & send to Accounting'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface OrphanStatTileProps {
  label: string;
  value: number | string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
  accent: 'pink' | 'rose-deep' | 'mono';
}

function OrphanStatTile({ label, value, hint, icon: Icon, accent }: OrphanStatTileProps) {
  const accentMap = {
    pink: 'bg-gradient-to-br from-pink-400 to-rose-600 text-white shadow-rose-500/30',
    'rose-deep': 'bg-gradient-to-br from-rose-700 to-zinc-900 text-white shadow-rose-900/35',
    mono:
      'bg-gradient-to-br from-zinc-800 to-black text-white shadow-zinc-900/30 dark:from-zinc-200 dark:to-white dark:text-zinc-900 dark:shadow-zinc-200/20',
  } as const;

  return (
    <div className="group relative flex items-center gap-4 overflow-hidden rounded-xl border border-pink-100/80 bg-white/90 px-4 py-4 ring-1 ring-pink-500/5 backdrop-blur-sm transition-shadow hover:shadow-md hover:shadow-pink-500/10 dark:border-pink-950/50 dark:bg-zinc-950/75 dark:ring-pink-400/10 dark:hover:border-pink-800/60">
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg shadow-md',
          accentMap[accent],
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-pink-600/85 dark:text-pink-400/85">
          {label}
        </div>
        <div className="mt-0.5 bg-gradient-to-br from-zinc-900 via-rose-900 to-zinc-800 bg-clip-text text-xl font-bold tabular-nums text-transparent dark:from-white dark:via-pink-200 dark:to-zinc-200 sm:text-2xl">
          {value}
        </div>
        <div className="mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{hint}</div>
      </div>
    </div>
  );
}
