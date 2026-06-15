'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AppFooter from '@/components/AppFooter';
import { Lock, Menu } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { normEmail } from '@/lib/email/norm-email';
import { SESSION_EMAIL_KEY } from '@/lib/rbac/views';
import { cn } from '@/lib/utils';
import PayrollClerkSidebar from './PayrollClerkSidebar';
import ProcessorQueue from './ProcessorQueue';
import DispatchLoader from './DispatchLoader';
import ExcludedQueue from './ExcludedQueue';
import SentPaymentsHistory from './SentPaymentsHistory';
import DispatchReports from './DispatchReports';
import MarkPaidDialog, { type MarkPaidPayload } from './MarkPaidDialog';
import UrgentPaymentsQueue from './UrgentPaymentsQueue';
import { PROCESSORS, type ProcessorId, type QueueRow } from './mock-queue';
import { useDispatchQueue } from './useDispatchQueue';
import { useWizardDispatchLock } from '@/hooks/useWizardDispatchLock';

function isPlausibleEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export default function PayrollClerkApp() {
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams?.get('email') ?? null;
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  const [activeTab, setActiveTab] = useState<string>('all');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [viewerEmail, setViewerEmail] = useState<string | null>(null);

  const { rows: fetched, excluded, paid, period, wizardReady, loading, error, refresh } = useDispatchQueue();
  // Realtime "values locked" flag — re-pull when the wizard locks/unlocks so the
  // queue appears/clears live.
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
  const [markPaidRow, setMarkPaidRow] = useState<QueueRow | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [urgentCount, setUrgentCount] = useState(0);

  // Carla's gate: list only appears once a cycle is marked "ready".
  // For now this is a UI toggle so we can demo both states.
  const [cycleReady, setCycleReady] = useState(true);

  useLayoutEffect(() => {
    if (loading) {
      setHydrated(false);
      return;
    }
    setPending(fetched);
    setHydrated(true);
  }, [fetched, loading]);

  useEffect(() => {
    setMounted(true);
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

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNavOpen]);

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

  const visibleRows = useMemo(() => {
    if (activeTab === 'all') return pending;
    if (PROCESSORS.some((p) => p.id === activeTab)) {
      return pending.filter((r) => r.processor === activeTab);
    }
    return [];
  }, [pending, activeTab]);

  // Stable refs so the memoized ProcessorQueue + rows don't re-render when
  // markPaidRow toggles.
  const handleOpenMarkPaid = useCallback((row: QueueRow) => {
    setMarkPaidRow(row);
  }, []);
  const handleCloseMarkPaid = useCallback(() => {
    setMarkPaidRow(null);
  }, []);

  const handleConfirmPaid = async (payload: MarkPaidPayload) => {
    const row = pending.find((r) => r.id === payload.rowId);
    if (!row) return;

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
      const json = (await res.json()) as {
        error?: string;
        paystub?: { staged: boolean; sent: boolean; error: string | null };
      };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Could not log dispatch');
      if (payload.status === 'paid' && json.paystub?.sent) {
        toast.success(`${row.name} marked paid · paystub emailed`);
      } else if (payload.status === 'paid' && json.paystub && !json.paystub.staged) {
        toast.warning(`${row.name} marked paid — no staged paystub to email`);
      } else {
        toast.success(`${row.name} marked paid`);
      }
      void refresh();
    } catch (e) {
      setPending((prev) => (prev.some((r) => r.id === row.id) ? prev : [row, ...prev]));
      toast.error(e instanceof Error ? e.message : 'Could not log dispatch');
    }
  };

  const isDark = mounted ? resolvedTheme === 'dark' : false;

  const renderContent = () => {
    // Reports view stands on its own — it doesn't need the dispatch queue or
    // a "ready" cycle because it's reading historical Hubstaff uploads.
    if (activeTab === 'reports') {
      return <DispatchReports />;
    }
    if (activeTab === 'urgent') {
      return <UrgentPaymentsQueue onCountChange={setUrgentCount} />;
    }
    if (!cycleReady) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#fafaf8] px-6 text-center dark:bg-[#0d1117]">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
            <Menu className="h-7 w-7" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-white">No cycle ready yet</h2>
            <p className="mt-1 text-sm text-[#71717a] dark:text-zinc-500">
              The list will appear here once Accounting marks a pay cycle as ready.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setCycleReady(true)}>
            (Demo) Toggle cycle ready
          </Button>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-white">Couldn&apos;t load queue</h2>
          <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
        </div>
      );
    }
    if (loading || !hydrated) {
      return <DispatchLoader />;
    }
    // No queue data until accounting locks + stages this cycle from the wizard.
    if (!wizardReady) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#fafaf8] px-6 text-center dark:bg-[#0d1117]">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/30">
            <Lock className="h-7 w-7" />
          </div>
          <div className="max-w-md">
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-white">Payroll Wizard isn&apos;t ready yet</h2>
            <p className="mt-1 text-sm text-[#71717a] dark:text-zinc-500">
              This cycle&apos;s values haven&apos;t been locked. Nothing to pay here until accounting clicks
              <span className="font-semibold text-zinc-700 dark:text-zinc-200"> &ldquo;Lock in Values &amp; Send to Payment Dispatch&rdquo;</span> in the Payroll Wizard.
            </p>
          </div>
        </div>
      );
    }
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
        processor={activeTab === 'all' ? null : (activeTab as ProcessorId)}
        rows={visibleRows}
        onMarkPaid={handleOpenMarkPaid}
        periodStart={period.start}
        periodEnd={period.end}
      />
    );
  };

  return (
    <div
      className={cn(
        'flex h-dvh max-h-dvh w-full overflow-hidden text-zinc-900 dark:text-zinc-100',
        'bg-white dark:bg-[#0d1117]',
      )}
    >
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
          aria-label="Close navigation menu"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <PayrollClerkSidebar
        activeTab={activeTab}
        setActiveTab={(t) => {
          setActiveTab(t);
          setMobileNavOpen(false);
        }}
        mobileOpen={mobileNavOpen}
        viewerEmail={viewerEmail}
        counts={counts}
        cycleReady={cycleReady}
        urgentCount={urgentCount}
      />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center gap-3 border-b border-[#ececec] bg-white/95 px-3 py-2.5 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.625rem,env(safe-area-inset-top))] dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 border-[#ececec] bg-[#fafaf8] dark:border-zinc-800 dark:bg-zinc-900"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-controls="payroll-clerk-sidebar-nav"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <span className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Payroll clerk
          </span>
        </header>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{renderContent()}</div>
        <AppFooter />
      </main>

      <MarkPaidDialog row={markPaidRow} onClose={handleCloseMarkPaid} onConfirm={handleConfirmPaid} />
      <Toaster position="top-right" theme={isDark ? 'dark' : 'light'} />
    </div>
  );
}
