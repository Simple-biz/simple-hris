'use client';

import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Banknote,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Coins,
  FileSpreadsheet,
  Globe2,
  History,
  Loader2,
  Lock,
  Play,
  Send,
  ShieldOff,
  Sparkles,
  StopCircle,
  Wallet,
  Wallet2,
  Wifi,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import ProcessorQueue from './ProcessorQueue';
import ExcludedQueue from './ExcludedQueue';
import SentPaymentsHistory from './SentPaymentsHistory';
import DispatchReports from './DispatchReports';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ProcessorCard from './ProcessorCard';
import AnimatedNumber from './AnimatedNumber';
import QueueSkeleton from './QueueSkeleton';
import { PROCESSORS, type ProcessorId, type QueueRow } from './mock-queue';
import { useDispatchQueue } from './useDispatchQueue';
import { useDispatchLock } from '@/hooks/useDispatchLock';

type TabId = 'all' | 'history' | 'reports' | 'excluded' | ProcessorId;

interface ProcessorVisual {
  Icon: React.ComponentType<{ className?: string }>;
  /** Solid icon-tile gradient. */
  accent: string;
  /** Active card glow gradient (background tint). */
  glow: string;
  blurb: string;
}

const PROCESSOR_VISUALS: Record<ProcessorId, ProcessorVisual> = {
  hurupay: {
    Icon: Coins,
    accent: 'from-orange-500 to-amber-500',
    glow: 'from-orange-100/80 via-amber-50/60 to-white dark:from-orange-950/40 dark:via-amber-950/30 dark:to-zinc-900',
    blurb: 'Email only',
  },
  wepay: {
    Icon: Wallet,
    accent: 'from-sky-500 to-blue-600',
    glow: 'from-sky-100/80 via-blue-50/60 to-white dark:from-sky-950/40 dark:via-blue-950/30 dark:to-zinc-900',
    blurb: 'Email only',
  },
  higlobe: {
    Icon: Globe2,
    accent: 'from-emerald-500 to-teal-500',
    glow: 'from-emerald-100/80 via-teal-50/60 to-white dark:from-emerald-950/40 dark:via-teal-950/30 dark:to-zinc-900',
    blurb: 'Email + account',
  },
  wise: {
    Icon: Wallet2,
    accent: 'from-green-500 to-lime-500',
    glow: 'from-green-100/80 via-lime-50/60 to-white dark:from-green-950/40 dark:via-lime-950/30 dark:to-zinc-900',
    blurb: 'Email or tag',
  },
  jeeves: {
    Icon: Wifi,
    accent: 'from-pink-500 to-rose-500',
    glow: 'from-pink-100/80 via-rose-50/60 to-white dark:from-pink-950/40 dark:via-rose-950/30 dark:to-zinc-900',
    blurb: 'Phone + wire',
  },
  wires: {
    Icon: Banknote,
    accent: 'from-zinc-700 to-zinc-900 dark:from-zinc-500 dark:to-zinc-700',
    glow: 'from-zinc-100/80 via-zinc-50/60 to-white dark:from-zinc-900/60 dark:via-zinc-800/40 dark:to-zinc-900',
    blurb: 'Manual wire',
  },
};

const ALL_VISUAL: ProcessorVisual = {
  Icon: Send,
  accent: 'from-orange-500 to-rose-500',
  glow: 'from-orange-100/80 via-rose-50/60 to-white dark:from-orange-950/40 dark:via-rose-950/30 dark:to-zinc-900',
  blurb: 'Everything pending',
};

const HISTORY_VISUAL: ProcessorVisual = {
  Icon: History,
  accent: 'from-emerald-500 to-green-600',
  glow: 'from-emerald-100/80 via-green-50/60 to-white dark:from-emerald-950/40 dark:via-green-950/30 dark:to-zinc-900',
  blurb: 'Sent this cycle',
};

const REPORTS_VISUAL: ProcessorVisual = {
  Icon: ClipboardList,
  accent: 'from-violet-500 to-fuchsia-500',
  glow: 'from-violet-100/80 via-fuchsia-50/60 to-white dark:from-violet-950/40 dark:via-fuchsia-950/30 dark:to-zinc-900',
  blurb: 'Weekly summary',
};

const EXCLUDED_VISUAL: ProcessorVisual = {
  Icon: ShieldOff,
  accent: 'from-zinc-500 to-zinc-700',
  glow: 'from-zinc-100/80 via-zinc-50/60 to-white dark:from-zinc-800/60 dark:via-zinc-900/40 dark:to-zinc-900',
  blurb: 'No bank · pay · hours',
};

const containerStagger = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};

const itemPop = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 280, damping: 24 } },
};

export default function PayrollDispatch() {
  const { data: session } = useSession();
  const firstName = useMemo(() => deriveFirstName(session?.user?.name, session?.user?.email), [
    session?.user?.name,
    session?.user?.email,
  ]);
  const [activeTab, setActiveTab] = useState<TabId>('all');
  const { rows: fetched, excluded, paid, period, loading, error, refresh } = useDispatchQueue();
  const { state: lockState, setLocked } = useDispatchLock();
  const [pending, setPending] = useState<QueueRow[]>([]);
  const [markPaidRow, setMarkPaidRow] = useState<QueueRow | null>(null);
  const [confirmingLockToggle, setConfirmingLockToggle] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  // Lenny can only dispatch when she's "started processing" (i.e. lock=true)
  // and a Hubstaff cycle is loaded. The "ready" mental model from the meeting
  // maps cleanly onto: cycle exists AND processing started.
  const cycleReady = Boolean(period.cycleId);
  // True only after `fetched` is copied into `pending` for the current load.
  // Reset while loading so we never paint the table with stale `pending` after
  // `loading` flips false (browser painted before `pending` caught up).
  const [hydrated, setHydrated] = useState(false);

  useLayoutEffect(() => {
    if (loading) {
      setHydrated(false);
      return;
    }
    setPending(fetched);
    setHydrated(true);
  }, [fetched, loading]);

  const counts = useMemo(() => {
    const result: Record<ProcessorId, number> = {
      hurupay: 0,
      wepay: 0,
      higlobe: 0,
      wise: 0,
      jeeves: 0,
      wires: 0,
    };
    for (const row of pending) result[row.processor] += 1;
    return result;
  }, [pending]);

  const totalPending = pending.length;
  // "Sent" counts only rows that actually went through (status='paid'). Rows
  // logged with Threshold / Problem are excluded so the headline doesn't lie.
  const paidRows = useMemo(() => paid.filter((p) => p.status === 'paid'), [paid]);
  const totalSent = paidRows.length;
  const totalPaidUSD = useMemo(
    () => paidRows.reduce((sum, r) => sum + (r.amount_usd ?? 0), 0),
    [paidRows],
  );
  const totalPendingUSD = useMemo(
    () => pending.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0),
    [pending],
  );

  const visibleRows = useMemo(() => {
    if (activeTab === 'all') return pending;
    if (PROCESSORS.some((p) => p.id === activeTab)) {
      return pending.filter((r) => r.processor === activeTab);
    }
    return [];
  }, [pending, activeTab]);

  // Stable references so React.memo on ProcessorQueue / QueueRowItem actually
  // skips re-renders when only sibling state changes (e.g. opening Mark Paid
  // dialog). Without these the inline arrows force a full re-render of all
  // ~1000 rows on every dialog open.
  const handleOpenMarkPaid = useCallback((row: QueueRow) => {
    setMarkPaidRow(row);
  }, []);
  const handleCloseMarkPaid = useCallback(() => {
    setMarkPaidRow(null);
  }, []);

  const handleConfirmPaid = async (payload: MarkPaidPayload) => {
    const row = pending.find((r) => r.id === payload.rowId);
    if (!row) return;

    // Optimistically drop the row so the UI feels instant. If the POST fails
    // we put it back and surface the error.
    setPending((prev) => prev.filter((r) => r.id !== payload.rowId));
    setMarkPaidRow(null);

    try {
      const res = await fetch('/api/payment-dispatches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cycle_id: period.cycleId,
          cycle_period_start: period.start,
          cycle_period_end: period.end,
          cycle_source_file: period.sourceFile,
          recipient_email: row.email,
          recipient_name: row.name,
          processor: row.processor,
          bank_preferred_raw: row.bankPreferredRaw,
          recipient_preferred_bank: payload.recipientPreferredBank || null,
          recipient_account_number: payload.recipientAccountNumber || null,
          recipient_account_holder: payload.recipientAccountHolder || null,
          recipient_swift_code: payload.recipientSwiftCode || null,
          amount_usd: row.amountUSD,
          amount_php: row.amountPHP,
          transaction_id: payload.transactionId,
          bank_used: payload.bankUsed,
          sent_date: payload.sentDate,
          arrival_date: payload.arrivalDate || null,
          status: payload.status,
          note: payload.note || null,
        }),
      });
      const json = (await res.json()) as { row?: unknown; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? 'Could not log dispatch');
      }
      toast.success(
        payload.status === 'paid'
          ? `${row.name} marked paid`
          : `${row.name} logged · ${payload.status.replace('_', ' ')}`,
        { icon: payload.status === 'paid' ? '✨' : '📝' },
      );
      // Re-pull queue + history so paid count + persistence are accurate.
      void refresh();
    } catch (e) {
      // Restore the row in pending.
      setPending((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      toast.error(e instanceof Error ? e.message : 'Could not log dispatch');
    }
  };

  const renderBody = () => {
    // Show the skeleton while the network is still in flight OR while we
    // haven't mirrored the first server snapshot into local state yet.
    if (activeTab === 'reports') return <DispatchReports />;
    if (error) return <ErrorState message={error} />;
    if (loading || !hydrated) return <QueueSkeleton />;
    if (!cycleReady) return <NoCycleState />;
    if (activeTab === 'history') {
      return (
        <SentPaymentsHistory records={paid} periodStart={period.start} periodEnd={period.end} />
      );
    }
    if (activeTab === 'excluded') {
      return <ExcludedQueue rows={excluded} />;
    }
    return (
      <ProcessorQueue
        processor={activeTab === 'all' ? null : activeTab}
        rows={visibleRows}
        onMarkPaid={handleOpenMarkPaid}
        periodStart={period.start}
        periodEnd={period.end}
      />
    );
  };

  const handleLockToggle = async () => {
    if (togglingLock) return;
    setTogglingLock(true);
    const goingLocked = !lockState.locked;
    try {
      await setLocked(goingLocked);
      toast.success(
        goingLocked
          ? 'Processing started — employee disputes are paused'
          : 'Processing stopped — employees can dispute again',
        { icon: goingLocked ? '🔒' : '🔓' },
      );
      // Close after success so the dialog gracefully animates out alongside
      // the parent state changes — feels like one motion, not two.
      setConfirmingLockToggle(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update lock');
    } finally {
      setTogglingLock(false);
    }
  };

  return (
    <div className="relative flex min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117] lg:h-full lg:overflow-hidden">
      {/* Decorative background blobs — pure dopamine */}
      <BackgroundOrbs />

      {/* ── Hero ── */}
      <div className="relative shrink-0 px-4 pt-5 sm:px-8 sm:pt-8">
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap items-start justify-between gap-4"
        >
          <div>
            <div className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-orange-200/80 bg-white/70 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300">
              <Sparkles className="h-3 w-3" />
              Payroll clerk
            </div>
            <motion.p
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.05 }}
              className="text-[13px] font-medium text-zinc-500 dark:text-zinc-400"
            >
              Welcome back,{' '}
              <span className="bg-gradient-to-r from-orange-600 to-rose-500 bg-clip-text font-semibold text-transparent dark:from-orange-400 dark:to-rose-400">
                {firstName}
              </span>{' '}
              <motion.span
                initial={{ rotate: 0 }}
                animate={{ rotate: [0, 14, -8, 14, -4, 10, 0] }}
                transition={{ duration: 1.4, ease: 'easeInOut', delay: 0.3 }}
                className="inline-block origin-[70%_70%]"
              >
                👋
              </motion.span>
            </motion.p>
            <h1 className="mt-0.5 text-xl font-bold tracking-tight text-zinc-900 dark:text-white sm:text-[28px]">
              Payment dispatch
            </h1>
            <p className="mt-1 max-w-xl text-[13px] text-zinc-500 dark:text-zinc-400 sm:text-sm">
              Dispatch this week&apos;s payroll one transfer at a time. Pick a processor on the left,
              log each payment as it goes out, and the queue clears as money moves.
            </p>
          </div>

          <div className="flex w-full flex-row flex-wrap items-center gap-2 sm:w-auto sm:flex-col sm:items-end">
            <PeriodPill period={period} />
            <div className="flex items-center gap-2">
              <ProcessingPill locked={lockState.locked} />
              <ProcessingToggleButton
                locked={lockState.locked}
                onClick={() => setConfirmingLockToggle(true)}
              />
            </div>
          </div>
        </motion.div>
      </div>

      {/* ── Two-column layout: bank cards left, stats + table right ── */}
      <div
        className={cn(
          'relative mt-4 flex flex-col gap-3 px-4 pb-6 sm:mt-6 sm:px-8 sm:pb-8',
          // lg+ becomes a 2-col / 2-row grid: banks span the left column full
          // height, stats top-right, table bottom-right.
          'lg:min-h-0 lg:flex-1 lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-4',
        )}
      >
        {/* RIGHT TOP — Hero stats. Order 1 on mobile so stats sit above
            everything else. lg: top-right cell. */}
        <motion.div
          variants={containerStagger}
          initial="hidden"
          animate="visible"
          className="order-1 grid grid-cols-3 gap-2 sm:gap-4 lg:order-none lg:col-start-2 lg:row-start-1"
        >
          <HeroStat
            tone="orange"
            label="Pending"
            value={totalPending}
            sub={totalPending === 1 ? 'person to pay' : 'people to pay'}
            Icon={Send}
          />
          <HeroStat
            tone="emerald"
            label="Sent"
            value={totalSent}
            sub={totalSent === 1 ? 'payment logged' : 'payments logged'}
            Icon={CheckCircle2}
          />
          <HeroStat
            tone="violet"
            label="Paid"
            value={totalPaidUSD}
            sub={
              totalSent === 0
                ? 'no payments logged yet'
                : totalPendingUSD > 0
                  ? `$${Math.round(totalPendingUSD).toLocaleString('en-US')} still owed`
                  : `all paid · ${totalSent} dispatch${totalSent === 1 ? '' : 'es'}`
            }
            Icon={Coins}
            currency
          />
        </motion.div>

        {/* LEFT — Bank cards (filter rail). Order 2 on mobile (between stats
            and table); spans full height of left column on lg. */}
        <div className="order-2 flex min-h-0 flex-col gap-2 lg:order-none lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <div className="flex shrink-0 items-center justify-between px-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              Filter by processor
            </h2>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              <AnimatedNumber value={visibleRows.length} /> in view
            </span>
          </div>
          <motion.div
            variants={containerStagger}
            initial="hidden"
            animate="visible"
            className={cn(
              // Mobile / sm: horizontal scroll strip — no more 5-row grid crushing the table
              'flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              // lg: stack vertically inside the narrow left column
              'lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0 lg:pr-1',
            )}
          >
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="All pending"
                subtitle={ALL_VISUAL.blurb}
                count={totalPending}
                Icon={ALL_VISUAL.Icon}
                accent={ALL_VISUAL.accent}
                glow={ALL_VISUAL.glow}
                active={activeTab === 'all'}
                onClick={() => setActiveTab('all')}
                iconOnlyFallback
              />
            </motion.div>
            {PROCESSORS.map((p) => {
              const v = PROCESSOR_VISUALS[p.id];
              return (
                <motion.div key={p.id} variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
                  <ProcessorCard
                    label={p.label}
                    subtitle={v.blurb}
                    count={counts[p.id] ?? 0}
                    Icon={v.Icon}
                    accent={v.accent}
                    glow={v.glow}
                    active={activeTab === p.id}
                    onClick={() => setActiveTab(p.id)}
                  />
                </motion.div>
              );
            })}
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="History"
                subtitle={HISTORY_VISUAL.blurb}
                count={totalSent}
                Icon={HISTORY_VISUAL.Icon}
                accent={HISTORY_VISUAL.accent}
                glow={HISTORY_VISUAL.glow}
                active={activeTab === 'history'}
                onClick={() => setActiveTab('history')}
                iconOnlyFallback
              />
            </motion.div>
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="Reports"
                subtitle={REPORTS_VISUAL.blurb}
                Icon={REPORTS_VISUAL.Icon}
                accent={REPORTS_VISUAL.accent}
                glow={REPORTS_VISUAL.glow}
                active={activeTab === 'reports'}
                onClick={() => setActiveTab('reports')}
                iconOnlyFallback
              />
            </motion.div>
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="Excluded"
                subtitle={EXCLUDED_VISUAL.blurb}
                count={excluded.length}
                Icon={EXCLUDED_VISUAL.Icon}
                accent={EXCLUDED_VISUAL.accent}
                glow={EXCLUDED_VISUAL.glow}
                active={activeTab === 'excluded'}
                onClick={() => setActiveTab('excluded')}
                iconOnlyFallback
              />
            </motion.div>
          </motion.div>
        </div>

        {/* RIGHT BOTTOM — Table body. Order 3 on mobile, bottom-right cell on lg. */}
        <div className="relative order-3 min-h-[420px] overflow-hidden rounded-2xl border border-orange-100/80 bg-white/90 shadow-[0_8px_28px_-12px_rgba(255,138,76,0.18)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80 lg:order-none lg:col-start-2 lg:row-start-2 lg:min-h-0 lg:flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={
                activeTab === 'reports' || activeTab === 'excluded'
                  ? activeTab
                  : activeTab +
                    (loading || !hydrated
                      ? '-loading'
                      : error
                        ? '-error'
                        : !cycleReady
                          ? '-locked'
                          : '-ok')
              }
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="flex h-full min-h-0 flex-col"
            >
              {renderBody()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <MarkPaidDialog row={markPaidRow} onClose={handleCloseMarkPaid} onConfirm={handleConfirmPaid} />
      <LockToggleConfirmDialog
        open={confirmingLockToggle}
        locked={lockState.locked}
        submitting={togglingLock}
        onClose={() => setConfirmingLockToggle(false)}
        onConfirm={handleLockToggle}
      />
    </div>
  );
}

/* ─────────────────────── helpers ─────────────────────── */

function BackgroundOrbs() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8 }}
        className="absolute -left-32 -top-32 h-72 w-72 rounded-full bg-orange-300/30 blur-3xl dark:bg-orange-600/10"
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, delay: 0.1 }}
        className="absolute -right-24 top-32 h-72 w-72 rounded-full bg-blue-300/25 blur-3xl dark:bg-blue-600/10"
      />
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: 0.2 }}
        className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-rose-200/30 blur-3xl dark:bg-fuchsia-700/10"
      />
    </div>
  );
}

function ProcessingToggleButton({
  locked,
  onClick,
}: {
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      className={cn(
        'relative inline-flex h-8 min-w-[7.25rem] items-center justify-center gap-1.5 overflow-hidden rounded-md px-3 text-[11px] font-semibold text-white shadow-sm transition-[box-shadow,background-image] duration-300',
        locked
          ? 'bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/30 hover:from-rose-600 hover:to-red-700'
          : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700',
      )}
      aria-pressed={locked}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={locked ? 'stop' : 'start'}
          initial={{ opacity: 0, y: 6, scale: 0.92 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -6, scale: 0.92 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="flex items-center gap-1.5"
        >
          {locked ? (
            <>
              <StopCircle className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Stop processing</span>
              <span className="sm:hidden">Stop</span>
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Start processing</span>
              <span className="sm:hidden">Start</span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

function ProcessingPill({ locked }: { locked: boolean }) {
  return (
    <motion.span
      key={locked ? 'locked' : 'open'}
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 22 }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium backdrop-blur-md',
        locked
          ? 'border-rose-200/80 bg-rose-50/80 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300'
          : 'border-zinc-200/80 bg-zinc-50/80 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300',
      )}
      title={locked ? 'Disputes are paused for employees until you stop processing' : undefined}
    >
      {locked ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
          Processing · disputes paused
        </>
      ) : (
        <>
          <Lock className="h-3 w-3 opacity-60" />
          Not processing
        </>
      )}
    </motion.span>
  );
}

function HeroStat({
  tone,
  label,
  value,
  sub,
  Icon,
  currency = false,
}: {
  tone: 'orange' | 'emerald' | 'violet';
  label: string;
  value: number | null;
  sub: string;
  Icon: React.ComponentType<{ className?: string }>;
  currency?: boolean;
}) {
  const palette = {
    orange: {
      ring: 'from-orange-200/40 to-rose-200/40 dark:from-orange-900/30 dark:to-rose-900/30',
      icon: 'from-orange-500 to-rose-500',
      text: 'text-orange-700 dark:text-orange-300',
    },
    emerald: {
      ring: 'from-emerald-200/40 to-teal-200/40 dark:from-emerald-900/30 dark:to-teal-900/30',
      icon: 'from-emerald-500 to-teal-500',
      text: 'text-emerald-700 dark:text-emerald-300',
    },
    violet: {
      ring: 'from-violet-200/40 to-fuchsia-200/40 dark:from-violet-900/30 dark:to-fuchsia-900/30',
      icon: 'from-violet-500 to-fuchsia-500',
      text: 'text-violet-700 dark:text-violet-300',
    },
  }[tone];

  return (
    <motion.div
      variants={itemPop}
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      className="group relative overflow-hidden rounded-xl border border-white/60 bg-white/70 p-2.5 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 sm:rounded-2xl sm:p-4"
    >
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-br opacity-60 transition-opacity duration-300 group-hover:opacity-100',
          palette.ring,
        )}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em] sm:text-[10px]', palette.text)}>
            {label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-0.5 sm:mt-1 sm:gap-1">
            {currency && value != null && (
              <span className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 sm:text-base">$</span>
            )}
            <span className="truncate text-xl font-bold tracking-tight text-zinc-900 tabular-nums dark:text-white sm:text-3xl">
              {value == null ? (
                '—'
              ) : (
                <AnimatedNumber
                  value={value}
                  formatter={(n) =>
                    currency
                      ? n.toLocaleString('en-US', {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 0,
                        })
                      : Math.round(n).toLocaleString('en-US')
                  }
                />
              )}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400 sm:text-[11px]">{sub}</div>
        </div>
        <div
          className={cn(
            'hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md sm:flex',
            palette.icon,
          )}
        >
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </motion.div>
  );
}

function NoCycleState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <motion.div
        initial={{ scale: 0.8, rotate: -8 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 240, damping: 18 }}
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-lg shadow-amber-500/30"
      >
        <FileSpreadsheet className="h-8 w-8" />
      </motion.div>
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">No Hubstaff cycle uploaded</h2>
        <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">
          Upload this week&apos;s Hubstaff CSV in the Payroll Wizard. Once it&apos;s the current upload,
          everyone owed pay shows up here.
        </p>
      </div>
    </motion.div>
  );
}

function LockToggleConfirmDialog({
  open,
  locked,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  locked: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isStarting = !locked;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Don't allow dismissing the dialog while the toggle POST is in flight.
        if (!o && !submitting) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            {isStarting ? (
              <Play className="h-5 w-5 text-emerald-500" />
            ) : (
              <StopCircle className="h-5 w-5 text-rose-500" />
            )}
            {isStarting ? 'Start payroll processing?' : 'Stop payroll processing?'}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {isStarting ? (
              <>
                Starts the dispatch run for this cycle. Employees&apos; <span className="font-medium">File a Dispute</span>{' '}
                button will be disabled live across all dashboards while processing is active.
              </>
            ) : (
              <>
                Ends processing for this cycle. Employees can file disputes again and the live banner will
                clear from their dashboards.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={submitting}
            className={cn(
              'gap-2 text-white transition-colors',
              isStarting
                ? 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/80'
                : 'bg-rose-600 hover:bg-rose-700 disabled:bg-rose-600/80',
            )}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isStarting ? (
              <Play className="h-4 w-4" />
            ) : (
              <StopCircle className="h-4 w-4" />
            )}
            {submitting
              ? isStarting
                ? 'Starting…'
                : 'Stopping…'
              : isStarting
                ? 'Start processing'
                : 'Stop processing'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
        <AlertCircle className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Couldn&apos;t load queue</h2>
      <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{message}</p>
    </motion.div>
  );
}

function PeriodPill({ period }: { period: { start: string | null; end: string | null; sourceFile: string | null } }) {
  const label = formatPeriodLabel(period.start, period.end);
  const hasPeriod = period.start && period.end;

  return (
    <motion.div
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.1 }}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] backdrop-blur-md',
        hasPeriod
          ? 'border-orange-200/80 bg-white/70 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200'
          : 'border-amber-200/80 bg-amber-50/80 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300',
      )}
      title={period.sourceFile ?? undefined}
    >
      <CalendarRange className="h-3.5 w-3.5 text-orange-500" />
      <div className="flex flex-col leading-tight">
        <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Payroll period
        </span>
        <span className="font-semibold tracking-tight">{label}</span>
      </div>
      {period.sourceFile && (
        <span className="hidden items-center gap-1 border-l border-orange-100 pl-2 text-[10px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500 sm:inline-flex">
          <FileSpreadsheet className="h-3 w-3" />
          <span className="max-w-[120px] truncate" title={period.sourceFile}>
            {period.sourceFile.replace(/\.csv$/i, '')}
          </span>
        </span>
      )}
    </motion.div>
  );
}

function formatPeriodLabel(start: string | null, end: string | null): string {
  if (!start || !end) return 'No upload yet';
  const s = parseISO(start);
  const e = parseISO(end);
  if (!s || !e) return `${start} → ${end}`;
  const sameMonth = s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear();
  const monthLong = (d: Date) => d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = (d: Date) => d.getUTCDate();
  const year = (d: Date) => d.getUTCFullYear();
  if (sameMonth) {
    return `${monthLong(s)} ${day(s)}-${day(e)}, ${year(e)} Week`;
  }
  if (s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${monthLong(s)} ${day(s)} - ${monthLong(e)} ${day(e)}, ${year(e)} Week`;
  }
  return `${monthLong(s)} ${day(s)}, ${year(s)} - ${monthLong(e)} ${day(e)}, ${year(e)} Week`;
}

function parseISO(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Friendly first-name fallback chain: NextAuth name → email local part → "there". */
function deriveFirstName(name: string | null | undefined, email: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (trimmed) return trimmed.split(/\s+/)[0]!;
  const local = (email ?? '').split('@')[0] ?? '';
  if (local) {
    const cleaned = local.replace(/[._-]+/g, ' ').trim();
    const first = cleaned.split(/\s+/)[0] ?? '';
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return 'there';
}
