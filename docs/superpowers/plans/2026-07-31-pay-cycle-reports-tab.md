# Pay Cycle Reports Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Reports** tab to Accounting → Documents where the team publishes a frozen, exportable pay-cycle report (who got paid) via a prominent manual "payment cycle complete" button.

**Architecture:** Three layers, each in its own file. A **pure** snapshot/eligibility module (no I/O, fully unit-tested) decides when a cycle is complete and shapes the frozen record. A **server-only** persistence module stores one JSON snapshot per cycle in `app_settings` — zero DDL. A **client** export module renders CSV/XLSX/PDF from that snapshot in the browser, mirroring the existing `transfers-export.ts`. Four API routes join them; two React components render the tab.

**Tech Stack:** Next.js 16 App Router · React 19 · TypeScript 5.8 · Tailwind 4 · Supabase (service-role) · `xlsx` (SheetJS 0.18) · `pdf-lib` 1.17 · `motion` · `lucide-react` · `sonner` toasts · tests via `node --import tsx --test`

**Spec:** [docs/superpowers/specs/2026-07-31-pay-cycle-reports-tab-design.md](../specs/2026-07-31-pay-cycle-reports-tab-design.md)

## Global Constraints

- **No DDL.** Nothing in this feature may require a SQL migration. Storage is `app_settings` rows only.
- **Key format:** `documents.pay_cycle_report.<source_file>` — prefix constant `PAY_CYCLE_REPORT_PREFIX = 'documents.pay_cycle_report.'`.
- **Snapshot `version` is `1`.** Readers tolerate other versions rather than throwing.
- **Auth gate:** `requireFeatureAccess('accounting', 'documents', 'view')` on reads, `'edit'` on publish/unpublish. No new permission, no new role.
- **`urgent_*` cycles are excluded** from publishing entirely (they are one-off payouts, not pay cycles). Detect with `isUrgentSourceFile` from `@/lib/payroll/urgent-cycle`.
- **Never `upsert` a published report** — plain `INSERT` only, so a duplicate key (`23505`) is what prevents double-publishing.
- **PostgREST 1000-row cap:** any un-ranged Supabase read of a table that can exceed 1000 rows must use `selectAllPaged` from `@/lib/supabase/select-all-paged`.
- **pdf-lib Helvetica is WinAnsi-encoded.** All PDF text goes through a `sanitize()` that maps `₱`→`PHP `, `→`→`->`, `—`→`-`, smart quotes→ASCII, `…`→`...`, anything else outside 32–126/160–255 → `?`.
- **Money formatting:** USD `$1,234.56`, PHP `₱1,234.56` — 2 decimals, `en-US`/`en-PH` grouping.
- **Commit locally only. Never `git push`** — Kane handles pushing. Stage only the files each task names (this repo is a shared checkout).
- **Lint gate:** `npm run lint` is `tsc --noEmit` and must pass before each commit.

---

### Task 1: Pure snapshot model + completeness rule

The only logic worth testing in isolation: *is this cycle finished?* and *what exactly gets frozen?* Keeping it free of Supabase and `server-only` means the test file can call it directly with plain objects.

**Files:**
- Create: `src/lib/accounting/pay-cycle-report-snapshot.ts`
- Test: `src/lib/accounting/pay-cycle-report-snapshot.test.ts`

**Interfaces:**
- Consumes: `DisbursementReportSummary`, `DisbursementReportTotals` (types) from `@/lib/payroll/disbursement-reports`; `PaymentDispatchRow` from `@/lib/supabase/payment-dispatches`; `ProcessorId` from `@/components/payroll-clerk/mock-queue`.
- Produces:
  - `PAY_CYCLE_REPORT_VERSION = 1`
  - `interface PayCycleReportPayee { name: string | null; email: string; payeeType: 'employee' | 'contractor'; processor: string; amountUSD: number; amountPHP: number; transactionId: string | null; bankUsed: string | null; dateSent: string | null; arrivalDate: string | null }`
  - `interface PayCycleReportTotals { payeeCount: number; employeeCount: number; contractorCount: number; dispatchCount: number; paidUSD: number; paidPHP: number }`
  - `interface PayCycleReportSnapshot { version: number; published_at: string; published_by: string; published_by_email: string; source_file: string; cycle_id: string; label: string; period_start: string | null; period_end: string | null; totals: PayCycleReportTotals; byProcessor: Record<string, { count: number; usd: number; php: number }>; payees: PayCycleReportPayee[] }`
  - `type PayCycleReportSummary = Omit<PayCycleReportSnapshot, 'payees'>`
  - `interface CycleCompleteness { complete: boolean; paidCount: number; pendingCount: number; blockedCount: number }`
  - `function cycleCompleteness(totals: DisbursementReportTotals): CycleCompleteness`
  - `function isPublishableCycle(summary: Pick<DisbursementReportSummary, 'sourceFile' | 'totals'>): boolean`
  - `function buildPayCycleReportSnapshot(input: { summary: DisbursementReportSummary; dispatches: PaymentDispatchRow[]; publishedBy: string; publishedByEmail: string; publishedAt: string }): PayCycleReportSnapshot`
  - `function toPayCycleReportSummary(snap: PayCycleReportSnapshot): PayCycleReportSummary`

- [ ] **Step 1: Write the failing test**

Create `src/lib/accounting/pay-cycle-report-snapshot.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_CYCLE_REPORT_VERSION,
  buildPayCycleReportSnapshot,
  cycleCompleteness,
  isPublishableCycle,
  toPayCycleReportSummary,
} from './pay-cycle-report-snapshot';
import type { DisbursementReportSummary, DisbursementReportTotals } from '@/lib/payroll/disbursement-reports';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

function totals(over: Partial<DisbursementReportTotals> = {}): DisbursementReportTotals {
  return {
    paidCount: 10, paidUSD: 1000, paidPHP: 56000,
    notPaidCount: 0, thresholdCount: 0, problemCount: 0,
    pendingDispatchedUSD: 0, sentCount: 10, totalDispatchedUSD: 1000,
    outstandingCount: 0, outstandingUSD: 0,
    totalRecipients: 10, totalOwedUSD: 1000,
    ...over,
  };
}

function summary(over: Partial<DisbursementReportSummary> = {}): DisbursementReportSummary {
  return {
    cycleId: 'upload-1',
    periodStart: '2026-07-26',
    periodEnd: '2026-08-01',
    sourceFile: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    uploadedAt: '2026-08-01T02:00:00.000Z',
    uploadedBy: 'carla@simple.biz',
    rowCount: 10,
    isCurrent: true,
    reportName: 'Jul 26 - Aug 1, 2026',
    totals: totals(),
    byProcessor: {},
    paidRecipients: [],
    ...over,
  };
}

function dispatch(over: Partial<PaymentDispatchRow> = {}): PaymentDispatchRow {
  return {
    id: 'd1',
    recipient_email: 'juan@simple.biz',
    recipient_name: 'Juan Santos',
    processor: 'hurupay',
    amount_usd: 100,
    amount_php: 5600,
    transaction_id: 'TXN-1',
    bank_used: 'Hurupay',
    sent_date: '2026-08-01',
    arrival_date: '2026-08-02',
    status: 'paid',
    payee_type: 'employee',
    cycle_source_file: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    ...over,
  } as PaymentDispatchRow;
}

describe('cycleCompleteness', () => {
  test('a fully paid cycle is complete', () => {
    const c = cycleCompleteness(totals());
    assert.equal(c.complete, true);
    assert.equal(c.paidCount, 10);
    assert.equal(c.pendingCount, 0);
    assert.equal(c.blockedCount, 0);
  });

  test('each blocking bucket alone keeps it incomplete', () => {
    for (const key of ['notPaidCount', 'thresholdCount', 'outstandingCount'] as const) {
      const c = cycleCompleteness(totals({ [key]: 3 }));
      assert.equal(c.complete, false, `${key} should block completion`);
      assert.equal(c.pendingCount, 3, `${key} counts as pending`);
    }
  });

  test('problem rows count as blocked, not pending', () => {
    const c = cycleCompleteness(totals({ problemCount: 2 }));
    assert.equal(c.complete, false);
    assert.equal(c.blockedCount, 2);
    assert.equal(c.pendingCount, 0);
  });

  test('a cycle with nothing paid is never complete', () => {
    assert.equal(cycleCompleteness(totals({ paidCount: 0, sentCount: 0 })).complete, false);
  });
});

describe('isPublishableCycle', () => {
  test('a complete regular cycle is publishable', () => {
    assert.equal(isPublishableCycle(summary()), true);
  });

  test('urgent cycles are never publishable', () => {
    assert.equal(isPublishableCycle(summary({ sourceFile: 'urgent_2026-07-26' })), false);
  });

  test('a cycle with no source file is never publishable', () => {
    assert.equal(isPublishableCycle(summary({ sourceFile: null })), false);
  });
});

describe('buildPayCycleReportSnapshot', () => {
  const base = {
    publishedBy: 'Carla Dela Cruz',
    publishedByEmail: 'carla@simple.biz',
    publishedAt: '2026-08-02T01:00:00.000Z',
  };

  test('freezes identity, version and publisher', () => {
    const snap = buildPayCycleReportSnapshot({ summary: summary(), dispatches: [dispatch()], ...base });
    assert.equal(snap.version, PAY_CYCLE_REPORT_VERSION);
    assert.equal(snap.published_by, 'Carla Dela Cruz');
    assert.equal(snap.published_by_email, 'carla@simple.biz');
    assert.equal(snap.published_at, '2026-08-02T01:00:00.000Z');
    assert.equal(snap.source_file, 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv');
    assert.equal(snap.cycle_id, 'upload-1');
    assert.equal(snap.label, 'Jul 26 - Aug 1, 2026');
    assert.equal(snap.period_start, '2026-07-26');
    assert.equal(snap.period_end, '2026-08-01');
  });

  test('keeps only paid dispatches, one payee row each', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', transaction_id: 'TXN-A' }),
        dispatch({ id: 'b', status: 'not_paid', transaction_id: 'TXN-B' }),
        dispatch({ id: 'c', status: 'problem', transaction_id: 'TXN-C' }),
      ],
      ...base,
    });
    assert.equal(snap.payees.length, 1);
    assert.equal(snap.payees[0].transactionId, 'TXN-A');
    assert.equal(snap.totals.dispatchCount, 1);
  });

  test('payeeCount is distinct employees plus one per contractor invoice', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', recipient_email: 'Juan@simple.biz', amount_usd: 60 }),
        dispatch({ id: 'b', recipient_email: 'juan@simple.biz ', amount_usd: 40 }),
        dispatch({ id: 'c', recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 500 }),
        dispatch({ id: 'd', recipient_email: 'claire@agency.com', payee_type: 'contractor', amount_usd: 700 }),
      ],
      ...base,
    });
    // Juan collapses to 1; Claire's two invoices stay 2.
    assert.equal(snap.totals.payeeCount, 3);
    assert.equal(snap.totals.employeeCount, 1);
    assert.equal(snap.totals.contractorCount, 2);
    // Every dispatch is still its own traceable row.
    assert.equal(snap.payees.length, 4);
    assert.equal(snap.totals.dispatchCount, 4);
    assert.equal(snap.totals.paidUSD, 1300);
  });

  test('tallies per processor and sums both currencies', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', processor: 'hurupay', amount_usd: 100, amount_php: 5600 }),
        dispatch({ id: 'b', processor: 'hurupay', amount_usd: 50, amount_php: 2800, recipient_email: 'b@simple.biz' }),
        dispatch({ id: 'c', processor: 'wise', amount_usd: 25, amount_php: 1400, recipient_email: 'c@simple.biz' }),
      ],
      ...base,
    });
    assert.deepEqual(snap.byProcessor.hurupay, { count: 2, usd: 150, php: 8400 });
    assert.deepEqual(snap.byProcessor.wise, { count: 1, usd: 25, php: 1400 });
    assert.equal(snap.totals.paidUSD, 175);
    assert.equal(snap.totals.paidPHP, 9800);
  });

  test('null money and blank txn ids normalize instead of producing NaN', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [dispatch({ amount_usd: null, amount_php: null, transaction_id: '  ', bank_used: '' })],
      ...base,
    });
    assert.equal(snap.totals.paidUSD, 0);
    assert.equal(snap.totals.paidPHP, 0);
    assert.equal(snap.payees[0].transactionId, null);
    assert.equal(snap.payees[0].bankUsed, null);
  });

  test('payees sort by name, unnamed last', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [
        dispatch({ id: 'a', recipient_name: 'Zoe', recipient_email: 'z@simple.biz' }),
        dispatch({ id: 'b', recipient_name: null, recipient_email: 'anon@simple.biz' }),
        dispatch({ id: 'c', recipient_name: 'Abel', recipient_email: 'a@simple.biz' }),
      ],
      ...base,
    });
    assert.deepEqual(snap.payees.map((p) => p.email), ['a@simple.biz', 'z@simple.biz', 'anon@simple.biz']);
  });
});

describe('toPayCycleReportSummary', () => {
  test('drops the payees array and keeps everything else', () => {
    const snap = buildPayCycleReportSnapshot({
      summary: summary(),
      dispatches: [dispatch()],
      publishedBy: 'Carla',
      publishedByEmail: 'carla@simple.biz',
      publishedAt: '2026-08-02T01:00:00.000Z',
    });
    const sum = toPayCycleReportSummary(snap);
    assert.equal('payees' in sum, false);
    assert.equal(sum.totals.payeeCount, snap.totals.payeeCount);
    assert.equal(sum.source_file, snap.source_file);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="cycleCompleteness|isPublishableCycle|buildPayCycleReportSnapshot|toPayCycleReportSummary"`
Expected: FAIL — cannot resolve `./pay-cycle-report-snapshot`.

(If the `--test-name-pattern` passthrough is awkward, plain `npm test` also works — it runs every `src/**/*.test.ts`. Use whichever gives readable output.)

- [ ] **Step 3: Write the implementation**

Create `src/lib/accounting/pay-cycle-report-snapshot.ts`:

```ts
/**
 * Pay Cycle Report — the frozen record Accounting publishes when a payment
 * cycle is finished, plus the rule that decides when it MAY be published.
 *
 * Deliberately pure: no Supabase, no `server-only`. The persistence layer
 * (pay-cycle-reports.ts) feeds it rows and stores what it returns; the export
 * layer (pay-cycle-report-export.ts) renders what it returned. That keeps the
 * one piece of real judgment in this feature — "is this cycle actually done?" —
 * unit-testable with plain objects.
 */

import { isUrgentSourceFile } from '@/lib/payroll/urgent-cycle';
import type {
  DisbursementReportSummary,
  DisbursementReportTotals,
} from '@/lib/payroll/disbursement-reports';
import type { PaymentDispatchRow } from '@/lib/supabase/payment-dispatches';

/** Bumped only if the stored shape changes incompatibly. Readers tolerate
 *  unknown versions (missing fields fall back) rather than throwing. */
export const PAY_CYCLE_REPORT_VERSION = 1;

/** One paid dispatch, frozen. One row per payment — NOT per person — so every
 *  transaction ID stays individually traceable to the bank statement. */
export interface PayCycleReportPayee {
  name: string | null;
  email: string;
  payeeType: 'employee' | 'contractor';
  processor: string;
  amountUSD: number;
  amountPHP: number;
  transactionId: string | null;
  bankUsed: string | null;
  dateSent: string | null;
  arrivalDate: string | null;
}

export interface PayCycleReportTotals {
  /** Distinct employees + one per contractor invoice — Payment Dispatch's own
   *  headline rule (see distinctPaidCount in PayrollDispatch.tsx), so the two
   *  screens can never disagree on "how many got paid". */
  payeeCount: number;
  employeeCount: number;
  contractorCount: number;
  /** Raw paid-dispatch row count (≥ payeeCount when someone was paid twice). */
  dispatchCount: number;
  paidUSD: number;
  paidPHP: number;
}

export interface PayCycleReportSnapshot {
  version: number;
  published_at: string;
  published_by: string;
  published_by_email: string;
  source_file: string;
  cycle_id: string;
  label: string;
  period_start: string | null;
  period_end: string | null;
  totals: PayCycleReportTotals;
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
  payees: PayCycleReportPayee[];
}

/** A published report without its payee rows — what the list view needs. */
export type PayCycleReportSummary = Omit<PayCycleReportSnapshot, 'payees'>;

export interface CycleCompleteness {
  complete: boolean;
  paidCount: number;
  /** Still owed and still payable: not_paid + threshold + never-dispatched. */
  pendingCount: number;
  /** Flagged Problem — out of the queue, money still stuck. */
  blockedCount: number;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/**
 * Payment Dispatch's 100% rule, expressed against report totals: nothing
 * pending, nobody blocked, at least one person paid. Working from totals rather
 * than the live queue means the Reports tab needs no wizard/queue hydration to
 * decide whether the button lights up.
 */
export function cycleCompleteness(totals: DisbursementReportTotals): CycleCompleteness {
  const pendingCount =
    totals.notPaidCount + totals.thresholdCount + totals.outstandingCount;
  const blockedCount = totals.problemCount;
  return {
    complete: totals.paidCount > 0 && pendingCount === 0 && blockedCount === 0,
    paidCount: totals.paidCount,
    pendingCount,
    blockedCount,
  };
}

/** Complete AND a real pay cycle. Urgent (MESA/one-off) weeks are excluded —
 *  they are payouts, not cycles, and are reported in Payment Dispatch only. */
export function isPublishableCycle(
  summary: Pick<DisbursementReportSummary, 'sourceFile' | 'totals'>,
): boolean {
  if (!summary.sourceFile) return false;
  if (isUrgentSourceFile(summary.sourceFile)) return false;
  return cycleCompleteness(summary.totals).complete;
}

/**
 * Freeze a cycle. Only `status === 'paid'` dispatches make it in — the report
 * answers "who got paid", so a not_paid/threshold/problem row has no place in
 * it (and by the time we publish, `isPublishableCycle` guarantees there are
 * none anyway).
 */
export function buildPayCycleReportSnapshot(input: {
  summary: DisbursementReportSummary;
  dispatches: PaymentDispatchRow[];
  publishedBy: string;
  publishedByEmail: string;
  publishedAt: string;
}): PayCycleReportSnapshot {
  const paid = input.dispatches.filter((d) => d.status === 'paid');

  const payees: PayCycleReportPayee[] = paid.map((d) => ({
    name: trimOrNull(d.recipient_name),
    email: (d.recipient_email ?? '').trim(),
    payeeType: (d.payee_type ?? 'employee') === 'contractor' ? 'contractor' : 'employee',
    processor: (d.processor ?? '').trim() || 'unknown',
    amountUSD: num(d.amount_usd),
    amountPHP: num(d.amount_php),
    transactionId: trimOrNull(d.transaction_id),
    bankUsed: trimOrNull(d.bank_used),
    dateSent: trimOrNull(d.sent_date),
    arrivalDate: trimOrNull(d.arrival_date),
  }));

  // Named people first (A→Z), unnamed rows last so they read as a tail rather
  // than sorting under whatever their email happens to start with.
  payees.sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    const an = (a.name ?? a.email).toLocaleLowerCase();
    const bn = (b.name ?? b.email).toLocaleLowerCase();
    const byName = an.localeCompare(bn);
    return byName !== 0 ? byName : a.email.localeCompare(b.email);
  });

  const employeeEmails = new Set<string>();
  let contractorCount = 0;
  let paidUSD = 0;
  let paidPHP = 0;
  const byProcessor: Record<string, { count: number; usd: number; php: number }> = {};

  for (const p of payees) {
    if (p.payeeType === 'contractor') contractorCount += 1;
    else employeeEmails.add(p.email.toLowerCase());
    paidUSD += p.amountUSD;
    paidPHP += p.amountPHP;
    const acc = byProcessor[p.processor] ?? { count: 0, usd: 0, php: 0 };
    acc.count += 1;
    acc.usd += p.amountUSD;
    acc.php += p.amountPHP;
    byProcessor[p.processor] = acc;
  }

  return {
    version: PAY_CYCLE_REPORT_VERSION,
    published_at: input.publishedAt,
    published_by: input.publishedBy,
    published_by_email: input.publishedByEmail,
    source_file: input.summary.sourceFile ?? '',
    cycle_id: input.summary.cycleId,
    label: input.summary.reportName,
    period_start: input.summary.periodStart,
    period_end: input.summary.periodEnd,
    totals: {
      payeeCount: employeeEmails.size + contractorCount,
      employeeCount: employeeEmails.size,
      contractorCount,
      dispatchCount: payees.length,
      paidUSD,
      paidPHP,
    },
    byProcessor,
    payees,
  };
}

/** Strip `payees[]` for the list payload. */
export function toPayCycleReportSummary(snap: PayCycleReportSnapshot): PayCycleReportSummary {
  const { payees: _payees, ...rest } = snap;
  return rest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `pay-cycle-report-snapshot` tests green, no existing test broken.

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/accounting/pay-cycle-report-snapshot.ts src/lib/accounting/pay-cycle-report-snapshot.test.ts
git commit -m "feat(accounting): pay-cycle report snapshot model + completeness rule"
```

---

### Task 2: Server persistence layer (app_settings, no DDL)

**Files:**
- Create: `src/lib/accounting/pay-cycle-reports.ts`

**Interfaces:**
- Consumes: everything Task 1 produced; `listDisbursementReports`, `getDisbursementReportDetail` from `@/lib/payroll/disbursement-reports`; `createSupabaseServiceRoleClient` from `@/lib/supabase/server`.
- Produces:
  - `PAY_CYCLE_REPORT_PREFIX` (const string)
  - `function payCycleReportKey(sourceFile: string): string`
  - `interface PublishableCycle { sourceFile: string; cycleId: string; label: string; periodStart: string | null; periodEnd: string | null; payeeCount: number; paidUSD: number; paidPHP: number }`
  - `interface IncompleteCycle { sourceFile: string; label: string; periodStart: string | null; periodEnd: string | null; paidCount: number; pendingCount: number; blockedCount: number; totalCount: number; paidPct: number }`
  - `async function listPayCycleReports(): Promise<{ published: PayCycleReportSummary[]; unreadable: string[]; error: string | null }>`
  - `async function getPayCycleReport(sourceFile: string): Promise<{ report: PayCycleReportSnapshot | null; error: string | null }>`
  - `async function listCycleStatus(): Promise<{ publishable: PublishableCycle[]; incomplete: IncompleteCycle | null; publishedSources: string[]; error: string | null }>`
  - `async function publishPayCycleReport(input: { sourceFile: string; publishedBy: string; publishedByEmail: string }): Promise<{ report: PayCycleReportSnapshot | null; already: boolean; notComplete: CycleCompleteness | null; error: string | null }>`
  - `async function unpublishPayCycleReport(sourceFile: string): Promise<{ deleted: boolean; error: string | null }>`

- [ ] **Step 1: Write the implementation**

Create `src/lib/accounting/pay-cycle-reports.ts`:

```ts
import 'server-only';

/**
 * Pay Cycle Reports — persistence.
 *
 * A published report is ONE `app_settings` row per cycle, keyed
 * `documents.pay_cycle_report.<source_file>`, whose value is the frozen
 * PayCycleReportSnapshot JSON. No dedicated table, and therefore no migration:
 * the report's *content* is derivable from disbursement_records /
 * payment_dispatches at any time — the only new fact is the publication itself,
 * plus the frozen numbers that must survive a later undo.
 *
 * Eligibility comes from listDisbursementReports(), the same source Payment
 * Dispatch → Reports reads, so the two screens agree about what a cycle is.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import {
  getDisbursementReportDetail,
  listDisbursementReports,
} from '@/lib/payroll/disbursement-reports';
import {
  buildPayCycleReportSnapshot,
  cycleCompleteness,
  isPublishableCycle,
  toPayCycleReportSummary,
  type CycleCompleteness,
  type PayCycleReportSnapshot,
  type PayCycleReportSummary,
} from './pay-cycle-report-snapshot';
import { isUrgentSourceFile } from '@/lib/payroll/urgent-cycle';

export const PAY_CYCLE_REPORT_PREFIX = 'documents.pay_cycle_report.';

export function payCycleReportKey(sourceFile: string): string {
  return `${PAY_CYCLE_REPORT_PREFIX}${sourceFile}`;
}

export interface PublishableCycle {
  sourceFile: string;
  cycleId: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  payeeCount: number;
  paidUSD: number;
  paidPHP: number;
}

export interface IncompleteCycle {
  sourceFile: string;
  label: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidCount: number;
  pendingCount: number;
  blockedCount: number;
  totalCount: number;
  paidPct: number;
}

/** Parse a stored value, returning null (not throwing) on anything malformed —
 *  one corrupt row must not blank the whole tab. */
function parseSnapshot(value: string): PayCycleReportSnapshot | null {
  try {
    const parsed = JSON.parse(value) as PayCycleReportSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.source_file) return null;
    if (!Array.isArray(parsed.payees)) parsed.payees = [];
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Every published report, newest period first. `unreadable` carries the keys
 * whose JSON would not parse so the UI can offer an Unpublish on them instead
 * of silently dropping them.
 *
 * Published cycles number in the dozens per year, so one un-paged `.like()`
 * select is correct here — but note the 1000-row ceiling is real, and this read
 * would need selectAllPaged if reports ever became per-person rows.
 */
export async function listPayCycleReports(): Promise<{
  published: PayCycleReportSummary[];
  unreadable: string[];
  error: string | null;
}> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { published: [], unreadable: [], error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value')
    .like('key', `${PAY_CYCLE_REPORT_PREFIX}%`);
  if (error) return { published: [], unreadable: [], error: error.message };

  const published: PayCycleReportSummary[] = [];
  const unreadable: string[] = [];
  for (const row of (data ?? []) as { key: string; value: string }[]) {
    const snap = parseSnapshot(row.value);
    if (!snap) {
      unreadable.push(row.key);
      continue;
    }
    published.push(toPayCycleReportSummary(snap));
  }
  published.sort((a, b) => {
    const byPeriod = (b.period_start ?? '').localeCompare(a.period_start ?? '');
    return byPeriod !== 0 ? byPeriod : b.published_at.localeCompare(a.published_at);
  });
  return { published, unreadable, error: null };
}

export async function getPayCycleReport(
  sourceFile: string,
): Promise<{ report: PayCycleReportSnapshot | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { report: null, error: 'Supabase client unavailable' };

  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', payCycleReportKey(sourceFile))
    .maybeSingle();
  if (error) return { report: null, error: error.message };
  if (!data) return { report: null, error: null };

  const snap = parseSnapshot((data as { value: string }).value);
  return snap
    ? { report: snap, error: null }
    : { report: null, error: 'Stored report could not be read' };
}

/**
 * What the Reports tab needs to render its publish card:
 *   • publishable — complete, unpublished, non-urgent cycles (newest first).
 *   • incomplete  — the newest cycle that is NOT complete, so a tab with
 *                   nothing publishable can still explain what is outstanding
 *                   instead of showing an empty card.
 */
export async function listCycleStatus(): Promise<{
  publishable: PublishableCycle[];
  incomplete: IncompleteCycle | null;
  publishedSources: string[];
  error: string | null;
}> {
  const [{ reports, error }, { published, error: pubErr }] = await Promise.all([
    listDisbursementReports(),
    listPayCycleReports(),
  ]);
  if (error) return { publishable: [], incomplete: null, publishedSources: [], error };
  if (pubErr) return { publishable: [], incomplete: null, publishedSources: [], error: pubErr };

  const publishedSources = published.map((p) => p.source_file);
  const alreadyPublished = new Set(publishedSources);

  const publishable: PublishableCycle[] = [];
  let incomplete: IncompleteCycle | null = null;

  // `reports` arrives newest period first, so the first incomplete cycle we
  // meet is the newest one.
  for (const r of reports) {
    if (!r.sourceFile || isUrgentSourceFile(r.sourceFile)) continue;
    const c = cycleCompleteness(r.totals);
    if (!c.complete) {
      if (!incomplete) {
        const totalCount = c.paidCount + c.pendingCount + c.blockedCount;
        incomplete = {
          sourceFile: r.sourceFile,
          label: r.reportName,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          paidCount: c.paidCount,
          pendingCount: c.pendingCount,
          blockedCount: c.blockedCount,
          totalCount,
          paidPct: totalCount > 0 ? Math.round((c.paidCount / totalCount) * 100) : 0,
        };
      }
      continue;
    }
    if (alreadyPublished.has(r.sourceFile)) continue;
    publishable.push({
      sourceFile: r.sourceFile,
      cycleId: r.cycleId,
      label: r.reportName,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      // Pre-publish estimate straight off the report totals. The authoritative
      // count is recomputed from the dispatch rows at publish time.
      payeeCount: r.totals.paidCount,
      paidUSD: r.totals.paidUSD,
      paidPHP: r.totals.paidPHP,
    });
  }

  return { publishable, incomplete, publishedSources, error: null };
}

/**
 * Freeze and store a cycle.
 *
 * Completeness is RE-CHECKED here against fresh totals: this is what stops a
 * stale browser tab from publishing a cycle that has since had a payment undone.
 *
 * The write is a plain INSERT, never an upsert — `app_settings.key` is unique,
 * so a double-click or two clerks racing produce one row and a 23505 for the
 * loser, reported as `already: true`.
 */
export async function publishPayCycleReport(input: {
  sourceFile: string;
  publishedBy: string;
  publishedByEmail: string;
}): Promise<{
  report: PayCycleReportSnapshot | null;
  already: boolean;
  notComplete: CycleCompleteness | null;
  error: string | null;
}> {
  const fail = (error: string) => ({ report: null, already: false, notComplete: null, error });

  if (isUrgentSourceFile(input.sourceFile)) {
    return fail('Urgent payouts are not pay cycles and cannot be published');
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return fail('Supabase client unavailable');

  const { reports, error: listErr } = await listDisbursementReports();
  if (listErr) return fail(listErr);
  const summary = reports.find((r) => r.sourceFile === input.sourceFile);
  if (!summary) return fail('Cycle not found');

  if (!isPublishableCycle(summary)) {
    return {
      report: null,
      already: false,
      notComplete: cycleCompleteness(summary.totals),
      error: null,
    };
  }

  const { report: detail, error: detailErr } = await getDisbursementReportDetail(summary.cycleId);
  if (detailErr || !detail) return fail(detailErr ?? 'Could not load cycle detail');

  const snapshot = buildPayCycleReportSnapshot({
    summary,
    dispatches: detail.dispatches,
    publishedBy: input.publishedBy,
    publishedByEmail: input.publishedByEmail,
    publishedAt: new Date().toISOString(),
  });

  const { error: insertErr } = await supabase.from('app_settings').insert({
    key: payCycleReportKey(input.sourceFile),
    value: JSON.stringify(snapshot),
    updated_at: snapshot.published_at,
  });
  if (insertErr) {
    if (insertErr.code === '23505') {
      // Someone else won the race — the report exists, which is the outcome
      // the clerk wanted. Hand back the stored one.
      const { report } = await getPayCycleReport(input.sourceFile);
      return { report, already: true, notComplete: null, error: null };
    }
    return fail(insertErr.message);
  }

  return { report: snapshot, already: false, notComplete: null, error: null };
}

export async function unpublishPayCycleReport(
  sourceFile: string,
): Promise<{ deleted: boolean; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: false, error: 'Supabase client unavailable' };
  const { error } = await supabase
    .from('app_settings')
    .delete()
    .eq('key', payCycleReportKey(sourceFile));
  return { deleted: !error, error: error ? error.message : null };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: no errors. If `PaymentDispatchRow.arrival_date` or `payee_type` resolve as optional, the snapshot builder's `?? null` / `?? 'employee'` already handle it — do not widen the stored types.

- [ ] **Step 3: Run the existing suite**

Run: `npm test`
Expected: PASS (Task 1's tests still green; this module has no tests of its own — it is thin I/O over tested logic).

- [ ] **Step 4: Commit**

```bash
git add src/lib/accounting/pay-cycle-reports.ts
git commit -m "feat(accounting): persist pay-cycle reports as frozen app_settings snapshots"
```

---

### Task 3: API routes

**Files:**
- Create: `app/api/accounting/pay-cycle-reports/route.ts`
- Create: `app/api/accounting/pay-cycle-reports/[sourceFile]/route.ts`

**Interfaces:**
- Consumes: everything Task 2 produced; `requireFeatureAccess` from `@/lib/auth/authorize-feature`; `deniedResponse` from `@/lib/auth/authorize-email`; `getSessionActor` from `@/lib/auth/session-actor`; `insertAuditLog` from `@/lib/supabase/audit-log`.
- Produces (consumed by Tasks 5–6 over `fetch`):
  - `GET /api/accounting/pay-cycle-reports` → `{ published: PayCycleReportSummary[]; publishable: PublishableCycle[]; incomplete: IncompleteCycle | null; unreadable: string[]; error: string | null }`
  - `POST /api/accounting/pay-cycle-reports` body `{ source_file: string }` → `{ report: PayCycleReportSnapshot | null; already: boolean; error: string | null }`; `409` with `{ notComplete: CycleCompleteness }` when the cycle regressed
  - `GET /api/accounting/pay-cycle-reports/[sourceFile]` → `{ report: PayCycleReportSnapshot | null; error: string | null }`
  - `DELETE /api/accounting/pay-cycle-reports/[sourceFile]` → `{ deleted: boolean; error: string | null }`

- [ ] **Step 1: Write the collection route**

Create `app/api/accounting/pay-cycle-reports/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  listCycleStatus,
  listPayCycleReports,
  publishPayCycleReport,
} from '@/lib/accounting/pay-cycle-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Reports.
 *
 *   GET  → published reports + which cycles may still be published
 *   POST → publish one cycle (freeze it), edit-gated
 *
 * Both ride the accounting `documents` feature — the tab they live in — so no
 * new permission is introduced.
 */
export async function GET() {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const [reportsRes, statusRes] = await Promise.all([listPayCycleReports(), listCycleStatus()]);
  if (reportsRes.error) {
    return NextResponse.json({ error: reportsRes.error }, { status: 500 });
  }
  // A failed eligibility read must not hide reports that were already
  // published — degrade to "nothing publishable" and surface the reason.
  return NextResponse.json({
    published: reportsRes.published,
    unreadable: reportsRes.unreadable,
    publishable: statusRes.publishable,
    incomplete: statusRes.incomplete,
    error: statusRes.error,
  });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'edit');
  if (!authz.ok) return deniedResponse(authz);

  let body: { source_file?: unknown };
  try {
    body = (await req.json()) as { source_file?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sourceFile =
    typeof body.source_file === 'string' ? body.source_file.trim().slice(0, 300) : '';
  if (!sourceFile) {
    return NextResponse.json({ error: 'source_file is required' }, { status: 400 });
  }

  const actor = await getSessionActor();
  const email = actor.user_name === 'anonymous' ? '' : actor.user_name;
  const result = await publishPayCycleReport({
    sourceFile,
    publishedBy: email ? email.split('@')[0] : 'Accounting',
    publishedByEmail: email,
  });

  if (result.notComplete) {
    return NextResponse.json(
      {
        error: 'This cycle is no longer fully paid — refresh and check Payment Dispatch.',
        notComplete: result.notComplete,
      },
      { status: 409 },
    );
  }
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });

  if (!result.already && result.report) {
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'pay_cycle_report.published',
      resource: 'app_settings',
      resource_id: sourceFile,
      details: {
        source_file: sourceFile,
        cycle_id: result.report.cycle_id,
        label: result.report.label,
        payee_count: result.report.totals.payeeCount,
        dispatch_count: result.report.totals.dispatchCount,
        paid_usd: result.report.totals.paidUSD,
        paid_php: result.report.totals.paidPHP,
      },
    });
  }

  return NextResponse.json({
    report: result.report,
    already: result.already,
    error: null,
  });
}
```

- [ ] **Step 2: Write the item route**

Create `app/api/accounting/pay-cycle-reports/[sourceFile]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  getPayCycleReport,
  unpublishPayCycleReport,
} from '@/lib/accounting/pay-cycle-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 *   GET    → the full frozen snapshot (including every payee row)
 *   DELETE → unpublish. Needed because a mistaken publish would otherwise be
 *            permanent, and unpublish→republish is the only way to refresh a
 *            snapshot that no longer matches reality. Both are audited.
 *
 * `sourceFile` arrives URL-encoded (Hubstaff filenames contain dots and
 * underscores, and MAY contain characters that need escaping) — always decode.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceFile: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { sourceFile: raw } = await params;
  const sourceFile = decodeURIComponent(raw ?? '').trim();
  if (!sourceFile) return NextResponse.json({ error: 'Missing sourceFile' }, { status: 400 });

  const { report, error } = await getPayCycleReport(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  return NextResponse.json({ report, error: null });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sourceFile: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'edit');
  if (!authz.ok) return deniedResponse(authz);

  const { sourceFile: raw } = await params;
  const sourceFile = decodeURIComponent(raw ?? '').trim();
  if (!sourceFile) return NextResponse.json({ error: 'Missing sourceFile' }, { status: 400 });

  const { deleted, error } = await unpublishPayCycleReport(sourceFile);
  if (error) return NextResponse.json({ error }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'pay_cycle_report.unpublished',
    resource: 'app_settings',
    resource_id: sourceFile,
    details: { source_file: sourceFile },
  });

  return NextResponse.json({ deleted, error: null });
}
```

- [ ] **Step 3: Confirm the routes are reachable and gated**

Run: `npm run lint`
Expected: no errors.

Then confirm the middleware access test is unaffected:
Run: `npm run test:authz`
Expected: PASS, unchanged. That suite tests `requiredRolesFor`'s path→roles mapping (`/admin` sub-routes, open routes, `/ceo` self-pinning) — it has no per-route manifest to register these two in, and non-admin `/api/accounting/*` routes are gated by the `requireFeatureAccess` calls in the handlers themselves. If this suite does fail, the cause is elsewhere; do not add entries to it.

- [ ] **Step 4: Commit**

```bash
git add app/api/accounting/pay-cycle-reports
git commit -m "feat(accounting): pay-cycle report publish/list/unpublish API"
```

---

### Task 4: CSV / XLSX / PDF export module

Mirrors [`src/lib/transfers/transfers-export.ts`](../../../src/lib/transfers/transfers-export.ts) — read that file first; this task reuses its structure, its Accounting orange→rose theme, and its `sanitize`/`wrapText`/`drawHGradient` techniques. Runs entirely in the browser.

**Files:**
- Create: `src/lib/accounting/pay-cycle-report-export.ts`
- Test: `src/lib/accounting/pay-cycle-report-export.test.ts`

**Interfaces:**
- Consumes: `PayCycleReportSnapshot`, `PayCycleReportPayee` from `./pay-cycle-report-snapshot`; `PDFDocument, StandardFonts, rgb` from `pdf-lib`; `* as XLSX` from `xlsx`.
- Produces:
  - `interface PayCycleReportExportModel { generatedAt: Date; snapshot: PayCycleReportSnapshot; rows: PayCycleReportPayee[]; title: string; eyebrow: string; fileBase: string; filterLabel: string }`
  - `function buildPayCycleReportExport(snapshot: PayCycleReportSnapshot, opts?: { rows?: PayCycleReportPayee[]; filterLabel?: string; generatedAt?: Date }): PayCycleReportExportModel`
  - `function payCycleReportToCsv(model: PayCycleReportExportModel): string`
  - `function buildPayCycleReportWorkbook(model: PayCycleReportExportModel): XLSX.WorkBook`
  - `function generatePayCycleReportPdf(model: PayCycleReportExportModel, opts?: { logoUrl?: string }): Promise<Uint8Array>`
  - `function downloadPayCycleReportCsv(model: PayCycleReportExportModel): void`
  - `function downloadPayCycleReportXlsx(model: PayCycleReportExportModel): void`
  - `function downloadPayCycleReportPdf(model: PayCycleReportExportModel, opts?: { logoUrl?: string }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/accounting/pay-cycle-report-export.test.ts`:

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  buildPayCycleReportExport,
  buildPayCycleReportWorkbook,
  generatePayCycleReportPdf,
  payCycleReportToCsv,
} from './pay-cycle-report-export';
import type { PayCycleReportPayee, PayCycleReportSnapshot } from './pay-cycle-report-snapshot';

function payee(over: Partial<PayCycleReportPayee> = {}): PayCycleReportPayee {
  return {
    name: 'Juan Santos',
    email: 'juan@simple.biz',
    payeeType: 'employee',
    processor: 'hurupay',
    amountUSD: 100,
    amountPHP: 5600,
    transactionId: 'TXN-1',
    bankUsed: 'Hurupay',
    dateSent: '2026-08-01',
    arrivalDate: '2026-08-02',
    ...over,
  };
}

function snapshot(payees: PayCycleReportPayee[]): PayCycleReportSnapshot {
  return {
    version: 1,
    published_at: '2026-08-02T01:00:00.000Z',
    published_by: 'carla',
    published_by_email: 'carla@simple.biz',
    source_file: 'simple-biz_daily_report_2026-07-26_to_2026-08-01.csv',
    cycle_id: 'upload-1',
    label: 'Jul 26 - Aug 1, 2026',
    period_start: '2026-07-26',
    period_end: '2026-08-01',
    totals: {
      payeeCount: payees.length,
      employeeCount: payees.filter((p) => p.payeeType === 'employee').length,
      contractorCount: payees.filter((p) => p.payeeType === 'contractor').length,
      dispatchCount: payees.length,
      paidUSD: payees.reduce((s, p) => s + p.amountUSD, 0),
      paidPHP: payees.reduce((s, p) => s + p.amountPHP, 0),
    },
    byProcessor: { hurupay: { count: payees.length, usd: 0, php: 0 } },
    payees,
  };
}

describe('payCycleReportToCsv', () => {
  test('starts with a UTF-8 BOM and a provenance preamble', () => {
    const csv = payCycleReportToCsv(buildPayCycleReportExport(snapshot([payee()])));
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.match(csv, /Pay Cycle Report/);
    assert.match(csv, /Jul 26 - Aug 1, 2026/);
    assert.match(csv, /Pulled from Simple-HRIS System/);
    assert.match(csv, /carla@simple\.biz/);
  });

  test('emits a numbered row per payee with the expected header', () => {
    const csv = payCycleReportToCsv(
      buildPayCycleReportExport(snapshot([payee(), payee({ name: 'Ana', email: 'ana@simple.biz' })])),
    );
    const lines = csv.split('\r\n');
    const headerIdx = lines.findIndex((l) => l.startsWith('#,'));
    assert.ok(headerIdx > 0, 'header row present after the preamble');
    assert.equal(
      lines[headerIdx],
      '#,Name,Email,Type,Processor,Amount (USD),Amount (PHP),Transaction ID,Bank Used,Date Sent',
    );
    assert.ok(lines[headerIdx + 1].startsWith('1,'));
    assert.ok(lines[headerIdx + 2].startsWith('2,'));
  });

  test('escapes commas and quotes per RFC 4180', () => {
    const csv = payCycleReportToCsv(
      buildPayCycleReportExport(snapshot([payee({ name: 'Santos, Juan "JD"' })])),
    );
    assert.match(csv, /"Santos, Juan ""JD"""/);
  });
});

describe('buildPayCycleReportWorkbook', () => {
  test('puts the header on row 5 with an autofilter over the data', () => {
    const model = buildPayCycleReportExport(snapshot([payee(), payee({ email: 'b@simple.biz' })]));
    const wb = buildPayCycleReportWorkbook(model);
    assert.deepEqual(wb.SheetNames, ['Pay Cycle Report']);
    const ws = wb.Sheets['Pay Cycle Report'];
    assert.equal(ws.A5?.v, '#');
    assert.equal(ws.B5?.v, 'Name');
    // 10 columns => last col index 9 ("J"); 2 data rows => through row 7.
    assert.equal(ws['!autofilter']?.ref, 'A5:J7');
    assert.equal(ws.A6?.v, 1);
    assert.equal(ws.A7?.v, 2);
  });
});

describe('generatePayCycleReportPdf', () => {
  test('produces a loadable PDF for an empty report', async () => {
    const bytes = await generatePayCycleReportPdf(buildPayCycleReportExport(snapshot([])));
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString('utf8'), '%PDF-');
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
  });

  test('paginates a long payee list', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      payee({ name: `Person ${i}`, email: `p${i}@simple.biz` }),
    );
    const bytes = await generatePayCycleReportPdf(buildPayCycleReportExport(snapshot(many)));
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() > 1, 'expected more than one page');
  });

  test('survives characters Helvetica cannot encode', async () => {
    const bytes = await generatePayCycleReportPdf(
      buildPayCycleReportExport(
        snapshot([payee({ name: 'Iñigo — “Ñoño” … ₱ → 中文', bankUsed: '₱ wallet' })]),
      ),
    );
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString('utf8'), '%PDF-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./pay-cycle-report-export`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/accounting/pay-cycle-report-export.ts`. Structure it in the same order as `transfers-export.ts` so the two read as siblings:

```ts
// Pay Cycle Report → CSV + XLSX + PDF export.
//
// Renders a PUBLISHED (frozen) pay-cycle report — see pay-cycle-report-snapshot.ts
// — into three portable formats, all built in the browser from the snapshot the
// tab already holds. No server round-trip, and no risk of the export disagreeing
// with the report on screen.
//
//   - CSV  → one flat table with a provenance preamble, UTF-8 BOM so Excel
//            renders the peso sign.
//   - XLSX → native workbook: title/summary banner, sized columns, autofilter.
//   - PDF  → branded document built from scratch with pdf-lib (deploys cleanly
//            on Vercel; no template read at runtime), Simple logo in the
//            masthead, warm orange→rose Accounting treatment.
//
// Mirrors src/lib/transfers/transfers-export.ts deliberately — same theme, same
// gradient-by-slices technique, same WinAnsi sanitizer. SheetJS community emits
// no cell fills, so the XLSX "theme" is structural only; the PDF carries colour.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type { PayCycleReportPayee, PayCycleReportSnapshot } from './pay-cycle-report-snapshot';
```

Then, in order:

1. **Model.** `PayCycleReportExportModel` + `buildPayCycleReportExport`. `rows` defaults to `snapshot.payees` (the caller passes the *filtered* list when a search is active); `title` = `'Pay Cycle Report'`; `eyebrow` = `` `ACCOUNTING - PAY CYCLE REPORT` ``; `fileBase` = `` `pay-cycle-report-${snapshot.period_start ?? snapshot.source_file.replace(/\.csv$/i, '')}` ``; `filterLabel` defaults to `snapshot.label`; `generatedAt` defaults to `new Date()`.

2. **Formatting helpers.** `clean`, `money(n, currency)` → `$1,234.56` / `₱1,234.56`, `formatTimestamp(d)` (the `en-US` long form with `timeZoneName: 'short'`, wrapped in try/catch), `typeLabel(p)` → `'Contractor' | 'Employee'`, `dash(v)` → `v ?? '-'`.

3. **Summary line** shared by all three formats:
   `` `${rows.length} of ${totals.dispatchCount} payments · ${totals.payeeCount} payees · ${money(paidUSD,'USD')} · ${money(paidPHP,'PHP')}` `` — collapsing the `X of Y` to just `Y payments` when nothing is filtered out.

4. **Flat columns** (one definition, shared by CSV + XLSX — this is the DRY point):

```ts
interface FlatColumn {
  header: string;
  width: number;
  get: (p: PayCycleReportPayee) => string | number;
}

const FLAT_COLUMNS: FlatColumn[] = [
  { header: 'Name',           width: 26, get: (p) => p.name ?? p.email },
  { header: 'Email',          width: 30, get: (p) => p.email },
  { header: 'Type',           width: 12, get: (p) => (p.payeeType === 'contractor' ? 'Contractor' : 'Employee') },
  { header: 'Processor',      width: 14, get: (p) => p.processor },
  { header: 'Amount (USD)',   width: 14, get: (p) => p.amountUSD },
  { header: 'Amount (PHP)',   width: 16, get: (p) => p.amountPHP },
  { header: 'Transaction ID', width: 22, get: (p) => p.transactionId ?? '' },
  { header: 'Bank Used',      width: 20, get: (p) => p.bankUsed ?? '' },
  { header: 'Date Sent',      width: 14, get: (p) => p.dateSent ?? '' },
];
```

   The header row the test asserts is `['#', ...FLAT_COLUMNS.map(c => c.header)]`, so keep these headers and this order exactly. Amounts stay **numeric** in XLSX (so Excel can sum them) and are `toFixed`-style formatted without grouping in CSV (so a spreadsheet import doesn't split on the thousands comma).

5. **CSV.** `csvEscape` (quote when the value contains `"` `,` `\r` `\n`, doubling inner quotes), then a preamble of single-cell rows, a blank row, the header, and the numbered body — joined with `\r\n` and prefixed `'﻿'`:

```
Pay Cycle Report
Cycle: Jul 26 - Aug 1, 2026
Period: 2026-07-26 to 2026-08-01
Published: August 2, 2026, 9:00 AM GMT+8 by carla@simple.biz
Pulled from Simple-HRIS System
Exported: <formatTimestamp(generatedAt)>
<summary line>
Developed by AI/API Team / Simple.biz (c) <year>
<blank>
#,Name,Email,Type,Processor,Amount (USD),Amount (PHP),Transaction ID,Bank Used,Date Sent
```

6. **XLSX.** `aoa_to_sheet` with exactly four rows before the header so the header lands on **row 5** (`ws.A5 === '#'`): `[title]`, `[Cycle … / Period …]`, `[Published … · Exported …]`, `[]`. Then `!cols` = `[{wch:5}, ...widths]`, `!autofilter` = `` `A5:${XLSX.utils.encode_col(FLAT_COLUMNS.length)}${5 + rows.length}` ``, three single-row merges across the banner, sheet name `'Pay Cycle Report'`.

7. **PDF.** Copy the proven scaffolding from `transfers-export.ts`: `PAGE_W = 792` / `PAGE_H = 612` (landscape Letter), `MARGIN = 40`, `CONTENT_W = 712`, `BOTTOM = 52`; the `C_ORANGE` / `C_ORANGE_500` / `C_ROSE` / `C_AMBER` palette with `WHITE` / `INK` / `MUTED`; `sanitize`, `wrapText`, `drawHGradient`, `loadLogoBytes`. Sections in order:
   - masthead — logo (or the word `Simple` in orange when `/simple-logo.png` can't be fetched, which is what happens under `node --test`), right-aligned provenance block, eyebrow, title, cycle label, summary line, gradient rule;
   - metric band — four cards: `Payees`, `Payments`, `Total paid (USD)`, `Total paid (PHP)`;
   - `Paid by processor` band — one small cell per entry in `snapshot.byProcessor`, sorted by USD descending;
   - payee table — orange header, warm zebra, columns `# / Name / Email / Type / Processor / USD / PHP / Txn ID / Bank used / Sent` with the last column absorbing the width remainder, re-drawing the header on every new page;
   - `No payments in this report.` in `MUTED` when `rows.length === 0`;
   - footers on every page — gradient hairline, `Developed by AI/API Team / Simple.biz © <year>` left, `Page N of M` right.

   Column widths must sum to `CONTENT_W`. Give `#` **at least 26pt** — `transfers-export.ts` documents that 20pt was narrower than the string `"10"` at 8pt and every row from #10 on hard-broke into stacked digits.

8. **Download helpers.** `dateSuffix(d)` → `YYYY-MM-DD`, `downloadBlob(filename, blob)` (guard `typeof window === 'undefined'`, `URL.createObjectURL`, click a temp `<a>`, revoke after 200ms), `baseName(model)` → `` `${fileBase}-${dateSuffix(generatedAt)}` ``, then the three `download…` functions. The PDF one copies the bytes into a fresh `ArrayBuffer` before constructing the `Blob`, exactly as `downloadTransfersPdf` does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all export tests green.

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/accounting/pay-cycle-report-export.ts src/lib/accounting/pay-cycle-report-export.test.ts
git commit -m "feat(accounting): CSV/XLSX/PDF export for published pay-cycle reports"
```

---

### Task 5: Reports tab — list, publish card, confirm dialog

**Files:**
- Create: `src/components/accounting/PayCycleReports.tsx`

**Interfaces:**
- Consumes: the Task 3 routes over `fetch`; types `PayCycleReportSummary`, `PayCycleReportSnapshot`, `CycleCompleteness` from `@/lib/accounting/pay-cycle-report-snapshot`; `PublishableCycle`, `IncompleteCycle` — **re-declare these two as local `interface`s in this file rather than importing them**, because `pay-cycle-reports.ts` is `server-only` and importing it would break the client bundle; `formatUSD`, `formatPHP` from `@/components/payroll-clerk/mock-queue`; `Button`, `Dialog…` from `@/components/ui/*`; `toast` from `sonner`; `cn` from `@/lib/utils`.
- Produces: `export default function PayCycleReports({ canEdit, onReadyCountChange }: { canEdit: boolean; onReadyCountChange?: (n: number) => void }): JSX.Element` — `onReadyCountChange` is how Task 7's tab badge learns how many cycles are ready.

- [ ] **Step 1: Build the data layer + states**

State: `published`, `publishable`, `incomplete`, `unreadable`, `loading`, `error`, `publishTarget: PublishableCycle | null`, `publishing`, `publishError`, `selected: PayCycleReportSnapshot | null`, `selectedLoading`, `selectedError`, `unpublishing`.

`load()` — `GET /api/accounting/pay-cycle-reports` with `cache: 'no-store'`, set all four lists, and call `onReadyCountChange?.(publishable.length)`. Call it in a `useEffect` with an `AbortController`, ignoring `AbortError` (copy the shape of `loadReports` in [DispatchReports.tsx:190](../../../src/components/payroll-clerk/DispatchReports.tsx#L190)).

`openReport(sourceFile)` — `GET …/${encodeURIComponent(sourceFile)}` → `setSelected`.

`publish()` — `POST` `{ source_file }`. On `409`, show the returned message via `toast.error`, close the dialog, and `load()` so the card re-renders in its not-ready state. On `already`, `toast.success('Report already published')` and `load()`. On success, `toast.success` naming the cycle, close, `load()`, then `openReport(sourceFile)` so the clerk lands on what they just made.

`unpublish(sourceFile)` — `DELETE`, two-step confirm (first click arms, second click sends — the `markPaidConfirm` pattern at [DispatchReports.tsx:994](../../../src/components/payroll-clerk/DispatchReports.tsx#L994)), then `setSelected(null)` and `load()`.

- [ ] **Step 2: Render the three-state publish card**

`publishable[0]` present → the **ready** card: `border-amber-300`, `ring-2 ring-amber-200/60`, a `motion.div` slow opacity pulse on the ring, the cycle label, `{payeeCount} payees · {formatUSD} · {formatPHP}`, a `100% paid` pill, and a large gradient button `bg-gradient-to-r from-orange-500 to-rose-500` reading **"Payment cycle complete"** with a `CheckCircle2`. Disabled with a `title` of `'You have view-only access'` when `!canEdit`.

No `publishable` but `incomplete` present → the **muted** card: `border-zinc-200`, `opacity-*` muted text, `{paidPct}% paid`, `{pendingCount} still pending · {blockedCount} blocked` (omit a zero clause), and the line *"Finish the queue in Payment Dispatch first."* Button rendered `disabled`.

Neither → the **all-published** confirmation: dashed emerald border, `CheckCircle2`, *"Every completed cycle has been reported."*

`publishable.slice(1)` → an **Also unpublished** list: one compact row per cycle with its label, period, `100% paid`, and a small `Publish` button.

- [ ] **Step 3: Render the published-report grid**

Card grid `grid gap-3 sm:grid-cols-2 xl:grid-cols-3`, newest first, each a `button` opening the detail: `FileCheck2` icon tile in an orange→rose gradient, the cycle label, `Published {formatTimestamp} by {published_by}`, three mini stats (Payees / Payments / Total paid), and a `View report →` footer. Follow `ReportCard` in [DispatchReports.tsx:794](../../../src/components/payroll-clerk/DispatchReports.tsx#L794) for the visual language.

Empty state: dashed orange border, `FileSpreadsheet`, *"No pay cycle reports published yet."*

`unreadable.length > 0` → an amber strip above the grid: *"{n} stored report(s) could not be read"* with an `Unpublish` per key (edit-gated), so a corrupt row is recoverable instead of permanent.

- [ ] **Step 4: Render the confirm dialog**

```tsx
<Dialog open={!!publishTarget} onOpenChange={(o) => !o && setPublishTarget(null)}>
  <DialogContent className="sm:max-w-md">
    <DialogHeader>
      <DialogTitle>Has this payment cycle been completed?</DialogTitle>
      <DialogDescription>
        This freezes the cycle exactly as it stands now and posts it to Reports.
        Later undos or re-marks won&rsquo;t change the published report.
      </DialogDescription>
    </DialogHeader>
    {/* cycle label · payee count · formatUSD · formatPHP in a zinc-50 panel */}
    {/* publishError, when set, in a rose-bordered panel */}
    <DialogFooter>
      <Button variant="outline" onClick={() => setPublishTarget(null)}>Cancel</Button>
      <Button
        onClick={() => void publish()}
        disabled={publishing}
        className="gap-1.5 bg-gradient-to-r from-orange-500 to-rose-500 text-white"
      >
        {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        Yes — publish report
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 5: Wire the detail view**

When `selected` (or `selectedLoading` / `selectedError`) is set, return `<PayCycleReportDetail … />` instead of the list — the in-place swap `DispatchReports` uses at [line 315](../../../src/components/payroll-clerk/DispatchReports.tsx#L315). Task 6 creates that component; until then, stub it as a `Back` button plus the report label so this task compiles and is independently testable, and replace the stub in Task 6.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/accounting/PayCycleReports.tsx
git commit -m "feat(accounting): Reports tab list + payment-cycle-complete publish flow"
```

---

### Task 6: Report detail view + export buttons

**Files:**
- Create: `src/components/accounting/PayCycleReportDetail.tsx`
- Modify: `src/components/accounting/PayCycleReports.tsx` (replace the Task 5 stub with the real import)

**Interfaces:**
- Consumes: `PayCycleReportSnapshot`, `PayCycleReportPayee`; every `build…`/`download…` function from `@/lib/accounting/pay-cycle-report-export`; `DISPATCH_PROCESSORS`, `PROCESSORS`, `formatUSD`, `formatPHP` from `@/components/payroll-clerk/mock-queue`; `ContractorChip` from `@/components/payroll-clerk/ContractorChip`.
- Produces: `export default function PayCycleReportDetail({ report, loading, error, canEdit, onBack, onUnpublish }: { report: PayCycleReportSnapshot | null; loading: boolean; error: string | null; canEdit: boolean; onBack: () => void; onUnpublish: (sourceFile: string) => void | Promise<void> }): JSX.Element`

- [ ] **Step 1: Header, stats and processor band**

Loading → centred `Loader2` + *"Loading report…"*. Error/absent → the rose gradient `AlertTriangle` panel + `Back to reports`, matching [DispatchReports.tsx:956](../../../src/components/payroll-clerk/DispatchReports.tsx#L956).

Header: `← Back`, the cycle label as `h1`, and a meta line of `CalendarDays {period_start} → {period_end}` · `Clock Published {formatTimestamp(published_at)} by {published_by}` · `FileSpreadsheet {source_file}`.

Four `DetailStat`-style cards: **Payees** (`totals.payeeCount`, sub `{employeeCount} employees · {contractorCount} contractor invoices`), **Payments** (`totals.dispatchCount`), **Total paid** (`formatUSD(paidUSD)`), **In pesos** (`formatPHP(paidPHP)`).

Processor band: one cell per `DISPATCH_PROCESSORS` entry reading `byProcessor[p.id] ?? {count:0,usd:0,php:0}`, plus a trailing cell for any key in `byProcessor` that is **not** a known processor id (older rows can carry `'unknown'`), labelled by that key — never silently drop money.

- [ ] **Step 2: Who-got-paid table**

Search input (name or email, case-insensitive) + pagination at 25 rows. Columns: Name (with `<ContractorChip />` when `payeeType === 'contractor'`) · Email (mono) · Processor (`PROCESSORS.find(p => p.id === processor)?.label ?? processor`) · USD (right, mono) · PHP (right, mono) · Txn ID (mono, `'—'` when null) · Bank used · Date sent. Empty search result → *"No results for “{query}”"*.

- [ ] **Step 3: Export buttons**

Three buttons in the header. Each builds the model from the **filtered** rows so an export matches what's on screen, passing `filterLabel`:

```tsx
const exportModel = () =>
  buildPayCycleReportExport(report, {
    rows: filtered,
    filterLabel: query.trim()
      ? `${report.label} — matching "${query.trim()}"`
      : report.label,
  });

// CSV / XLSX are synchronous; PDF is async and shows a spinner while it builds.
<Button onClick={() => downloadPayCycleReportCsv(exportModel())} disabled={filtered.length === 0}>
  <Download className="h-3.5 w-3.5" /> Export CSV
</Button>
```

Wrap the PDF call in `try/catch` with `toast.error` and a `pdfBusy` state; disable all three when `filtered.length === 0` with `title="Nothing to export"`.

- [ ] **Step 4: Unpublish**

An edit-gated ghost/outline `Unpublish` in the header, two-step confirm (first click turns it rose and reads `Confirm unpublish`, with a small `Cancel` beneath), calling `onUnpublish(report.source_file)`.

- [ ] **Step 5: Replace the stub in PayCycleReports.tsx**

Import the real component and pass `report={selected}`, `loading={selectedLoading}`, `error={selectedError}`, `canEdit`, `onBack={() => { setSelected(null); setSelectedError(null); }}`, `onUnpublish={unpublish}`.

- [ ] **Step 6: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/accounting/PayCycleReportDetail.tsx src/components/accounting/PayCycleReports.tsx
git commit -m "feat(accounting): pay-cycle report detail view with CSV/XLSX/PDF export"
```

---

### Task 7: Tab shell in Accounting → Documents

**Files:**
- Modify: `src/components/accounting/AccountingDocuments.tsx`

**Interfaces:**
- Consumes: `PayCycleReports` from `./PayCycleReports`.
- Produces: no new exports — the component's props are unchanged, so `src/App.tsx` needs no edit.

- [ ] **Step 1: Add the tab state**

```tsx
type DocumentsTab = 'queue' | 'reports';
const DOCUMENTS_TAB_STORAGE_KEY = 'accounting-documents-tab';
```

`const [tab, setTab] = useState<DocumentsTab>('queue')` — default preserves today's behaviour. Restore from `localStorage` in a mount `useEffect` (so SSR markup stays deterministic) and persist in a `changeTab` helper, both wrapped in `try/catch`. Copy the comments and shape from `REPORTS_VIEW_STORAGE_KEY` in [DispatchReports.tsx:229](../../../src/components/payroll-clerk/DispatchReports.tsx#L229).

Also `const [readyCount, setReadyCount] = useState(0)` for the badge.

- [ ] **Step 2: Add the tab bar**

Inside the existing header block, below the title/Refresh row:

```tsx
<div role="tablist" className="mt-3 inline-flex items-center rounded-lg border border-orange-100 bg-orange-50/50 p-0.5 dark:border-orange-950/40 dark:bg-orange-950/20">
  <DocumentsTabButton
    active={tab === 'queue'}
    onClick={() => changeTab('queue')}
    icon={FileSignature}
    label="Signing queue"
    count={counts.pending}
  />
  <DocumentsTabButton
    active={tab === 'reports'}
    onClick={() => changeTab('reports')}
    icon={FileSpreadsheet}
    label="Reports"
    count={readyCount}
    highlight
  />
</div>
```

And a local `DocumentsTabButton` at the bottom of the file, modelled on `ViewTabButton` in [AccountingMesa.tsx:2168](../../../src/components/payroll/AccountingMesa.tsx#L2168) but orange:

```tsx
function DocumentsTabButton({
  active, onClick, icon: Icon, label, count, highlight = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  /** Amber-pulse the count when there is work waiting (Reports: cycles ready
   *  to publish), so the call to action is visible from the other tab. */
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-orange-100/70 hover:text-orange-700 dark:text-zinc-400 dark:hover:bg-orange-950/40 dark:hover:text-orange-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="accounting-documents-tab-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-orange-500 to-rose-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5" />
        {label}
        {count != null && count > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
              active
                ? 'bg-white/25 text-white'
                : highlight
                  ? 'animate-pulse bg-amber-200 text-amber-900 dark:bg-amber-500/25 dark:text-amber-200'
                  : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
            )}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}
```

Add `motion` (`import { motion } from 'motion/react'`) and `FileSpreadsheet` to the imports.

- [ ] **Step 3: Split the body into tab panels**

Wrap the existing scroll container's two `<section>`s (signature manager + requests queue) so they render only when `tab === 'queue'`, and render `<PayCycleReports canEdit={canEdit} onReadyCountChange={setReadyCount} />` when `tab === 'reports'`. Keep the outer `flex h-full min-h-0 flex-col` shell and the scroll container as they are — `PayCycleReports` brings its own padding, so render it as a sibling of the `max-w-6xl` wrapper, not inside it.

Make the header subtitle follow the tab:
- `queue` → the existing sentence, unchanged.
- `reports` → *"Pay cycle reports published by Accounting once every payment in a cycle has gone out. Export any report as CSV, XLSX or PDF."*

Point Refresh at the active tab: on `reports` it should re-run the Reports fetch. Simplest correct approach — give `PayCycleReports` a `refreshKey?: number` prop it watches in a `useEffect` to re-`load()`, and have the header's Refresh bump a counter when `tab === 'reports'` instead of calling `fetchRows()`.

- [ ] **Step 4: Update the module docstring**

The comment at the top of the file lists "Two jobs". Make it three: the signing queue, the signature manager, and the Reports tab (pay cycle reports).

- [ ] **Step 5: Typecheck**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `npm run dev` and open `http://localhost:3000/accounting` → Documents.

Confirm: both tabs render and the pill animates between them · the signing queue behaves exactly as before · the Reports badge shows the ready count while sitting on the signing queue · the tab choice survives a reload · Refresh works on both tabs · with a fully-paid cycle the publish card is unmissable and the dialog publishes · the published report opens, searches, paginates · all three exports download and open cleanly (check the PDF's peso amounts read `PHP …`) · a view-only user sees no publish/unpublish action.

- [ ] **Step 7: Commit**

```bash
git add src/components/accounting/AccountingDocuments.tsx
git commit -m "feat(accounting): Documents tab bar — Signing queue + Reports"
```

---

### Task 8: Feature documentation

**Files:**
- Modify: `docs/features/documents-tab.md`

- [ ] **Step 1: Document the Reports tab**

Add a section after the existing "Accounting → Documents" entry covering: the two inner tabs; the publish button's completeness rule (`paidCount > 0` and `notPaid + threshold + problem + outstanding === 0`, `urgent_*` excluded); the `app_settings` key format and that **no migration is required**; that the snapshot is frozen so later undos don't change a published report; the four API routes; unpublish→republish as the only refresh path; and the three export formats. Link `pay-cycle-report-snapshot.ts`, `pay-cycle-reports.ts`, `pay-cycle-report-export.ts`, `PayCycleReports.tsx`, `PayCycleReportDetail.tsx` and the spec.

Note explicitly that this is **separate from** Payment Dispatch → Reports (live, every cycle, derived) and from the `payment_cycle_complete` confetti webhook (which fires on PD's 100%, not on publish).

- [ ] **Step 2: Commit**

```bash
git add docs/features/documents-tab.md
git commit -m "docs: document the Accounting Documents Reports tab"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Inner tab bar, badge, localStorage, subtitle, Refresh | 7 |
| Reports list: 3-state publish card, "Also unpublished", published grid | 5 |
| Confirm dialog copy | 5 |
| Detail view: stats, processor band, who-got-paid table, unpublish | 6 |
| Data model, key format, `version`, row granularity | 1 (shape) + 2 (storage) |
| Eligibility rule, `urgent_*` exclusion, incomplete fallback | 1 (rule) + 2 (selection) |
| API: GET/POST collection, GET/DELETE item, gates, 409 re-check | 3 |
| Exports: CSV/XLSX/PDF, columns, theme, WinAnsi | 4 (build) + 6 (wiring) |
| Error handling: list, publish, duplicate, malformed, zero-payee | 2 (`parseSnapshot`, `already`), 3 (409/500), 5 (`unreadable` strip), 6 (disabled exports) |
| Testing: eligibility, snapshot, export | 1, 4 |
| Out of scope: no notification, no PD change, no bucket | respected — no task touches them |

**Placeholder scan** — no TBD/TODO. Every code step carries real code; the two prose-heavy steps (Task 4 Step 3, Task 5 Steps 2–3) name exact constants, column headers, class names and the file:line to copy from, and their assertions are pinned by Task 4's tests. The Task 5 detail-view stub is explicitly temporary and is replaced in Task 6 Step 5.

**Type consistency** — checked across tasks: `PayCycleReportSnapshot` fields are snake_case (matching the stored JSON) while `totals`/`byProcessor`/`payees` members are camelCase, used identically in Tasks 2, 4, 5, 6. `cycleCompleteness` returns `{complete, paidCount, pendingCount, blockedCount}` — the same four names the 409 payload and the muted card consume. `payCycleReportKey`/`PAY_CYCLE_REPORT_PREFIX` are defined once (Task 2) and used only there. `buildPayCycleReportExport(snapshot, opts)` has the same signature in Task 4's definition, its test, and Task 6's `exportModel()`. `PublishableCycle`/`IncompleteCycle` are deliberately re-declared client-side in Task 5 (with the reason given) since their server module is `server-only`.
