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
import { toast } from 'sonner';
import { playStagePrepped, stopStagePrepped } from '@/lib/sound/ping-chime';
import ProcessorQueue from './ProcessorQueue';
import ExcludedQueue from './ExcludedQueue';
import DoneQueue from './DoneQueue';
import OrphanageQueue from './OrphanageQueue';
import UrgentPaymentsQueue from './UrgentPaymentsQueue';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import { PayStubModal } from '@/components/paystub/PayStubModal';
import ContractorInvoiceDialog from './ContractorInvoiceDialog';
import LockToggleConfirmDialog, { deriveFirstName } from '@/components/payroll/LockToggleConfirmDialog';
import ProcessorCard from './ProcessorCard';
import AnimatedNumber from './AnimatedNumber';
import DispatchLoader from './DispatchLoader';
import { PROCESSORS, DISPATCH_PROCESSORS, parseCyclePeriodFromFile, formatCycleLabelFromFile, type ArrearsInfo, type ExcludedRow, type ProcessorId, type QueueRow } from './mock-queue';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import type { CycleCloseoutRecord } from '@/lib/payroll/cycle-closeout';
import {
  buildFinalCloseoutCsv,
  buildPrematureSnapshotWorkbook,
  closeReportFilename,
  downloadCsvFile,
  downloadWorkbookFile,
  projectPaidDetailRows,
  type PrematureUnpaidRow,
  type UnpaidAmountSource,
} from '@/lib/payroll/cycle-close-report-export';
import { useDispatchQueue } from './useDispatchQueue';
import NotificationsPanel from '@/components/notifications/NotificationsPanel';
import { useDispatchLock } from '@/hooks/useDispatchLock';
import { useWizardDispatchLock } from '@/hooks/useWizardDispatchLock';
import { usePaymentsLivePublisher } from '@/hooks/usePaymentsLive';

type TabId = 'all' | 'cop' | 'urgent' | 'done' | 'excluded' | 'orphanage' | 'notifications' | ProcessorId;

interface ProcessorVisual {
  Icon: React.ComponentType<{ className?: string }>;
  /** Solid icon-tile gradient. */
  accent: string;
  /** Active card glow gradient (background tint). */
  glow: string;
  blurb: string;
  /** Real brand logo (in /public) — shown on a white tile in place of the icon. */
  logoSrc?: string;
}

const PROCESSOR_VISUALS: Record<ProcessorId, ProcessorVisual> = {
  hurupay: {
    Icon: Coins,
    accent: 'from-orange-500 to-amber-500',
    glow: 'from-orange-100/80 via-amber-50/60 to-white dark:from-orange-950/40 dark:via-amber-950/30 dark:to-zinc-900',
    blurb: 'Email only',
    logoSrc: '/hurupay.png',
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
    logoSrc: '/higlobe.png',
  },
  wise: {
    Icon: Wallet2,
    accent: 'from-green-500 to-lime-500',
    glow: 'from-green-100/80 via-lime-50/60 to-white dark:from-green-950/40 dark:via-lime-950/30 dark:to-zinc-900',
    blurb: 'Email or tag',
    logoSrc: '/wise.png',
  },
  jeeves: {
    Icon: Wifi,
    accent: 'from-amber-500 to-yellow-600',
    glow: 'from-amber-100/80 via-yellow-50/60 to-white dark:from-amber-950/40 dark:via-yellow-950/30 dark:to-zinc-900',
    blurb: 'Phone + wire',
    logoSrc: '/jeeves.png',
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

/** Eased spring-like tween shared by the "focus mode" layout shifts so the
 *  sidebar retract, KPI shrink, and table growth all read as one motion. */
const FOCUS_TRANSITION = { duration: 0.7, ease: [0.22, 1, 0.36, 1] as const };

/** True at the `lg` breakpoint and up — the only place the two-column grid
 *  (and therefore the sidebar-retract focus animation) exists. Below lg the
 *  layout is a plain flex column, so focus mode is a no-op there. */
function useIsLgUp() {
  const [isLgUp, setIsLgUp] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsLgUp(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return isLgUp;
}

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
  const {
    rows: fetched,
    excluded,
    paid,
    deptByEmail,
    period,
    wizardReady,
    loading,
    error,
    contractorError,
    contractorAdvisory,
    valuesWarning,
    refresh,
  } = useDispatchQueue(selectedSourceFile);
  const viewingPastWeek = selectedSourceFile != null;
  const { state: lockState, setLocked } = useDispatchLock();
  const isLgUp = useIsLgUp();
  // "Focus mode" — once processing has started (lock on) at lg+, retract the
  // processor sidebar and condense the KPI strip so the queue table gets the
  // full width/height. The clerk is heads-down logging payments now, so the
  // filter rail and big hero stats are just chrome in the way.
  const focusMode = lockState.locked && isLgUp;
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
  // `null` = not yet known (initial load). We fetch the urgent count up-front
  // (see effect below) so the Urgent card can hide itself when the queue is
  // empty, even before the tab is ever opened. `UrgentPaymentsQueue` keeps this
  // fresh via `onCountChange` once it mounts.
  const [urgentCount, setUrgentCount] = useState<number | null>(null);
  // Urgent payouts ALREADY dispatched this Sun→Sat week (paid / not paid /
  // threshold / problem). Keeps the Urgent card visible after the last pending
  // item is paid — the bucket persists for the week like every other bucket,
  // it just reads 0 pending. `null` = not yet known.
  const [urgentDispatchedCount, setUrgentDispatchedCount] = useState<number | null>(null);
  // Which employee's pay statement is open in the read-only viewer modal (accounting
  // can open any payee's stub without downloading). null = closed.
  const [viewPaystub, setViewPaystub] = useState<{ sourceFile: string; email: string } | null>(null);
  // Contractor rows open their INVOICE instead — see `handleViewPaystub`. null = closed.
  const [viewInvoice, setViewInvoice] = useState<{
    invoiceId: string;
    name: string;
    invoiceNumber: string | null;
  } | null>(null);
  const [confirmingLockToggle, setConfirmingLockToggle] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  // ── Close Pay Cycle (the Stop dialog's toggle) ──────────────────────────────
  // Off by default, EVERY time the dialog opens: closing a week writes a
  // permanent record that can't be re-filed, so it must be a deliberate act, not
  // a setting that quietly stays on from last week.
  const [closeCycleOn, setCloseCycleOn] = useState(false);
  // The Stop dialog's "download a report" checkbox. Default ON each open
  // (Kane: "it should just ask me to download") — unlike the close toggle,
  // a download is harmless to repeat, so the friendly default is offered.
  const [downloadReportOn, setDownloadReportOn] = useState(true);
  // Source files that already carry a close-out record. `null` = not loaded yet.
  const [closedCycles, setClosedCycles] = useState<Set<string> | null>(null);
  // When the Start/Prepare modal closes, fade out the "stage prepped" sound so
  // the long clip doesn't keep playing behind the dashboard. Runs on the
  // open→closed transition (covers success + any dismissal path).
  useEffect(() => {
    if (!confirmingLockToggle) stopStagePrepped();
    // Closing a cycle is never sticky — every visit to this dialog starts off.
    // The download checkbox resets too, back to its friendly ON.
    if (!confirmingLockToggle) {
      setCloseCycleOn(false);
      setDownloadReportOn(true);
    }
  }, [confirmingLockToggle]);
  // Unknown (`null`, the fetch hasn't landed or failed) reads as NOT closed: the
  // server refuses a duplicate anyway, so the honest failure is "you tried and
  // were told it already exists", not a UI that hides the control.
  const cycleAlreadyClosed = Boolean(
    period.sourceFile && closedCycles?.has(period.sourceFile),
  );
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

  // Fetch the urgent count once up-front so the Urgent card can hide itself when
  // there's nothing pending — the card renders regardless of the active tab, but
  // `UrgentPaymentsQueue` (the authoritative source via onCountChange) only
  // mounts once its tab is open. Mirror its count: pending MESA disbursements +
  // approved orphanage budget requests. Best-effort — on any failure we leave
  // the count unknown (card stays visible) rather than hiding a real queue.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [mesaRes, orphRes, dispatchedRes] = await Promise.all([
          fetch('/api/urgent-payments', { cache: 'no-store' }),
          fetch('/api/orphanage-dispatches?pending=1', { cache: 'no-store' }),
          fetch('/api/urgent-payments/dispatches', { cache: 'no-store' }),
        ]);
        if (!mesaRes.ok) throw new Error(`HTTP ${mesaRes.status}`);
        const mesaJson = (await mesaRes.json()) as { rows?: unknown[]; error?: string };
        if (mesaJson.error) throw new Error(mesaJson.error);
        const mesaCount = mesaJson.rows?.length ?? 0;

        let budgetCount = 0;
        try {
          const orphJson = (await orphRes.json()) as {
            items?: { sourceType?: string }[];
            error?: string;
          };
          if (orphRes.ok && !orphJson.error) {
            budgetCount = (orphJson.items ?? []).filter((i) => i.sourceType === 'budget_request').length;
          }
        } catch {
          /* ignore — budget section silently omitted, matches UrgentPaymentsQueue */
        }
        if (!cancelled) setUrgentCount(mesaCount + budgetCount);

        // This week's already-dispatched urgents — best-effort, same contract:
        // on failure the count stays unknown and the card stays visible.
        try {
          const dispatchedJson = (await dispatchedRes.json()) as { rows?: unknown[]; error?: string };
          if (dispatchedRes.ok && !dispatchedJson.error && !cancelled) {
            setUrgentDispatchedCount(dispatchedJson.rows?.length ?? 0);
          }
        } catch {
          /* leave dispatched count unknown */
        }
      } catch {
        /* leave count unknown so the card stays visible */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Whether to show the Urgent card at all. Shown while either count is still
  // unknown (initial load) to avoid a flash, whenever there's ≥1 pending, AND
  // whenever this week already saw urgent dispatches — paying the last pending
  // item must not make the bucket disappear; it persists for the week (with its
  // Paid / Not paid views) like every other bucket, just reading 0 pending.
  const showUrgentCard =
    urgentCount == null ||
    urgentCount > 0 ||
    urgentDispatchedCount == null ||
    urgentDispatchedCount > 0;

  // Only bounce off the Urgent tab when the bucket is truly empty for the week
  // (no pending AND nothing dispatched) — i.e. when the card itself is about to
  // hide, so we don't strand the clerk on a hidden tab. A freshly paid queue
  // keeps the tab open on its dispatch-log views.
  useEffect(() => {
    if (activeTab === 'urgent' && urgentCount === 0 && urgentDispatchedCount === 0) {
      setActiveTab('all');
    }
  }, [activeTab, urgentCount, urgentDispatchedCount]);

  // COP-paid people (Colombian staff on COP-denominated structures) are carved
  // OUT of the processor tabs and paid separately in their own currency tab —
  // each person appears in exactly one place, so there's no double-paying.
  // USD-denominated people never reach `pending` at all: useDispatchQueue holds
  // them in Excluded under `usd_paid`, so they're off this screen's counters
  // entirely. The filter here is belt-and-braces against a stale sessionStorage
  // queue cached before that change.
  const copPending = useMemo(() => pending.filter((r) => r.payCurrency === 'COP'), [pending]);
  const mainPending = useMemo(() => pending.filter((r) => r.payCurrency === 'PHP'), [pending]);

  const counts = useMemo(() => {
    const result: Record<ProcessorId, number> = {
      hurupay: 0,
      wepay: 0,
      higlobe: 0,
      wise: 0,
      jeeves: 0,
      wires: 0,
    };
    for (const row of mainPending) result[row.processor] += 1;
    return result;
  }, [mainPending]);

  const totalPending = mainPending.length;
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
  //
  // Counted as SETTLEMENTS, not people, because `pending` is one row per payment
  // and a contractor has one row per invoice. Distinct emails for employees (a
  // person can hold several dispatch rows for one cycle) plus one per contractor
  // invoice — otherwise paying 4 of Claire's 7 invoices would collapse to a single
  // "paid" while `pending` shed 4, so the progress strip, the Pending card and the
  // CEO tile would all drift while `totalSent` counted 4.
  const distinctPaidCount = useMemo(() => {
    const employeeEmails = new Set<string>();
    let contractorSettlements = 0;
    for (const p of paidRows) {
      if ((p.payee_type ?? 'employee') === 'contractor') contractorSettlements += 1;
      else employeeEmails.add(p.recipient_email.trim().toLowerCase());
    }
    return employeeEmails.size + contractorSettlements;
  }, [paidRows]);
  /**
   * People who left the pending queue WITHOUT being paid, counted per outcome.
   *
   * Both statuses are locked out of pending (see useDispatchQueue's
   * `lockedEmails`) while nobody has been paid, so they stay in the progress
   * DENOMINATOR — otherwise marking the last few stuck or held payments would
   * flip the strip to "everyone paid" with the money still owed.
   *
   * `blocked` = Problem (stuck, needs fixing). `held` = Threshold (deliberately
   * under the payout minimum this week). They're separate because the strip names
   * them differently — "flagged problem" is wrong copy for a deliberate hold —
   * and because they're the two reasons a week can't read 100%.
   */
  const { blockedCount, heldCount, blockedEmails, heldEmails } = useMemo(() => {
    // Someone flagged/held and then paid anyway (the marker row left in place) is
    // already counted as paid — never count them twice.
    const settled = new Set(
      paidRows
        .filter((p) => (p.payee_type ?? 'employee') !== 'contractor')
        .map((p) => p.recipient_email.trim().toLowerCase()),
    );
    const blocked = new Set<string>();
    const held = new Set<string>();
    for (const p of paid) {
      if (p.status !== 'problem' && p.status !== 'threshold') continue;
      // A contractor problem/threshold marker leaves its invoice payable (the API
      // only claims an invoice on 'paid'), so that row is STILL in `pending` —
      // adding it here would count the same money in the denominator twice.
      if ((p.payee_type ?? 'employee') === 'contractor') continue;
      const email = p.recipient_email.trim().toLowerCase();
      if (settled.has(email)) continue;
      if (p.status === 'problem') blocked.add(email);
      else held.add(email);
    }
    // A person carrying both markers is one head in the denominator: Problem wins,
    // since it's the outcome that still needs work.
    for (const email of blocked) held.delete(email);
    // The SETS travel with the counts on purpose: the cycle close-out has to name
    // these people, and a second pass re-deriving "who is blocked" would be a
    // second implementation of the superseded-marker rule, free to drift from the
    // number on the progress strip.
    return {
      blockedCount: blocked.size,
      heldCount: held.size,
      blockedEmails: blocked,
      heldEmails: held,
    };
  }, [paid, paidRows]);
  usePaymentsLivePublisher({
    enabled:
      !viewingPastWeek && wizardReady && hydrated && !loading && Boolean(period.sourceFile),
    sourceFile: period.sourceFile,
    label: period.sourceFile ? formatCycleLabelFromFile(period.sourceFile) : 'Current pay week',
    // Problem-flagged and Threshold-held people count in `total` (still owed, just
    // out of the queue) but not in `remaining` (they're no longer in the queue
    // Lenny can send from), so the CEO tile and this screen share one denominator.
    total: pending.length + distinctPaidCount + blockedCount + heldCount,
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
  // One universe for the progress strip + the KPI fractions: people still to
  // pay (ALL currencies) + people already paid + people blocked on a problem +
  // people held under the payout threshold — the same numbers broadcast to the
  // CEO live card above, so every surface tells one story. "Started" is what the
  // week began with; it shrinks/grows only if the queue itself does.
  const startedCount = pending.length + distinctPaidCount + blockedCount + heldCount;
  const paidPct = startedCount > 0 ? Math.round((distinctPaidCount / startedCount) * 100) : 0;
  // The week's full dollar bill = what already went out + what's still owed.
  const totalWeekUSD = totalPaidUSD + totalPendingUSD;

  // ── 100% paid → celebrate the Accounting team ───────────────────────────────
  // When the strip genuinely reaches 100% (nothing pending, nobody blocked or
  // held, ≥1 paid), report it so the server can email every accounting-role holder a
  // confetti congratulations via the `payment_cycle_complete` n8n webhook. The
  // SERVER owns the once-per-cycle guarantee (an atomic app_settings claim), so
  // any number of browsers/reloads can report the same completion and the team
  // still gets exactly one email. Client-side we only keep the noise down: one
  // attempt per source file per mount, and a PAST week celebrates only when this
  // session actually watched its queue finish — opening an old fully-paid CSV
  // must not toast it.
  const celebrateAttemptedRef = useRef<Set<string>>(new Set());
  const sawIncompleteRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sourceFile = period.sourceFile;
    if (!sourceFile || loading || !hydrated || !wizardReady || error || contractorError) return;
    // Threshold holds count here too: money is still owed on those people, so a
    // week carrying one hasn't finished paying — the confetti would be a lie.
    if (pending.length > 0 || blockedCount > 0 || heldCount > 0) {
      sawIncompleteRef.current.add(sourceFile);
      return;
    }
    if (distinctPaidCount === 0 || startedCount === 0) return;
    if (viewingPastWeek && !sawIncompleteRef.current.has(sourceFile)) return;
    if (celebrateAttemptedRef.current.has(sourceFile)) return;
    celebrateAttemptedRef.current.add(sourceFile);
    const totalPaidPHP = paidRows.reduce((sum, r) => sum + (r.amount_php ?? 0), 0);
    void fetch('/api/payment-dispatches/cycle-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_file: sourceFile,
        cycle_id: period.cycleId,
        label: formatCycleLabelFromFile(sourceFile),
        period_start: period.start,
        period_end: period.end,
        paid_count: distinctPaidCount,
        total_count: startedCount,
        total_paid_usd: totalPaidUSD,
        total_paid_php: totalPaidPHP,
      }),
    })
      .then((res) => {
        // Auth/validation failures won't heal on retry; only transient server
        // trouble (5xx) earns another attempt on the next state change.
        if (!res.ok && res.status >= 500) celebrateAttemptedRef.current.delete(sourceFile);
      })
      .catch(() => {
        celebrateAttemptedRef.current.delete(sourceFile);
      });
  }, [
    period.sourceFile,
    period.cycleId,
    period.start,
    period.end,
    viewingPastWeek,
    loading,
    hydrated,
    wizardReady,
    error,
    contractorError,
    pending.length,
    blockedCount,
    heldCount,
    distinctPaidCount,
    startedCount,
    totalPaidUSD,
    paidRows,
  ]);

  // ── Cycle close-out ─────────────────────────────────────────────────────────
  // Which weeks already carry a close-out record, so the Stop dialog can say
  // "already closed" instead of offering to write a second one (the server
  // refuses either way — this is so the UI doesn't promise something it can't do).
  const loadClosedCycles = useCallback(async () => {
    try {
      const res = await fetch('/api/payment-dispatches/cycle-closeout');
      if (!res.ok) return;
      const json = (await res.json()) as {
        closeouts?: { source_file?: string }[];
        error?: string | null;
      };
      if (json.error) return;
      setClosedCycles(
        new Set((json.closeouts ?? []).map((c) => c.source_file ?? '').filter(Boolean)),
      );
    } catch {
      // Leave `null` (unknown). The dialog then hides the already-closed claim
      // rather than asserting a week is open when we couldn't check.
    }
  }, []);
  useEffect(() => {
    void loadClosedCycles();
  }, [loadClosedCycles]);

  /**
   * Payable people this cycle who have NOT been paid — the list a close-out
   * names, and the count its warning leads with.
   *
   * "Payable" is Kane's rule: the Excluded tab is deliberately out. Those people
   * are held on purpose (no bank, no rate, wizard-excluded, USD track), and
   * calling them "not paid" in a permanent record would turn a deliberate hold
   * into an apparent failure.
   *
   * Three ways to be payable-and-unpaid, matching the progress strip's own
   * denominator exactly: still in `pending` (never dispatched), flagged Problem,
   * or held at Threshold. The blocked/held sets come from the SAME memo that
   * feeds the strip, so this list can never disagree with the number on screen.
   */
  const unpaidPayable = useMemo(() => {
    const out: {
      name: string | null;
      email: string;
      payeeType: 'employee' | 'contractor';
      reason: 'pending' | 'problem' | 'threshold';
      amountUSD: number | null;
      amountPHP: number | null;
      processor: string | null;
    }[] = [];

    for (const r of pending) {
      out.push({
        name: r.name || null,
        email: r.email,
        payeeType: r.payeeKind === 'contractor' ? 'contractor' : 'employee',
        reason: 'pending',
        amountUSD: r.amountUSD,
        amountPHP: r.amountPHP,
        processor: r.processor,
      });
    }

    // Problem / Threshold people left the queue without being paid, so their
    // details come off the marker row rather than a pending row. Newest marker
    // wins (`paid` is ordered newest-first) — one entry per person.
    const seen = new Set(out.map((o) => o.email.trim().toLowerCase()));
    for (const p of paid) {
      const email = p.recipient_email.trim().toLowerCase();
      if (seen.has(email)) continue;
      const isBlocked = blockedEmails.has(email);
      const isHeld = heldEmails.has(email);
      if (!isBlocked && !isHeld) continue;
      seen.add(email);
      out.push({
        name: p.recipient_name || null,
        email,
        payeeType: (p.payee_type ?? 'employee') === 'contractor' ? 'contractor' : 'employee',
        reason: isBlocked ? 'problem' : 'threshold',
        amountUSD: p.amount_usd ?? null,
        amountPHP: p.amount_php ?? null,
        processor: p.processor ?? null,
      });
    }
    return out;
  }, [pending, paid, blockedEmails, heldEmails]);

  const unpaidPayablePHP = useMemo(
    () => unpaidPayable.reduce((sum, r) => sum + (r.amountPHP ?? 0), 0),
    [unpaidPayable],
  );

  const visibleRows = useMemo(() => {
    if (activeTab === 'all') return mainPending;
    if (PROCESSORS.some((p) => p.id === activeTab)) {
      return mainPending.filter((r) => r.processor === activeTab);
    }
    return [];
  }, [mainPending, activeTab]);

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
  // Open an employee's staged pay statement in the modal (read-only). Both the
  // row's work email and the operative week's source_file are in scope here.
  /**
   * "View" on a queue row → the document that payment is made against.
   *
   * A CONTRACTOR row settles an approved invoice, so it opens that invoice, not a
   * pay statement: contractors have no rates row and no staged paystub, so the
   * paystub viewer could only ever tell the clerk "no pay statement available".
   * Keyed off `payeeKind` — the settlement signal — and never off the fuchsia
   * Contractor badge, which also rides hourly-payroll rows belonging to
   * contractor-role holders (see ContractorChip). Those rows genuinely do have a
   * paystub and keep it.
   *
   * Both documents are pay-period scoped: the statement by `period.sourceFile`,
   * the invoice by being the one THIS row settles (and the contractor queue only
   * carries invoices billed inside the period — see loadContractorDispatchRows).
   */
  const handleViewPaystub = useCallback(
    (row: QueueRow) => {
      if (row.payeeKind === 'contractor') {
        if (!row.contractorInvoiceId) {
          toast.error('No invoice on this row', {
            description: 'This contractor payment has no linked invoice to open.',
          });
          return;
        }
        setViewInvoice({
          invoiceId: row.contractorInvoiceId,
          name: row.name,
          invoiceNumber: row.invoiceNumber ?? null,
        });
        return;
      }
      if (!period.sourceFile) {
        toast.error('No pay week selected', {
          description: 'Pick a locked pay week first, then open a statement.',
        });
        return;
      }
      setViewPaystub({ sourceFile: period.sourceFile, email: row.email });
    },
    [period.sourceFile],
  );
  /**
   * Excluded-tab "View" → the same pay statement the Pending worksheet opens.
   * Takes an ExcludedRow rather than a QueueRow because a non-payable row (no
   * bank / no rate) has no `payable` QueueRow to hand over — only the email, which
   * is all the statement reader needs. Contractor rows are filtered out at the
   * button, so this path is always an employee statement.
   */
  const handleViewExcludedPaystub = useCallback(
    (row: ExcludedRow) => {
      if (!period.sourceFile) {
        toast.error('No pay week selected', {
          description: 'Pick a locked pay week first, then open a statement.',
        });
        return;
      }
      setViewPaystub({ sourceFile: period.sourceFile, email: row.email });
    },
    [period.sourceFile],
  );
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
    // A contractor row settles ONE invoice in the cycle being viewed, so it never
    // takes the multi-cycle arrears path — that loop would POST the same
    // contractor_invoice_id once per held cycle and every attempt after the first
    // would 409 on the claim guard.
    //
    // Gated on the INVOICE LINK, never on the badge: `contractorRole` marks people
    // who hold the contractor role but are being paid ordinary hourly payroll, and
    // treating them as invoice settlements would 400 every one of their payments.
    const isContractorRow = !!row.contractorInvoiceId;
    const cycles =
      arrears && arrears.cycles.length > 0 && !isContractorRow
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
    // Payment Catalog system bonus (PAB / Tech) — `row` was priced for THIS
    // period only, so the breakdown is only meaningful on the leg that matches
    // it (mirrors the contractor_invoice_id gate below). Older arrears legs
    // don't recompute their own historical bonus, so they carry none.
    //
    // These two values are FROZEN onto `payment_dispatches` and are what the Paid
    // tab's chip reads forever, so they must be the wizard's own figures — the row
    // now carries them (`valuesSource`), where it used to carry a PAB/Tech-only
    // recomputation that read ₱0 for everyone paid a dept/KPI bonus. When the
    // itemization is genuinely UNKNOWN nothing is written rather than a ₱0 claim.
    const systemBonusParts: string[] = [];
    if (row.pabBonusPHP > 0) systemBonusParts.push(`PAB ₱${row.pabBonusPHP.toLocaleString('en-PH')}`);
    if (row.techBonusPHP > 0) systemBonusParts.push(`Tech ₱${row.techBonusPHP.toLocaleString('en-PH')}`);
    const systemBonusPhp =
      row.breakdownUnavailable || row.bonusTotalPHP === 0 ? null : row.bonusTotalPHP;
    const systemBonusLabel =
      row.breakdownUnavailable ? null : systemBonusParts.length > 0 ? systemBonusParts.join(' + ') : null;
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
            // Contractor settlement. Only sent on the leg that matches the cycle
            // being viewed, so no arrears fan-out can claim the same invoice twice.
            payee_type: isContractorRow ? 'contractor' : 'employee',
            contractor_invoice_id:
              isContractorRow && c.sourceFile === period.sourceFile ? row.contractorInvoiceId ?? null : null,
            system_bonus_php: c.sourceFile === period.sourceFile ? systemBonusPhp : null,
            system_bonus_label: c.sourceFile === period.sourceFile ? systemBonusLabel : null,
          }),
        });
        const json = (await res.json()) as {
          row?: unknown;
          error?: string;
          paystub?: {
            staged: boolean;
            sent: boolean;
            error: string | null;
            amount_mismatch?: { paid: number; stub: number };
          };
        };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        paidCycles += 1;
        const ps = json.paystub;
        if (ps?.sent) sent += 1;
        else if (ps?.staged && ps?.error) {
          failedSend += 1;
          lastSendError = ps.error;
        } else if (ps && !ps.staged) notStaged += 1;
        // The server reconciles the emailed stub against the recorded payment;
        // when neither the fresh nor the staged figures matched the money, warn
        // immediately — the row is flagged in the audit log for follow-up.
        if (ps?.amount_mismatch) {
          const fmtPhp = (n: number) =>
            `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          toast.warning(`${row.name}: paystub total differs from the amount paid`, {
            description: `Paid ${fmtPhp(ps.amount_mismatch.paid)} but the statement says ${fmtPhp(ps.amount_mismatch.stub)}. Re-check this week in the Payroll Wizard.`,
          });
        }
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
    } else if (notStaged && !isContractorRow) {
      // Contractors are paid off an invoice and never have a staged paystub, so
      // this warning (and its "lock in this cycle" advice) would be wrong on
      // every contractor payment — they fall through to the plain success toast.
      toast.warning(`${row.name} marked paid — no staged paystub to email`, {
        description: 'Lock in this cycle from the Payroll Wizard to enable paystub emails.',
      });
    } else if (isContractorRow) {
      toast.success(`${row.name} marked paid`, {
        icon: '✨',
        description: row.invoiceNumber ? `Invoice ${row.invoiceNumber} settled.` : undefined,
      });
    } else {
      toast.success(`${row.name} marked paid`, { icon: '✨' });
    }
  };

  /**
   * Contractor invoices failed to load. NOT an error state for the whole screen —
   * employee payroll is unaffected — but it must be visible: otherwise a missing
   * migration or a failed read looks exactly like "no approved invoices" and real
   * money is silently absent from a queue that appears healthy.
   */
  const contractorErrorBanner = contractorError ? (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong className="font-semibold">Contractor invoices could not be loaded</strong> — approved
        invoices are NOT shown in this queue. Employee payroll below is unaffected.
        <span className="ml-1 font-mono opacity-80">{contractorError}</span>
      </span>
    </div>
  ) : null;

  /**
   * The contractor half loaded FINE but something needs attention (invoices stuck
   * mid-dispatch). Deliberately distinct copy from the failure banner above: saying
   * "could not be loaded" here would tell the clerk the opposite of the truth and
   * could push them to pay out of band.
   */
  const contractorAdvisoryBanner = contractorAdvisory ? (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-fuchsia-300/70 bg-fuchsia-50 px-3 py-2 text-[11px] text-fuchsia-900 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-200">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong className="font-semibold">Contractor invoices need attention</strong>{' '}
        {contractorAdvisory}
      </span>
    </div>
  ) : null;

  /**
   * The amounts on screen are not the Payroll Wizard's for at least one payee.
   *
   * Rose, not amber, and above the contractor banners: everything else on this
   * screen can be wrong and be fixed later, but sending the wrong AMOUNT cannot be
   * undone. The wizard's figures used to degrade silently to a recomputation that
   * excludes Adjustments, Orphanage pay, KPI/dept bonuses and MESA — a queue that
   * looked perfectly healthy while quoting numbers payroll never approved.
   */
  const valuesWarningBanner = valuesWarning ? (
    <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-[11px] text-rose-900 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <strong className="font-semibold">Check these amounts against the Payroll Wizard</strong>{' '}
        {valuesWarning}
      </span>
    </div>
  ) : null;

  const renderBody = () => {
    // Show the skeleton while the network is still in flight OR while we
    // haven't mirrored the first server snapshot into local state yet.
    if (activeTab === 'notifications') return <NotificationsPanel viewerEmail={session?.user?.email} accent="zinc" view="accounting" />;
    if (activeTab === 'orphanage') return <OrphanageQueue />;
    if (activeTab === 'urgent') {
      return (
        <UrgentPaymentsQueue
          onCountChange={setUrgentCount}
          onDispatchedCountChange={setUrgentDispatchedCount}
        />
      );
    }
    if (error) return <ErrorState message={error} />;
    if (loading || !hydrated) return <DispatchLoader />;
    if (!cycleReady) return <NoCycleState />;
    // No queue data until accounting locks + stages this cycle from the wizard.
    if (!wizardReady) return <WizardNotReadyState period={period} />;
    if (activeTab === 'done') {
      return (
        <DoneQueue
          records={paid}
          deptByEmail={deptByEmail}
          periodStart={period.start}
          periodEnd={period.end}
          onRefresh={refresh}
        />
      );
    }
    if (activeTab === 'excluded') {
      return (
        <ExcludedQueue
          rows={excluded}
          onMarkPaid={handleOpenExcludedMarkPaid}
          onViewPaystub={handleViewExcludedPaystub}
          txnRecords={paid}
        />
      );
    }
    if (activeTab === 'cop') {
      return (
        <ProcessorQueue
          processor={null}
          rows={copPending}
          onMarkPaid={handleOpenMarkPaid}
          onViewPaystub={handleViewPaystub}
          periodStart={period.start}
          periodEnd={period.end}
          onRefresh={refresh}
          nativeCurrency="COP"
          txnRecords={paid}
          deptByEmail={deptByEmail}
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
        onViewPaystub={handleViewPaystub}
        periodStart={period.start}
        periodEnd={period.end}
        onRefresh={refresh}
        // "All pending" gets the full dispatch log so its in-table tabs (Paid /
        // Not paid / Threshold / Problem) span every processor; each processor
        // tab stays scoped to its own dispatches.
        paidRecords={activeTab === 'all' ? paid : paidByProcessor[activeTab]}
        deptByEmail={deptByEmail}
      />
    );
  };

  /**
   * Fetch the FILED close-out record and download its FINAL CSV (record-only).
   * The retry path behind the failure toasts — the Stop dialog itself is
   * unreachable once processing has stopped (it reopens on the Start side), so
   * a toast that pointed there would be promising a door that no longer exists.
   */
  const downloadFiledRecord = async (sourceFile: string): Promise<void> => {
    try {
      const res = await fetch(
        `/api/payment-dispatches/cycle-closeout?source_file=${encodeURIComponent(sourceFile)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        closeout?: CycleCloseoutRecord | null;
        error?: string | null;
      };
      if (!res.ok || json.error || !json.closeout) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      generateCloseReportSafe({
        kind: 'final',
        record: json.closeout,
        livePaidRows: null,
        generatedAt: new Date(),
      });
    } catch (e) {
      console.warn('[cycle-close-report] filed-record fetch failed:', e);
      toast.error('Could not fetch the filed close-out record.', {
        action: { label: 'Retry', onClick: () => void downloadFiledRecord(sourceFile) },
      });
    }
  };

  /**
   * Build + download the requested close report. NEVER throws — a download
   * failure is toast-only and must not abort the stop, reorder the close-out
   * POST, or block `setLocked` (docs/features/cycle-closeout.md § ordering).
   */
  const generateCloseReportSafe = (
    model: Parameters<typeof buildFinalCloseoutCsv>[0] | Parameters<typeof buildPrematureSnapshotWorkbook>[0],
  ): void => {
    try {
      if (model.kind === 'final') {
        downloadCsvFile(
          closeReportFilename('final', model.record.label, model.generatedAt),
          buildFinalCloseoutCsv(model),
        );
      } else {
        downloadWorkbookFile(
          closeReportFilename('premature', model.label, model.generatedAt),
          buildPrematureSnapshotWorkbook(model),
        );
      }
    } catch (e) {
      console.warn('[cycle-close-report] build/download failed:', e);
      if (model.kind === 'final') {
        // The record is safely filed — offer a real retry (a fresh GET + build),
        // not directions to a dialog that reopens on the Start side.
        const sourceFile = model.record.source_file;
        toast.error('Report download failed — the close-out record itself is safely filed.', {
          action: { label: 'Retry download', onClick: () => void downloadFiledRecord(sourceFile) },
        });
      } else {
        toast.error('Snapshot download failed — nothing else was affected.');
      }
    }
  };

  /** The premature unpaid list: the unpaidPayable memo verbatim, plus per-row
   *  amount provenance off the pending queue. Keyed by (email, payee kind), not
   *  email alone — dual-identity payees (Claire: salary row + invoice rows on
   *  one email) would otherwise blank the RECOMPUTED warning on the salary row
   *  or stamp wizard provenance onto invoice amounts the wizard never priced.
   *  Contractor invoice rows deliberately carry no valuesSource, and marker
   *  (problem/threshold) rows aren't in `pending` at all → both stay blank. */
  const buildPrematureUnpaidRows = (): PrematureUnpaidRow[] => {
    const sourceByIdentity = new Map<string, UnpaidAmountSource | null>(
      pending.map((r) => [
        `${r.email.trim().toLowerCase()}|${r.payeeKind === 'contractor' ? 'contractor' : 'employee'}`,
        r.valuesSource ?? null,
      ]),
    );
    return unpaidPayable.map((p) => ({
      ...p,
      amountSource:
        sourceByIdentity.get(`${p.email.trim().toLowerCase()}|${p.payeeType}`) ?? null,
    }));
  };

  const handleLockToggle = async () => {
    if (togglingLock) return;
    setTogglingLock(true);
    const goingLocked = !lockState.locked;
    const closingCycle = !goingLocked && closeCycleOn && !cycleAlreadyClosed && Boolean(period.sourceFile);
    // Read the checkbox at confirm time, same caller-owned channel as closeCycleOn.
    // Only meaningful on a STOP with a real cycle on screen (the dialog withholds
    // the block otherwise, so the state can only be stale-true — guard anyway).
    const wantsReport =
      !goingLocked && downloadReportOn && !viewingPastWeek && Boolean(period.sourceFile);
    // Fire the "stage prepped" alert the instant Start is confirmed — synced
    // with the optimistic retract + the Preparing Dispatch scene. Start only.
    if (goingLocked) playStagePrepped();
    // Minimum on-screen time for the "Preparing Dispatch…" scene so it plays
    // gracefully instead of flashing by when the optimistic POST returns fast.
    const minShow = new Promise((r) => setTimeout(r, 1600));
    try {
      // ── Close-out BEFORE the lock flips ─────────────────────────────────────
      // The record is the part that can't be re-done: once processing has
      // stopped, the clerk has no second chance to file it from this dialog. So
      // if the write fails, nothing else happens and the error is loud — they
      // can retry, or switch the toggle off and stop plainly.
      if (closingCycle) {
        const res = await fetch('/api/payment-dispatches/cycle-closeout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source_file: period.sourceFile,
            cycle_id: period.cycleId,
            label: period.sourceFile ? formatCycleLabelFromFile(period.sourceFile) : null,
            period_start: period.start,
            period_end: period.end,
            unpaid: unpaidPayable,
          }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          already?: boolean;
          error?: string | null;
          closeout?: CycleCloseoutRecord | null;
        };
        if (!res.ok || json.error) {
          throw new Error(
            json.error ??
              `Could not close the pay cycle (${res.status}). Processing was NOT stopped — turn the toggle off to stop without closing.`,
          );
        }
        if (period.sourceFile) {
          const closed = period.sourceFile;
          setClosedCycles((prev) => new Set(prev ?? []).add(closed));
        }
        toast.success(
          json.already
            ? 'This pay cycle was already closed — no second record written'
            : `Pay cycle closed — close-out record filed${
                unpaidPayable.length > 0
                  ? ` with ${unpaidPayable.length} unpaid ${unpaidPayable.length === 1 ? 'person' : 'people'}`
                  : ''
              }`,
          { icon: '🗄️' },
        );
        // ── FINAL report download ─────────────────────────────────────────────
        // Rendered VERBATIM from the server-computed record in the response —
        // never a client tally (docs/features/cycle-closeout.md). On
        // `already:true` the response carries the ORIGINAL record, so the file
        // shows the original closer, never this click. Non-throwing: a download
        // problem cannot abort the setLocked below.
        if (wantsReport) {
          if (json.closeout) {
            generateCloseReportSafe({
              kind: 'final',
              record: json.closeout,
              // Live per-payee paid rows, behind the mandatory disclosure — the
              // record itself stores totals only, by design.
              livePaidRows: json.already ? null : projectPaidDetailRows(paid),
              generatedAt: new Date(),
            });
          } else {
            const sf = period.sourceFile;
            toast.error('The close succeeded but the report payload was missing.', {
              action: sf
                ? { label: 'Download filed record', onClick: () => void downloadFiledRecord(sf) }
                : undefined,
            });
          }
        }
      }
      await Promise.all([setLocked(goingLocked), minShow]);
      toast.success(
        goingLocked
          ? 'Processing started — employee issues are paused'
          : 'Processing stopped — employees can file issues again',
        { icon: goingLocked ? '🔒' : '🔓' },
      );
      // ── PREMATURE snapshot download (stopped WITHOUT closing) ───────────────
      // Fire-and-forget AFTER the stop already went through, so the best-effort
      // GET below can never delay or abort setLocked. If a close-out record
      // already exists for this week (an earlier stop here, or another session),
      // the FILED record downloads instead — a file stamped NOT YET CLOSED about
      // a closed week would be the premature lie in the other direction. On GET
      // failure, unknown reads as not-closed and the premature label stands
      // (same rule as the dialog's already-closed state).
      if (wantsReport && !closingCycle) {
        const sourceFile = period.sourceFile ?? '';
        const label = sourceFile ? formatCycleLabelFromFile(sourceFile) : 'cycle';
        const paidSnapshot = projectPaidDetailRows(paid);
        const unpaidSnapshot = buildPrematureUnpaidRows();
        const distinctPaid = distinctPaidCount;
        const periodStart = period.start;
        const periodEnd = period.end;
        // The client's own closed-cycles list is a POSITIVE assertion — when it
        // says closed, "unknown reads as not-closed" does not apply and a
        // premature fallback would stamp NOT YET CLOSED on a closed week.
        const knownClosed = cycleAlreadyClosed;
        void (async () => {
          let filed: CycleCloseoutRecord | null = null;
          try {
            const res = await fetch(
              `/api/payment-dispatches/cycle-closeout?source_file=${encodeURIComponent(sourceFile)}`,
              { cache: 'no-store', signal: AbortSignal.timeout(4000) },
            );
            if (res.ok) {
              const json = (await res.json()) as {
                closeout?: CycleCloseoutRecord | null;
                error?: string | null;
              };
              if (!json.error) filed = json.closeout ?? null;
            }
          } catch {
            /* handled below: knownClosed fails honestly, otherwise premature stands */
          }
          if (filed) {
            if (!knownClosed) {
              toast.info(
                'This week already has a close-out — downloading the filed record instead of a snapshot.',
              );
            }
            generateCloseReportSafe({
              kind: 'final',
              record: filed,
              livePaidRows: null,
              generatedAt: new Date(),
            });
          } else if (knownClosed) {
            // The dialog promised the FILED record for an already-closed week.
            // Never substitute a live snapshot wearing a NOT YET CLOSED banner —
            // fail honestly, with a real retry.
            toast.error(
              'This week is already closed, but the filed record could not be fetched — no file was generated (a snapshot would wrongly say NOT YET CLOSED).',
              { action: { label: 'Retry', onClick: () => void downloadFiledRecord(sourceFile) } },
            );
          } else {
            // GET failure on a week with no known close-out: unknown reads as
            // not-closed (same rule as the dialog) and the premature label stands.
            generateCloseReportSafe({
              kind: 'premature',
              label,
              sourceFile,
              periodStart,
              periodEnd,
              generatedAt: new Date(),
              paidRows: paidSnapshot,
              distinctPaidCount: distinctPaid,
              unpaid: unpaidSnapshot,
            });
          }
        })();
      }
      // Close after success so the dialog gracefully animates out alongside
      // the parent state changes — feels like one motion, not two.
      setConfirmingLockToggle(false);
    } catch (e) {
      // On failure, still let the scene settle a beat before showing the error.
      await minShow.catch(() => {});
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
      <motion.div
        className={cn(
          'relative mt-4 flex flex-col gap-3 px-4 pb-6 sm:mt-6 sm:px-8 sm:pb-8',
          // lg+ becomes a 2-col / 2-row grid: banks span the left column full
          // height, stats top-right, table bottom-right. The actual track sizes
          // are driven by the animated inline style below so focus mode can
          // retract the sidebar / shrink the KPI row smoothly.
          'lg:min-h-0 lg:flex-1 lg:grid lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-4',
        )}
        // Two-column grid at lg+ (processor rail 255px — 75% of the original
        // 340px, so the table gets the reclaimed width — content fills the rest).
        // The rail/buckets stay visible during processing — focus mode shrinks
        // the KPI stats + retracts the app sidebar, but NOT the buckets.
        initial={false}
        animate={{ gridTemplateColumns: '255px minmax(0,1fr)' }}
        transition={FOCUS_TRANSITION}
      >
        {/* RIGHT TOP — Dispatch progress strip + hero stats. Order 1 on mobile
            so they sit above everything else. lg: top-right cell. */}
        <motion.div
          variants={containerStagger}
          initial="hidden"
          animate="visible"
          className="order-1 flex flex-col gap-2 sm:gap-3 lg:order-none lg:col-start-2 lg:row-start-1"
        >
          <DispatchProgress
            paid={distinctPaidCount}
            started={startedCount}
            remaining={pending.length}
            blocked={blockedCount}
            held={heldCount}
            pct={paidPct}
          />
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <HeroStat
              tone="orange"
              label="Pending"
              value={pending.length}
              over={startedCount > 0 ? startedCount.toLocaleString('en-US') : undefined}
              sub={pending.length === 1 ? 'person to pay' : 'people to pay'}
              Icon={Send}
              compact={focusMode}
            />
            <HeroStat
              tone="emerald"
              label="Sent"
              value={totalSent}
              sub={totalSent === 1 ? 'payment logged' : 'payments logged'}
              Icon={CheckCircle2}
              compact={focusMode}
            />
            <HeroStat
              tone="violet"
              label="Paid"
              value={totalPaidUSD}
              over={
                totalWeekUSD > 0
                  ? `$${Math.round(totalWeekUSD).toLocaleString('en-US')}`
                  : undefined
              }
              sub={
                totalSent === 0
                  ? 'no payments logged yet'
                  : totalPendingUSD > 0
                    ? `$${Math.round(totalPendingUSD).toLocaleString('en-US')} still owed`
                    : `all paid · ${totalSent} dispatch${totalSent === 1 ? '' : 'es'}`
              }
              Icon={Coins}
              currency
              compact={focusMode}
            />
          </div>
        </motion.div>

        {/* LEFT — Bank cards (filter rail). Order 2 on mobile (between stats
            and table); spans full height of left column on lg. The rail/buckets
            stay fully visible + interactive at all times, including during
            processing — focus mode does NOT retract them. */}
        <motion.div
          animate={{ opacity: 1, x: 0 }}
          transition={FOCUS_TRANSITION}
          className="order-2 flex min-h-0 flex-col gap-2 lg:order-none lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:overflow-hidden"
        >
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
            <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
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
            {showUrgentCard && (
              <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
                <ProcessorCard
                  label="Urgent"
                  subtitle={URGENT_VISUAL.blurb}
                  count={urgentCount ?? 0}
                  Icon={URGENT_VISUAL.Icon}
                  accent={URGENT_VISUAL.accent}
                  glow={URGENT_VISUAL.glow}
                  active={activeTab === 'urgent'}
                  onClick={() => setActiveTab('urgent')}
                  iconOnlyFallback
                  glowBorder
                />
              </motion.div>
            )}
            {DISPATCH_PROCESSORS.map((p) => {
              const v = PROCESSOR_VISUALS[p.id];
              return (
                <motion.div key={p.id} variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
                  <ProcessorCard
                    label={p.label}
                    subtitle={v.blurb}
                    count={counts[p.id] ?? 0}
                    Icon={v.Icon}
                    logoSrc={v.logoSrc}
                    accent={v.accent}
                    glow={v.glow}
                    active={activeTab === p.id}
                    onClick={() => setActiveTab(p.id)}
                  />
                </motion.div>
              );
            })}
            {copPending.length > 0 && (
              <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
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
            <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
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
            <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
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
            <motion.div variants={itemPop} className="w-[176px] shrink-0 lg:w-auto">
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
        </motion.div>

        {/* RIGHT BOTTOM — Table body. Order 3 on mobile, bottom-right cell on lg. */}
        <div className="relative order-3 min-h-[420px] overflow-hidden rounded-2xl border border-orange-100/80 bg-white/90 shadow-[0_8px_28px_-12px_rgba(255,138,76,0.18)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/80 lg:order-none lg:col-start-2 lg:row-start-2 lg:min-h-0 lg:flex-1">
          <AnimatePresence mode="wait">
            <motion.div
              key={
                activeTab === 'excluded' || activeTab === 'orphanage' || activeTab === 'urgent' || activeTab === 'cop'
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
              {/* Only over queue views — Urgent / Orphanage / Notifications
                  do not read the contractor source. */}
              {!['notifications', 'orphanage', 'urgent'].includes(activeTab) && (
                <>
                  {valuesWarningBanner}
                  {contractorErrorBanner}
                  {contractorAdvisoryBanner}
                </>
              )}
              {renderBody()}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>

      <MarkPaidDialog
        row={markPaidRow}
        onClose={handleCloseMarkPaid}
        onConfirm={handleConfirmPaid}
        onBankDetailsOverridden={refresh}
        position={
          galleryIdx != null
            ? { index: galleryIdx, total: gallerySiblings.length }
            : undefined
        }
        onPrev={handleGalleryPrev}
        onNext={handleGalleryNext}
      />
      <PayStubModal
        open={viewPaystub != null}
        sourceFile={viewPaystub?.sourceFile ?? null}
        email={viewPaystub?.email ?? null}
        onClose={() => setViewPaystub(null)}
      />
      {/* Contractor rows settle an invoice, so their "View" opens the invoice. */}
      <ContractorInvoiceDialog
        invoiceId={viewInvoice?.invoiceId ?? null}
        name={viewInvoice?.name}
        invoiceNumber={viewInvoice?.invoiceNumber}
        onClose={() => setViewInvoice(null)}
      />
      <LockToggleConfirmDialog
        open={confirmingLockToggle}
        locked={lockState.locked}
        submitting={togglingLock}
        firstName={firstName}
        onClose={() => setConfirmingLockToggle(false)}
        onConfirm={handleLockToggle}
        // Only Payment Dispatch offers the close-out; the Payroll Wizard renders
        // this same dialog without it. Withheld while viewing a past week (the
        // Stop button is disabled there anyway) and with no cycle loaded, since
        // there'd be nothing to key the record to.
        closeOut={
          viewingPastWeek || !period.sourceFile
            ? undefined
            : {
                enabled: closeCycleOn,
                onEnabledChange: setCloseCycleOn,
                alreadyClosed: cycleAlreadyClosed,
                cycleLabel: formatCycleLabelFromFile(period.sourceFile),
                unpaidCount: unpaidPayable.length,
                unpaidPHP: unpaidPayablePHP,
                paidCount: distinctPaidCount,
                paidUSD: totalPaidUSD,
                downloadReport: downloadReportOn,
                onDownloadReportChange: setDownloadReportOn,
              }
        }
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

/** Wizard-style progress strip pinned above the KPI cards — fills as payments
 *  go out (people paid / people the week started with) and flips emerald once
 *  the queue is clear. Same visual language as the Payroll Wizard's bar. */
function DispatchProgress({
  paid,
  started,
  remaining,
  blocked,
  held,
  pct,
}: {
  /** Distinct people already paid this week. */
  paid: number;
  /** People the week started with (pending + paid + blocked + held). */
  started: number;
  /** People still waiting on a payment (all currencies). */
  remaining: number;
  /** People flagged Problem — out of the queue, still unpaid. */
  blocked: number;
  /** People marked Threshold — held under the payout minimum, out of the queue. */
  held: number;
  /** Whole-number % paid, precomputed against the same universe. */
  pct: number;
}) {
  // A flagged or held person is out of the queue but NOT paid, so the week isn't
  // done while any problem or threshold hold is still open.
  const complete = started > 0 && remaining === 0 && blocked === 0 && held === 0;
  const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
  // "12 flagged problem · 3 held" — only the reasons that actually apply.
  const stalled = [
    blocked > 0 ? `${fmt(blocked)} flagged problem` : null,
    held > 0 ? `${fmt(held)} held` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <motion.div
      variants={itemPop}
      className="relative overflow-hidden rounded-xl border border-white/60 bg-white/70 px-3 py-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 sm:rounded-2xl sm:px-4 sm:py-2.5"
    >
      {/* Soft indigo (emerald when done) wash so the strip reads as part of the KPI family. */}
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-r transition-opacity duration-500',
          complete
            ? 'from-emerald-100/50 via-teal-50/30 to-emerald-100/50 dark:from-emerald-950/40 dark:via-teal-950/20 dark:to-emerald-950/40'
            : 'from-white via-indigo-50/60 to-white dark:from-zinc-900/60 dark:via-indigo-950/30 dark:to-zinc-900/60',
        )}
        aria-hidden
      />
      <div className="relative">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span
                className={cn(
                  'absolute inline-flex h-full w-full rounded-full opacity-75',
                  complete ? 'animate-ping bg-emerald-400' : 'animate-ping bg-indigo-400',
                )}
              />
              <span
                className={cn(
                  'relative inline-flex h-1.5 w-1.5 rounded-full',
                  complete ? 'bg-emerald-500' : 'bg-indigo-500',
                )}
              />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-700 sm:text-[11px] dark:text-zinc-200">
              Dispatch Progress
            </span>
            <span className="truncate text-[10px] text-zinc-500 dark:text-zinc-400 sm:text-[11px]">
              &middot;{' '}
              {started === 0
                ? 'waiting for the queue'
                : complete
                  ? 'everyone paid'
                  : remaining === 0
                    ? stalled
                    : `${fmt(remaining)} left to pay${stalled ? ` · ${stalled}` : ''}`}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-baseline gap-1.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">
              <AnimatedNumber value={paid} formatter={fmt} />
            </span>
            <span>/</span>
            <span>{fmt(started)}</span>
            <span>paid</span>
            <span
              className={cn(
                'ml-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold',
                complete
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
              )}
            >
              {pct}%
            </span>
          </div>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-zinc-200/70 ring-1 ring-inset ring-zinc-300/50 dark:bg-zinc-800/80 dark:ring-zinc-700/50">
          <motion.div
            className={cn(
              'relative h-full min-w-[0.625rem] overflow-hidden rounded-full',
              complete
                ? 'bg-gradient-to-r from-emerald-400 via-emerald-500 to-teal-500 shadow-[0_0_14px_-2px_rgba(16,185,129,0.65)]'
                : 'bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[0_0_14px_-2px_rgba(139,92,246,0.6)]',
            )}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${fmt(paid)} of ${fmt(started)} people paid`}
          >
            {/* Glass top-highlight — a soft sheen along the upper half of the fill. */}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-full bg-white/25" />
            {/* Light streak that sweeps across the filled portion (transform-only). */}
            <span aria-hidden className="progress-sheen pointer-events-none absolute inset-y-0 left-0 w-2/5 bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            {/* Bright leading edge so the fill head reads as a glowing tip. */}
            <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-1 rounded-full bg-white/80 blur-[0.5px]" />
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

function HeroStat({
  tone,
  label,
  value,
  sub,
  Icon,
  currency = false,
  compact = false,
  over,
}: {
  tone: 'orange' | 'emerald' | 'violet';
  label: string;
  value: number | null;
  sub: string;
  Icon: React.ComponentType<{ className?: string }>;
  currency?: boolean;
  /** Focus mode — collapse to a slim one-line stat so the table gets the room. */
  compact?: boolean;
  /** Pre-formatted denominator rendered as "/ 1,500" after the big value, so a
   *  card can read as a fraction of the week's starting total. */
  over?: string;
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
      className={cn(
        'group relative overflow-hidden rounded-xl border border-white/60 bg-white/70 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] backdrop-blur-md transition-[padding] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] dark:border-zinc-800 dark:bg-zinc-900/60 sm:rounded-2xl',
        // Focus mode trims the card down to a slim one-liner; otherwise the
        // roomy hero padding.
        compact ? 'p-2 sm:px-3.5 sm:py-2' : 'p-2.5 sm:p-4',
      )}
    >
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-br opacity-60 transition-opacity duration-300 group-hover:opacity-100',
          palette.ring,
        )}
        aria-hidden
      />
      <div className="relative flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em] sm:text-[10px]', palette.text)}>
            {label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-0.5 sm:mt-1 sm:gap-1">
            {currency && value != null && (
              <span
                className={cn(
                  'font-semibold text-zinc-500 transition-[font-size] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] dark:text-zinc-400',
                  compact ? 'text-xs sm:text-sm' : 'text-sm sm:text-base',
                )}
              >
                $
              </span>
            )}
            <span
              className={cn(
                'truncate font-bold tracking-tight text-zinc-900 tabular-nums transition-[font-size] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] dark:text-white',
                compact ? 'text-lg sm:text-xl' : 'text-xl sm:text-3xl',
              )}
            >
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
            {/* "of the week's total" denominator — e.g. 1,000 / 1,500. */}
            {over != null && value != null && (
              <span
                className={cn(
                  'shrink-0 whitespace-nowrap font-semibold tracking-tight text-zinc-400 tabular-nums transition-[font-size] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] dark:text-zinc-500',
                  compact ? 'text-[10px] sm:text-xs' : 'text-xs sm:text-base',
                )}
              >
                / {over}
              </span>
            )}
          </div>
          {/* Sub-caption collapses away in focus mode so the card can go slim. */}
          <AnimatePresence initial={false}>
            {!compact && (
              <motion.div
                key="sub"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={FOCUS_TRANSITION}
                className="overflow-hidden"
              >
                <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400 sm:text-[11px]">
                  {sub}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.div
          animate={{ scale: compact ? 0.78 : 1 }}
          transition={FOCUS_TRANSITION}
          className={cn(
            'hidden shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md sm:flex',
            compact ? 'h-8 w-8' : 'h-10 w-10',
            palette.icon,
          )}
        >
          <Icon className={cn(compact ? 'h-4 w-4' : 'h-5 w-5')} />
        </motion.div>
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

/* BreathingDots, PreparingScene and LockToggleConfirmDialog moved to
   `@/components/payroll/LockToggleConfirmDialog` so the Payroll Wizard's
   Start/Stop processing flow renders the identical modal. */
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
          {/* Click-away backdrop. z-[75] so it also covers the collab avatar
              rail (z-[60]) / ping bubbles (z-[70]) — otherwise clicking an
              avatar that overlaps the open panel opened a peer card instead
              of closing the dropdown. */}
          <button
            type="button"
            aria-label="Close week selector"
            className="fixed inset-0 z-[75] cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-[80] mt-1.5 max-h-[60vh] w-72 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
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

