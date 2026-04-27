'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { CurrentPayResult, PayrollPeriod } from '@/lib/payroll/current-pay';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import { buildQueueFromRates, type QueueRow } from './mock-queue';

interface DispatchQueueState {
  /** Pending rows — already-paid recipients are filtered out. */
  rows: QueueRow[];
  /** Already-paid records for the current cycle. */
  paid: PaymentDispatchRow[];
  period: PayrollPeriod;
  fxRate: number;
  loading: boolean;
  error: string | null;
  /** Re-pulls dispatches + queue. Call after Mark paid succeeds. */
  refresh: () => Promise<void>;
}

const EMPTY_PERIOD: PayrollPeriod = {
  cycleId: null,
  start: null,
  end: null,
  sourceFile: null,
};

async function loadAll(signal?: AbortSignal): Promise<{
  rows: QueueRow[];
  paid: PaymentDispatchRow[];
  period: PayrollPeriod;
  fxRate: number;
  error: string | null;
}> {
  const [ratesRes, payRes] = await Promise.all([
    fetch('/api/employee-hourly-rates', { cache: 'no-store', signal }),
    fetch('/api/payroll-current-pay', { cache: 'no-store', signal }),
  ]);
  const ratesJson = (await ratesRes.json()) as {
    rows?: EmployeeHourlyRateRow[];
    error?: string | null;
  };
  const payJson = (await payRes.json()) as Partial<CurrentPayResult> & {
    error?: string;
  };

  if (ratesJson.error) {
    return {
      rows: [],
      paid: [],
      period: EMPTY_PERIOD,
      fxRate: 0,
      error: ratesJson.error,
    };
  }

  const period = payJson.period ?? EMPTY_PERIOD;
  // Pull existing dispatches for the current cycle so we can hide them from
  // the queue (don't pay anyone twice) and surface them in History.
  let paid: PaymentDispatchRow[] = [];
  if (period.cycleId) {
    const dispatchRes = await fetch(
      `/api/payment-dispatches?cycle_id=${encodeURIComponent(period.cycleId)}`,
      { cache: 'no-store', signal },
    );
    const dispatchJson = (await dispatchRes.json()) as {
      rows?: PaymentDispatchRow[];
      error?: string;
    };
    paid = dispatchJson.rows ?? [];
  }

  // Only `status='paid'` rows lock a recipient out of the pending queue —
  // Threshold and Problem rows leave the person available for retry, since
  // money never actually moved for those.
  const paidEmails = new Set(
    paid
      .filter((p) => p.status === 'paid')
      .map((p) => p.recipient_email.trim().toLowerCase()),
  );
  const allQueue = buildQueueFromRates(ratesJson.rows ?? [], payJson.byEmail ?? {});
  const pendingQueue = allQueue.filter((r) => !paidEmails.has(r.id));

  return {
    rows: pendingQueue,
    paid,
    period,
    fxRate: payJson.fxRate ?? 0,
    error: null,
  };
}

/**
 * Loads the dispatch queue. Joins:
 *  1. employee_hourly_rates  → who's eligible + their bank-preferred + contact
 *  2. /api/payroll-current-pay → per-person USD/PHP from the latest CSV
 *  3. payment_dispatches      → who already got paid this cycle (filtered out)
 *
 * Returns a `refresh()` callback so callers can re-pull after Mark paid.
 */
export function useDispatchQueue(): DispatchQueueState {
  const [state, setState] = useState<Omit<DispatchQueueState, 'refresh'>>({
    rows: [],
    paid: [],
    period: EMPTY_PERIOD,
    fxRate: 0,
    loading: true,
    error: null,
  });

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await loadAll(signal);
      if (signal?.aborted) return;
      setState({
        rows: result.rows,
        paid: result.paid,
        period: result.period,
        fxRate: result.fxRate,
        loading: false,
        error: result.error,
      });
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setState({
        rows: [],
        paid: [],
        period: EMPTY_PERIOD,
        fxRate: 0,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load dispatch queue',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  return { ...state, refresh };
}
