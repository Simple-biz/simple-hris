# Payroll Wizard — Validation step calculation breakdown

**Date:** 2026-08-07
**Status:** Approved, not yet implemented
**Origin:** Ticket from Carla via the `/tickets` dashboard — "Accounting > Payroll Wiz > Validation"

## Problem

Step 7 (Validation) is the last surface before Alivia locks a cycle and sends it to
Payment Dispatch. Its table shows five columns:

```
Employee │ Hrs │ Initial Pay │ Bonuses │ Final Pay │ Exclude
```

Every component that actually built those numbers — the rate, the weekend premium, the
overtime differential, the MESA deduction, the Payroll Notes adjustment, orphanage pay —
is collapsed into `Initial Pay` and `Bonuses`. Alivia is asked to certify a figure whose
derivation is not on screen. The components *are* visible one step earlier, on the
Additions and HSL tabs, but not on the step where the lock decision is made.

Carla's ticket asks for the components back, in the vocabulary of the "NEW Payroll
Dashboard - Hogan" Google Sheet that Accounting has always paid HSL from:

| Ticket phrase | Sheet column | `hogan-week-pay.ts` |
|---|---|---|
| M-F rate | AC "M-F Rate" | `regularRatePhp` |
| Weekend rate | AE "Hogan WE Rate" (= AC + 15) | `weekendRatePhp` |
| M-F .5 overtime amount | AG "OT Differential" (= AC × 0.5) | `otDifferentialPhp` |
| orphanage | AJ "Orphan Hours Total Pay" | `orphanPayPhp` |
| gross pay calculation | AN "Total Hourly Pay" + MESA + bonuses | `totalHourlyPayPhp` |

The ask is therefore narrower and more concrete than "add columns": make the wizard's
Validation step reconcilable, line by line, against the spreadsheet it is replacing.

## Non-goals

- **Changing how pay is computed.** `computeHoganWeekPay()` exists and is verified
  against 6,791 sheet rows, but is not wired into the pay run. Routing HSL through it
  would re-price every stub and needs its own spec.
- **Dispatch-readiness flags** (unassigned department, missing bank details). Already
  covered by the Step 1 Setup readiness checklist and the Payroll Readiness tab.
- **Context chips** for prorated / weekend-unavailable / excluded rows.

## Architecture

The reconciliation math checks money, so it does not belong inside a 19,346-line
component. Three files, following the existing `hogan-week-pay.ts` + `.test.ts` pattern:

| File | Role |
|---|---|
| `src/lib/payroll/validation-breakdown.ts` | Pure. `CalcRow` + context → one typed breakdown per person, with flags. No React, no fetch. |
| `src/lib/payroll/validation-breakdown.test.ts` | Unit tests against synthetic fixtures. |
| `src/components/payroll/ValidationBreakdownTable.tsx` | Presentational. Breakdowns in, table out. |

`PayrollWizard.tsx` case 7 keeps the department rail, the search box, the summary cards
and the Validation Checks card, and delegates the table. `src/components/payroll/` is the
established home for wizard-adjacent panels (`TimeAdjustmentReviewPanel`).

## Data contract

```ts
type PayrollBreakdown = {
  email: string;
  name: string;
  deptKey: string | null;
  deptName: string;
  isHsl: boolean;
  excluded: boolean;

  hours: { mf: number; we: number; ot: number; total: number };

  /** Null when no rate resolved at all. */
  rates: {
    /** Regular / "M-F" rate. Both tables show this. */
    mf: number;
    /** The engine's STORED OT rate. Base table's `OT` column. */
    ot: number | null;
    /** mf + 15. HSL only — null elsewhere. */
    we: number | null;
    /** mf × 0.5. HSL only — null elsewhere. Compared against `ot` for `ot_ratio`. */
    otDifferential: number | null;
  } | null;

  /** Set on a mid-period rate change; renders as "₱285.00 → ₱305.00". */
  rateChange: { from: number; to: number } | null;

  earnings: {
    /** HSL: mfHours × mfRate, which INCLUDES OT hours paid at 1.0×.
     *  Base: regularPay as the engine computed it. Not the same quantity —
     *  the column header differs per table for exactly this reason. */
    base: number;
    /** HSL only; 0 elsewhere. */
    weekend: number;
    /** HSL: the 0.5× differential (`OT$`). Base: otHours × otRate (`OT pay`). */
    otPay: number;
    bonuses: number;
    bonusParts: { kpi: number; pab: number; tech: number; other: number };
  };

  adjustments: {
    mesaDeduction: number;      // positive; subtracted
    mesaDisbursement: number;   // positive; added
    adjustment: number;         // signed
    orphanage: number;          // positive; added
  };

  /** Rebuilt from the components above — what the table's own columns sum to. */
  gross: number;
  /** The engine's number — what Step 8 will actually stage to Payment Dispatch. */
  dispatchNet: number;

  flags: ValidationFlag[];
};
```

### `gross` vs `dispatchNet`

This pair is the spine of the design. `gross` is recomputed from the parts rendered on
screen. `dispatchNet` is the engine's own figure. When they disagree by more than ₱0.01
the row is flagged.

Alivia is not asked to trust the table. The table proves itself against what is shipping,
every row, every cycle.

### HSL derivation

Follows the sheet, not the engine's collapsed form:

```
weHours   = weekend.regularHours + weekend.otHours
mfHours   = totalHours − weHours          // M-F INCLUDES its own OT hours (col AB)
otHours   = max(0, totalHours − 40)       // all seven days count toward the cap
mfRate    = regularRate
weRate    = mfRate + HSL_WEEKEND_PREMIUM_PHP   // 15
otDiff    = mfRate × OT_DIFFERENTIAL_MULTIPLIER // 0.5

earnings.base   = mfHours × mfRate
earnings.weekend = weHours × weRate
earnings.otPay  = otHours × otDiff
```

Reuse the exported constants from `hogan-week-pay.ts` rather than re-declaring 15 and 0.5.

### Base (non-HSL) derivation

No weekend concept; OT is the engine's stored rate, not a derived differential:

```
earnings.base    = regularPay        // as the engine computed it
earnings.weekend = 0
earnings.otPay   = otHours × otRate
```

### Gross — both shapes

```
gross = earnings.base + earnings.weekend + earnings.otPay + earnings.bonuses
      + adjustment + orphanage + mesaDisbursement − mesaDeduction
```

**Double-count trap.** `CalcRow.weekend.regularPay` / `.otPay` are *already included* in
`regularPay` / `otPay` — the field is documented as a breakdown, never an addition.
Summing the weekend column on top of base pay overstates every HSL row.

**Weekend unknowable.** `CalcRow.weekend` is null for non-HSL rows and for HSL rows with
no per-day columns. When null, render the M-F / WE / OT½ cells as `—` and fall back to
the base earnings shape for that row. No flag — a missing split is not a wrong number.

## Table layouts

Both tables use spanning group headers with horizontal scroll, keep the existing
`Exclude` checkbox and department subtotal footer, and give every row a chevron that
expands the worked formula inline.

**Base — all departments except HSL**

```
          │  HOURS   │    RATES    │        EARNINGS        │  ADJUSTMENTS   │
Employee  │ Reg   OT │  Reg    OT  │ Reg pay  OT pay  Bonus │ MESA  Adj  Orph│   GROSS
```

**HSL — the sheet's three-stage form**

```
          │   HOURS    │      RATES       │       EARNINGS        │  ADJUSTMENTS  │
Employee  │ M-F  WE  OT│ M-F    WE   OT½  │  Base   Wknd    OT$   │ MESA Adj Orph │   GROSS
```

HSL gets its own tab for free — the Validation step already buckets rows by department
into a rail.

**Expanded row** renders the calculation Carla asked for as a calculation:

```
▾ Marie C   38.0  6.0  4.0 │ 265.00  280.00  132.50 │ 10,070  1,680  530.00 │ −100 +500 250 │ 12,930.00
   └ M-F        38.00 h × ₱265.00 = 10,070.00
     Weekend     6.00 h × ₱280.00 =  1,680.00
     OT ½        4.00 h × ₱132.50 =    530.00
     Adjustment                    +   500.00
     Orphanage                     +   250.00
     MESA                          −   100.00
     ─────────────────────────────────────────
     Gross                          ₱12,930.00   ✓ ties to dispatch
```

**Bonuses.** Carla's column list omits them, but gross cannot tie without them. Included
as one `Bonus` column, with KPI / PAB / tech / other itemised in the expand rather than
promoted to four more columns.

## Flags

### Red — "cannot be paid as calculated"

Counted in the table header so it cannot be scrolled past.

| Flag | Condition |
|---|---|
| `no_rate` | `hours.total > 0` and no rate resolved |
| `hours_without_pay` | `hours.total > 0` and initial pay is 0 or null |
| `pay_without_hours` | `hours.total === 0` and `gross > 0` |
| `negative_gross` | `gross < 0` |
| `gross_mismatch` | `abs(gross − dispatchNet) > 0.01` |

### Amber — rate-source disagreement

Non-blocking. Informational, but shown while Alivia can still act on it.

| Flag | Condition |
|---|---|
| `ot_ratio` | HSL only: engine OT rate ≠ `mfRate × 1.5` (tolerance ₱0.01) |
| `rate_source` | From the existing `findRateConsistencyIssues` — paid rate ≠ sheet rate |

`ot_ratio` is a permanent regression net for the `ot = reg + 15` corruption fixed on
2026-08-04, where the weekend premium had been mis-keyed into the OT rate column and 10
HSL people were underpaid on every overtime hour. It should report zero today. The value
is catching the next one.

### Gate behaviour

Red flags **do not hard-block** Step 8. Only FX-at-zero blocks dispatch today, and a
display ticket should not change the gate philosophy. Continue shows a confirmation
dialog when the red count is non-zero.

### Proration

Handled in the math rather than with a chip. The verifier reads `CalcRow.prorationSegments`
to derive expected pay instead of multiplying `hours × rate`, so a mid-week raise does not
trip `gross_mismatch`. The rate cell renders `₱285.00 → ₱305.00` from `rateChange`.

## Two fixes riding along

1. **`PayrollWizard.tsx:14637` omits `mesaDisbursement`.**

   ```ts
   finalPay: (r.initialPay ?? 0) + getEffectiveBonus(r.email) - mesaDed + orphanagePay
   ```

   The dispatch payload (`PayrollWizard.tsx:7454`) and the HSL tab
   (`PayrollWizard.tsx:14057`) both add `mesaDisbursement`; Validation does not. Anyone
   with an accounting-approved MESA payout has been understated on the one screen that
   certifies the cycle. Fixed here, and `gross_mismatch` becomes the standing net so it
   cannot silently return.

2. **`dispatchData.rateIssues` renders only on Step 8** — one click after the lock
   decision, when acting on it means unlocking. Mirrored into Step 7 as per-row amber.
   Step 8 keeps its existing summary block.

## Testing

`hogan-week-pay.test.ts` is the model: synthetic fixtures only. The real sheet CSV is
deliberately uncommitted because it holds real names and salaries, so the live oracle
stays the opt-in `scripts/verify-hogan-formula.mts`.

Cases:

- Each red and amber flag in isolation.
- The carve-out double-count trap — an HSL row where `weekend.*Pay` is inside
  `regularPay`; asserting `gross` does not overstate.
- A prorated week — `gross_mismatch` must not fire on a mid-period rate change.
- An HSL row with `weekend === null` — degrades to base shape, no flag.
- A mixed department where `gross === dispatchNet` for every row.
- MESA: enrolled member charged ₱100; ledger-opted-out member not charged; opted-out
  ex-member receiving a disbursement without being re-charged.

## Open risks

- **Alert fatigue.** Seven flag types is already near the limit. Resist adding more
  without removing one.
- **Horizontal scroll on laptops.** The HSL table is wide. If it proves unusable at
  1280px, the fallback is a column-group toggle, not dropping columns.
