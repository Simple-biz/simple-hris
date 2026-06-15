'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { CurrentPayResult, PayrollPeriod } from '@/lib/payroll/current-pay';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import type { PaystubQueueListItem, ArrearsEntry } from '@/lib/supabase/paystub-dispatch-queue';
import {
  buildQueueFromRates,
  formatCycleLabelFromFile,
  type ArrearsInfo,
  type ExcludedRow,
  type ExclusionReason,
  type QueueRow,
} from './mock-queue';
import { getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';

/** Cached slice of the queue state — everything except the transient flags. */
type CachedQueue = {
  rows: QueueRow[];
  excluded: ExcludedRow[];
  paid: PaymentDispatchRow[];
  period: PayrollPeriod;
  fxRate: number;
  wizardReady: boolean;
};

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
  /**
   * False when the Payroll Wizard has NOT locked + staged this cycle yet
   * (no rows in paystub_dispatch_queue for the current source file). The UI
   * shows a "Payroll Wizard isn't ready yet" note instead of the queue.
   * Fail-open: stays true if the staging check can't be made (error/permission).
   */
  wizardReady: boolean;
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

/** Read the cycle's "values locked" flag value (JSON, legacy bool, or null). */
function parseLockedFlag(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false' || t === '') return false;
  try {
    return (JSON.parse(t) as { locked?: boolean }).locked === true;
  } catch {
    return false;
  }
}

async function loadAll(signal?: AbortSignal): Promise<{
  rows: QueueRow[];
  excluded: ExcludedRow[];
  paid: PaymentDispatchRow[];
  period: PayrollPeriod;
  fxRate: number;
  wizardReady: boolean;
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
      wizardReady: true,
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

  // Payroll Wizard "do not pay" exclusions for this cycle. People accounting
  // excluded from pay are moved out of the pending queue into the Excluded tab
  // (still payable from there — paying them logs the dispatch + sends their
  // staged paystub). Keyed by lowercased work email; carries the last paystub
  // send timestamp for a per-row badge.
  const wizardExcluded = new Map<string, { sentAt: string | null }>();
  if (period.sourceFile) {
    try {
      const stageRes = await fetch(
        `/api/paystub-dispatch-queue?source_file=${encodeURIComponent(period.sourceFile)}`,
        { cache: 'no-store', signal },
      );
      const stageJson = (await stageRes.json()) as { rows?: PaystubQueueListItem[] };
      for (const r of stageJson.rows ?? []) {
        if (r.excluded) {
          wizardExcluded.set(r.recipient_email.trim().toLowerCase(), { sentAt: r.sent_at });
        }
      }
    } catch {
      /* ignore — no staging just means nobody is wizard-excluded */
    }
  }

  // Readiness = the cycle's realtime "values locked" flag
  // (payroll.dispatch_lock.<sourceFile>). Until accounting LOCKS the cycle in the
  // wizard, Payment Dispatch shows no data. An absent flag (never locked) reads
  // as false. Fail-open ONLY on a fetch error so a hiccup never blanks a
  // genuinely-locked run. Realtime flips are picked up via the lock subscription
  // in the component, which calls refresh() to re-pull this.
  let wizardReady = true;
  if (period.sourceFile) {
    try {
      const lockRes = await fetch(
        `/api/app-settings?key=${encodeURIComponent(`payroll.dispatch_lock.${period.sourceFile}`)}`,
        { cache: 'no-store', signal },
      );
      const lockJson = (await lockRes.json()) as { value?: string | null };
      if (lockRes.ok) wizardReady = parseLockedFlag(lockJson.value);
    } catch {
      /* fail-open — stays ready */
    }
  }

  // Cross-cycle arrears: cumulative pending pay for held employees across every
  // unpaid cycle. Keyed by lowercased work email. Best-effort.
  const arrearsByEmail = new Map<string, ArrearsInfo>();
  try {
    const arRes = await fetch('/api/paystub-dispatch-queue/arrears', { cache: 'no-store', signal });
    const arJson = (await arRes.json()) as { entries?: ArrearsEntry[] };
    for (const e of arJson.entries ?? []) {
      arrearsByEmail.set(e.email.trim().toLowerCase(), {
        totalPHP: e.totalPhp,
        totalUSD: e.totalUsd,
        cycles: e.cycles.map((c) => ({
          sourceFile: c.sourceFile,
          label: formatCycleLabelFromFile(c.sourceFile),
          amountPHP: c.amountPhp,
          amountUSD: c.amountUsd,
          paystubSentAt: c.paystubSentAt,
          lastError: c.lastError,
        })),
      });
    }
  } catch {
    /* ignore — arrears rollup is additive; queue still works without it */
  }

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

  // Only show people who are on the Global Master List to begin with. The rates
  // table can carry stale / off-boarded / never-mastered rows; the master list
  // (active_employees) is the identity source of truth. Fail-open: if the
  // master set is unavailable (degraded fetch / older payload) we don't filter,
  // so we never blank the whole queue.
  const masterEmails = payJson.masterEmails;
  const masterSet =
    Array.isArray(masterEmails) && masterEmails.length > 0
      ? new Set(masterEmails.map((e) => e.trim().toLowerCase()))
      : null;
  const inMaster = <T extends { id: string; email: string }>(r: T): boolean =>
    masterSet == null || masterSet.has(r.id) || masterSet.has(r.email.trim().toLowerCase());

  const pendingActive = active
    .filter((r) => !paidEmails.has(r.id))
    .filter(inMaster)
    .map(applyWizardFinal);
  const excludedBase = excluded
    .filter((r) => !paidEmails.has(r.id))
    .filter(inMaster)
    .map(applyWizardFinal);

  // Split pending into truly-pending vs wizard-excluded.
  const pendingQueue: QueueRow[] = [];
  const movedExcluded: ExcludedRow[] = [];
  for (const row of pendingActive) {
    const ex = wizardExcluded.get(row.id);
    if (ex) {
      movedExcluded.push({
        id: row.id,
        name: row.name,
        email: row.email,
        totalHours: row.totalHours,
        amountUSD: row.amountUSD,
        amountPHP: row.amountPHP,
        bankPreferredRaw: row.bankPreferredRaw,
        reasons: ['do_not_pay'],
        payable: row,
        paystubSentAt: ex.sentAt,
      });
    } else {
      pendingQueue.push(row);
    }
  }
  // Tag any already-excluded (no_bank/no_pay/no_hours) row that's ALSO
  // wizard-excluded so the reason chip set is complete.
  const excludedQueue: ExcludedRow[] = [
    ...excludedBase.map((r) => {
      const ex = wizardExcluded.get(r.id);
      if (!ex) return r;
      const reasons = r.reasons.includes('do_not_pay')
        ? r.reasons
        : ([...r.reasons, 'do_not_pay'] as ExclusionReason[]);
      return { ...r, reasons, paystubSentAt: ex.sentAt };
    }),
    ...movedExcluded,
  ];

  // Overlay cross-cycle arrears: a held person's owed amount is the SUM across
  // all their unpaid held cycles, not just this one. We mirror that total onto
  // the row's amount + the payable QueueRow (so the Mark Paid dialog shows the
  // full balance) and keep a per-cycle breakdown for the UI.
  const activeByEmail = new Map(active.map((r) => [r.id, r] as const));
  const pendingIds = new Set(pendingQueue.map((r) => r.id));
  const shown = new Set<string>();
  const withArrears: ExcludedRow[] = excludedQueue.map((r) => {
    shown.add(r.id);
    const ar = arrearsByEmail.get(r.id);
    if (!ar) return r;
    const payable = r.payable
      ? { ...r.payable, amountPHP: ar.totalPHP, amountUSD: ar.totalUSD }
      : activeByEmail.get(r.id)
        ? { ...activeByEmail.get(r.id)!, amountPHP: ar.totalPHP, amountUSD: ar.totalUSD }
        : null;
    return { ...r, arrears: ar, amountPHP: ar.totalPHP, amountUSD: ar.totalUSD, payable };
  });

  // Surface people owed from PRIOR held cycles who aren't in this cycle's
  // excluded set — so back-owed money never disappears. Skip anyone currently
  // payable (they'll be paid through the pending queue this cycle).
  for (const [email, ar] of arrearsByEmail) {
    if (shown.has(email) || pendingIds.has(email)) continue;
    const base = activeByEmail.get(email) ?? null;
    withArrears.push({
      id: email,
      name: base?.name ?? email,
      email: base?.email ?? email,
      totalHours: base?.totalHours ?? null,
      amountUSD: ar.totalUSD,
      amountPHP: ar.totalPHP,
      bankPreferredRaw: base?.bankPreferredRaw ?? null,
      reasons: ['do_not_pay'],
      payable: base ? { ...base, amountPHP: ar.totalPHP, amountUSD: ar.totalUSD } : null,
      arrears: ar,
    });
  }

  return {
    // Until the wizard locks this cycle, Payment Dispatch shows NO queue data —
    // just the "not ready" note. (Reports / Urgent / Orphanage are separate and
    // not gated by this in the component.)
    rows: wizardReady ? pendingQueue : [],
    excluded: wizardReady ? withArrears : [],
    paid: wizardReady ? paid : [],
    period,
    fxRate: payJson.fxRate ?? 0,
    wizardReady,
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
  // Seed from the in-session cache so switching back to the dispatch tab paints
  // the last-known queue instantly instead of a skeleton; we still revalidate.
  const [state, setState] = useState<Omit<DispatchQueueState, 'refresh'>>(() => {
    const cached = getTabCache<CachedQueue>(TAB_CACHE_KEYS.dispatchQueue);
    return {
      rows: cached?.rows ?? [],
      excluded: cached?.excluded ?? [],
      paid: cached?.paid ?? [],
      period: cached?.period ?? EMPTY_PERIOD,
      fxRate: cached?.fxRate ?? 0,
      wizardReady: cached?.wizardReady ?? true,
      loading: cached === undefined,
      error: null,
    };
  });

  const load = useCallback(async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
    // Silent refreshes (post-action reconciliation, or a cache-backed remount)
    // skip the loading flag so the table isn't torn down to a skeleton and
    // re-mounted — no visible reload.
    if (!opts?.silent) setState((s) => ({ ...s, loading: true }));
    try {
      const result = await loadAll(signal);
      if (signal?.aborted) return;
      // Only cache clean loads — an errored result shouldn't overwrite good data.
      if (!result.error) {
        setTabCache<CachedQueue>(TAB_CACHE_KEYS.dispatchQueue, {
          rows: result.rows,
          excluded: result.excluded,
          paid: result.paid,
          period: result.period,
          fxRate: result.fxRate,
          wizardReady: result.wizardReady,
        });
      }
      setState({
        rows: result.rows,
        excluded: result.excluded,
        paid: result.paid,
        period: result.period,
        fxRate: result.fxRate,
        wizardReady: result.wizardReady,
        loading: false,
        error: result.error,
      });
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // A background revalidation that fails should keep the last good data on
      // screen rather than blanking the queue.
      if (opts?.silent && hasTabCache(TAB_CACHE_KEYS.dispatchQueue)) {
        setState((s) => ({ ...s, loading: false }));
        return;
      }
      setState({
        rows: [],
        excluded: [],
        paid: [],
        period: EMPTY_PERIOD,
        fxRate: 0,
        wizardReady: true,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load dispatch queue',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // If we already have a cached snapshot, revalidate silently (no skeleton).
    void load(controller.signal, { silent: hasTabCache(TAB_CACHE_KEYS.dispatchQueue) });
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(async () => {
    await load(undefined, { silent: true });
  }, [load]);

  return { ...state, refresh };
}
