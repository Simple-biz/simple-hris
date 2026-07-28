'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Re-pulls dispatches + queue. Call after Mark paid succeeds. */
  refresh: () => Promise<void>;
}

const EMPTY_PERIOD: PayrollPeriod = {
  cycleId: null,
  start: null,
  end: null,
  sourceFile: null,
};

/** Build the visible state for a cache key — the last-known queue for that week
 *  (instant paint) or a blank loading shell when the week hasn't been seen. */
function seedState(cacheKey: string): Omit<DispatchQueueState, 'refresh'> {
  const cached = getTabCache<CachedQueue>(cacheKey);
  return {
    rows: cached?.rows ?? [],
    excluded: cached?.excluded ?? [],
    paid: cached?.paid ?? [],
    period: cached?.period ?? EMPTY_PERIOD,
    fxRate: cached?.fxRate ?? 0,
    wizardReady: cached?.wizardReady ?? true,
    loading: cached === undefined,
    error: null,
    contractorError: null,
    contractorAdvisory: null,
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
  period: PayrollPeriod;
  fxRate: number;
  wizardReady: boolean;
  error: string | null;
  /** Contractor-side failure, if any. Never blanks the employee queue. */
  contractorError: string | null;
  /** Advisory on a SUCCESSFUL contractor load (e.g. invoices stuck mid-dispatch). */
  contractorAdvisory: string | null;
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
      period: EMPTY_PERIOD,
      fxRate: 0,
      wizardReady: true,
      error: ratesJson.error,
      contractorError: null,
      contractorAdvisory: null,
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
  // USD anchor for re-deriving a COP person's native amount when the wizard
  // overrides their final PHP pay (COP = USD-equivalent × usd_to_cop_rate).
  const usdToCop = payJson.fxRates?.usdToCop ?? 0;
  const applyWizardFinal = <
    T extends { id: string; amountPHP: number | null; amountUSD: number | null; amountCOP: number | null },
  >(r: T): T => {
    const f = wizardFinalByEmail[r.id];
    if (typeof f !== 'number') return r;
    const newUsd = fx > 0 ? Math.round((f / fx) * 100) / 100 : r.amountUSD;
    // Only COP-paid rows carry a non-null amountCOP; keep it in step with the override.
    const newCop =
      r.amountCOP != null && newUsd != null && usdToCop > 0 ? Math.round(newUsd * usdToCop) : r.amountCOP;
    return {
      ...r,
      amountPHP: f,
      amountUSD: newUsd,
      amountCOP: newCop,
    };
  };

  // Payroll Wizard "do not pay" exclusions for this cycle. People accounting
  // excluded from pay are moved out of the pending queue into the Excluded tab
  // (still payable from there — paying them logs the dispatch + sends their
  // staged paystub). Keyed by lowercased work email; carries the last paystub
  // send timestamp for a per-row badge.
  const wizardExcluded = new Map<string, { sentAt: string | null; departmentKey: string | null }>();
  // Every email the Payroll Wizard LOCKED IN for this cycle (payable AND
  // excluded). This staged set is the payroll-authoritative payee list — anyone
  // the wizard locked in must appear in Payment Dispatch. We use it below to
  // (1) stop the master-list gate from dropping people the wizard already
  // vouched for (re-hires / sync-lagged employees not yet in active_employees),
  // and (2) as a safety-net: synthesize a row for anyone locked in that the
  // rates-only queue build couldn't produce, so nobody ever silently vanishes.
  const stagedEmails = new Set<string>();
  const stagedItems: PaystubQueueListItem[] = [];
  if (period.sourceFile) {
    try {
      const stageRes = await fetch(
        `/api/paystub-dispatch-queue?source_file=${encodeURIComponent(period.sourceFile)}`,
        { cache: 'no-store', signal },
      );
      const stageJson = (await stageRes.json()) as { rows?: PaystubQueueListItem[] };
      for (const r of stageJson.rows ?? []) {
        stagedItems.push(r);
        const re = r.recipient_email?.trim().toLowerCase();
        if (re) stagedEmails.add(re);
        if (r.personal_email) stagedEmails.add(r.personal_email.trim().toLowerCase());
        if (r.excluded) {
          wizardExcluded.set(r.recipient_email.trim().toLowerCase(), {
            sentAt: r.sent_at,
            departmentKey: r.department_key ?? null,
          });
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

  // Only `status='paid'` rows lock a recipient out of the pending queue —
  // Threshold and Problem rows leave the person available for retry, since
  // money never actually moved for those.
  // Contractor settlements are excluded: this set is keyed by EMAIL and is applied
  // to the employee rows below, so a settled invoice would delete that person's
  // hourly salary row from pending, from Excluded and from the staged safety net —
  // salary still owed, silently invisible, while Done shows a green paid row against
  // their address for the invoice amount. Per-invoice payability is already enforced
  // by the contractor builder's own dispatch_id/dispatch_claimed_at query.
  // Pre-migration-safe: the column is absent from the payload, and
  // `undefined !== 'contractor'` preserves today's behaviour exactly.
  const paidEmails = new Set(
    paid
      .filter((p) => p.status === 'paid' && p.payee_type !== 'contractor')
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
    .filter((r) => !paidEmails.has(r.id))
    .filter(inMasterOrStaged)
    .map(applyWizardFinal)
    .map(tagContractorRole);
  const excludedBase = excluded
    .filter((r) => !paidEmails.has(r.id))
    .filter(inMasterOrStaged)
    .map(applyWizardFinal)
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
  //  • paidEmails      — that filter is keyed per (email, cycle); settlement for
  //                      an invoice is per-INVOICE (contractor_invoices.dispatch_id),
  //                      already applied by the builder's query. Reusing the email
  //                      filter would hide Claire's other six approved invoices
  //                      the moment one of them was paid.
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
  // from Payment Dispatch entirely despite being owed money. Surface every
  // staged person we haven't already placed (pending / excluded / paid) into the
  // Excluded tab, flagged 'no_rate' (+ 'do_not_pay' when the wizard excluded
  // them in validation), so accounting can see them and set up a rate/bank.
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
  for (const e of paidEmails) representedEmails.add(e);
  for (const s of stagedItems) {
    const email = s.recipient_email.trim().toLowerCase();
    const personal = s.personal_email?.trim().toLowerCase() ?? null;
    if (representedEmails.has(email) || (personal && representedEmails.has(personal))) continue;
    representedEmails.add(email);
    const reasons: ExclusionReason[] = ['no_rate'];
    if (s.excluded) reasons.push('do_not_pay');
    withArrears.push({
      id: email,
      name: s.recipient_name?.trim() || s.recipient_email,
      email: s.recipient_email,
      totalHours: null,
      amountUSD: s.amount_usd,
      amountPHP: s.amount_php,
      amountCOP: null,
      bankPreferredRaw: null,
      reasons,
      departmentKey: s.department_key ?? null,
      departmentName: deptNameFromKey(s.department_key),
      contractorRole: contractorRoleEmails.has(email) || (personal ? contractorRoleEmails.has(personal) : false),
      payable: null,
      paystubSentAt: s.sent_at,
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
    contractorError,
    contractorAdvisory,
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
        contractorError: result.contractorError,
        contractorAdvisory: result.contractorAdvisory,
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
        period: EMPTY_PERIOD,
        fxRate: 0,
        wizardReady: true,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load dispatch queue',
        contractorError: null,
        contractorAdvisory: null,
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

  const refresh = useCallback(async () => {
    await load(undefined, { silent: true });
  }, [load]);

  return { ...state, refresh };
}
