# HSL weekend & overtime pay — the sheet-form rule

**Effective 2026-08-11 (Kane).** HSL weekly pay is the Hogan sheet's column AN,
verbatim — three additive legs, nothing else:

| Leg | Hours | Rate | Notes |
| --- | --- | --- | --- |
| **M-F** | ALL Mon–Fri hours, **including** hours past 40 (the sheet's AB) | regular | M-F hours never re-rate on their own |
| **Weekend** | ALL Sat+Sun hours, **past-cap included** (AD) | regular + ₱15 (AE) | the premium makes no within-cap/past-cap distinction |
| **OT Differential** | max(0, total − 40), 2dp (AF) | regular × 0.5 (AG) | **derived** — the stored OT rate is NOT a money input for HSL |

Kane's worked example: 43h M-F + 2h WE at ₱235 → 10,105 + 500 + 5 × 117.50 =
**₱11,192.50**. The pinned live case: angelicaco@ week 2026-08-02 (M-F 34.38h +
Sat 8.97h at ₱235, cap crossed mid-Saturday) → 8,079.30 + 2,242.50 + 393.63 =
**₱10,715.43** (+ ₱5,400 bonuses = ₱16,115.43).

Rounding is the sheet's: each leg = 2dp **hours** × rate, rounded per leg, legs
summed. Whole-seconds math produces different centavos (₱16,116.02 on the case
above) and is wrong by definition — the sheet is the payment authority.

**Transition weeks (ruling 2026-08-18, Kane — "doc stands / moving away from the
sheet"):** a week whose rate changed mid-period (a transfer, a dated raise)
keeps the three-leg form **per rate** — every leg 2dp hours × that leg's rate
(`priceChangedWeek2dp`, prorate-mid-period.ts) — and the OT Differential's 40h
threshold counts **ALL hours worked that week, pre-change days included**,
derived from the rounded totals and attributed newest-rate-first. The sheet
itself prices transitions through its AK/AL columns, which EXCLUDE the old-rate
hours from `AF = max(0, AB + AD − 40)` — that reading was **rejected**: HRIS
deliberately pays more than the sheet on transition weeks (₱1,534.60 across the
23-person 2026-08-09 week), so a sheet-vs-HRIS reconciliation diff on a
transition week's OT is the ruling working, not a bug. AK/AL are deliberately
NOT implemented in `hogan-week-pay.ts`.

## History — do not resurrect either predecessor

- **Pre-2026-08-07:** weekend hours past the cap paid `otRate + 15` on a
  separate "Weekend Overtime" line.
- **2026-08-07 (5eb398a, REVERSED):** the premium was scoped to within-cap
  weekend hours only; past-cap weekend hours paid the plain stored OT rate.
  This made HRIS disagree with the sheet by ₱15/weekend-OT-hour — surfaced by
  Kane on 2026-08-11 via the angelicaco case and reversed the same day.
- **2026-08-11 (this rule):** the sheet form above. Deriving the differential
  from the regular rate also retires the whole class of stored-OT-rate
  corruption for HSL pay (the reg+15-in-the-OT-column bug of 2026-08-04 can no
  longer misprice a single hour). The rates sheet's OT column SHOULD still hold
  regular × 1.5 — the validation step's amber `ot_ratio` flag audits the store,
  it just no longer prices anything.

## Where the rule lives (keep these in lockstep)

- `src/lib/payroll/hogan-week-pay.ts` — `computeHoganWeekPay`, the sheet
  replica (verified against 6,791 live sheet rows) and the single-rate
  authority. `HoganSheetBlockRaw` is the payload block shape.
- `src/components/PayrollWizard.tsx` — `hslWeekSecsByEmail` (M-F vs weekend
  seconds, hslFrom-gated) + the `calcResults` single-rate path; a genuine
  mid-week rate change falls through to `proratePayForMidPeriodChange`.
- `src/lib/payroll/prorate-mid-period.ts` / `src/lib/payroll/current-pay.ts`
  (`computeProratedRowPay`) — the paired per-day engines: every HSL hour
  base-paid once at that day's rate (+15 on eligible weekend days), the
  differential accrues on chronological past-40 hours at 0.5 × that day's
  regular rate. A week that priced at ONE regular rate short-circuits to the
  exact 2dp sheet computation so all engines stage identical centavos.

## The payload contract (`hogan_sheet`)

Staged HSL payloads carry a `hogan_sheet` block: `mf_hours` / `we_hours` /
`ot_hours` (2dp, sheet semantics — `mf_hours` includes past-cap hours, the
`ot_hours` overlap them) + `rates_php {regular, weekend, ot_differential}`
(null on genuinely prorated weeks) + `pay_php {base, weekend, ot_differential}`
whose three legs sum to `pay_php.initial` exactly.

Bucket compatibility: payload `pay_php.regular` = base + weekend legs,
`pay_php.ot` = the differential, `hours.regular`/`hours.ot` keep the
chronological 40h partition — every total-summing consumer is untouched. The
`weekend` carve-out block holds ALL weekend hours in its `regular` half
(`ot` half is structurally 0; the shape survives for pre-2026-08-07 payloads).

Renderers (`mapPayloadToPayStub`, PayStubStatement, `paystub-email-html`,
XLSX/PDF export, the employee route's `buildView`) render the block's three
legs — labels **"M-F Hours" / "Weekend Hours" / "OT Differential"** — and fall
back to the legacy derivation when the block is absent, so payloads staged
before 2026-08-11 render exactly as staged. `rates_php.ot` on sheet-form
payloads IS the differential (the rate the OT line displays and pays).

Checks: `paystub-rate-consistency.ts` validates the three legs (no headroom)
and skips the bucket checks for sheet-form rows; the Validation step
(`validation-breakdown.ts`) re-derives the same three legs independently, so
its gross now equals the engine to the centavo. The freshness merge
(`paystub-fresh.ts`) moves `hogan_sheet` in the same write as the figures it
explains, and the catalog staleness gate knows a sheet-form snapshot's
`otRate` is the differential.

## Not every HSL row takes this rule — the legacy two-bucket fallback

**The sheet-form rule needs DAILY columns.** `PayrollWizard.tsx:6632` gates the whole
three-leg computation on `hslSecs && regularRate != null`, where `hslSecs` comes from
`hslWeekSecsByEmail` — the per-day Mon–Sun split. When the week's Hubstaff CSV carries no
daily columns for that person, the weekend is **unknowable**, so the row keeps the legacy
two-bucket formula (whole-seconds regular + stored OT rate) instead. Same when no regular
rate resolves.

**How to spot one:** its staged payload has **`hoganSheet: null`** — no `hogan_sheet`
block, so no per-leg basis line on the paystub and no weekend itemization. Nine HSL rows
were on this path in the 2026-08-09 → 08-15 cycle (measured 2026-08-18).

**Why it matters when reconciling:** a sheet-vs-HRIS difference on such a row is *this*,
not a math error and not a rate change — the two systems are running different formulas
for that person. Check `hoganSheet` before checking anything else, in this order:
`hoganSheet: null` → legacy path (this section) · `hoganSheet` present but the weekend rate
isn't `reg + 15` → a **dated rate change**, check `proration.effective_date` · both fine →
compare the USD divisor, not the pesos (see
[payroll-wizard-final-pay.md](./payroll-wizard-final-pay.md) § 2026-08-18).

## Operational notes

- **Already-staged rows reprice only on wizard re-lock/restage** (unchanged,
  Kane's call). After deploying this rule, unlock + re-lock the current cycle
  so staged HSL rows with past-cap weekend hours pick up the premium.
- The Hogan Google Sheet and HRIS agree again — the DO-NOT-WIRE guard on
  `hogan-week-pay.ts` is lifted.
- The employee monthly rollup (`member-monthly-pay.ts`) remains an estimate:
  it has never applied the ₱15 premium and still prices OT from the stored
  rate. Pre-existing, display-only drift — fix separately if it matters.
- HSL rows whose upload has **no daily columns** (weekend unknowable) keep the
  legacy two-bucket formula and stage no block — the statement renders the
  classic two lines.
- **The differential prices weekly pay ONLY.** The Payroll Wizard's Orphanage
  step (add-on pay: pasted hours stacked against the 40h cap) prices its
  OT-crossing hours at the **full 1.5× rate** — orphanage hours have no base
  leg in the weekly pay, so the 0.5× differential would half-pay them. On
  sheet-form rows (`row.hogan != null`) the wizard derives regular × 1.5 (2dp);
  every other row's stored OT rate is already the full rate (Kane 2026-08-18,
  `orphanagePasteParse` in PayrollWizard.tsx).
