'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Building2, CalendarDays, Send, Wallet, ChevronRight, Loader2, Search, Eye,
} from 'lucide-react';
import { usePaymentsLive } from '@/hooks/usePaymentsLive';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import CeoPayrollLive from './CeoPayrollLive';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TeamAvatar } from '@/components/team/team-ui';
import { cn } from '@/lib/utils';

interface DeptCount {
  department: string;
  count: number;
}
interface UnpaidWorker {
  email: string;
  name: string | null;
  amountUsd: number | null;
  status: string;
}
interface LastCycle {
  reportName: string;
  periodStart: string | null;
  periodEnd: string | null;
  sourceFile: string | null;
  unpaidCount: number;
  paidCount: number;
  totalRecipients: number;
  workers: UnpaidWorker[];
}
interface OverviewKpis {
  departments: DeptCount[];
  totalHeadcount: number;
  payWeek: { label: string; sourceFile: string | null; paymentsToSend: number; totalRoster: number };
  lastCycle: LastCycle | null;
  error: string | null;
}

function fmtUsd(v: number | null): string {
  if (v == null) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Not dispatched',
  not_paid: 'Not paid',
  threshold: 'Below threshold',
  problem: 'Problem',
};

export default function CeoOverviewKpis({ viewerEmail }: { viewerEmail: string | null }) {
  const [kpis, setKpis] = useState<OverviewKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showUnpaid, setShowUnpaid] = useState(false);
  // Live "payments to send" — counts down as workers are paid (Supabase
  // Realtime on payment_dispatches), independent of the one-shot KPI fetch.
  const live = usePaymentsLive();
  // Global dispatch lock drives the "processing live" beacon on the card; the
  // card opens the live watch modal (who's driving the Wizard / Payment Dispatch).
  const { state: lockState } = useDispatchLock();
  const [liveOpen, setLiveOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch('/api/ceo/overview-kpis', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: OverviewKpis & { error?: string }) => {
        if (!alive) return;
        setKpis(j);
        setErr(j.error ?? null);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-yellow-200/60 bg-white py-16 text-sm text-zinc-500 dark:border-yellow-900/30 dark:bg-zinc-950">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading executive metrics…
      </div>
    );
  }

  const departments = kpis?.departments ?? [];
  const maxDept = Math.max(1, ...departments.map((d) => d.count));
  const lastCycle = kpis?.lastCycle ?? null;
  const hasUnpaid = !!lastCycle && lastCycle.unpaidCount > 0 && lastCycle.workers.length > 0;
  const paidPct = live.total > 0 ? Math.min(100, Math.round((live.paid / live.total) * 100)) : 0;

  return (
    <div className="flex flex-col gap-4 lg:gap-5">
      {err && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          Some metrics may be incomplete: {err}
        </div>
      )}

      {/* Cards 2 & 3 — pay week / payments to send, and last-cycle unpaid. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Current pay week + payments to send — LIVE: the headline number is
            how many are LEFT to pay, counting down to zero as the payroll clerk
            (or anyone) marks workers paid, via Supabase Realtime. CLICK to watch
            the live driver POVs (Payroll Wizard / Payment Dispatch). */}
        <button
          type="button"
          onClick={() => setLiveOpen(true)}
          title="Watch live payroll processing"
          className={cn(
            'group rounded-2xl border bg-white p-5 text-left shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 dark:bg-zinc-950',
            lockState.locked
              ? 'border-rose-300/70 hover:border-rose-400 dark:border-rose-900/50 dark:hover:border-rose-800'
              : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Send className="h-3.5 w-3.5 text-sky-500" /> Payments to send
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Live
            </span>
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <motion.span
              key={live.remaining}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="text-3xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100"
            >
              {live.remaining}
            </motion.span>
            <span className="text-[13px] text-zinc-400">left of {live.total}</span>
          </div>
          {/* Progress — how much of the cycle is paid. */}
          <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500"
              initial={false}
              animate={{ width: `${paidPct}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
            <span className="flex min-w-0 items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="truncate font-medium text-zinc-700 dark:text-zinc-300">{live.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">{live.paid} paid</span>
          </div>
          {/* Watch-live affordance — beacon when accounting is actively processing. */}
          <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-2.5 dark:border-zinc-800">
            <span className="flex items-center gap-1.5 text-[11px] font-medium">
              {lockState.locked ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
                  </span>
                  <span className="text-rose-600 dark:text-rose-400">Accounting is processing live</span>
                </>
              ) : (
                <span className="text-zinc-400">No active processing</span>
              )}
            </span>
            <span className="flex items-center gap-0.5 text-[11px] font-semibold text-zinc-500 group-hover:text-zinc-800 dark:text-zinc-400 dark:group-hover:text-zinc-200">
              <Eye className="h-3.5 w-3.5" /> Watch
              <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </div>
        </button>

        {/* Unpaid workers — last pay cycle (click to see who) */}
        <button
          type="button"
          onClick={() => setShowUnpaid(true)}
          disabled={!hasUnpaid}
          className={cn(
            'group rounded-2xl border border-zinc-200 bg-white p-5 text-left shadow-sm transition-colors dark:border-zinc-800 dark:bg-zinc-950',
            hasUnpaid
              ? 'hover:border-rose-300 hover:bg-rose-50/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 dark:hover:border-rose-900/60 dark:hover:bg-rose-950/20'
              : 'cursor-default',
          )}
          title={hasUnpaid ? 'See who has not been paid this cycle' : undefined}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
              <Wallet className="h-3.5 w-3.5 text-rose-500" /> Unpaid · last cycle
            </div>
            {hasUnpaid && (
              <span className="flex items-center gap-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                View list <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            )}
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
              {lastCycle?.unpaidCount ?? 0}
            </span>
            {lastCycle && <span className="text-[13px] text-zinc-400">of {lastCycle.totalRecipients} workers</span>}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
            <CalendarDays className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            {lastCycle ? <span className="truncate">{lastCycle.reportName}</span> : 'No completed cycle yet'}
          </div>
        </button>
      </div>

      {/* Card 1 — headcount by department graph */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
            <Building2 className="h-3.5 w-3.5 text-amber-500" /> Headcount by department
          </div>
          <span className="text-[12px] text-zinc-400">{kpis?.totalHeadcount ?? 0} people</span>
        </div>
        {departments.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-400">No people to show.</p>
        ) : (
          <ul className="space-y-2.5">
            {departments.map((d) => (
              <li key={d.department} className="flex items-center gap-3">
                <span
                  className="w-28 shrink-0 truncate text-[12.5px] text-zinc-600 sm:w-44 dark:text-zinc-300"
                  title={d.department}
                >
                  {d.department}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900">
                  <div
                    className="h-full rounded-md bg-gradient-to-r from-amber-400 to-yellow-500 transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.max(3, (d.count / maxDept) * 100)}%` }}
                  />
                </div>
                <span className="w-9 shrink-0 text-right text-[13px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                  {d.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showUnpaid && lastCycle && (
        <UnpaidWorkersDialog cycle={lastCycle} onClose={() => setShowUnpaid(false)} />
      )}

      {/* Live driver-watching modal, opened by the "Payments to send" card. */}
      <CeoPayrollLive
        viewerEmail={viewerEmail}
        open={liveOpen}
        onOpenChange={setLiveOpen}
        locked={lockState.locked}
      />
    </div>
  );
}

/* ── Unpaid-workers modal ───────────────────────────────────────────────── */

function UnpaidWorkersDialog({ cycle, onClose }: { cycle: LastCycle; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return cycle.workers;
    return cycle.workers.filter(
      (w) => (w.name ?? '').toLowerCase().includes(term) || w.email.toLowerCase().includes(term),
    );
  }, [cycle.workers, q]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <DialogTitle className="text-lg">Unpaid workers · {cycle.reportName}</DialogTitle>
            <DialogDescription>
              {cycle.unpaidCount} of {cycle.totalRecipients} workers in this pay cycle have not been marked paid.
            </DialogDescription>
          </DialogHeader>

          <div className="shrink-0 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name or email…"
                className="h-9 pl-8 text-[13px]"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {list.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">No one matches your search.</p>
            ) : (
              <ul className="space-y-1.5">
                {list.map((w) => (
                  <li
                    key={w.email}
                    className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
                  >
                    <TeamAvatar name={w.name ?? ''} email={w.email} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                        {w.name ?? w.email}
                      </div>
                      <div className="truncate text-[11px] text-zinc-400">{w.email}</div>
                    </div>
                    <span className="inline-flex shrink-0 items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10.5px] font-medium text-rose-600 dark:bg-rose-950/40 dark:text-rose-300">
                      {STATUS_LABEL[w.status] ?? w.status}
                    </span>
                    <span className="w-20 shrink-0 text-right text-[13px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                      {fmtUsd(w.amountUsd)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-200 px-5 py-3 text-[11px] text-zinc-400 dark:border-zinc-800">
            Showing {list.length} of {cycle.workers.length}. Amounts are USD owed for the cycle.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
