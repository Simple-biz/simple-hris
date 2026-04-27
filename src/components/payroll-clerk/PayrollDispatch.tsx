'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Banknote,
  CalendarRange,
  CheckCircle2,
  Coins,
  FileSpreadsheet,
  Globe2,
  History,
  Lock,
  Play,
  Send,
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
import SentPaymentsHistory from './SentPaymentsHistory';
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

type TabId = 'all' | 'history' | ProcessorId;

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
  const { rows: fetched, paid, period, loading, error, refresh } = useDispatchQueue();
  const { state: lockState, setLocked } = useDispatchLock();
  const [pending, setPending] = useState<QueueRow[]>([]);
  const [markPaidRow, setMarkPaidRow] = useState<QueueRow | null>(null);
  const [confirmingLockToggle, setConfirmingLockToggle] = useState(false);
  // Lenny can only dispatch when she's "started processing" (i.e. lock=true)
  // and a Hubstaff cycle is loaded. The "ready" mental model from the meeting
  // maps cleanly onto: cycle exists AND processing started.
  const cycleReady = Boolean(period.cycleId);
  // True once we've mirrored the first server snapshot into local `pending`.
  // Prevents a one-frame flash where `loading=false` but the local list is
  // still its empty initial state (would briefly show "Queue clear").
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPending(fetched);
    if (!loading) setHydrated(true);
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
  const totalSent = paid.length;
  const totalVolumeUSD = useMemo(
    () => pending.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0),
    [pending],
  );
  const knownAmountCount = useMemo(
    () => pending.filter((r) => r.amountUSD != null).length,
    [pending],
  );

  const visibleRows = useMemo(() => {
    if (activeTab === 'all') return pending;
    if (PROCESSORS.some((p) => p.id === activeTab)) {
      return pending.filter((r) => r.processor === activeTab);
    }
    return [];
  }, [pending, activeTab]);

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
          amount_usd: row.amountUSD,
          amount_php: row.amountPHP,
          transaction_id: payload.transactionId,
          bank_used: payload.bankUsed,
          sent_date: payload.sentDate,
          arrival_date: payload.arrivalDate || null,
        }),
      });
      const json = (await res.json()) as { row?: unknown; error?: string };
      if (!res.ok || json.error) {
        throw new Error(json.error ?? 'Could not log dispatch');
      }
      toast.success(`${row.name} marked paid`, { icon: '✨' });
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
    if (loading || !hydrated) return <QueueSkeleton />;
    if (error) return <ErrorState message={error} />;
    if (!cycleReady) return <NoCycleState />;
    if (activeTab === 'history') return <SentPaymentsHistory records={paid} />;
    return (
      <ProcessorQueue
        processor={activeTab === 'all' ? null : activeTab}
        rows={visibleRows}
        onMarkPaid={(row) => setMarkPaidRow(row)}
      />
    );
  };

  const handleLockToggle = async () => {
    try {
      await setLocked(!lockState.locked);
      toast.success(
        lockState.locked
          ? 'Processing stopped — employees can dispute again'
          : 'Processing started — employee disputes are paused',
        { icon: lockState.locked ? '🔓' : '🔒' },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update lock');
    } finally {
      setConfirmingLockToggle(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
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
              Send pay via processor and log each confirmation. Streamlined for Lenny — only
              what&apos;s needed to move money safely.
            </p>
          </div>

          <div className="flex w-full flex-row flex-wrap items-center gap-2 sm:w-auto sm:flex-col sm:items-end">
            <PeriodPill period={period} />
            <div className="flex items-center gap-2">
              <ProcessingPill locked={lockState.locked} />
              <Button
                size="sm"
                onClick={() => setConfirmingLockToggle(true)}
                className={cn(
                  'h-8 gap-1.5 text-[11px] font-semibold shadow-sm',
                  lockState.locked
                    ? 'bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-rose-500/30 hover:from-rose-600 hover:to-red-700'
                    : 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700',
                )}
              >
                {lockState.locked ? (
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
              </Button>
            </div>
          </div>
        </motion.div>

        {/* Hero stat strip */}
        <motion.div
          variants={containerStagger}
          initial="hidden"
          animate="visible"
          className="mt-4 grid grid-cols-3 gap-2 sm:mt-5 sm:gap-4"
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
            label="Volume"
            value={knownAmountCount > 0 ? totalVolumeUSD : null}
            sub={
              knownAmountCount === 0
                ? 'awaiting pay calc'
                : knownAmountCount < totalPending
                  ? `${knownAmountCount} of ${totalPending} priced`
                  : 'all priced'
            }
            Icon={Coins}
            currency
          />
        </motion.div>
      </div>

      {/* ── Processor cards ── */}
      <div className="relative shrink-0 px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="mb-2.5 flex items-center justify-between">
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
          className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2 lg:grid-cols-8"
        >
          <motion.div variants={itemPop}>
            <ProcessorCard
              id="all"
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
              <motion.div key={p.id} variants={itemPop}>
                <ProcessorCard
                  id={p.id}
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
          <motion.div variants={itemPop}>
            <ProcessorCard
              id="history"
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
        </motion.div>
      </div>

      {/* ── Body ── */}
      <div className="relative mt-4 min-h-0 flex-1 overflow-hidden px-4 pb-4 sm:mt-6 sm:px-8 sm:pb-8">
        <div className="relative h-full overflow-hidden rounded-2xl border border-orange-100/80 bg-white/90 shadow-[0_8px_28px_-12px_rgba(255,138,76,0.18)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab + (loading || !hydrated ? '-loading' : error ? '-error' : !cycleReady ? '-locked' : '-ok')}
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

      <MarkPaidDialog row={markPaidRow} onClose={() => setMarkPaidRow(null)} onConfirm={handleConfirmPaid} />
      <LockToggleConfirmDialog
        open={confirmingLockToggle}
        locked={lockState.locked}
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
  onClose,
  onConfirm,
}: {
  open: boolean;
  locked: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isStarting = !locked;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            className={cn(
              'gap-2 text-white',
              isStarting
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-rose-600 hover:bg-rose-700',
            )}
          >
            {isStarting ? <Play className="h-4 w-4" /> : <StopCircle className="h-4 w-4" />}
            {isStarting ? 'Start processing' : 'Stop processing'}
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
  const monthShort = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = (d: Date) => d.getUTCDate();
  const year = (d: Date) => d.getUTCFullYear();
  if (sameMonth) {
    return `${monthShort(s)} ${day(s)} – ${day(e)}, ${year(e)}`;
  }
  if (s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${monthShort(s)} ${day(s)} – ${monthShort(e)} ${day(e)}, ${year(e)}`;
  }
  return `${monthShort(s)} ${day(s)} ${year(s)} – ${monthShort(e)} ${day(e)} ${year(e)}`;
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
