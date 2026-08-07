# Payroll Wizard Validation Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Payroll Wizard's Validation (Step 7) five-column table with a per-department calculation breakdown that shows every component of a person's pay, recomputes gross independently, and flags rows where the numbers do not reconcile.

**Architecture:** A pure, unit-tested module (`validation-breakdown.ts`) turns each `CalcRow` plus its staged dispatch payload into a typed `PayrollBreakdown` with flags. A presentational component (`ValidationBreakdownTable.tsx`) renders it as a grouped, horizontally-scrolling table with per-row expansion. `PayrollWizard.tsx` case 7 keeps its department rail, search and summary cards and delegates the table.

**Tech Stack:** TypeScript, React 19, Next.js App Router, Tailwind, `motion/react`, shadcn-style `@/components/ui/*`. Tests are `node:test` run through `tsx` — no React test renderer exists in this repo.

**Spec:** `docs/superpowers/specs/2026-08-07-payroll-wizard-validation-breakdown-design.md`

## Global Constraints

- Money tolerance for reconciliation is **₱0.01**. Rate comparison tolerance is **₱0.01**.
- Reuse `HSL_WEEKEND_PREMIUM_PHP` (15) and `OT_DIFFERENTIAL_MULTIPLIER` (0.5) from `src/lib/payroll/hogan-week-pay.ts`. Never re-declare those literals.
- All money rounds to 2dp with `Math.round(n * 100) / 100`.
- Red flags **never** block Step 8. Only FX-at-zero blocks dispatch. Continue shows a confirmation dialog when the red count is non-zero.
- `CalcRow.weekend.regularPay` / `.otPay` are **already inside** `regularPay` / `otPay`. Never add them on top.
- The new table must render a row for **every** `effectiveCalcResults` entry, including people with no personal email who never become dispatch rows.
- Tests: `npm test` runs `node --import tsx --test "src/**/*.test.ts"`. Single file: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`.
- Typecheck: `npm run lint` (which is `tsc --noEmit`).
- Do not run `next build` without checking for a running dev server first — they share `.next/`.
- Commit locally to `main`. Never push. Stage only the files each task names.

## Deviations from the spec

Two research findings supersede the spec text. Both are implemented as written here.

1. **`not_dispatchable` is a new red flag.** `dispatchData` drops anyone whose personal email cannot be resolved into a `missing` array (`PayrollWizard.tsx:7498-7513`) — they never become a `DispatchEmployee`. Step 7 currently shows them anyway, with a Final Pay that will never be paid. Sourcing the table from `dispatchData` would hide them; instead we iterate `effectiveCalcResults` and join the payload by email, flagging rows with no payload. This is a payability failure, not the dispatch-readiness group that was descoped.

2. **`gross_mismatch` has different strength per department.** For HSL, `gross` is re-derived from hours × derived rates and is a genuinely independent check against the engine. For base departments both figures trace to the same payload, so it degrades to "do the itemized parts sum to the stated total". Still worth keeping — it is the standing net for the `mesaDisbursement` class of bug — but do not describe it as independent verification for non-HSL.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/format-php.ts` | **Create.** `formatPHP(n)`. Currently a private function at `PayrollWizard.tsx:1163`; the new component needs it too. |
| `src/lib/payroll/validation-breakdown.ts` | **Create.** Pure. Input → `PayrollBreakdown[]` + flags. No React, no fetch, no dates. |
| `src/lib/payroll/validation-breakdown.test.ts` | **Create.** Unit tests, synthetic fixtures only. |
| `src/components/payroll/ValidationBreakdownTable.tsx` | **Create.** Presentational table: group headers, row expansion, flag rendering. |
| `src/components/PayrollWizard.tsx` | **Modify.** Case 7 delegates the table; fix the `mesaDisbursement` omission; replace local `formatPHP`; add the Continue confirmation. |

---

### Task 1: Shared PHP formatter

**Files:**
- Create: `src/lib/format-php.ts`
- Modify: `src/components/PayrollWizard.tsx:1163-1165`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatPHP(n: number): string` — returns `"₱12,930.00"`.

- [ ] **Step 1: Create the module**

```ts
// src/lib/format-php.ts
/**
 * The org's peso formatter. Extracted from PayrollWizard.tsx so the Validation
 * breakdown table can render identical strings to the wizard around it — a table
 * that formats money differently from its own subtotal footer reads as a bug.
 */
export function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

- [ ] **Step 2: Replace the wizard's private copy**

In `src/components/PayrollWizard.tsx`, delete lines 1163-1165:

```ts
function formatPHP(n: number): string {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
```

and add to the import block near the other `@/lib` imports:

```ts
import { formatPHP } from '@/lib/format-php';
```

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: PASS, no errors. Every existing `formatPHP(...)` call site now resolves to the import.

- [ ] **Step 4: Commit**

```bash
git add src/lib/format-php.ts src/components/PayrollWizard.tsx
git commit -m "refactor(payroll): extract formatPHP for reuse outside the wizard"
```

---

### Task 2: Breakdown module — types and base derivation

**Files:**
- Create: `src/lib/payroll/validation-breakdown.ts`
- Test: `src/lib/payroll/validation-breakdown.test.ts`

**Interfaces:**
- Consumes: `formatPHP` from Task 1.
- Produces: `BreakdownInput`, `PayrollBreakdown`, `ValidationFlag`, `ValidationFlagCode`, `buildValidationBreakdown(input): PayrollBreakdown`, `buildValidationBreakdowns(inputs): PayrollBreakdown[]`, `countRedFlags(rows): number`, `round2(n): number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/payroll/validation-breakdown.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildValidationBreakdown, type BreakdownInput } from './validation-breakdown';

/**
 * All figures synthetic. The real-sheet oracle is scripts/verify-hogan-formula.mts,
 * which reads an export that is deliberately never committed (real names + salaries).
 */
function baseInput(over: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    email: 'test@simple.biz',
    name: 'Test Person',
    deptKey: 'support',
    deptName: 'Support',
    isHsl: false,
    excluded: false,
    totalHours: 42,
    regularHours: 40,
    otHours: 2,
    regularRate: 200,
    otRate: 300,
    regularPay: 8000,
    otPay: 600,
    initialPay: 8600,
    weekend: null,
    rateChange: null,
    dispatch: {
      final: 9500,
      pab: 0, tech: 0, other: 1000, adjustment: 0,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0,
    },
    rateSourceIssue: null,
    ...over,
  };
}

test('base department: hours, rates and earnings come straight from the engine', () => {
  const b = buildValidationBreakdown(baseInput());
  assert.equal(b.hours.mf, 42);
  assert.equal(b.hours.we, 0);
  assert.equal(b.hours.ot, 2);
  assert.equal(b.rates?.mf, 200);
  assert.equal(b.rates?.ot, 300);
  assert.equal(b.rates?.we, null);
  assert.equal(b.rates?.otDifferential, null);
  assert.equal(b.earnings.base, 8000);
  assert.equal(b.earnings.weekend, 0);
  assert.equal(b.earnings.otPay, 600);
});

test('base department: gross sums components and ties to the dispatch total', () => {
  const b = buildValidationBreakdown(baseInput());
  // 8000 + 0 + 600 + 1000 bonus - 100 MESA = 9500
  assert.equal(b.gross, 9500);
  assert.equal(b.dispatchNet, 9500);
  assert.equal(b.flags.length, 0);
});

test('bonusParts itemise the dispatch payload', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: {
      final: 11000, pab: 1000, tech: 500, other: 1000, adjustment: 0,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0,
    },
  }));
  assert.equal(b.earnings.bonuses, 2500);
  assert.deepEqual(b.earnings.bonusParts, { kpi: 1000, pab: 1000, tech: 500, other: 0 });
});
```

Note on `bonusParts`: the dispatch payload's `other_bonuses` holds KPI and departmental performance amounts together. The module maps payload `other` → `bonusParts.kpi` and leaves `bonusParts.other` for the signed accounting `adjustment` when it is folded in. See Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: FAIL — `Cannot find module './validation-breakdown'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/payroll/validation-breakdown.ts
/**
 * Turns one person's pay week into the itemised breakdown the Payroll Wizard's
 * Validation step renders — and, for HSL, independently re-derives the total from
 * hours and rates so the table can prove itself against the engine.
 *
 * PURE: no React, no fetch, no Date. Every input is passed in by the caller so the
 * whole thing is unit-testable and so the wizard and any future server-side check
 * can run identical arithmetic.
 *
 * Why the table does not simply read the staged dispatch payload: `dispatchData`
 * skips anyone whose personal email cannot be resolved, so sourcing from it would
 * silently drop people from the one screen that certifies the cycle. The caller
 * iterates the calc results and joins the payload in; a row with no payload is
 * flagged `not_dispatchable` rather than hidden.
 */
import {
  HSL_WEEKEND_PREMIUM_PHP,
  OT_DIFFERENTIAL_MULTIPLIER,
  REGULAR_WEEK_CAP_HOURS,
} from '@/lib/payroll/hogan-week-pay';
import { formatPHP } from '@/lib/format-php';

/** Money tolerance. Per-day accumulation rounds once at the end. */
const MONEY_EPSILON_PHP = 0.01;
/** Rates are money; compare to the centavo. */
const RATE_EPSILON_PHP = 0.01;

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export type ValidationFlagCode =
  | 'no_rate'
  | 'hours_without_pay'
  | 'pay_without_hours'
  | 'negative_gross'
  | 'gross_mismatch'
  | 'not_dispatchable'
  | 'ot_ratio'
  | 'rate_source';

export type ValidationFlag = {
  code: ValidationFlagCode;
  severity: 'red' | 'amber';
  /** Human-readable one-liner shown on the row. */
  message: string;
};

/** The staged dispatch payload's money, flattened. Null when the person has no
 *  personal email and therefore never becomes a dispatch row. */
export type BreakdownDispatch = {
  final: number;
  pab: number;
  tech: number;
  other: number;
  adjustment: number;
  mesaDeduction: number;
  mesaDisbursement: number;
  orphanage: number;
};

export type BreakdownInput = {
  email: string;
  name: string;
  deptKey: string | null;
  deptName: string;
  isHsl: boolean;
  excluded: boolean;
  totalHours: number;
  regularHours: number;
  otHours: number;
  regularRate: number | null;
  otRate: number | null;
  regularPay: number | null;
  otPay: number | null;
  initialPay: number | null;
  /** HSL-only carve-out. Its pay is ALREADY inside regularPay/otPay. */
  weekend: {
    regularHours: number;
    otHours: number;
    regularPay: number | null;
    otPay: number | null;
  } | null;
  rateChange: { from: number | null; to: number | null } | null;
  dispatch: BreakdownDispatch | null;
  rateSourceIssue: {
    shortfallPhp: number;
    sheetRate: number | null;
    paidRate: number | null;
  } | null;
};

export type PayrollBreakdown = {
  email: string;
  name: string;
  deptKey: string | null;
  deptName: string;
  isHsl: boolean;
  excluded: boolean;
  hours: { mf: number; we: number; ot: number; total: number };
  rates: {
    mf: number;
    ot: number | null;
    we: number | null;
    otDifferential: number | null;
  } | null;
  rateChange: { from: number; to: number } | null;
  earnings: {
    base: number;
    weekend: number;
    otPay: number;
    bonuses: number;
    bonusParts: { kpi: number; pab: number; tech: number; other: number };
  };
  adjustments: {
    mesaDeduction: number;
    mesaDisbursement: number;
    adjustment: number;
    orphanage: number;
  };
  gross: number;
  dispatchNet: number | null;
  flags: ValidationFlag[];
};

export function buildValidationBreakdown(input: BreakdownInput): PayrollBreakdown {
  const d = input.dispatch;

  const adjustments = {
    mesaDeduction: round2(num(d?.mesaDeduction)),
    mesaDisbursement: round2(num(d?.mesaDisbursement)),
    adjustment: round2(num(d?.adjustment)),
    orphanage: round2(num(d?.orphanage)),
  };

  // The payload's `other_bonuses` carries KPI + departmental performance together;
  // the wizard has no split for them, so it lands in `kpi` and `other` stays 0.
  // Keeping the field means a future split needs no shape change here.
  const bonusParts = {
    kpi: round2(num(d?.other)),
    pab: round2(num(d?.pab)),
    tech: round2(num(d?.tech)),
    other: 0,
  };
  const bonuses = round2(bonusParts.kpi + bonusParts.pab + bonusParts.tech + bonusParts.other);

  const hours = deriveHours(input);
  const rates = deriveRates(input);
  const earnings = { ...deriveEarnings(input, hours, rates), bonuses, bonusParts };

  const gross = round2(
    earnings.base +
      earnings.weekend +
      earnings.otPay +
      earnings.bonuses +
      adjustments.adjustment +
      adjustments.orphanage +
      adjustments.mesaDisbursement -
      adjustments.mesaDeduction,
  );

  const dispatchNet = d ? round2(d.final) : null;

  const rateChange =
    input.rateChange && input.rateChange.from != null && input.rateChange.to != null
      ? { from: input.rateChange.from, to: input.rateChange.to }
      : null;

  return {
    email: input.email,
    name: input.name,
    deptKey: input.deptKey,
    deptName: input.deptName,
    isHsl: input.isHsl,
    excluded: input.excluded,
    hours,
    rates,
    rateChange,
    earnings,
    adjustments,
    gross,
    dispatchNet,
    flags: [],
  };
}

function deriveHours(input: BreakdownInput): PayrollBreakdown['hours'] {
  const total = round2(num(input.totalHours));
  const we = input.weekend
    ? round2(num(input.weekend.regularHours) + num(input.weekend.otHours))
    : 0;
  // HSL follows the sheet: M-F is everything that is not weekend, and it INCLUDES
  // the hours that end up classed as overtime (column AB).
  const mf = input.isHsl ? round2(total - we) : total;
  const ot = input.isHsl
    ? round2(Math.max(0, total - REGULAR_WEEK_CAP_HOURS))
    : round2(num(input.otHours));
  return { mf, we, ot, total };
}

function deriveRates(input: BreakdownInput): PayrollBreakdown['rates'] {
  if (input.regularRate == null) return null;
  const mf = input.regularRate;
  // The sheet DERIVES both of these rather than storing them, which is what makes
  // an off-ratio OT rate inexpressible. Only meaningful for HSL.
  const hsl = input.isHsl && input.weekend != null;
  return {
    mf,
    ot: input.otRate,
    we: hsl ? round2(mf + HSL_WEEKEND_PREMIUM_PHP) : null,
    otDifferential: input.isHsl ? round2(mf * OT_DIFFERENTIAL_MULTIPLIER) : null,
  };
}

function deriveEarnings(
  input: BreakdownInput,
  hours: PayrollBreakdown['hours'],
  rates: PayrollBreakdown['rates'],
): { base: number; weekend: number; otPay: number } {
  // HSL renders the sheet's three-stage form, re-derived from hours and rates. This
  // is the only genuinely independent path in the module: it never reads regularPay
  // or otPay, so a disagreement with the engine is real signal.
  //
  // Requires the weekend carve-out. `CalcRow.weekend` is null for non-HSL rows AND
  // for HSL rows with no per-day columns, where the M-F / WE split is unknowable —
  // those degrade to the base shape rather than guessing.
  if (input.isHsl && input.weekend != null && rates != null && rates.we != null) {
    return {
      base: round2(hours.mf * rates.mf),
      weekend: round2(hours.we * rates.we),
      otPay: round2(hours.ot * num(rates.otDifferential)),
    };
  }
  // Base shape: the engine's own figures. `regularPay` already contains any weekend
  // pay, so the weekend column stays 0 — adding it would double-count.
  return {
    base: round2(num(input.regularPay)),
    weekend: 0,
    otPay: round2(num(input.otPay)),
  };
}

export function buildValidationBreakdowns(inputs: BreakdownInput[]): PayrollBreakdown[] {
  return inputs.map(buildValidationBreakdown);
}

export function countRedFlags(rows: PayrollBreakdown[]): number {
  return rows.filter((r) => r.flags.some((f) => f.severity === 'red')).length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/validation-breakdown.ts src/lib/payroll/validation-breakdown.test.ts
git commit -m "feat(payroll): validation breakdown module — base derivation"
```

---

### Task 3: HSL sheet-form derivation

**Files:**
- Modify: `src/lib/payroll/validation-breakdown.ts` (already correct from Task 2 — this task proves it)
- Test: `src/lib/payroll/validation-breakdown.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: no new exports. Locks HSL behaviour behind tests.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/payroll/validation-breakdown.test.ts`:

```ts
function hslInput(over: Partial<BreakdownInput> = {}): BreakdownInput {
  // Marie: M-F 38.00 @ ₱265, weekend 6.00 @ ₱280, so 44.00 total → 4.00 OT @ ₱132.50.
  //   base 38.00 × 265.00 = 10,070.00
  //   wknd  6.00 × 280.00 =  1,680.00
  //   OT ½  4.00 × 132.50 =    530.00   → 12,280.00
  //   + 500 adjustment + 250 orphanage - 100 MESA = 12,930.00
  return {
    email: 'marie@hogansmith.com',
    name: 'Marie C',
    deptKey: 'hsl',
    deptName: 'Hogan Smith Law',
    isHsl: true,
    excluded: false,
    totalHours: 44,
    regularHours: 40,
    otHours: 4,
    regularRate: 265,
    otRate: 397.5,
    regularPay: 11220,
    otPay: 1590,
    initialPay: 12810,
    weekend: { regularHours: 6, otHours: 0, regularPay: 1680, otPay: 0 },
    rateChange: null,
    dispatch: {
      final: 12930, pab: 0, tech: 0, other: 0, adjustment: 500,
      mesaDeduction: 100, mesaDisbursement: 0, orphanage: 250,
    },
    rateSourceIssue: null,
    ...over,
  };
}

test('HSL derives the weekend rate and OT differential from the M-F rate', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.rates?.mf, 265);
  assert.equal(b.rates?.we, 280);              // 265 + 15
  assert.equal(b.rates?.otDifferential, 132.5); // 265 × 0.5
});

test('HSL splits M-F from weekend and counts OT across all seven days', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.hours.we, 6);
  assert.equal(b.hours.mf, 38);   // 44 total - 6 weekend; INCLUDES its own OT hours
  assert.equal(b.hours.ot, 4);    // max(0, 44 - 40)
});

test('HSL gross reconciles to the sheet formula and to dispatch', () => {
  const b = buildValidationBreakdown(hslInput());
  assert.equal(b.earnings.base, 10070);
  assert.equal(b.earnings.weekend, 1680);
  assert.equal(b.earnings.otPay, 530);
  assert.equal(b.gross, 12930);
  assert.equal(b.dispatchNet, 12930);
});

test('the weekend carve-out is never added on top of regular pay', () => {
  // regularPay 11,220 already CONTAINS the 1,680 of weekend pay. A naive
  // base + weekend would report 12,900 of hourly pay instead of 12,280.
  const b = buildValidationBreakdown(hslInput());
  const hourly = b.earnings.base + b.earnings.weekend + b.earnings.otPay;
  assert.equal(hourly, 12280);
  assert.notEqual(hourly, 12900);
});

test('an HSL row with no per-day data degrades to the base shape', () => {
  const b = buildValidationBreakdown(hslInput({ weekend: null }));
  assert.equal(b.hours.we, 0);
  assert.equal(b.rates?.we, null);
  assert.equal(b.earnings.base, 11220);  // the engine's own regularPay
  assert.equal(b.earnings.weekend, 0);
  assert.equal(b.earnings.otPay, 1590);  // the engine's own otPay
});
```

- [ ] **Step 2: Run tests to verify which fail**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: the five new tests PASS if Task 2 was implemented exactly as written. If any fail, fix `deriveHours` / `deriveRates` / `deriveEarnings` — do not change the test expectations, they are arithmetic.

- [ ] **Step 3: Commit**

```bash
git add src/lib/payroll/validation-breakdown.test.ts
git commit -m "test(payroll): lock HSL sheet-form derivation in the breakdown module"
```

---

### Task 4: Red flags

**Files:**
- Modify: `src/lib/payroll/validation-breakdown.ts`
- Test: `src/lib/payroll/validation-breakdown.test.ts`

**Interfaces:**
- Consumes: `PayrollBreakdown`, `BreakdownInput`, `round2`, `MONEY_EPSILON_PHP` from Task 2.
- Produces: `deriveFlags(input, partial): ValidationFlag[]`, wired into `buildValidationBreakdown` so `flags` is populated.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/payroll/validation-breakdown.test.ts`:

```ts
function codes(b: { flags: { code: string }[] }): string[] {
  return b.flags.map((f) => f.code).sort();
}

test('no_rate: hours logged but no rate resolved', () => {
  const b = buildValidationBreakdown(baseInput({
    regularRate: null, otRate: null, regularPay: null, otPay: null, initialPay: null,
    dispatch: { final: 0, pab: 0, tech: 0, other: 0, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('no_rate'));
  assert.equal(b.flags.find((f) => f.code === 'no_rate')?.severity, 'red');
});

test('hours_without_pay: hours worked, nothing computed', () => {
  const b = buildValidationBreakdown(baseInput({
    regularPay: 0, otPay: 0, initialPay: 0,
    dispatch: { final: 0, pab: 0, tech: 0, other: 0, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('hours_without_pay'));
});

test('pay_without_hours: money with no hours behind it', () => {
  const b = buildValidationBreakdown(baseInput({
    totalHours: 0, regularHours: 0, otHours: 0,
    regularPay: 0, otPay: 0, initialPay: 0,
    dispatch: { final: 1000, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('pay_without_hours'));
});

test('negative_gross: an adjustment larger than the earnings', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: -1900, pab: 0, tech: 0, other: 0, adjustment: -10500,
                mesaDeduction: 0, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(codes(b).includes('negative_gross'));
});

test('gross_mismatch: the parts do not sum to the stated total', () => {
  // Reproduces the live bug: a MESA disbursement present in the engine total but
  // missing from the itemisation the table renders.
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: 12000, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.equal(b.gross, 9500);
  assert.equal(b.dispatchNet, 12000);
  assert.ok(codes(b).includes('gross_mismatch'));
});

test('gross_mismatch tolerates a centavo of rounding', () => {
  const b = buildValidationBreakdown(baseInput({
    dispatch: { final: 9500.01, pab: 0, tech: 0, other: 1000, adjustment: 0,
                mesaDeduction: 100, mesaDisbursement: 0, orphanage: 0 },
  }));
  assert.ok(!codes(b).includes('gross_mismatch'));
});

test('not_dispatchable: the row will never become a payment', () => {
  const b = buildValidationBreakdown(baseInput({ dispatch: null }));
  assert.equal(b.dispatchNet, null);
  assert.ok(codes(b).includes('not_dispatchable'));
  // gross_mismatch must NOT also fire — there is no total to disagree with.
  assert.ok(!codes(b).includes('gross_mismatch'));
});

test('a prorated week does not trip gross_mismatch', () => {
  const b = buildValidationBreakdown(baseInput({
    rateChange: { from: 285, to: 305 },
  }));
  assert.ok(!codes(b).includes('gross_mismatch'));
  assert.deepEqual(b.rateChange, { from: 285, to: 305 });
});

test('a clean row carries no flags', () => {
  assert.deepEqual(buildValidationBreakdown(baseInput()).flags, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: FAIL — `flags` is always `[]`, so every assertion expecting a code fails.

- [ ] **Step 3: Add the flag derivation**

In `src/lib/payroll/validation-breakdown.ts`, add before `buildValidationBreakdown`:

```ts
/**
 * Row-level problems worth stopping on. Deliberately short: seven codes is already
 * near the point where a reviewer stops reading them. A flag earns its place only
 * if it means a number on screen is wrong or will not be paid.
 *
 * Proration note: expected pay is never re-derived as hours × rate here. A dated
 * rate change inside the week makes pay a blend of two rates, so that multiplication
 * legitimately disagrees with the engine. `gross` is summed from the engine's own
 * itemised components instead, which stays correct across a mid-week raise.
 */
function deriveFlags(
  input: BreakdownInput,
  b: Omit<PayrollBreakdown, 'flags'>,
): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  const hasHours = b.hours.total > 0;
  const hasRate = input.regularRate != null;
  const paidSomething = num(input.initialPay) > 0;

  if (hasHours && !hasRate) {
    flags.push({
      code: 'no_rate',
      severity: 'red',
      message: `${b.hours.total.toFixed(2)}h logged but no pay rate resolved — this line pays nothing.`,
    });
  }

  if (hasHours && hasRate && !paidSomething) {
    flags.push({
      code: 'hours_without_pay',
      severity: 'red',
      message: `${b.hours.total.toFixed(2)}h logged but initial pay is zero.`,
    });
  }

  if (!hasHours && b.gross > 0) {
    flags.push({
      code: 'pay_without_hours',
      severity: 'red',
      message: `${formatPHP(b.gross)} with no hours behind it.`,
    });
  }

  if (b.gross < 0) {
    flags.push({
      code: 'negative_gross',
      severity: 'red',
      message: `Gross is ${formatPHP(b.gross)} — adjustments exceed earnings.`,
    });
  }

  if (b.dispatchNet == null) {
    // No personal email, so `dispatchData` never built a payload. The row shows a
    // figure that will not be paid to anyone. Not a readiness warning — the pay run
    // silently omits this person.
    flags.push({
      code: 'not_dispatchable',
      severity: 'red',
      message: 'No personal email on file — this person is skipped by the pay run entirely.',
    });
  } else if (Math.abs(b.gross - b.dispatchNet) > MONEY_EPSILON_PHP) {
    const delta = round2(b.dispatchNet - b.gross);
    flags.push({
      code: 'gross_mismatch',
      severity: 'red',
      message:
        `Components sum to ${formatPHP(b.gross)} but dispatch will send ` +
        `${formatPHP(b.dispatchNet)} — a ${formatPHP(Math.abs(delta))} ` +
        `${delta > 0 ? 'surplus' : 'shortfall'} the itemisation does not explain.`,
    });
  }

  return flags;
}
```

Then replace the `flags: []` line at the end of `buildValidationBreakdown` so the object is built once and flagged against itself:

```ts
  const partial: Omit<PayrollBreakdown, 'flags'> = {
    email: input.email,
    name: input.name,
    deptKey: input.deptKey,
    deptName: input.deptName,
    isHsl: input.isHsl,
    excluded: input.excluded,
    hours,
    rates,
    rateChange,
    earnings,
    adjustments,
    gross,
    dispatchNet,
  };
  return { ...partial, flags: deriveFlags(input, partial) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payroll/validation-breakdown.ts src/lib/payroll/validation-breakdown.test.ts
git commit -m "feat(payroll): red flags for rows that cannot be paid as calculated"
```

---

### Task 5: Amber flags

**Files:**
- Modify: `src/lib/payroll/validation-breakdown.ts`
- Test: `src/lib/payroll/validation-breakdown.test.ts`

**Interfaces:**
- Consumes: `deriveFlags` from Task 4.
- Produces: no new exports. Adds `ot_ratio` and `rate_source` codes to `deriveFlags` output.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/payroll/validation-breakdown.test.ts`:

```ts
test('ot_ratio: the stored OT rate is not 1.5x the regular rate', () => {
  // The reg+15 corruption: 265 + 15 = 280 sitting in the OT column, where
  // 265 × 1.5 = 397.50 belongs. Underpays ₱117.50 on every overtime hour.
  const b = buildValidationBreakdown(hslInput({ otRate: 280 }));
  assert.ok(codes(b).includes('ot_ratio'));
  assert.equal(b.flags.find((f) => f.code === 'ot_ratio')?.severity, 'amber');
});

test('ot_ratio does not fire when the ratio holds', () => {
  assert.ok(!codes(buildValidationBreakdown(hslInput())).includes('ot_ratio'));
});

test('ot_ratio is HSL-only', () => {
  // A base department's OT rate is a free-standing stored value, not a derived
  // differential — 300 against a 200 regular is 1.5x anyway, but 250 would not be
  // a defect there the way it is for HSL.
  const b = buildValidationBreakdown(baseInput({ otRate: 250 }));
  assert.ok(!codes(b).includes('ot_ratio'));
});

test('rate_source: paid rate differs from the sheet rate', () => {
  const b = buildValidationBreakdown(baseInput({
    rateSourceIssue: { shortfallPhp: 830, sheetRate: 305, paidRate: 285 },
  }));
  const f = b.flags.find((x) => x.code === 'rate_source');
  assert.equal(f?.severity, 'amber');
  assert.match(f?.message ?? '', /285/);
  assert.match(f?.message ?? '', /305/);
});

test('amber flags never suppress red ones', () => {
  const b = buildValidationBreakdown(hslInput({
    otRate: 280,
    dispatch: null,
  }));
  assert.ok(codes(b).includes('ot_ratio'));
  assert.ok(codes(b).includes('not_dispatchable'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: FAIL on the four tests expecting `ot_ratio` / `rate_source`.

- [ ] **Step 3: Add the amber flags**

In `deriveFlags`, insert before `return flags;`:

```ts
  // ── Amber: the number is defensible but its SOURCE disagrees with another store.
  // Never blocking. Shown here rather than only on Step 8 because acting on it after
  // the lock means unlocking the cycle.

  // A permanent regression net for the reg+15 corruption fixed 2026-08-04, where the
  // weekend premium had been mis-keyed into the OT rate column and ten HSL people were
  // underpaid on every overtime hour. Expected to report zero — the value is the next one.
  if (input.isHsl && b.rates != null && b.rates.ot != null && b.rates.otDifferential != null) {
    const expectedOtRate = round2(b.rates.mf + b.rates.otDifferential); // mf × 1.5
    if (Math.abs(b.rates.ot - expectedOtRate) > RATE_EPSILON_PHP) {
      const ratio = b.rates.mf > 0 ? b.rates.ot / b.rates.mf : 0;
      flags.push({
        code: 'ot_ratio',
        severity: 'amber',
        message:
          `OT rate is ${formatPHP(b.rates.ot)}/h against a ${formatPHP(b.rates.mf)}/h ` +
          `regular rate — ${ratio.toFixed(2)}×, where the sheet derives ` +
          `${formatPHP(expectedOtRate)}/h (1.50×).`,
      });
    }
  }

  if (input.rateSourceIssue) {
    const { paidRate, sheetRate, shortfallPhp } = input.rateSourceIssue;
    const rates =
      paidRate != null && sheetRate != null
        ? `paid ${formatPHP(paidRate)}/h, sheet says ${formatPHP(sheetRate)}/h`
        : 'the paid rate and the sheet rate disagree';
    const short = shortfallPhp > 0 ? ` — ${formatPHP(shortfallPhp)} short this week.` : '.';
    flags.push({
      code: 'rate_source',
      severity: 'amber',
      message: `Rate sources disagree: ${rates}${short}`,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test src/lib/payroll/validation-breakdown.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `npm test`
Expected: PASS. No existing test touches these files, so nothing else should change.

- [ ] **Step 6: Commit**

```bash
git add src/lib/payroll/validation-breakdown.ts src/lib/payroll/validation-breakdown.test.ts
git commit -m "feat(payroll): amber flags for rate-source disagreement"
```

---

### Task 6: The breakdown table component

**Files:**
- Create: `src/components/payroll/ValidationBreakdownTable.tsx`

**Interfaces:**
- Consumes: `PayrollBreakdown`, `countRedFlags` from Task 2/4; `formatPHP` from Task 1.
- Produces: `export default function ValidationBreakdownTable(props: { rows: PayrollBreakdown[]; deptName: string; isHsl: boolean; disabled: boolean; onToggleExcluded: (email: string) => void; onToggleAllExcluded: (emails: string[], next: boolean) => void; })`.

There is **no React test renderer in this repo** — `npm test` globs `src/**/*.test.ts`, not `.tsx`. This task verifies by typecheck plus a manual browser pass in Task 7. Do not add a test framework.

- [ ] **Step 1: Create the component**

```tsx
// src/components/payroll/ValidationBreakdownTable.tsx
'use client';

import React, { useState } from 'react';
import { AlertTriangle, ChevronRight, Ban } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPHP } from '@/lib/format-php';
import type { PayrollBreakdown, ValidationFlag } from '@/lib/payroll/validation-breakdown';

type Props = {
  rows: PayrollBreakdown[];
  deptName: string;
  /** Drives the column set: HSL shows the sheet's M-F / WE / OT½ form. */
  isHsl: boolean;
  disabled: boolean;
  onToggleExcluded: (email: string) => void;
  onToggleAllExcluded: (emails: string[], next: boolean) => void;
};

const H = 'px-2 py-2 text-right text-[11px] font-medium text-zinc-600 dark:text-zinc-400';
const GROUP =
  'px-2 py-1 text-center text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500';
const CELL = 'px-2 py-2.5 text-right font-mono text-xs tabular-nums';

function money(n: number, dim = false): React.ReactNode {
  if (n === 0) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  return <span className={dim ? 'text-zinc-600 dark:text-zinc-400' : undefined}>{formatPHP(n)}</span>;
}

function hrs(n: number): React.ReactNode {
  if (n === 0) return <span className="text-zinc-300 dark:text-zinc-600">—</span>;
  return <>{n.toFixed(2)}</>;
}

function FlagList({ flags }: { flags: ValidationFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {flags.map((f) => (
        <div
          key={f.code}
          className={cn(
            'flex items-start gap-1.5 text-[10px] leading-snug',
            f.severity === 'red'
              ? 'text-rose-700 dark:text-rose-300'
              : 'text-amber-700 dark:text-amber-300',
          )}
        >
          {f.severity === 'red' ? (
            <Ban className="mt-px h-3 w-3 shrink-0" />
          ) : (
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          )}
          <span>{f.message}</span>
        </div>
      ))}
    </div>
  );
}

/** The worked calculation, shown when a row is expanded. */
function WorkedTotal({ r }: { r: PayrollBreakdown }) {
  const lines: Array<[string, string, number]> = [];
  if (r.isHsl && r.rates?.we != null) {
    lines.push(['M-F', `${r.hours.mf.toFixed(2)} h × ${formatPHP(r.rates.mf)}`, r.earnings.base]);
    if (r.hours.we > 0)
      lines.push(['Weekend', `${r.hours.we.toFixed(2)} h × ${formatPHP(r.rates.we)}`, r.earnings.weekend]);
    if (r.hours.ot > 0 && r.rates.otDifferential != null)
      lines.push(['OT ½', `${r.hours.ot.toFixed(2)} h × ${formatPHP(r.rates.otDifferential)}`, r.earnings.otPay]);
  } else {
    lines.push(['Regular', r.rates ? `${r.hours.mf.toFixed(2)} h × ${formatPHP(r.rates.mf)}` : '—', r.earnings.base]);
    if (r.hours.ot > 0)
      lines.push(['Overtime', r.rates?.ot != null ? `${r.hours.ot.toFixed(2)} h × ${formatPHP(r.rates.ot)}` : '—', r.earnings.otPay]);
  }
  const { kpi, pab, tech } = r.earnings.bonusParts;
  if (kpi) lines.push(['KPI / performance', '', kpi]);
  if (pab) lines.push(['Perfect attendance', '', pab]);
  if (tech) lines.push(['Tech bonus', '', tech]);
  if (r.adjustments.adjustment) lines.push(['Adjustment', '', r.adjustments.adjustment]);
  if (r.adjustments.orphanage) lines.push(['Orphanage', '', r.adjustments.orphanage]);
  if (r.adjustments.mesaDisbursement) lines.push(['MESA disbursement', '', r.adjustments.mesaDisbursement]);
  if (r.adjustments.mesaDeduction) lines.push(['MESA', '', -r.adjustments.mesaDeduction]);

  const ties = r.dispatchNet != null && Math.abs(r.dispatchNet - r.gross) <= 0.01;

  return (
    <div className="border-l-2 border-indigo-300 bg-indigo-50/40 px-4 py-3 dark:border-indigo-700 dark:bg-indigo-950/15">
      <table className="text-[11px]">
        <tbody>
          {lines.map(([label, basis, amount], i) => (
            <tr key={i}>
              <td className="py-0.5 pr-4 text-zinc-600 dark:text-zinc-400">{label}</td>
              <td className="py-0.5 pr-4 font-mono text-zinc-500 dark:text-zinc-500">{basis}</td>
              <td className="py-0.5 text-right font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
                {amount < 0 ? `− ${formatPHP(Math.abs(amount))}` : formatPHP(amount)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-indigo-300/60 dark:border-indigo-700/60">
            <td className="pt-1 pr-4 font-semibold text-zinc-800 dark:text-zinc-200">Gross</td>
            <td />
            <td className="pt-1 text-right font-mono font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
              {formatPHP(r.gross)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className={cn('mt-1.5 text-[10px]', ties ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
        {r.dispatchNet == null
          ? 'Not staged for dispatch — this row will not be paid.'
          : ties
            ? '✓ ties to dispatch'
            : `Dispatch will send ${formatPHP(r.dispatchNet)}.`}
      </p>
    </div>
  );
}

export default function ValidationBreakdownTable({
  rows, deptName, isHsl, disabled, onToggleExcluded, onToggleAllExcluded,
}: Props) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (email: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  const emails = rows.map((r) => r.email);
  const excludedCount = rows.filter((r) => r.excluded).length;
  const allExcluded = rows.length > 0 && excludedCount === rows.length;
  const someExcluded = excludedCount > 0 && !allExcluded;

  const payable = rows.filter((r) => !r.excluded);
  const subtotal = payable.reduce((s, r) => s + r.gross, 0);

  // Column count for colSpan on the expanded row and the empty state.
  const cols = isHsl ? 14 : 12;

  return (
    <div className="overflow-auto [scrollbar-gutter:stable]" style={{ maxHeight: 'min(62vh, calc(100dvh - 26rem))' }}>
      <table className={cn('w-full text-xs', isHsl ? 'min-w-[1240px]' : 'min-w-[1040px]')}>
        <thead className="sticky top-0 z-20 bg-zinc-100/95 shadow-[0_1px_0_0_rgb(228_228_231)] dark:bg-zinc-900/95 dark:shadow-[0_1px_0_0_rgb(39_39_42)]">
          <tr>
            <th className={GROUP} colSpan={2} />
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Hours</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 3 : 2}>Rates</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={isHsl ? 4 : 3}>Earnings</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={3}>Adjustments</th>
            <th className={cn(GROUP, 'border-l border-zinc-200 dark:border-zinc-800')} colSpan={2}>Gross</th>
          </tr>
          <tr>
            <th className="w-6 px-1" />
            <th className="min-w-[170px] px-3 text-left text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Employee</th>
            {isHsl ? (
              <>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>M-F</th>
                <th className={H}>WE</th>
                <th className={H}>OT</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>M-F rate</th>
                <th className={H} title="M-F rate + ₱15 Sat/Sun premium">WE rate</th>
                <th className={H} title="M-F rate × 0.5 — the second stage of 1.5× overtime">OT ½</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Base</th>
                <th className={H}>Wknd</th>
                <th className={H}>OT $</th>
              </>
            ) : (
              <>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg</th>
                <th className={H}>OT</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg rate</th>
                <th className={H}>OT rate</th>
                <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')}>Reg pay</th>
                <th className={H}>OT pay</th>
              </>
            )}
            <th className={H}>Bonus</th>
            <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800')} title="₱100/paycheck for enrolled members, plus any approved disbursement">MESA</th>
            <th className={H}>Adj</th>
            <th className={H}>Orph</th>
            <th className={cn(H, 'border-l border-zinc-200 dark:border-zinc-800 font-semibold text-indigo-600 dark:text-indigo-400')}>Gross</th>
            <th className="min-w-[80px] px-2 text-center text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
              <div className="flex items-center justify-center gap-1.5">
                <input
                  type="checkbox"
                  checked={allExcluded}
                  ref={(el) => { if (el) el.indeterminate = someExcluded; }}
                  onChange={() => onToggleAllExcluded(emails, !allExcluded)}
                  disabled={disabled || rows.length === 0}
                  aria-label={`Exclude all employees in ${deptName} from pay`}
                  className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                />
                <span>Excl</span>
              </div>
            </th>
          </tr>
        </thead>

        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={cols} className="py-10 text-center text-sm text-zinc-400">
                No employees in this department.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const isOpen = open.has(r.email);
              const hasRed = r.flags.some((f) => f.severity === 'red');
              const hasAmber = !hasRed && r.flags.some((f) => f.severity === 'amber');
              const dim = r.excluded ? 'opacity-55' : '';
              return (
                <React.Fragment key={r.email}>
                  <tr
                    className={cn(
                      'hover:bg-zinc-50 dark:hover:bg-zinc-900/30',
                      r.excluded && 'bg-rose-50/40 dark:bg-rose-950/15',
                      hasRed && !r.excluded && 'bg-rose-50/60 dark:bg-rose-950/20',
                      hasAmber && !r.excluded && 'bg-amber-50/50 dark:bg-amber-950/15',
                    )}
                  >
                    <td className="px-1 align-top">
                      <button
                        type="button"
                        onClick={() => toggleOpen(r.email)}
                        aria-label={isOpen ? `Hide calculation for ${r.name}` : `Show calculation for ${r.name}`}
                        aria-expanded={isOpen}
                        className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      >
                        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} />
                      </button>
                    </td>
                    <td className={cn('px-3 py-2.5 align-top', dim)}>
                      <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{r.name || '—'}</div>
                      <div className="truncate font-mono text-[10px] text-zinc-400">{r.email}</div>
                      <FlagList flags={r.flags} />
                    </td>

                    {isHsl ? (
                      <>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{hrs(r.hours.mf)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.we)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.ot)}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                          {r.rateChange
                            ? <span title="Rate changed mid-period — pay is prorated across both">{formatPHP(r.rateChange.from)} → {formatPHP(r.rateChange.to)}</span>
                            : r.rates ? formatPHP(r.rates.mf) : '—'}
                        </td>
                        <td className={cn(CELL, dim)}>{r.rates?.we != null ? formatPHP(r.rates.we) : '—'}</td>
                        <td className={cn(CELL, dim)}>{r.rates?.otDifferential != null ? formatPHP(r.rates.otDifferential) : '—'}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{money(r.earnings.base, true)}</td>
                        <td className={cn(CELL, dim, 'text-amber-600 dark:text-amber-400')}>{money(r.earnings.weekend)}</td>
                        <td className={cn(CELL, dim)}>{money(r.earnings.otPay, true)}</td>
                      </>
                    ) : (
                      <>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{hrs(r.hours.mf)}</td>
                        <td className={cn(CELL, dim)}>{hrs(r.hours.ot)}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                          {r.rateChange
                            ? <span title="Rate changed mid-period — pay is prorated across both">{formatPHP(r.rateChange.from)} → {formatPHP(r.rateChange.to)}</span>
                            : r.rates ? formatPHP(r.rates.mf) : '—'}
                        </td>
                        <td className={cn(CELL, dim)}>{r.rates?.ot != null ? formatPHP(r.rates.ot) : '—'}</td>
                        <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>{money(r.earnings.base, true)}</td>
                        <td className={cn(CELL, dim)}>{money(r.earnings.otPay, true)}</td>
                      </>
                    )}

                    <td className={cn(CELL, dim, 'text-emerald-600 dark:text-emerald-400')}>
                      {r.earnings.bonuses > 0 ? `+${formatPHP(r.earnings.bonuses)}` : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </td>
                    <td className={cn(CELL, dim, 'border-l border-zinc-100 dark:border-zinc-800/60')}>
                      {r.adjustments.mesaDeduction || r.adjustments.mesaDisbursement ? (
                        <span className={r.adjustments.mesaDisbursement ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
                          {formatPHP(r.adjustments.mesaDisbursement - r.adjustments.mesaDeduction)}
                        </span>
                      ) : <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </td>
                    <td className={cn(CELL, dim)}>{money(r.adjustments.adjustment)}</td>
                    <td className={cn(CELL, dim)}>{money(r.adjustments.orphanage)}</td>
                    <td className={cn(CELL, 'border-l border-zinc-100 font-bold dark:border-zinc-800/60', r.excluded ? 'text-zinc-400 line-through dark:text-zinc-600' : 'text-indigo-700 dark:text-indigo-300')}>
                      {formatPHP(r.gross)}
                    </td>
                    <td className="px-2 py-2.5 text-center align-top">
                      <input
                        type="checkbox"
                        checked={r.excluded}
                        onChange={() => onToggleExcluded(r.email)}
                        disabled={disabled}
                        aria-label={`Exclude ${r.name || r.email} from pay`}
                        className="h-4 w-4 cursor-pointer rounded border-zinc-300 accent-rose-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600"
                      />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={cols} className="p-0">
                        <WorkedTotal r={r} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })
          )}
        </tbody>

        {rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/60">
              <td colSpan={cols - 2} className="px-3 py-2.5 text-xs font-bold text-zinc-700 dark:text-zinc-300">
                {deptName} Subtotal ({payable.length} payable{excludedCount > 0 ? ` · ${excludedCount} excluded` : ''})
              </td>
              <td className="px-2 py-2.5 text-right font-mono text-xs font-bold tabular-nums text-indigo-700 dark:text-indigo-300">
                {formatPHP(subtotal)}
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: PASS. If `cn` is not at `@/lib/utils`, find its real path with `grep -rn "export function cn" src/lib` and correct the import.

- [ ] **Step 3: Commit**

```bash
git add src/components/payroll/ValidationBreakdownTable.tsx
git commit -m "feat(payroll): validation breakdown table component"
```

---

### Task 7: Wire into the wizard and fix the MESA omission

**Files:**
- Modify: `src/components/PayrollWizard.tsx` — `finalPayRows` (≈14624-14640), the table block (≈15038-15163), the Validation header (≈14677-14691), and the Continue button (≈17221).

**Interfaces:**
- Consumes: `buildValidationBreakdowns`, `countRedFlags`, `type BreakdownInput` from Tasks 2-5; `ValidationBreakdownTable` from Task 6.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the imports**

Near the other `@/lib/payroll` and `@/components/payroll` imports in `src/components/PayrollWizard.tsx`:

```ts
import ValidationBreakdownTable from '@/components/payroll/ValidationBreakdownTable';
import {
  buildValidationBreakdowns,
  countRedFlags,
  type BreakdownInput,
} from '@/lib/payroll/validation-breakdown';
```

- [ ] **Step 2: Replace `finalPayRows` with breakdown construction**

Replace the `finalPayRows` block at ≈14624-14640 with the following. Two changes of substance: the dispatch payload is joined in by email, and `mesaDisbursement` is no longer dropped.

```ts
        // Index the staged payloads by email. `dispatchData` SKIPS anyone whose
        // personal email cannot be resolved, so this is a left join from the calc
        // results — never a filter. A row with no payload still renders, flagged
        // `not_dispatchable`, because the pay run silently omits that person and
        // Validation is the last place anyone would notice.
        const stagedByEmail = new Map<string, DispatchEmployee>();
        for (const e of dispatchData.rows) stagedByEmail.set(e.email, e);
        for (const x of dispatchData.excludedRows) {
          if (x.payload) stagedByEmail.set(x.email, x.payload);
        }
        const rateIssueByEmail = new Map(dispatchData.rateIssues.map((x) => [x.email, x]));

        const breakdownInputs: BreakdownInput[] = effectiveCalcResults.map((r) => {
          const staged = stagedByEmail.get(r.email) ?? null;
          const issue = rateIssueByEmail.get(r.email);
          const deptKey = employeeDepts[r.email] ?? null;
          return {
            email: r.email,
            name: r.name,
            deptKey,
            deptName: findAdditionsDept(deptKey)?.name ?? '—',
            isHsl: normalizeDeptToKey(deptKey ?? '') === 'hogan_smith_law',
            excluded: excludedEmails.has(normEmail(r.email) ?? ''),
            totalHours: r.totalHours,
            regularHours: r.regularHours,
            otHours: r.otHours,
            regularRate: r.regularRate,
            otRate: r.otRate,
            regularPay: r.regularPay,
            otPay: r.otPay,
            initialPay: r.initialPay,
            weekend: r.weekend ?? null,
            rateChange: r.rateChange
              ? { from: r.rateChange.oldRegular, to: r.rateChange.newRegular }
              : null,
            dispatch: staged
              ? {
                  final: staged.pay_php.final ?? 0,
                  pab: staged.pay_php.perfect_attendance_bonus ?? 0,
                  tech: staged.pay_php.tech_bonus ?? 0,
                  other: staged.pay_php.other_bonuses ?? 0,
                  adjustment: staged.pay_php.adjustment ?? 0,
                  mesaDeduction: staged.pay_php.mesa_deduction ?? 0,
                  // Previously dropped here while the dispatch payload and the HSL
                  // tab both included it, so anyone with an approved MESA payout was
                  // understated on the screen that certifies the cycle.
                  mesaDisbursement: staged.pay_php.mesa_disbursement ?? 0,
                  orphanage: staged.pay_php.orphanage_pay ?? 0,
                }
              : null,
            rateSourceIssue: issue
              ? { shortfallPhp: issue.shortfallPhp, sheetRate: issue.sheetRate, paidRate: issue.paidRate }
              : null,
          };
        });

        const finalPayRows = buildValidationBreakdowns(breakdownInputs)
          .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        const redFlagCount = countRedFlags(finalPayRows);
```

Use `normalizeDeptToKey` from `src/lib/payroll/normalize-dept-key.ts` — it already collapses the `hsl:*` sub-department keys to `hogan_smith_law` (line 11), which a bare `=== 'hogan_smith_law'` comparison would miss. Add to the import block:

```ts
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
```

Do not copy the inline two-key comparison at `PayrollWizard.tsx:4676-4678` — it predates the sub-department restructure and misses `hsl:intake_specialist` and its siblings.

- [ ] **Step 3: Update the totals that read the old shape**

The aggregate lines immediately below (≈14644-14649) reference `r.initialPay`, `r.bonusTotal`, `r.finalPay`. Point them at the breakdown shape:

```ts
        const payableFinalRows = finalPayRows.filter(r => !r.excluded);
        const excludedCount = finalPayRows.length - payableFinalRows.length;
        const grandInitial = payableFinalRows.reduce((s, r) => s + r.earnings.base + r.earnings.otPay + r.earnings.weekend, 0);
        const grandBonuses = payableFinalRows.reduce((s, r) => s + r.earnings.bonuses, 0);
        const grandMesaDeductions = payableFinalRows.reduce((s, r) => s + r.adjustments.mesaDeduction, 0);
        const grandFinal = payableFinalRows.reduce((s, r) => s + r.gross, 0);
```

Then run `npm run lint` and fix every remaining reference the compiler reports — `row.bonusTotal`, `row.finalPay`, `row.deptKey`, `row.totalHours` in the department-rail grouping and the summary cards. The rail's `groupMap` bucketing on `row.deptKey` still works unchanged.

- [ ] **Step 4: Swap the table**

Replace the `<Table>…</Table>` block inside the department panel (≈15054-15161, from `<Table>` through `</Table>`) with:

```tsx
                        <ValidationBreakdownTable
                          rows={filteredRows}
                          deptName={activeGroup.name}
                          isHsl={filteredRows.some((r) => r.isHsl)}
                          disabled={isReplay}
                          onToggleExcluded={toggleExcluded}
                          onToggleAllExcluded={setExcludedMany}
                        />
```

Delete the now-unused wrapper `<div className="overflow-auto …">` around it — the component owns its own scroll container and `maxHeight`.

- [ ] **Step 5: Add the red-flag count to the header**

In the Validation header badge row (≈14677-14691), add before the `unassignedCount` badge:

```tsx
                {redFlagCount > 0 && (
                  <Badge className="border-rose-500/40 bg-rose-500/15 font-semibold text-rose-700 dark:text-rose-300">
                    {redFlagCount} row{redFlagCount !== 1 ? 's' : ''} cannot be paid as calculated
                  </Badge>
                )}
```

- [ ] **Step 6: Add the Continue confirmation**

`redFlagCount` is scoped inside `case 7`, so lift it to component scope alongside the other derived values. Add a `useMemo` near `dispatchData` that rebuilds the same breakdowns, and expose `validationRedFlagCount`. Then wrap the Continue handler at ≈17221:

```tsx
onClick={() => {
  if (currentStep === 7 && validationRedFlagCount > 0) {
    const ok = window.confirm(
      `${validationRedFlagCount} row${validationRedFlagCount !== 1 ? 's' : ''} cannot be paid as calculated. ` +
      `Continue to dispatch anyway?`,
    );
    if (!ok) return;
  }
  goNext();
}}
```

Replace `goNext()` with whatever the existing handler body is — read it first and preserve it exactly.

To avoid computing breakdowns twice, extract the `breakdownInputs` construction from Step 2 into the component-scope `useMemo` and have `case 7` read from it.

- [ ] **Step 7: Typecheck**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Manual verification**

Check for a running dev server before starting one — `next build` and `next dev` share `.next/`.

```bash
# Only if nothing is already serving on 3000:
npm run dev
```

Walk Accounting → Payroll Wizard → Step 7 and confirm:
1. Every department tab renders; row counts match the rail badges.
2. HSL shows M-F / WE / OT½ columns; other departments show Reg / OT.
3. Expanding a row shows the worked total, and it ends "✓ ties to dispatch".
4. A person with an approved MESA disbursement now shows the disbursement and a gross matching Step 8.
5. Exclude checkboxes still drive the subtotal and the excluded count.
6. Horizontal scroll works at 1280px without the page body scrolling sideways.

- [ ] **Step 10: Commit**

```bash
git add src/components/PayrollWizard.tsx
git commit -m "feat(wizard): show the full calculation on Validation, and stop dropping MESA disbursements

The Validation table collapsed every component into Initial Pay and Bonuses,
so Alivia certified a figure whose derivation was not on screen. It now shows
hours, rates, earnings, MESA, adjustment and orphanage per person, with HSL in
the Hogan sheet's own M-F / weekend / 0.5x-differential form, and each row
expands to the worked total.

Gross is summed from the components on screen and compared against what
dispatch will actually send. That check exists because the two had already
diverged: Validation's finalPay omitted mesaDisbursement while the dispatch
payload and the HSL tab both included it, understating anyone with an approved
MESA payout. Fixed, and now guarded."
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| Pure module, no React/fetch | 2 |
| `PayrollBreakdown` contract incl. `rates.ot`, `earnings.otPay` | 2 |
| Base derivation | 2 |
| HSL sheet-form derivation, reusing hogan constants | 2, 3 |
| Weekend double-count trap | 3 |
| `weekend === null` degrades to base shape | 3 |
| Red flags | 4 |
| `gross` vs `dispatchNet` reconciliation | 4 |
| Amber flags (`ot_ratio`, `rate_source`) | 5 |
| Wide grouped table + row expand | 6 |
| Two layouts (base / HSL) | 6 |
| Bonus as one column, itemised in expand | 6 |
| Rate cell renders `₱old → ₱new` | 6 |
| `mesaDisbursement` fix | 7 |
| `rateIssues` surfaced on Step 7 | 5 (flag), 7 (wiring) |
| Red count in header | 7 |
| No hard block; Continue confirms | 7 |
| MESA test cases | Covered by the `gross_mismatch` and disbursement fixtures in Task 4; the enrolled/opted-out gating itself lives in `PayrollWizard.tsx` and is out of this module's scope |

**Known gaps, accepted**

- No component tests for Tasks 6-7 — this repo has no React test renderer and adding one is out of scope. Verified by `tsc --noEmit` plus the manual pass in Task 7 Step 9.
- Task 7 Steps 2, 3 and 6 require reading surrounding code (`isHslDeptKey`, the Continue handler body, remaining `finalPayRows` references) rather than applying a fixed patch, because those call sites shift as the file changes. Each step names the exact grep to run.
