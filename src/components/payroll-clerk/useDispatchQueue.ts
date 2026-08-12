'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { CurrentPayResult, PayrollPeriod } from '@/lib/payroll/current-pay';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';
import type { PaystubQueueListItem, ArrearsEntry } from '@/lib/supabase/paystub-dispatch-queue';
import {
  applySmallWiresWiseReroute,
  buildQueueFromRates,
  buildStagedOnlyPlacement,
  formatCycleLabelFromFile,
  type ArrearsInfo,
  type ExcludedRow,
  type ExclusionReason,
  type QueueRow,
} from './mock-queue';
import {
  resolveWizardRowValues,
  type CatalogRateClaimLike,
  type WizardRowValues,
  type WizardSnapshotEntry,
} from '@/lib/payroll/wizard-dispatch-values';
import { getTabCache, hasTabCache, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';

/** Resolve a department key to its display name (null when unknown/empty). */
function deptNameFromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return DEPARTMENTS.find((d) => d.key === key)?.name ?? null;
}

/** Cached slice of the queue state — everything except the transient flags. */
type CachedQueue = {
  rows: QueueRow[];
  excluded: ExcludedRow[];
  paid: PaymentDispatchRow[];
  /** See {@link DispatchQueueState.deptByEmail}. Cached with the rows so a warm
   *  repaint doesn't drop every log view's department filter to "No department". */
  deptByEmail: Record<string, string>;
  period: PayrollPeriod;
  fxRate: number;
  wizardReady: boolean;
  valuesWarning: string | null;
};

/**
 * Build a lowercased-email → EmployeeIdRow map. Both work_email and
 * personal_email are indexed so a rate row keyed on either resolves to
 * the employee's row (which carries their preferred_processor and the
 * per-processor payout fields they filled in via Settings).
 */
/**
 * Hold a USD-denominated payee out of the payable queue.
 *
 * US-based staff on a USD pay structure settle on their own track, not from this
 * screen. They used to ride a dedicated USD queue tab, which meant they counted
 * against the pending total and pinned the Dispatch Progress strip below 100%
 * for a week whose entire peso payroll had actually gone out. Holding them in
 * Excluded keeps the money auditable while leaving every counter on this screen
 * to the payments it can actually send.
 *
 * Deliberately carries NO `payable`: that's what withholds the Excluded tab's
 * "Pay now" button (see ExcludedQueue's `onMarkPaid` gate), so a US payee can't
 * be settled through the peso rails by accident.
 */
function heldUsdRow(row: QueueRow): ExcludedRow {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    totalHours: row.totalHours,
    amountUSD: row.amountUSD,
    amountPHP: row.amountPHP,
    amountCOP: row.amountCOP,
    bankPreferredRaw: row.bankPreferredRaw,
    reasons: ['usd_paid'],
    departmentKey: row.departmentKey ?? null,
    departmentName: row.departmentName ?? null,
    contractorRole: row.contractorRole,
    payeeKind: row.payeeKind,
    contractorInvoiceId: row.contractorInvoiceId,
    invoiceNumber: row.invoiceNumber,
  };
}

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
  /**
   * Lowercased email → department name for **every** payee in this cycle,
   * including the people who have already been paid (they are filtered out of
   * {@link rows}, so their department is otherwise unknowable client-side —
   * `payment_dispatches` carries no department column).
   *
   * This is what lets the dispatch-log views (Paid / Not paid / Threshold /
   * Problem / Done) filter by department. Precedence mirrors the Excluded tab
   * (staged wizard dept wins, then the queue's own resolution, then the pay
   * layer), so one person reads the same department on both sides of a Mark
   * Paid. Work AND personal email are indexed, because a dispatch can be
   * recorded against either.
   */
  deptByEmail: Record<string, string>;
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
  /**
   * A contractor-side failure (missing migration, failed read, aborted fetch).
   * The employee queue is unaffected — but contractor invoices are silently
   * absent, so the UI must say so rather than looking healthy and empty.
   */
  contractorError: string | null;
  /**
   * Something needs attention on an otherwise successful contractor load — today,
   * invoices stuck mid-dispatch. Separate from {@link contractorError} because the
   * copy is the opposite: the queue below IS complete.
   */
  contractorAdvisory: string | null;
  /**
   * The amounts on screen are NOT the Payroll Wizard's for at least one payee, and
   * the clerk has to know before sending money.
   *
   * Never silent: the wizard's figures used to be a best-effort overlay whose every
   * failure mode (unreadable snapshot, unreadable stage, a snapshot rejected for
   * contradicting the Payment Catalog, a staged payee neither carrier could price)
   * degraded to a wizard-blind recompute behind a queue that looked perfectly
   * healthy — no Adj., no Orphanage, no KPI/dept bonuses, no MESA.
   */
  valuesWarning: string | null;
  /** Re-pulls dispatches + queue. Call after Mark paid succeeds. */
  refresh: () => Promise<void>;
}

const EMPTY_PERIOD: PayrollPeriod = {
  cycleId: null,
  start: null,
  end: null,
  sourceFile: null,
};

/**
 * Supabase Realtime **Broadcast** topic every open Payment Dispatch screen joins,
 * so a payment logged on one appears on all of them within a second.
 *
 * Its own topic rather than the CEO card's `payments-live`: that channel carries a
 * different contract (Accounting publishing exact counts to a viewer), and joining
 * one topic twice from the same page invites subscription conflicts.
 */
const DISPATCH_SYNC_CHANNEL = 'payment-dispatch-sync';
const DISPATCH_SYNC_EVENT = 'queue-changed';
/** Coalesce a burst — settling multi-cycle arrears fires one POST per cycle. */
const DISPATCH_SYNC_DEBOUNCE_MS = 400;
/** Fallback cadence when the socket is down or a change came from outside the app. */
const DISPATCH_POLL_INTERVAL_MS = 15_000;

/** Build the visible state for a cache key — the last-known queue for that week
 *  (instant paint) or a blank loading shell when the week hasn't been seen. */
function seedState(cacheKey: string): Omit<DispatchQueueState, 'refresh'> {
  const cached = getTabCache<CachedQueue>(cacheKey);
  return {
    rows: cached?.rows ?? [],
    excluded: cached?.excluded ?? [],
    paid: cached?.paid ?? [],
    deptByEmail: cached?.deptByEmail ?? {},
    period: cached?.period ?? EMPTY_PERIOD,
    fxRate: cached?.fxRate ?? 0,
    wizardReady: cached?.wizardReady ?? true,
    loading: cached === undefined,
    error: null,
    contractorError: null,
    contractorAdvisory: null,
    // Cached: a warm repaint must not drop a "these aren't the wizard's amounts"
    // notice that the cached rows are still carrying.
    valuesWarning: cached?.valuesWarning ?? null,
  };
}

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

async function loadAll(
  signal?: AbortSignal,
  selectedSourceFile?: string | null,
): Promise<{
  rows: QueueRow[];
  excluded: ExcludedRow[];
  paid: PaymentDispatchRow[];
  /** See {@link DispatchQueueState.deptByEmail}. */
  deptByEmail: Record<string, string>;
  period: PayrollPeriod;
  fxRate: number;
  wizardReady: boolean;
  error: string | null;
  /** Contractor-side failure, if any. Never blanks the employee queue. */
  contractorError: string | null;
  /** Advisory on a SUCCESSFUL contractor load (e.g. invoices stuck mid-dispatch). */
  contractorAdvisory: string | null;
  /** See {@link DispatchQueueState.valuesWarning}. */
  valuesWarning: string | null;
}> {
  // When the clerk picks a PAST week in the dispatch CSV selector, pay + cycle
  // are computed for that source file instead of the live `is_current` cycle.
  // Everything downstream already keys off the returned `period.sourceFile`, so
  // only these two upstream fetches need the override.
  const sel = selectedSourceFile?.trim() || null;
  const q = sel ? `?source_file=${encodeURIComponent(sel)}` : '';
  // All four endpoints fire at once. Dispatches used to wait for
  // /api/payroll-current-pay (the slow one) just to learn the cycle id; the
  // cheap /api/current-cycle endpoint surfaces that id on its own so the
  // dispatches request runs in parallel with the pay computation instead of
  // behind it. The dispatches fetch is chained off the cycle lookup only —
  // not off pay — so it overlaps the slowest endpoint instead of adding to it.
  const dispatchesPromise = (async (): Promise<PaymentDispatchRow[]> => {
    const cycleRes = await fetch(`/api/current-cycle${q}`, { cache: 'no-store', signal });
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
    fetch(`/api/payroll-current-pay${q}`, { cache: 'no-store', signal }),
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
      deptByEmail: {},
      period: EMPTY_PERIOD,
      fxRate: 0,
      wizardReady: true,
      error: ratesJson.error,
      contractorError: null,
      contractorAdvisory: null,
      valuesWarning: null,
    };
  }

  // Employee-chosen processors and per-processor payout fields live on
  // employee_ids. If that fetch fails we don't want to block the queue —
  // we just fall back to the legacy fields on employee_hourly_rates.
  const idsByEmail = buildIdsMap(idsJson.rows ?? []);

  const period = payJson.period ?? EMPTY_PERIOD;

  // ── What the Payroll Wizard LOCKED IN for this cycle ───────────────────────
  // Read BEFORE pricing, because the locked figures are one of the two carriers
  // the pricing below chooses between (the other is the wizard's live snapshot).
  //
  // Three jobs beyond that:
  //  (1) "do not pay" exclusions → the Excluded tab, keyed by lowercased work
  //      email, carrying the last paystub send timestamp for a per-row badge;
  //  (2) the staged set overrides the master-list gate — anyone payroll locked in
  //      must appear here, including re-hires / sync-lagged rows;
  //  (3) the safety net further down synthesizes a row for anyone locked in that
  //      the rates-only build couldn't produce, so nobody silently vanishes.
  const wizardExcluded = new Map<string, { sentAt: string | null; departmentKey: string | null }>();
  const stagedEmails = new Set<string>();
  const stagedItems: PaystubQueueListItem[] = [];
  /** Staged rows by lowercased work email — the pricing lookup below. */
  const stagedByEmail = new Map<string, PaystubQueueListItem>();
  /** Non-null when the staged read FAILED. Distinct from "nobody is staged": the
   *  first would silently price the whole week off the recompute and hide the
   *  safety net, so it is surfaced rather than swallowed. */
  let stagedError: string | null = null;
  if (period.sourceFile) {
    try {
      const stageRes = await fetch(
        `/api/paystub-dispatch-queue?source_file=${encodeURIComponent(period.sourceFile)}`,
        { cache: 'no-store', signal },
      );
      const stageJson = (await stageRes.json()) as {
        rows?: PaystubQueueListItem[];
        error?: string | null;
      };
      if (!stageRes.ok || stageJson.error) {
        stagedError = stageJson.error?.trim() || `HTTP ${stageRes.status}`;
      }
      for (const r of stageJson.rows ?? []) {
        stagedItems.push(r);
        const re = r.recipient_email?.trim().toLowerCase();
        if (re) {
          stagedEmails.add(re);
          stagedByEmail.set(re, r);
        }
        if (r.personal_email) stagedEmails.add(r.personal_email.trim().toLowerCase());
        if (r.excluded) {
          wizardExcluded.set(r.recipient_email.trim().toLowerCase(), {
            sentAt: r.sent_at,
            departmentKey: r.department_key ?? null,
          });
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      stagedError = e instanceof Error ? e.message : String(e);
    }
  }

  // ── The wizard's figures ───────────────────────────────────────────────────
  // /api/payroll-current-pay recomputes pay WITHOUT the accounting layer (Adj.,
  // Orphanage, KPI/dept bonuses, MESA) — which is precisely why the wizard
  // publishes its own figures (docs/features/payroll-wizard-final-pay.md §5).
  // TWO carriers hold them and they can disagree, so the precedence lives in one
  // shared, unit-tested module that the paystub engine uses too:
  //
  //   snapshot (only when it QUALIFIES) → the LOCKED stage → nothing
  //
  // Nothing → the row keeps computeCurrentPay's figure and says so
  // (`valuesSource: 'recomputed'`), because an absent saved value falls back to
  // live computation and never to ₱0 (payroll-wizard-week-replay.md, rule 3).
  //
  // This used to be a total-only overlay of the snapshot with NONE of the gates
  // paystub-fresh.ts applies — so a snapshot that predated a re-lock, a held row,
  // or a total-only snapshot could all price the payment differently from the
  // statement that person was emailed, and a missing snapshot silently handed the
  // clerk a wizard-blind recompute.
  let wizardFinals: Record<string, WizardSnapshotEntry> | null = null;
  let wizardSnapshotUpdatedAt: string | null = null;
  /** Non-null when the wizard's figures could NOT be read — never treated as
   *  "the wizard published nothing", which would silently price the week off the
   *  recompute. */
  let valuesError: string | null = null;
  const catalogClaimByEmail = new Map<string, CatalogRateClaimLike>();
  if (period.sourceFile) {
    // Employee-scope PHP catalog rates — the rate source of truth. A snapshot
    // entry whose own rate contradicts the catalog was published by a wizard
    // session holding pre-change data and must not price the payment. Fail-open:
    // if the catalog fetch fails, the guard simply doesn't fire.
    try {
      const catRes = await fetch('/api/payment-catalog/pay-structures', { cache: 'no-store', signal });
      if (catRes.ok) {
        const catJson = (await catRes.json()) as {
          structures?: Array<{
            scope?: string;
            employeeEmail?: string | null;
            regularRate?: number;
            otRate?: number | null;
            currency?: string;
          }>;
        };
        for (const s of catJson.structures ?? []) {
          if (s?.scope !== 'employee' || s.currency !== 'PHP') continue;
          const em = (s.employeeEmail ?? '').trim().toLowerCase();
          if (!em || typeof s.regularRate !== 'number' || !Number.isFinite(s.regularRate)) continue;
          catalogClaimByEmail.set(em, {
            regular: s.regularRate,
            ot: typeof s.otRate === 'number' && Number.isFinite(s.otRate) ? s.otRate : null,
          });
        }
      }
    } catch {
      /* fail-open — no catalog check */
    }

    // `meta=1` carries the row's updated_at: without it there is no way to tell a
    // snapshot that post-dates the lock from one the lock has superseded.
    try {
      const snapRes = await fetch(
        `/api/app-settings?key=${encodeURIComponent(`payroll.wizard.final_pay.${period.sourceFile}`)}&meta=1`,
        { cache: 'no-store', signal },
      );
      const snapJson = (await snapRes.json()) as {
        value?: string | null;
        updatedAt?: string | null;
        error?: string | null;
      };
      if (!snapRes.ok || snapJson.error) {
        valuesError = snapJson.error?.trim() || `HTTP ${snapRes.status}`;
      } else if (snapJson.value) {
        const parsed = JSON.parse(snapJson.value) as { finals?: Record<string, WizardSnapshotEntry> };
        wizardFinals = parsed.finals ?? null;
        wizardSnapshotUpdatedAt = snapJson.updatedAt ?? null;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      valuesError = e instanceof Error ? e.message : String(e);
    }
  }
  const fx = payJson.fxRate ?? 0;
  // USD anchor for re-deriving a COP person's native amount when the wizard
  // overrides their final PHP pay (COP = USD-equivalent × usd_to_cop_rate).
  const usdToCop = payJson.fxRates?.usdToCop ?? 0;
  /** Rows priced off the recompute despite the wizard having staged them. */
  const unpricedByWizard: string[] = [];
  /** Rows the wizard re-priced after the values were locked. */
  const repricedAfterLock: string[] = [];
  /** Rows whose snapshot was rejected for contradicting the Payment Catalog. */
  const staleRateRows: string[] = [];
  /** Resolve one payee through the shared precedence, recording what happened. */
  const wizardValuesFor = (row: { id: string; email: string }): WizardRowValues | null => {
    const staged = stagedByEmail.get(row.id) ?? null;
    const values = resolveWizardRowValues({
      // Work-email-only matching (the staged row's key is always the work email).
      // Personal addresses are shared/recycled in the master list, so an alias
      // match could pay one person another person's figures.
      workEmail: staged?.recipient_email ?? row.id,
      finals: wizardFinals,
      snapshotUpdatedAt: wizardSnapshotUpdatedAt,
      staged: staged
        ? {
            amountPHP: staged.amount_php,
            amountUSD: staged.amount_usd,
            lockedAt: staged.locked_at,
            excluded: staged.excluded === true,
            payPhp: staged.pay_php,
            hours: staged.hours,
          }
        : null,
      catalogClaim: catalogClaimByEmail.get(row.id) ?? null,
    });
    const who = row.email || row.id;
    if (!values) {
      // Staged but unpriced by either carrier: the clerk is looking at a
      // recomputed figure for someone payroll locked in. Reported, not swallowed.
      if (staged) unpricedByWizard.push(who);
      return null;
    }
    if (values.staleRateSnapshot) staleRateRows.push(who);
    if (values.repricedAfterLock) repricedAfterLock.push(who);
    return values;
  };

  /** PHP total → the USD/COP twins, keeping a row's currencies in step. */
  const deriveCurrencies = (
    r: { amountUSD: number | null; amountCOP: number | null },
    values: WizardRowValues,
  ): { amountUSD: number | null; amountCOP: number | null } => {
    const amountUSD =
      values.amountUSD ?? (fx > 0 ? Math.round((values.amountPHP / fx) * 100) / 100 : r.amountUSD);
    // Only COP-relevant rows carry a non-null amountCOP; keep it in step.
    const amountCOP =
      r.amountCOP != null && amountUSD != null && usdToCop > 0
        ? Math.round(amountUSD * usdToCop)
        : r.amountCOP;
    return { amountUSD, amountCOP };
  };

  /**
   * Overlay the wizard's own figures onto a payable row — total AND itemization
   * together. They must move in the same write: a wizard total beside a recomputed
   * bonus split is a row whose own numbers don't add up (the 2026-08-02 cycle had
   * 680 such rows, each showing no bonus chip while the wizard paid ₱120–₱7,000 of
   * dept/KPI bonuses).
   */
  const applyWizardValues = (r: QueueRow): QueueRow => {
    const values = wizardValuesFor(r);
    if (!values) return r;
    const b = values.breakdown;
    return {
      ...r,
      amountPHP: values.amountPHP,
      ...deriveCurrencies(r, values),
      valuesSource: values.source,
      lockedAmountPHP: values.lockedAmountPHP,
      repricedAfterLock: values.repricedAfterLock,
      // The split travels with the total or not at all. When the winning carrier
      // has no itemization the fields are floored at 0 and flagged UNAVAILABLE, so
      // a renderer shows "—" instead of asserting ₱0.
      breakdownUnavailable: b === null,
      initialPayPHP: b ? b.initialPayPHP : r.initialPayPHP,
      initialPayUSD:
        b && b.initialPayPHP != null && fx > 0
          ? Math.round((b.initialPayPHP / fx) * 100) / 100
          : r.initialPayUSD,
      bonusTotalPHP: b ? b.bonusTotalPHP : 0,
      pabBonusPHP: b ? b.pabBonusPHP : 0,
      techBonusPHP: b ? b.techBonusPHP : 0,
      orphanagePayPHP: b ? b.orphanagePayPHP : 0,
      mesaDeductionPHP: b ? b.mesaDeductionPHP : 0,
      mesaDisbursementPHP: b ? b.mesaDisbursementPHP : 0,
      // Hours stay the timesheet's when the wizard didn't carry them: they are a
      // display of hours worked, not a claim about money.
      totalHours: b?.totalHours ?? r.totalHours,
      otHours: b?.otHours ?? r.otHours,
    };
  };

  /**
   * The same overlay for an Excluded row, which carries amounts but no breakdown
   * (its payable twin, when it has one, is overlaid in full). A wizard-HELD row
   * resolves to its LOCKED figures by rule — the snapshot never speaks for a "do
   * not pay" row, because that is what the arrears ledger settles from.
   */
  const applyWizardAmounts = (r: ExcludedRow): ExcludedRow => {
    const values = wizardValuesFor(r);
    if (!values) return r;
    return {
      ...r,
      amountPHP: values.amountPHP,
      ...deriveCurrencies(r, values),
      totalHours: values.breakdown?.totalHours ?? r.totalHours,
    };
  };

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
        // Held arrears are tracked in PHP/USD only; COP people don't accrue
        // cross-cycle arrears today, so default to 0/null.
        totalCOP: 0,
        cycles: e.cycles.map((c) => ({
          sourceFile: c.sourceFile,
          label: formatCycleLabelFromFile(c.sourceFile),
          amountPHP: c.amountPhp,
          amountUSD: c.amountUsd,
          amountCOP: null,
          paystubSentAt: c.paystubSentAt,
          lastError: c.lastError,
        })),
      });
    }
  } catch {
    /* ignore — arrears rollup is additive; queue still works without it */
  }

  // ── Contractor payees ──────────────────────────────────────────────────────
  // Second payee source: one row per approved, unclaimed contractor invoice.
  // Contractors bill by invoice and mostly have no rates row or Hubstaff hours,
  // so buildQueueFromRates can never emit them.
  //
  // Its OWN try/catch, deliberately NOT a Promise.all sibling: a rejection up
  // there would fall into the shared catch and blank the entire employee queue.
  // A contractor-side failure must degrade to "no contractor rows", nothing more.
  let contractorActive: QueueRow[] = [];
  let contractorExcluded: ExcludedRow[] = [];
  let contractorRoleEmails = new Set<string>();
  let contractorError: string | null = null;
  let contractorAdvisory: string | null = null;
  try {
    const fxForContractors = payJson.fxRate ?? 0;
    const params = new URLSearchParams();
    if (period.sourceFile) params.set('source_file', period.sourceFile);
    if (fxForContractors > 0) params.set('fx', String(fxForContractors));
    const cRes = await fetch(`/api/contractor/dispatch-queue?${params.toString()}`, {
      cache: 'no-store',
      signal,
    });
    const cJson = (await cRes.json()) as {
      active?: QueueRow[];
      excluded?: ExcludedRow[];
      contractorEmails?: string[];
      error?: string | null;
      advisory?: string | null;
    };
    contractorActive = cJson.active ?? [];
    contractorExcluded = cJson.excluded ?? [];
    contractorRoleEmails = new Set((cJson.contractorEmails ?? []).map((e) => e.trim().toLowerCase()));
    // The route answers 200-with-error so it can never blank employee payroll.
    // Surface it: otherwise a missing migration, a failed read, or an aborted
    // fetch is indistinguishable from "no approved invoices" — the queue looks
    // perfectly healthy with real money simply absent from it.
    contractorError = cJson.error?.trim() || null;
    contractorAdvisory = cJson.advisory?.trim() || null;
  } catch (e) {
    // Additive by design; employee payroll still dispatches.
    contractorError = e instanceof Error ? e.message : String(e);
  }

  /**
   * Badge hourly rows belonging to a contractor-role holder (e.g. thea@, issa@).
   *
   * Sets `contractorRole` (DISPLAY ONLY) — never `payeeKind`. Stamping payeeKind
   * here would make the POST send payee_type='contractor' with no invoice id,
   * which the API rejects 400, leaving those employees permanently unpayable.
   */
  const tagContractorRole = <T extends { id: string; email: string; contractorRole?: boolean }>(r: T): T =>
    contractorRoleEmails.has(r.id) || contractorRoleEmails.has(r.email.trim().toLowerCase())
      ? { ...r, contractorRole: true }
      : r;

  // Three outcomes END a recipient's turn in the pending queue: `paid` (money
  // moved), `problem` (flagged blocked — they belong in the Problem tab, not back
  // in pending where the next clerk would just try to send again) and `threshold`
  // (deliberately held under the payout minimum this week — the decision is made,
  // so re-offering them in pending just invites the same call again).
  // Only Not Paid leaves the person available for retry: that alone means "not
  // sent yet", not "don't send".
  // Nothing is stranded by the Problem / Threshold lock-out — clearing the row
  // from that tab (PaidRecordsPanel "Clear" → /api/payment-dispatches/undo)
  // deletes it and the person is back in pending on the next refresh.
  // Contractor settlements are excluded: this set is keyed by EMAIL and is applied
  // to the employee rows below, so a settled invoice would delete that person's
  // hourly salary row from pending, from Excluded and from the staged safety net —
  // salary still owed, silently invisible, while Done shows a green paid row against
  // their address for the invoice amount. Per-invoice payability is already enforced
  // by the contractor builder's own dispatch_id/dispatch_claimed_at query.
  // Pre-migration-safe: the column is absent from the payload, and
  // `undefined !== 'contractor'` preserves today's behaviour exactly.
  //
  // Scoped to the current cycle (the `paid` array is fetched by cycle_id), so a
  // problem logged one week never blocks the next week's pay.
  const lockedEmails = new Set(
    paid
      .filter(
        (p) =>
          (p.status === 'paid' || p.status === 'problem' || p.status === 'threshold') &&
          p.payee_type !== 'contractor',
      )
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
  // A person the Payroll Wizard locked in this cycle is authoritative — never
  // let the master-list gate drop them. This recovers employees who are staged
  // + payable but missing from active_employees (master-list sync lag, re-hire
  // row reuse). Non-staged stale rates rows are still pruned by inMaster, and
  // the staged set only contains people with hours THIS cycle, so this can't
  // resurrect off-boarded people.
  const inMasterOrStaged = <T extends { id: string; email: string }>(r: T): boolean =>
    inMaster(r) || stagedEmails.has(r.id) || stagedEmails.has(r.email.trim().toLowerCase());

  const pendingActive = active
    .filter((r) => !lockedEmails.has(r.id))
    .filter(inMasterOrStaged)
    .map(applyWizardValues)
    .map(tagContractorRole);
  const excludedBase = excluded
    .filter((r) => !lockedEmails.has(r.id))
    .filter(inMasterOrStaged)
    .map(applyWizardAmounts)
    .map(tagContractorRole);

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
        amountCOP: row.amountCOP,
        bankPreferredRaw: row.bankPreferredRaw,
        reasons: ['do_not_pay'],
        departmentKey: ex.departmentKey,
        departmentName: deptNameFromKey(ex.departmentKey),
        // Carried explicitly: this row is REBUILT field-by-field rather than
        // spread, so the badge (and the invoice link on the payable copy) would
        // otherwise be silently dropped on the way into the Excluded tab.
        contractorRole: row.contractorRole,
        payeeKind: row.payeeKind,
        contractorInvoiceId: row.contractorInvoiceId,
        invoiceNumber: row.invoiceNumber,
        payable: row,
        paystubSentAt: ex.sentAt,
      });
    } else if (row.payCurrency === 'USD') {
      movedExcluded.push(heldUsdRow(row));
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
      // Staged "do not pay" dept wins; fall back to the rates-derived dept the
      // excluded row already carries so a wizard-unassigned person still keeps
      // their real department in the filter.
      const departmentKey = ex.departmentKey ?? r.departmentKey ?? null;
      return {
        ...r,
        reasons,
        departmentKey,
        departmentName: deptNameFromKey(ex.departmentKey) ?? r.departmentName ?? null,
        paystubSentAt: ex.sentAt,
      };
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
      amountCOP: base?.amountCOP ?? null,
      bankPreferredRaw: base?.bankPreferredRaw ?? null,
      reasons: ['do_not_pay'],
      // Same reason as above — rebuilt row, so the badge must be carried over.
      contractorRole: base?.contractorRole,
      payable: base ? { ...base, amountPHP: ar.totalPHP, amountUSD: ar.totalUSD } : null,
      arrears: ar,
    });
  }

  // ── Merge the contractor payees ────────────────────────────────────────────
  // Placed AFTER the employee filters, and deliberately skipping three of them:
  //  • lockedEmails    — that filter is keyed per (email, cycle); settlement for
  //                      an invoice is per-INVOICE (contractor_invoices.dispatch_id),
  //                      already applied by the builder's query. Reusing the email
  //                      filter would hide Claire's other six approved invoices
  //                      the moment one of them was paid — or flagged a problem.
  //                      (A contractor invoice logged 'problem' therefore STAYS
  //                      payable: the API deliberately doesn't claim the invoice
  //                      for a non-paid outcome, and the marker row carries no
  //                      invoice id to filter on.)
  //  • inMasterOrStaged — a contractor need not be on the master list at all.
  //  • applyWizardFinal — that overlay is the wizard's HOURLY final pay, keyed by
  //                      email. Claire/Carla also have employee identities, so it
  //                      could silently overwrite an invoice total.
  for (const r of contractorActive) pendingQueue.push(r);
  pendingQueue.sort((a, b) => a.name.localeCompare(b.name));
  for (const r of contractorExcluded) withArrears.push(r);
  withArrears.sort((a, b) => a.name.localeCompare(b.name));

  // ── Safety-net: never let a wizard-locked person vanish ────────────────────
  // The queue above is built from employee_hourly_rates. Anyone the wizard
  // locked in (staged) whose pay came from the employee/department CATALOG has
  // no rates row, so buildQueueFromRates never emitted them — they'd disappear
  // from Payment Dispatch entirely despite being owed money. Place every staged
  // person we haven't already placed (pending / excluded / locked) via
  // buildStagedOnlyPlacement, which routes them on their employee_ids bank pick
  // exactly like a rates-row payee: payable when a processor resolves, otherwise
  // Excluded with the real reason ('no_bank' / 'no_pay', + 'do_not_pay' when the
  // wizard excluded them in validation).
  //
  // These rows used to be synthesized from the staged paystub alone — no
  // employee_ids lookup — so they ALWAYS read "No bank" + "No rate on file" and
  // were never payable, even with complete bank details on the People tab. That
  // stranded 7 people (₱59,911) in the 2026-07-19 cycle alone.
  //
  // Contractor rows are skipped when seeding it: an approved INVOICE says nothing
  // about whether that person's staged hourly pay has been placed, so counting it
  // as "represented" would silently drop their catalog-paid salary row from the
  // Excluded tab. The two populations do overlap — holding the contractor role is
  // what lets thea@/issa@ invoice at all.
  const representedEmails = new Set<string>();
  for (const r of pendingQueue) {
    if (r.payeeKind === 'contractor') continue;
    representedEmails.add(r.id);
    representedEmails.add(r.email.trim().toLowerCase());
  }
  for (const r of withArrears) {
    if (r.payeeKind === 'contractor') continue;
    representedEmails.add(r.id);
    representedEmails.add(r.email.trim().toLowerCase());
  }
  for (const e of lockedEmails) representedEmails.add(e);
  const payByEmail = payJson.byEmail ?? {};
  let promotedStaged = 0;
  for (const s of stagedItems) {
    const email = s.recipient_email.trim().toLowerCase();
    const personal = s.personal_email?.trim().toLowerCase() ?? null;
    if (representedEmails.has(email) || (personal && representedEmails.has(personal))) continue;
    representedEmails.add(email);
    const placement = buildStagedOnlyPlacement({
      staged: s,
      idsRow: idsByEmail.get(email) ?? (personal ? idsByEmail.get(personal) : undefined),
      pay: payByEmail[email] ?? (personal ? payByEmail[personal] : undefined),
      contractorRole:
        contractorRoleEmails.has(email) || (personal ? contractorRoleEmails.has(personal) : false),
    });
    if (placement.kind === 'pending' && placement.row.payCurrency === 'USD') {
      // Same hold as the rates-row path above. This branch matters MORE than that
      // one: a US payee is catalog-paid precisely because they have no rates row,
      // so the staged safety net is the way most of them reach this queue at all.
      withArrears.push(heldUsdRow(placement.row));
    } else if (placement.kind === 'pending') {
      // Same overlay as every other pending row, so the staged-only population
      // (catalog-paid people with no rates row) is priced and itemized by the same
      // precedence rather than a second, looser one.
      pendingQueue.push(applyWizardValues(placement.row));
      promotedStaged += 1;
    } else {
      withArrears.push(placement.row);
    }
  }
  // Both arrays were sorted before the safety net appended to them.
  if (promotedStaged > 0) pendingQueue.sort((a, b) => a.name.localeCompare(b.name));
  withArrears.sort((a, b) => a.name.localeCompare(b.name));

  // ── Sub-₱7k wires → Wise (this cycle only) ────────────────────────────────
  // Owner rule (2026-07-29): a wires person whose FINAL pay this week is under
  // ₱7,000 is paid through Wise this week instead. Nothing is written back to
  // employee_ids — the flip is recomputed from each week's amount, so a ≥₱7k
  // week lands them back in the Wires tab on its own. Applied LAST, after the
  // wizard-final overlay, the arrears rollup and the staged safety net, because
  // the decision keys on the amount actually being sent. Excluded rows carry
  // the reroute on their `payable` copy so the "Pay now" path and the Excluded
  // tab's bank label follow the same rule. Contractor settlements and USD/COP
  // payees are exempt inside the helper.
  const routedPending = pendingQueue.map(applySmallWiresWiseReroute);
  const routedExcluded = withArrears.map((r) =>
    r.payable ? { ...r, payable: applySmallWiresWiseReroute(r.payable) } : r,
  );

  // ── Say it out loud when the amounts aren't the wizard's ───────────────────
  // Ordered worst-first: an unreadable carrier means the whole week may be priced
  // off the recompute; the per-row notes name who to check.
  const valuesWarning = ((): string | null => {
    if (!wizardReady) return null; // no queue on screen to be wrong about
    const parts: string[] = [];
    if (valuesError) {
      parts.push(
        `Couldn't read the Payroll Wizard's published pay for this week (${valuesError}) — ` +
          `amounts fall back to the locked values, or to a recomputation that excludes ` +
          `Adjustments, Orphanage pay, KPI/dept bonuses and MESA. Reload before sending.`,
      );
    }
    if (stagedError) {
      parts.push(`Couldn't read this week's locked payroll values (${stagedError}).`);
    }
    if (staleRateRows.length > 0) {
      parts.push(
        `${staleRateRows.length} ${staleRateRows.length === 1 ? 'row was' : 'rows were'} priced from the ` +
          `LOCKED values because the wizard's published figures contradict the Payment Catalog rate ` +
          `(stale wizard session — reload the wizard and re-lock the week): ${namesFor(staleRateRows)}.`,
      );
    }
    if (unpricedByWizard.length > 0) {
      parts.push(
        `${unpricedByWizard.length} locked-in ${unpricedByWizard.length === 1 ? 'payee is' : 'payees are'} ` +
          `showing a RECOMPUTED amount — the wizard published no usable figure for ` +
          `${namesFor(unpricedByWizard)}. Re-lock the week in the Payroll Wizard.`,
      );
    }
    if (repricedAfterLock.length > 0) {
      parts.push(
        `The wizard re-priced ${repricedAfterLock.length} ` +
          `${repricedAfterLock.length === 1 ? 'payee' : 'payees'} AFTER the values were locked; the newer ` +
          `figure is shown (${namesFor(repricedAfterLock)}). Re-lock to make the locked values match.`,
      );
    }
    return parts.length > 0 ? parts.join(' ') : null;
  })();

  // ── Department by email, for the whole cycle ───────────────────────────────
  // The dispatch-log views (Paid / Not paid / Threshold / Problem / Done) need a
  // department per RECORD, and `payment_dispatches` has no department column: a
  // paid person is filtered out of `rows`, so their department would otherwise be
  // unknowable on screen. Built here, from the same sources the queue rows use, so
  // one person reads the same department before and after a Mark Paid.
  //
  // Precedence is the Excluded tab's (staged wizard dept wins, then the queue's own
  // resolution, then the pay layer) — first write wins, so the sources are visited
  // in that order. Work AND personal email are indexed because a dispatch can be
  // recorded against either. A payee no source can place stays absent and reads as
  // "No department" downstream; it is never a reason to hide the row.
  const deptByEmail: Record<string, string> = {};
  const noteDept = (email: string | null | undefined, name: string | null | undefined) => {
    const key = email?.trim().toLowerCase();
    const label = name?.trim();
    if (!key || !label) return;
    if (deptByEmail[key] == null) deptByEmail[key] = label;
  };
  for (const s of stagedItems) {
    const name = deptNameFromKey(s.department_key);
    noteDept(s.recipient_email, name);
    noteDept(s.personal_email, name);
  }
  // `active` / `excluded` are the pre-filter builds, so they still carry the people
  // who have already been paid — precisely the ones the log views are about.
  for (const r of [...active, ...excluded]) {
    noteDept(r.id, r.departmentName);
    noteDept(r.email, r.departmentName);
  }
  for (const [email, entry] of Object.entries(payByEmail)) {
    noteDept(email, entry?.departmentName ?? null);
  }

  return {
    // Until the wizard locks this cycle, Payment Dispatch shows NO queue data —
    // just the "not ready" note. (Reports / Urgent / Orphanage are separate and
    // not gated by this in the component.)
    rows: wizardReady ? routedPending : [],
    excluded: wizardReady ? routedExcluded : [],
    paid: wizardReady ? paid : [],
    // Not gated on `wizardReady`: it labels whatever records ARE on screen, and an
    // empty queue simply means nothing looks it up.
    deptByEmail,
    period,
    fxRate: payJson.fxRate ?? 0,
    wizardReady,
    error: null,
    contractorError,
    contractorAdvisory,
    valuesWarning,
  };
}

/** "a@x, b@x + 3 more" — bounded so a whole-cycle problem stays readable. */
function namesFor(emails: string[], max = 3): string {
  const head = emails.slice(0, max).join(', ');
  return emails.length > max ? `${head} + ${emails.length - max} more` : head;
}

/**
 * Loads the dispatch queue. Joins:
 *  1. employee_hourly_rates  → who's eligible + their bank-preferred + contact
 *  2. /api/payroll-current-pay → per-person USD/PHP from the latest CSV
 *  3. payment_dispatches      → who already got paid this cycle (filtered out)
 *
 * Returns a `refresh()` callback so callers can re-pull after Mark paid.
 */
/**
 * @param sourceFile  Optional past pay-week to view instead of the live cycle
 *   (the Payment Dispatch CSV selector sets this). `null`/undefined = current
 *   `is_current` cycle. The cache is keyed per source file so switching weeks
 *   never paints another week's queue.
 */
export function useDispatchQueue(sourceFile?: string | null): DispatchQueueState {
  const sel = sourceFile?.trim() || null;
  // Per-week cache key: the live cycle keeps the bare key (so the common path is
  // unchanged); a selected past week gets its own slot.
  const cacheKey = sel ? `${TAB_CACHE_KEYS.dispatchQueue}:${sel}` : TAB_CACHE_KEYS.dispatchQueue;

  // Seed from the in-session cache so switching back to the dispatch tab paints
  // the last-known queue instantly instead of a skeleton; we still revalidate.
  const [state, setState] = useState<Omit<DispatchQueueState, 'refresh'>>(() => seedState(cacheKey));

  const load = useCallback(async (signal?: AbortSignal, opts?: { silent?: boolean }) => {
    // Silent refreshes (post-action reconciliation, or a cache-backed remount)
    // skip the loading flag so the table isn't torn down to a skeleton and
    // re-mounted — no visible reload.
    if (!opts?.silent) setState((s) => ({ ...s, loading: true }));
    try {
      const result = await loadAll(signal, sel);
      if (signal?.aborted) return;
      // Only cache clean loads — an errored result shouldn't overwrite good data.
      if (!result.error) {
        setTabCache<CachedQueue>(cacheKey, {
          rows: result.rows,
          excluded: result.excluded,
          paid: result.paid,
          deptByEmail: result.deptByEmail,
          period: result.period,
          fxRate: result.fxRate,
          wizardReady: result.wizardReady,
          valuesWarning: result.valuesWarning,
        });
      }
      setState({
        rows: result.rows,
        excluded: result.excluded,
        paid: result.paid,
        deptByEmail: result.deptByEmail,
        period: result.period,
        fxRate: result.fxRate,
        wizardReady: result.wizardReady,
        loading: false,
        error: result.error,
        contractorError: result.contractorError,
        contractorAdvisory: result.contractorAdvisory,
        valuesWarning: result.valuesWarning,
      });
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof DOMException && e.name === 'AbortError') return;
      // A background revalidation that fails should keep the last good data on
      // screen rather than blanking the queue.
      if (opts?.silent && hasTabCache(cacheKey)) {
        setState((s) => ({ ...s, loading: false }));
        return;
      }
      setState({
        rows: [],
        excluded: [],
        paid: [],
        deptByEmail: {},
        period: EMPTY_PERIOD,
        fxRate: 0,
        wizardReady: true,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load dispatch queue',
        contractorError: null,
        contractorAdvisory: null,
        valuesWarning: null,
      });
    }
  }, [sel, cacheKey]);

  const mountedRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    // On a week SWITCH (cacheKey changed after mount), immediately re-seed the
    // visible state from the NEW week's cache (or a blank shell) so the previous
    // week's rows can never linger on screen while the async load runs — even on
    // a silent warm-cache revalidate. Mount is already seeded by useState.
    if (mountedRef.current) setState(seedState(cacheKey));
    else mountedRef.current = true;
    void load(controller.signal, { silent: hasTabCache(cacheKey) });
    return () => controller.abort();
  }, [load, cacheKey]);

  // ── Live sync across every open dispatch screen ────────────────────────────
  // Marking someone paid used to move ONLY the browser that did it: the queue had
  // no subscription and no poll, so a second clerk (or Carla watching the progress
  // strip) saw a stale pending count until they reloaded the page.
  //
  // Realtime here means **Broadcast**, not `postgres_changes`. The browser client
  // connects as `anon` and `payment_dispatches` is RLS-protected, so row-change
  // events never reach it — the lesson already paid for by the CEO
  // "Payments to send" card (see usePaymentsLive: the app_settings pulse silently
  // never fired). Broadcast is a pub/sub bus that never touches the DB or RLS, so
  // it reaches every subscriber.
  //
  // Two paths, deliberately independent:
  //  1. Broadcast — instant, and the only sub-second path that actually works.
  //  2. A cheap `?signature=1` poll + a refetch on tab focus — covers a screen
  //     whose socket is down, or a change made outside this app (SQL, a cron, an
  //     n8n retry) that no browser broadcast.
  const broadcastRef = useRef<((sourceFile: string | null) => void) | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The cycle currently on screen, for the broadcast filter and the poll below.
  // Refs, so neither has to re-subscribe when unrelated state changes.
  const stateSourceFileRef = useRef<string | null>(null);
  stateSourceFileRef.current = state.period.sourceFile;
  const cycleIdRef = useRef<string | null>(null);
  cycleIdRef.current = state.period.cycleId;
  const signatureRef = useRef<string | null>(null);
  /** Reload WITHOUT announcing it — the remote-change path, so two screens can't
   *  ping-pong broadcasts at each other forever. */
  const reloadQuietly = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void load(undefined, { silent: true });
    }, DISPATCH_SYNC_DEBOUNCE_MS);
  }, [load]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase.channel(DISPATCH_SYNC_CHANNEL, {
      // Our own writes are already reflected locally by refresh(); hearing them
      // back would just double the work.
      config: { broadcast: { self: false } },
    });
    channel.on('broadcast', { event: DISPATCH_SYNC_EVENT }, ({ payload }) => {
      const p = (payload ?? {}) as { sourceFile?: string | null };
      // Ignore another week's activity — a clerk on a past week must not have
      // their view yanked by the live cycle being paid.
      const other = typeof p.sourceFile === 'string' ? p.sourceFile : null;
      if (other && sel && other !== sel) return;
      if (other && !sel && other !== stateSourceFileRef.current) return;
      reloadQuietly();
    });
    channel.subscribe((status, err) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // eslint-disable-next-line no-console
        console.warn(
          `[dispatch-queue] Realtime ${status} — falling back to the ` +
            `${DISPATCH_POLL_INTERVAL_MS / 1000}s signature poll.`,
          err,
        );
      }
    });
    broadcastRef.current = (sourceFile) => {
      void channel.send({
        type: 'broadcast',
        event: DISPATCH_SYNC_EVENT,
        payload: { sourceFile, ts: Date.now() },
      });
    };
    return () => {
      broadcastRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [sel, reloadQuietly]);

  // Fallback poll: ask ONLY "did anything change?" (count + newest timestamp) and
  // reload the queue when the answer differs. Skipped while the tab is hidden —
  // the focus listener catches up on return, so a background tab costs nothing.
  useEffect(() => {
    const checkSignature = async () => {
      const cycleId = cycleIdRef.current;
      if (!cycleId) return;
      try {
        const res = await fetch(
          `/api/payment-dispatches?cycle_id=${encodeURIComponent(cycleId)}&signature=1`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const json = (await res.json()) as { count?: number; latest?: string | null; error?: string | null };
        if (json.error) return;
        const next = `${json.count ?? 0}|${json.latest ?? ''}`;
        const prev = signatureRef.current;
        signatureRef.current = next;
        // First observation only establishes the baseline — the queue it belongs
        // to was just loaded, so there is nothing to reconcile.
        if (prev !== null && prev !== next) reloadQuietly();
      } catch {
        /* offline / aborted — the next tick tries again */
      }
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void checkSignature();
    }, DISPATCH_POLL_INTERVAL_MS);
    const onFocus = () => void checkSignature();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reloadQuietly]);

  // A LOCAL action (mark paid, undo, a wizard lock flip) reloads this screen and
  // tells every other open screen to do the same.
  const refresh = useCallback(async () => {
    signatureRef.current = null; // re-baseline; our own write must not read as remote
    // Announce FIRST: the other screens' reload runs in parallel with ours instead
    // of queueing behind it, so their counters move within ~a second of the click.
    broadcastRef.current?.(stateSourceFileRef.current);
    await load(undefined, { silent: true });
  }, [load]);

  return { ...state, refresh };
}
