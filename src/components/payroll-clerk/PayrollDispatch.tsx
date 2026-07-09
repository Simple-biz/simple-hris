'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  Banknote,
  CalendarRange,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  Coins,
  DollarSign,
  FileSpreadsheet,
  Globe2,
  Heart,
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
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import ProcessorQueue from './ProcessorQueue';
import ExcludedQueue from './ExcludedQueue';
import DoneQueue from './DoneQueue';
import DispatchReports from './DispatchReports';
import OrphanageQueue from './OrphanageQueue';
import UrgentPaymentsQueue from './UrgentPaymentsQueue';
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
import DispatchLoader from './DispatchLoader';
import { PROCESSORS, DISPATCH_PROCESSORS, parseCyclePeriodFromFile, formatCycleLabelFromFile, type ArrearsInfo, type ProcessorId, type QueueRow } from './mock-queue';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import { useDispatchQueue } from './useDispatchQueue';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useWizardDispatchLock } from '@/hooks/useWizardDispatchLock';
import { usePaymentsLivePublisher } from '@/hooks/usePaymentsLive';

type TabId = 'all' | 'usd' | 'cop' | 'urgent' | 'done' | 'reports' | 'excluded' | 'orphanage' | 'notifications' | ProcessorId;

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

const DONE_VISUAL: ProcessorVisual = {
  Icon: ClipboardCheck,
  accent: 'from-emerald-500 to-green-600',
  glow: 'from-emerald-100/80 via-green-50/60 to-white dark:from-emerald-950/40 dark:via-green-950/30 dark:to-zinc-900',
  blurb: 'Paid this cycle',
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

const ORPHANAGE_VISUAL: ProcessorVisual = {
  Icon: Heart,
  accent: 'from-teal-500 to-emerald-600',
  glow: 'from-teal-100/80 via-emerald-50/60 to-white dark:from-teal-950/40 dark:via-emerald-950/30 dark:to-zinc-900',
  blurb: 'Budgets & gifts',
};

const URGENT_VISUAL: ProcessorVisual = {
  Icon: Zap,
  accent: 'from-amber-500 to-orange-600',
  glow: 'from-amber-100/80 via-orange-50/60 to-white dark:from-amber-950/40 dark:via-orange-950/30 dark:to-zinc-900',
  blurb: 'MESA · pay now',
};

const USD_VISUAL: ProcessorVisual = {
  Icon: DollarSign,
  accent: 'from-green-600 to-emerald-700',
  glow: 'from-green-100/80 via-emerald-50/60 to-white dark:from-green-950/40 dark:via-emerald-950/30 dark:to-zinc-900',
  blurb: 'Paid in US dollars',
};

const COP_VISUAL: ProcessorVisual = {
  Icon: DollarSign,
  accent: 'from-yellow-500 to-amber-600',
  glow: 'from-yellow-100/80 via-amber-50/60 to-white dark:from-yellow-950/40 dark:via-amber-950/30 dark:to-zinc-900',
  blurb: 'Paid in Colombian pesos',
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
  // Which pay week the dispatch screen operates on. `null` = the live
  // (`is_current`) cycle — the default. The CSV selector in the header sets a
  // past week's source file so accounting can work historical data while not
  // yet live; everything (queue, dispatches, paystubs) follows the chosen week.
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null);
  const { rows: fetched, excluded, paid, period, wizardReady, loading, error, refresh } =
    useDispatchQueue(selectedSourceFile);
  const viewingPastWeek = selectedSourceFile != null;
  const { state: lockState, setLocked } = useDispatchLock();
  // Realtime "values locked" flag for this cycle — when the wizard locks/unlocks,
  // re-pull the queue so it appears/clears live (the queue's own `wizardReady`
  // mirrors this flag). The lock is owned by the wizard; here we only react.
  const cycleLock = useWizardDispatchLock(period.sourceFile);
  const prevCycleLockedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (cycleLock.loading) return;
    if (
      prevCycleLockedRef.current !== null &&
      prevCycleLockedRef.current !== cycleLock.state.locked
    ) {
      void refresh();
    }
    prevCycleLockedRef.current = cycleLock.state.locked;
  }, [cycleLock.state.locked, cycleLock.loading, refresh]);
  const [pending, setPending] = useState<QueueRow[]>([]);
  // Gallery state for the dispatch dialog: a snapshot of the sibling rows taken
  // at open time + the active index, so the user can slide ←/→ between payments.
  const [gallerySiblings, setGallerySiblings] = useState<QueueRow[]>([]);
  const [galleryIdx, setGalleryIdx] = useState<number | null>(null);
  const markPaidRow = galleryIdx != null ? gallerySiblings[galleryIdx] ?? null : null;
  // When paying from the Excluded tab, the cross-cycle arrears to settle in one
  // action (one payment + paystub per unpaid held cycle). null = normal pay.
  const [settleArrears, setSettleArrears] = useState<ArrearsInfo | null>(null);
  const [urgentCount, setUrgentCount] = useState(0);
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

  // Non-PHP people (US Managers in USD, Colombian staff in COP, etc.) are carved
  // OUT of the PHP processor tabs and paid separately in their own currency tab
  // — each person appears in exactly one place, so there's no double-paying.
  // Everyone else (PHP) stays in the normal processor queues.
  const usdPending = useMemo(() => pending.filter((r) => r.payCurrency === 'USD'), [pending]);
  const copPending = useMemo(() => pending.filter((r) => r.payCurrency === 'COP'), [pending]);
  const phpPending = useMemo(() => pending.filter((r) => r.payCurrency === 'PHP'), [pending]);

  const counts = useMemo(() => {
    const result: Record<ProcessorId, number> = {
      hurupay: 0,
      wepay: 0,
      higlobe: 0,
      wise: 0,
      jeeves: 0,
      wires: 0,
    };
    for (const row of phpPending) result[row.processor] += 1;
    return result;
  }, [phpPending]);

  const totalPending = phpPending.length;
  // "Sent" counts only rows that actually went through (status='paid'). Rows
  // logged with Threshold / Problem are excluded so the headline doesn't lie.
  const paidRows = useMemo(() => paid.filter((p) => p.status === 'paid'), [paid]);
  const totalSent = paidRows.length;

  // ── Mirror the CEO "Payments to send" card in real time ─────────────────────
  // Broadcast the SAME numbers this screen shows so the CEO dashboard stays in
  // lockstep (see usePaymentsLive). Distinct recipients (a person can have more
  // than one dispatch row) so "paid" counts people, matching the CEO framing.
  // Universe = still-pending payable (all currencies) + already-paid; excluded
  // (no-bank / no-pay / do-not-pay) people are intentionally left out, exactly
  // as this screen sets them aside — that's what removes the old over-count.
  const distinctPaidCount = useMemo(
    () => new Set(paidRows.map((p) => p.recipient_email.trim().toLowerCase())).size,
    [paidRows],
  );
  usePaymentsLivePublisher({
    enabled:
      !viewingPastWeek && wizardReady && hydrated && !loading && Boolean(period.sourceFile),
    sourceFile: period.sourceFile,
    label: period.sourceFile ? formatCycleLabelFromFile(period.sourceFile) : 'Current pay week',
    total: pending.length + distinctPaidCount,
    paid: distinctPaidCount,
    remaining: pending.length,
  });
  // Paid dispatches grouped by the processor they actually went through, so each
  // processor tab can show its own "Paid" sub-view alongside the global Done tab.
  const paidByProcessor = useMemo(() => {
    const map: Record<ProcessorId, PaymentDispatchRow[]> = {
      hurupay: [],
      wepay: [],
      higlobe: [],
      wise: [],
      jeeves: [],
      wires: [],
    };
    for (const r of paidRows) {
      const list = map[r.processor as ProcessorId];
      if (list) list.push(r);
    }
    return map;
  }, [paidRows]);
  const totalPaidUSD = useMemo(
    () => paidRows.reduce((sum, r) => sum + (r.amount_usd ?? 0), 0),
    [paidRows],
  );
  const totalPendingUSD = useMemo(
    () => pending.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0),
    [pending],
  );

  const visibleRows = useMemo(() => {
    if (activeTab === 'all') return phpPending;
    if (PROCESSORS.some((p) => p.id === activeTab)) {
      return phpPending.filter((r) => r.processor === activeTab);
    }
    return [];
  }, [phpPending, activeTab]);

  // Stable references so React.memo on ProcessorQueue / QueueRowItem actually
  // skips re-renders when only sibling state changes (e.g. opening Mark Paid
  // dialog). Without these the inline arrows force a full re-render of all
  // ~1000 rows on every dialog open.
  const handleOpenMarkPaid = useCallback(
    (row: QueueRow, ctx?: { siblings: QueueRow[]; index: number }) => {
      if (ctx && ctx.siblings.length > 0) {
        setGallerySiblings(ctx.siblings);
        setGalleryIdx(ctx.index);
      } else {
        setGallerySiblings([row]);
        setGalleryIdx(0);
      }
    },
    [],
  );
  const handleCloseMarkPaid = useCallback(() => {
    setGalleryIdx(null);
    setSettleArrears(null);
  }, []);
  // Excluded-tab "Pay now": single-row dialog that settles the person's full
  // cross-cycle balance on confirm.
  const handleOpenExcludedMarkPaid = useCallback((row: QueueRow, arrears?: ArrearsInfo) => {
    setGallerySiblings([row]);
    setGalleryIdx(0);
    setSettleArrears(arrears ?? null);
  }, []);
  const handleGalleryPrev = useCallback(() => {
    setGalleryIdx((i) => (i == null ? i : Math.max(0, i - 1)));
  }, []);
  const handleGalleryNext = useCallback(() => {
    setGalleryIdx((i) =>
      i == null ? i : Math.min(gallerySiblings.length - 1, i + 1),
    );
  }, [gallerySiblings.length]);

  const handleConfirmPaid = async (payload: MarkPaidPayload) => {
    const wasPending = pending.some((r) => r.id === payload.rowId);
    // Row can come from the pending queue OR from an Excluded-tab "Pay now"
    // (in which case it lives only in the gallery snapshot, not `pending`).
    const row =
      pending.find((r) => r.id === payload.rowId) ??
      gallerySiblings.find((r) => r.id === payload.rowId) ??
      null;
    if (!row) return;
    const arrears = settleArrears;

    // Optimistically drop the row so the UI feels instant (no-op for an
    // Excluded-tab pay). If the POST fails we put it back and surface the error.
    if (wasPending) setPending((prev) => prev.filter((r) => r.id !== payload.rowId));
    setGalleryIdx(null);
    setSettleArrears(null);

    // "Settle full balance" = one action clears every unpaid held cycle: one
    // payment + one paystub email per cycle (each keyed to its own staged
    // payload). A normal pay is just the single current cycle. Prior cycles get
    // their real period dates back from the filename.
    const cycles =
      arrears && arrears.cycles.length > 0
        ? arrears.cycles.map((c) => {
            const p = parseCyclePeriodFromFile(c.sourceFile);
            return {
              sourceFile: c.sourceFile,
              amountPHP: c.amountPHP,
              amountUSD: c.amountUSD,
              amountCOP: c.amountCOP,
              cycleId: null as string | null,
              periodStart: p.start,
              periodEnd: p.end,
            };
          })
        : [
            {
              sourceFile: period.sourceFile,
              amountPHP: row.amountPHP,
              amountUSD: row.amountUSD,
              amountCOP: row.amountCOP,
              cycleId: period.cycleId,
              periodStart: period.start,
              periodEnd: period.end,
            },
          ];

    // Settle cycle-by-cycle but NEVER abort the whole run on one failure: each
    // successful POST already moved money + emailed a paystub, so we record what
    // landed, keep going, then reconcile from the server. Failed cycles stay in
    // arrears (visible for a safe retry — paid cycles won't reappear).
    let sent = 0;
    let failedSend = 0;
    let notStaged = 0;
    let paidCycles = 0;
    let failedCycles = 0;
    let lastSendError: string | null = null;
    let lastDispatchError: string | null = null;
    for (const c of cycles) {
      try {
        const res = await fetch('/api/payment-dispatches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cycle_id: c.cycleId,
            cycle_period_start: c.periodStart,
            cycle_period_end: c.periodEnd,
            cycle_source_file: c.sourceFile,
            recipient_email: row.email,
            recipient_name: row.name,
            processor: row.processor,
            bank_preferred_raw: row.bankPreferredRaw,
            recipient_preferred_bank: payload.recipientPreferredBank || null,
            recipient_account_number: payload.recipientAccountNumber || null,
            recipient_account_holder: payload.recipientAccountHolder || null,
            recipient_swift_code: payload.recipientSwiftCode || null,
            amount_usd: c.amountUSD,
            amount_php: c.amountPHP,
            amount_cop: c.amountCOP,
            transaction_id: payload.transactionId,
            bank_used: payload.bankUsed,
            sent_date: payload.sentDate,
            arrival_date: payload.arrivalDate || null,
            status: payload.status,
            note: payload.note || null,
          }),
        });
        const json = (await res.json()) as {
          row?: unknown;
          error?: string;
          paystub?: { staged: boolean; sent: boolean; error: string | null };
        };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        paidCycles += 1;
        const ps = json.paystub;
        if (ps?.sent) sent += 1;
        else if (ps?.staged && ps?.error) {
          failedSend += 1;
          lastSendError = ps.error;
        } else if (ps && !ps.staged) notStaged += 1;
      } catch (e) {
        failedCycles += 1;
        lastDispatchError = e instanceof Error ? e.message : String(e);
      }
    }

    // Always reconcile from the server so the queue reflects exactly what landed.
    void refresh();

    if (paidCycles === 0) {
      // Nothing landed — restore the optimistically-removed pending row.
      if (wasPending) {
        setPending((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      }
      toast.error(`Couldn't log ${row.name}'s payment`, {
        description: lastDispatchError ?? undefined,
      });
      return;
    }

    if (payload.status !== 'paid') {
      toast.success(`${row.name} logged · ${payload.status.replace('_', ' ')}`, { icon: '📝' });
    } else if (cycles.length > 1) {
      const desc =
        `${sent} paystub${sent === 1 ? '' : 's'} emailed` +
        (failedSend ? ` · ${failedSend} email failed` : '') +
        (notStaged ? ` · ${notStaged} not staged` : '') +
        (failedCycles ? ` · ${failedCycles} cycle${failedCycles === 1 ? '' : 's'} still owed` : '');
      if (failedCycles) {
        toast.warning(`${row.name}: ${paidCycles}/${cycles.length} cycles settled`, { description: desc });
      } else {
        toast.success(`${row.name} settled · ${paidCycles} cycle${paidCycles === 1 ? '' : 's'}`, {
          icon: '✨',
          description: desc,
        });
      }
    } else if (sent) {
      toast.success(`${row.name} marked paid · paystub emailed`, { icon: '✨' });
    } else if (failedSend) {
      toast.warning(`${row.name} marked paid — paystub email failed`, {
        description: `${lastSendError ?? 'send error'}. Re-send from the Excluded tab.`,
      });
    } else if (notStaged) {
      toast.warning(`${row.name} marked paid — no staged paystub to email`, {
        description: 'Lock in this cycle from the Payroll Wizard to enable paystub emails.',
      });
    } else {
      toast.success(`${row.name} marked paid`, { icon: '✨' });
    }
  };

  const renderBody = () => {
    // Show the skeleton while the network is still in flight OR while we
    // haven't mirrored the first server snapshot into local state yet.
    if (activeTab === 'reports') return <DispatchReports />;
    if (activeTab === 'notifications') return <NotificationsPanel accent="zinc" />;
    if (activeTab === 'orphanage') return <OrphanageQueue />;
    if (activeTab === 'urgent') return <UrgentPaymentsQueue onCountChange={setUrgentCount} />;
    if (error) return <ErrorState message={error} />;
    if (loading || !hydrated) return <DispatchLoader />;
    if (!cycleReady) return <NoCycleState />;
    // No queue data until accounting locks + stages this cycle from the wizard.
    if (!wizardReady) return <WizardNotReadyState period={period} />;
    if (activeTab === 'done') {
      return (
        <DoneQueue
          records={paid}
          periodStart={period.start}
          periodEnd={period.end}
          onRefresh={refresh}
        />
      );
    }
    if (activeTab === 'excluded') {
      return <ExcludedQueue rows={excluded} onMarkPaid={handleOpenExcludedMarkPaid} />;
    }
    if (activeTab === 'usd') {
      return (
        <ProcessorQueue
          processor={null}
          rows={usdPending}
          onMarkPaid={handleOpenMarkPaid}
          periodStart={period.start}
          periodEnd={period.end}
          onRefresh={refresh}
          nativeCurrency="USD"
          allLabel={{
            title: 'USD payments',
            subtitle: 'People paid in US dollars — handled separately from the peso payroll. Mark each paid as it goes out.',
          }}
        />
      );
    }
    if (activeTab === 'cop') {
      return (
        <ProcessorQueue
          processor={null}
          rows={copPending}
          onMarkPaid={handleOpenMarkPaid}
          periodStart={period.start}
          periodEnd={period.end}
          onRefresh={refresh}
          nativeCurrency="COP"
          allLabel={{
            title: 'COP payments',
            subtitle: 'People paid in Colombian pesos — handled separately from the peso payroll. Mark each paid as it goes out.',
          }}
        />
      );
    }
    return (
      <ProcessorQueue
        processor={activeTab === 'all' ? null : activeTab}
        rows={visibleRows}
        onMarkPaid={handleOpenMarkPaid}
        periodStart={period.start}
        periodEnd={period.end}
        onRefresh={refresh}
        paidRecords={activeTab === 'all' ? undefined : paidByProcessor[activeTab]}
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
          ? 'Processing started — employee issues are paused'
          : 'Processing stopped — employees can file issues again',
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
            <div className="flex items-center gap-2">
              <PeriodPill period={period} />
              <CycleSelector value={selectedSourceFile} onChange={setSelectedSourceFile} />
            </div>
            <div className="flex items-center gap-2">
              <ProcessingPill locked={lockState.locked} />
              <ProcessingToggleButton
                locked={lockState.locked}
                onClick={() => setConfirmingLockToggle(true)}
                disabled={viewingPastWeek}
              />
            </div>
          </div>
        </motion.div>
      </div>

      {/* Working a PAST week (CSV selector) — make it loud so the clerk never
          mistakes historical data for the live cycle. */}
      {viewingPastWeek && (
        <div className="mx-4 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900 sm:mx-8 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          <span className="flex items-center gap-2">
            <History className="h-4 w-4 shrink-0" />
            <span>
              Viewing a <strong>past pay week</strong>
              {period.start && period.end ? <> — {formatPeriodLabel(period.start, period.end)}</> : null}. Anything you
              log is recorded against this week, not the live cycle.
            </span>
          </span>
          <button
            type="button"
            onClick={() => setSelectedSourceFile(null)}
            className="inline-flex items-center gap-1 rounded-lg border border-amber-400/70 bg-white/70 px-2.5 py-1 font-semibold text-amber-800 transition-colors hover:bg-white dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
          >
            <Wifi className="h-3.5 w-3.5 text-emerald-500" /> Back to current week
          </button>
        </div>
      )}

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
              // Mobile / sm: horizontal scroll strip — no more 5-row grid crushing the table.
              // A scroll container forces its cross-axis (here vertical) to clip, which would
              // shear the Urgent card's amber glow flat. Negative margin + equal padding pushes
              // the scrollport out so the glow bleeds freely, with no net layout shift.
              'flex gap-2 overflow-x-auto -my-4 py-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              // lg: stack vertically inside the narrow left column. overflow-y:auto forces the
              // computed overflow-x to clip too, so the same trick gives the glow room left/right
              // (fits inside the 16px grid gutter / 32px left padding — no overlap with the table).
              'lg:my-0 lg:py-0 lg:-mx-4 lg:px-4 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0',
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
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="Urgent"
                subtitle={URGENT_VISUAL.blurb}
                count={urgentCount}
                Icon={URGENT_VISUAL.Icon}
                accent={URGENT_VISUAL.accent}
                glow={URGENT_VISUAL.glow}
                active={activeTab === 'urgent'}
                onClick={() => setActiveTab('urgent')}
                iconOnlyFallback
                glowBorder
              />
            </motion.div>
            {DISPATCH_PROCESSORS.map((p) => {
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
                label="USD"
                subtitle={USD_VISUAL.blurb}
                count={usdPending.length}
                Icon={USD_VISUAL.Icon}
                accent={USD_VISUAL.accent}
                glow={USD_VISUAL.glow}
                active={activeTab === 'usd'}
                onClick={() => setActiveTab('usd')}
                iconOnlyFallback
              />
            </motion.div>
            {copPending.length > 0 && (
              <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
                <ProcessorCard
                  label="COP"
                  subtitle={COP_VISUAL.blurb}
                  count={copPending.length}
                  Icon={COP_VISUAL.Icon}
                  accent={COP_VISUAL.accent}
                  glow={COP_VISUAL.glow}
                  active={activeTab === 'cop'}
                  onClick={() => setActiveTab('cop')}
                  iconOnlyFallback
                />
              </motion.div>
            )}
            <motion.div variants={itemPop} className="w-[136px] shrink-0 lg:w-auto">
              <ProcessorCard
                label="Done"
                subtitle={DONE_VISUAL.blurb}
                count={totalSent}
                Icon={DONE_VISUAL.Icon}
                accent={DONE_VISUAL.accent}
                glow={DONE_VISUAL.glow}
                active={activeTab === 'done'}
                onClick={() => setActiveTab('done')}
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
                label="Orphanage"
                subtitle={ORPHANAGE_VISUAL.blurb}
                Icon={ORPHANAGE_VISUAL.Icon}
                accent={ORPHANAGE_VISUAL.accent}
                glow={ORPHANAGE_VISUAL.glow}
                active={activeTab === 'orphanage'}
                onClick={() => setActiveTab('orphanage')}
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
                activeTab === 'reports' || activeTab === 'excluded' || activeTab === 'orphanage' || activeTab === 'urgent' || activeTab === 'usd' || activeTab === 'cop'
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

      <MarkPaidDialog
        row={markPaidRow}
        onClose={handleCloseMarkPaid}
        onConfirm={handleConfirmPaid}
        position={
          galleryIdx != null
            ? { index: galleryIdx, total: gallerySiblings.length }
            : undefined
        }
        onPrev={handleGalleryPrev}
        onNext={handleGalleryNext}
      />
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
  disabled = false,
}: {
  locked: boolean;
  onClick: () => void;
  /** Greyed-out + inert while viewing a past week — this control flips the GLOBAL
   *  live-cycle issue lock, which is not scoped to a historical week. */
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={
        disabled
          ? 'Processing controls apply to the live cycle only — switch back to the current week to start/stop.'
          : undefined
      }
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 380, damping: 26 }}
      className={cn(
        'relative inline-flex h-8 min-w-[7.25rem] items-center justify-center gap-1.5 overflow-hidden rounded-md px-3 text-[11px] font-semibold text-white shadow-sm transition-[box-shadow,background-image] duration-300',
        disabled
          ? 'cursor-not-allowed bg-gradient-to-br from-zinc-400 to-zinc-500 opacity-60 dark:from-zinc-600 dark:to-zinc-700'
          : locked
            ? 'bg-gradient-to-br from-rose-500 to-red-600 shadow-rose-500/30 hover:from-rose-600 hover:to-red-700'
            : 'bg-gradient-to-br from-emerald-500 to-teal-600 shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700',
      )}
      aria-pressed={locked}
      aria-disabled={disabled}
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
      title={locked ? 'Issues are paused for employees until you stop processing' : undefined}
    >
      {locked ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-500" />
          </span>
          Processing · issues paused
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

function WizardNotReadyState({
  period,
}: {
  period: { start: string | null; end: string | null; sourceFile: string | null };
}) {
  const label = formatPeriodLabel(period.start, period.end);
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <motion.div
        initial={{ scale: 0.8, rotate: -6 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 240, damping: 18 }}
        className="relative flex h-20 w-20 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-xl shadow-indigo-500/30"
      >
        <Lock className="h-9 w-9" />
        <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-70" />
          <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-black text-white">!</span>
        </span>
      </motion.div>
      <div className="max-w-md">
        <h2 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
          Payroll Wizard isn&apos;t ready yet
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          This cycle&apos;s values haven&apos;t been locked. There&apos;s nothing to pay here until
          accounting opens the <span className="font-semibold text-indigo-600 dark:text-indigo-400">Payroll Wizard</span> and
          clicks <span className="font-semibold text-zinc-700 dark:text-zinc-200">&ldquo;Lock in Values &amp; Send to Payment Dispatch&rdquo;</span>.
          The queue, amounts, and paystubs all appear once it&apos;s locked.
        </p>
        {(period.start || period.sourceFile) && (
          <div className="mt-4 inline-flex items-center gap-2 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-1.5 text-[11px] font-medium text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
            <CalendarRange className="h-3.5 w-3.5" />
            <span>{label}</span>
            {period.sourceFile && (
              <span className="border-l border-amber-200 pl-2 font-mono text-amber-700/80 dark:border-amber-800 dark:text-amber-400/70">
                {period.sourceFile.replace(/\.csv$/i, '')}
              </span>
            )}
          </div>
        )}
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
                Starts the dispatch run for this cycle. Employees&apos; <span className="font-medium">File an Issue</span>{' '}
                button will be disabled live across all dashboards while processing is active.
              </>
            ) : (
              <>
                Ends processing for this cycle. Employees can file issues again and the live banner will
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

interface CycleOption {
  sourceFile: string;
  label: string;
  isCurrent: boolean;
}

/**
 * Header dropdown that lets the payroll clerk point Payment Dispatch at a PAST
 * pay week (so historical data can be worked while not yet live) or back at the
 * current `is_current` cycle. `value === null` means the live cycle. The list of
 * weeks comes from `/api/hubstaff-hours?source_files=1` (the same archive the
 * Payroll Wizard's period picker uses); backfills / multi-week / duplicate
 * uploads are filtered out so only real weekly cycles appear.
 */
function CycleSelector({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (file: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CycleOption[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/hubstaff-hours?source_files=1', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: {
        uploads?: Array<{ source_file: string | null; is_current: boolean }>;
        error?: string | null;
      }) => {
        if (!alive) return;
        const seen = new Set<string>();
        const opts: CycleOption[] = [];
        let current: string | null = null;
        for (const u of j.uploads ?? []) {
          const f = (u.source_file ?? '').trim();
          if (!f || seen.has(f)) continue;
          if (/backfill|time-activity|\(\d+\)|copy/i.test(f)) continue;
          seen.add(f);
          if (u.is_current && !current) current = f;
          opts.push({ sourceFile: f, label: formatCycleLabelFromFile(f), isCurrent: u.is_current });
        }
        setOptions(opts);
        setCurrentFile(current);
        setErr(j.error ?? null);
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const isLive = value == null;
  const buttonLabel = isLive ? 'Current week · live' : formatCycleLabelFromFile(value);
  // "Past weeks" = everything except the live cycle (represented by the top option).
  const pastOptions = options.filter((o) => o.sourceFile !== currentFile);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[11px] font-medium transition-colors',
          isLive
            ? 'border-zinc-200 bg-white/70 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300'
            : 'border-amber-300 bg-amber-50 text-amber-800 hover:border-amber-400 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300',
        )}
        title="Choose which pay week to dispatch"
      >
        {isLive ? <Wifi className="h-3.5 w-3.5 text-emerald-500" /> : <History className="h-3.5 w-3.5" />}
        <span className="max-w-[160px] truncate">{loading ? 'Loading weeks…' : buttonLabel}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <>
          {/* Click-away backdrop. */}
          <button
            type="button"
            aria-label="Close week selector"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1.5 max-h-[60vh] w-72 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
            <button
              type="button"
              onClick={() => { onChange(null); setOpen(false); }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors',
                isLive
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-900',
              )}
            >
              <Wifi className="h-4 w-4 shrink-0 text-emerald-500" />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">Current week · live</span>
                {currentFile && (
                  <span className="block truncate text-[10px] text-zinc-400">
                    {formatCycleLabelFromFile(currentFile)}
                  </span>
                )}
              </span>
              {isLive && <Check className="h-4 w-4 shrink-0 text-emerald-500" />}
            </button>

            {pastOptions.length > 0 && (
              <div className="px-2.5 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
                Past weeks
              </div>
            )}
            {pastOptions.map((o) => {
              const selected = value === o.sourceFile;
              return (
                <button
                  key={o.sourceFile}
                  type="button"
                  onClick={() => { onChange(o.sourceFile); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors',
                    selected
                      ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-900',
                  )}
                >
                  <CalendarRange className="h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{o.label}</span>
                    <span className="block truncate font-mono text-[10px] text-zinc-400">
                      {o.sourceFile.replace(/\.csv$/i, '')}
                    </span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-amber-500" />}
                </button>
              );
            })}
            {!loading && pastOptions.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-zinc-400">No earlier weeks on file.</p>
            )}
            {err && <p className="px-2.5 py-2 text-[10px] text-rose-500">{err}</p>}
          </div>
        </>
      )}
    </div>
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
