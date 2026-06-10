'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { CurrentPayResult, PayrollPeriod } from '@/lib/payroll/current-pay';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import { buildQueueFromRates, type ExcludedRow, type QueueRow } from './mock-queue';

/**
 * Build a lowercased-email → EmployeeIdRow map. Both work_email and
 * personal_email are indexed so a rate row keyed on either resolves to
 * the employee's row (which carries their preferred_processor and the
 * per-processor payout fields they filled in via Settings).
 */
function buildIdsMap(rows: EmployeeIdRow[]): Map<string, EmployeeIdRow> {
  const m = new Map<string, EmployeeIdRow>();
  for (const r of rows) {
    const we = r.work_email?.trim().toLowerCase();
    const pe = r.personal_email?.trim().toLowerCase();
    if (we) m.set(we, r);
    if (pe && !m.has(pe)) m.set(pe, r);
  }
  return m;
}

interface DispatchQueueState {
  /** Pending rows — already-paid recipients are filtered out. */
  rows: QueueRow[];
  /**
   * Employees the queue can NOT pay this cycle because they're missing one or
   * more of: bank/processor, current pay, or hours. Surfaced in a separate
   * tab so they're still visible.
   */
  excluded: ExcludedRow[];
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
  excluded: ExcludedRow[];
  paid: PaymentDispatchRow[];
  period: PayrollPeriod;
  fxRate: number;
  error: string | null;
}> {
  // All four endpoints fire at once. Dispatches used to wait for
  // /api/payroll-current-pay (the slow one) just to learn the cycle id; the
  // cheap /api/current-cycle endpoint surfaces that id on its own so the
  // dispatches request runs in parallel with the pay computation instead of
  // behind it. The dispatches fetch is chained off the cycle lookup only —
  // not off pay — so it overlaps the slowest endpoint instead of adding to it.
  const dispatchesPromise = (async (): Promise<PaymentDispatchRow[]> => {
    const cycleRes = await fetch('/api/current-cycle', { cache: 'no-store', signal });
    const cycleJson = (await cycleRes.json()) as { cycleId?: string | null };
    const cycleId = cycleJson.cycleId ?? null;
    if (!cycleId) return [];
    const dispatchRes = await fetch(
      `/api/payment-dispatches?cycle_id=${encodeURIComponent(cycleId)}`,
      { cache: 'no-store', signal },
    );
    const dispatchJson = (await dispatchRes.json()) as {
      rows?: PaymentDispatchRow[];
      error?: string;
    };
    return dispatchJson.rows ?? [];
  })();

  const [ratesRes, payRes, idsRes, paid] = await Promise.all([
    fetch('/api/employee-hourly-rates', { cache: 'no-store', signal }),
    fetch('/api/payroll-current-pay', { cache: 'no-store', signal }),
    fetch('/api/employee-ids', { cache: 'no-store', signal }),
    dispatchesPromise,
  ]);
  const ratesJson = (await ratesRes.json()) as {
    rows?: EmployeeHourlyRateRow[];
    error?: string | null;
  };
  const payJson = (await payRes.json()) as Partial<CurrentPayResult> & {
    error?: string;
  };
  const idsJson = (await idsRes.json()) as {
    rows?: EmployeeIdRow[];
    error?: string | null;
  };

  if (ratesJson.error) {
    return {
      rows: [],
      excluded: [],
      paid: [],
      period: EMPTY_PERIOD,
      fxRate: 0,
      error: ratesJson.error,
    };
  }

  // Employee-chosen processors and per-processor payout fields live on
  // employee_ids. If that fetch fails we don't want to block the queue —
  // we just fall back to the legacy fields on employee_hourly_rates.
  const idsByEmail = buildIdsMap(idsJson.rows ?? []);

  const period = payJson.period ?? EMPTY_PERIOD;

  // Payroll Wizard's published final pay for this period's source file. When present
  // it is authoritative — it includes the accounting layer (Adj., Orphanage, KPI/dept
  // bonuses, MESA disbursement) that /api/payroll-current-pay recomputes without. We
  // overlay it onto each queue row's amount so the clerk pays exactly what the wizard
  // computed. Falls back silently to the current-pay amount when no snapshot exists.
  let wizardFinalByEmail: Record<string, number> = {};
  if (period.sourceFile) {
    try {
      const snapRes = await fetch(
        `/api/app-settings?key=${encodeURIComponent(`payroll.wizard.final_pay.${period.sourceFile}`)}`,
        { cache: 'no-store', signal },
      );
      const snapJson = (await snapRes.json()) as { value?: string | null };
      if (snapJson?.value) {
        const parsed = JSON.parse(snapJson.value) as { finals?: Record<string, { final?: number }> };
        for (const [em, entry] of Object.entries(parsed.finals ?? {})) {
          if (entry && typeof entry.final === 'number') wizardFinalByEmail[em] = entry.final;
        }
      }
    } catch {
      /* ignore — fall back to current-pay amounts */
    }
  }
  const fx = payJson.fxRate ?? 0;
  const applyWizardFinal = <T extends { id: string; amountPHP: number | null; amountUSD: number | null }>(r: T): T => {
    const f = wizardFinalByEmail[r.id];
    if (typeof f !== 'number') return r;
    return {
      ...r,
      amountPHP: f,
      amountUSD: fx > 0 ? Math.round((f / fx) * 100) / 100 : r.amountUSD,
    };
  };

  // Only `status='paid'` rows lock a recipient out of the pending queue —
  // Threshold and Problem rows leave the person available for retry, since
  // money never actually moved for those.
  const paidEmails = new Set(
    paid
      .filter((p) => p.status === 'paid')
      .map((p) => p.recipient_email.trim().toLowerCase()),
  );
  const { active, excluded } = buildQueueFromRates(
    ratesJson.rows ?? [],
    payJson.byEmail ?? {},
    idsByEmail,
  );
  const pendingQueue = active.filter((r) => !paidEmails.has(r.id)).map(applyWizardFinal);
  const excludedQueue = excluded.filter((r) => !paidEmails.has(r.id)).map(applyWizardFinal);

  return {
    rows: pendingQueue,
    excluded: excludedQueue,
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
    excluded: [],
    paid: [],
    period: EMPTY_PERIOD,
    fxRate: 0,
    loading: true,
    error: null,
  });

  const load = useCallback(async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
    // Silent refreshes (post-action reconciliation) skip the loading flag so the
    // table isn't torn down to a skeleton and re-mounted — no visible reload.
    if (!opts?.silent) setState((s) => ({ ...s, loading: true }));
    try {
      const result = await loadAll(signal);
      if (signal?.aborted) return;
      setState({
        rows: result.rows,
        excluded: result.excluded,
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
        excluded: [],
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
    await load(undefined, { silent: true });
  }, [load]);

  return { ...state, refresh };
}
