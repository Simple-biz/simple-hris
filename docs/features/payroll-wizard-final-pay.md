# Payroll Wizard — Initial Calculation & Final Pay

How the Payroll Wizard turns Hubstaff hours into each employee's final pay, and the
accounting-editable adjustments layered on top. Covers the **Initial Calculation** (step 2),
the **Additions** table (step 3), and the **HSL** table (step 5).

Source: [`src/components/PayrollWizard.tsx`](../../src/components/PayrollWizard.tsx).
Last substantive update: **2026-07-25**.

---

## 2026-07-25 updates

- **Every master-list department is visible.** The wizard previously folded or
  dropped whole departments: `SMM Freelancer` was normalized into the built-in
  `smm` ("Social Media") tab, `hsl:*`-keyed people scattered, and master-list
  departments with no built-in mapping had no tab at all. Now `smm_freelancer`
  is split into its own tab, `hsl:*` members roll into the **HSL** tab
  (**pay-affecting** — ~35 people who previously fell through), unknown
  departments get **derived-slug tabs** (e.g. USEE), and members with no
  Hubstaff hours appear on a **read-only roster card** so a department is never
  silently empty. (`src/lib/payroll/normalize-dept-key.ts` + the wizard rail.)
- **Step-1 Configuration tab.** Per-department **Pay this week** (week-scoped
  exclusion) and **Overtime** switches — see
  [payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md).
- **Catalog-created departments get paid.** Departments minted in the Payment
  Catalog's Department tab appear in the wizard/Additions like any other — see
  [payment-catalog-departments.md](./payment-catalog-departments.md).
- **Time Adjustments are week-gated.** The Additions "Time Adjustments" fold-in
  only shows requests belonging to the wizard's **current pay week**; other
  weeks' requests no longer bleed into every run.
- **HSL table UX.** Pinned always-visible horizontal + vertical scrollbars,
  Additions-matching text size, and the **KPI Bonus column hidden by default**
  behind a Show/Hide dropdown in the toolbar.
- **Orphanage PAB auto-coverage (temporary).** Orphanage-step hours can
  auto-forgive short PAB weekdays — see
  [orphanage-pab-coverage.md](./orphanage-pab-coverage.md).

## 2026-07 updates

Three changes landed 2026-07 — a proration-parity fix, a PAB-pill display change, and
last-synced timestamps on the Initialize step.

Key files:

- [`src/lib/payroll/rate-history-resolve.ts`](../../src/lib/payroll/rate-history-resolve.ts) — client-safe rate-as-of-date + history index.
- [`app/api/payroll/rate-history-bulk/route.ts`](../../app/api/payroll/rate-history-bulk/route.ts) — rate-visible bulk `employee_rate_history` feed.
- [`app/api/accounting/sync-status/route.ts`](../../app/api/accounting/sync-status/route.ts) — last Google-sync timestamp per source.
- [`src/lib/supabase/audit-log.ts`](../../src/lib/supabase/audit-log.ts) — `fetchLastSyncTimestamps` (reads the audit trail).

### Mid-week rate proration (Step 2 ↔ Payment Dispatch parity)

Step 2's Initial-Pay calc now prorates a **mid-week rate change** per day so the wizard
matches Payment Dispatch byte-for-byte. When a dated rate change falls **inside** the pay week,
`proratePayForMidPeriodChange` (`PayrollWizard.tsx:457`) walks the pay days chronologically —
old rate before the effective date, new rate on/after — mirroring the server's
`computeProratedRowPay` in [`current-pay.ts`](../../src/lib/payroll/current-pay.ts): a **40h
chronological regular cap** (`REG_WEEK_CAP_SEC`), the **HSL +₱15/day** weekend premium on
Sat/Sun hours, and **raw accumulate then round once** (per-day PHP summed into a float,
`Math.round(..*100)/100` applied only at the end).

- **Data feed:** rate history comes from the client-safe
  [`rate-history-resolve.ts`](../../src/lib/payroll/rate-history-resolve.ts) module
  (`buildRateHistoryByEmail` / `resolveRateAsOfDate`, the pure half of `rate-history.ts`) hydrated
  from `GET /api/payroll/rate-history-bulk` — every `employee_rate_history` row (email, reg/ot,
  `effective_from`), newest-first, gated to **rate-visible roles** (admin / accounting / ceo).
- **Keyed on the Hubstaff email only.** History is looked up on the same `em` key Payment Dispatch
  uses, so the two engines can never resolve a different history row (`PayrollWizard.tsx:3922`).
  A flat **INDIVIDUAL** catalog rate is skipped (that rate is flat all period).
- **Unchanged employees stay byte-identical.** When the week has no in-window change and the
  constant history rate equals the fallback cache/catalog rate, the function returns `null` and
  the caller keeps its existing single-rate result (`PayrollWizard.tsx:536`).
- **Step-2 badge.** A mid-week change surfaces an amber `old→new eff YYYY-MM-DD` pill under the
  Rate column (`row.rateChange`, `PayrollWizard.tsx:7412`).

### PAB pill — provisional "Eligible" (display only)

On the **Additions** tab the PAB pill now shows a green **✓ Eligible** with the Payment-Catalog
PAB amount as soon as **no weekday has failed yet** (previously a neutral ⏳ "In Progress").
The tri-state pill (`PayrollWizard.tsx:9316`) collapses the raw `in_progress` status to `eligible`
for display: `status = rawStatus === 'in_progress' ? 'eligible' : rawStatus`. This is
**display-only** — actual payout is still gated by the `perfect_attendance` toggle plus dept
eligibility (`isPabDeptEligible`), and only a genuinely failed weekday locks the pill to
✗ Ineligible. The HSL step (id 4/5) tab is unchanged.

### Last-synced timestamps on Initialize

The **Initialize Payroll Data** step now renders a "Last synced …" line under each Google-sync
card — **Roster** (`master`), **Rates** (`rates`), and **Hogan** (`hsl`). The wizard fetches
`GET /api/accounting/sync-status` on mount into `lastSyncAt` (`PayrollWizard.tsx:969`, rendered via
`renderLastSynced`), which calls `fetchLastSyncTimestamps` — the latest `created_at` of the
`csv.master.sync` / `csv.rates.sync` / `csv.hsl.sync` audit actions. Because it reads the audit
trail each sync route already writes, **cron-triggered syncs count the same as manual button
syncs**; no separate persistence. Missing timestamps are non-fatal (the line just stays hidden).

---

## 1. The final-pay formula

For every employee the wizard computes:

```
Final = Initial Pay
        + PAB bonus            (Perfect Attendance, ₱5,000, final PAB week only)
        + Tech bonus           (₱1,850, 3rd-paycheck week, 30-day tenure)
        + KPI / dept bonuses   (manager KPI Calculator submission → "KPI Sub." column;
                                 SSD "KPI Bonus" toggle; US-manager toggles)
        − MESA deduction       (₱100/paycheck for enrolled members)
        + MESA disbursement    (approved payout being released this run, if any)
        + Adj.                 (accounting signed adjustment — see §2)
        + Orphanage            (accounting positive add — see §3)
```

`Initial Pay = regularPay + otPay`, where `regularHrs = min(totalHrs, 40)` and `otHrs = rest`,
priced at the employee's PHP `Regular Rate` / `OT Rate`. HSL employees also get a **+₱15/h
weekend premium** for Saturday/Sunday hours (baked into Initial Pay).

The same formula is used in three places and they must agree:
- the **Additions** table row Final (step 3, non-HSL),
- the **HSL** table Total Pay (step 5),
- the **dispatch payload** (`dispatchData`) `pay_php.final`, which is what actually gets paid.

> **Per-department performance bonuses moved to the KPI Calculator (2026-06-10).** The old violet
> in-wizard calculators (Tix ×₱50, Sites, Lead-Gen appts, Units, Sales, HR pool, Accounting weekly
> collections, QC) were removed from the Additions tab. `bonusTotals` no longer calls
> `calculateDepartmentBonus`; for formula departments the dept bonus now comes **only** from the
> manager's KPI Calculator submission (`resolvedManagerBonus` → "KPI Sub." column). So a department
> bonus requires a manager KPI submission — there is no auto-computed fallback in the wizard.

---

## 2. Adj. column — signed delta, not a replacement

The **Adj.** column (Additions) / **Adjustment** column (HSL) is backed by
`bonusOverrides: Record<email, number>`.

**Semantics (corrected 2026-06-10):** the typed value is a **signed delta added on top** of the
auto-computed bonus subtotal — it does **not** replace it. Positive increases pay, negative
deducts. So the auto PAB/Tech/KPI/dept amounts always remain in Final.

- Additions: `bonusTotal = autoBonus + adj`, `getEffectiveBonus(email) = bonusTotals[email] + bonusOverrides[email]`.
- HSL: `effectiveBonus = kpiBonus + adj`.
- Dispatch: `adj` is folded into `pay_php.other_bonuses` so `bonuses_total = pab + tech + other`.

> Before the fix it was a full **replacement** of the bonus subtotal, so setting an adjustment
> wiped KPI/PAB/Tech from Final. `bonusOverrides` is only ever written by the Adj inputs, so the
> meaning change is contained to this feature.

Persistence: saved in the Additions draft (`app_settings` key
`payroll.wizard.additions.<sourceFile>`) and reloaded by `loadAdditionsProgress`.

---

## 3. Orphanage column — positive add, own paystub line

Added **2026-06-10**. A manual per-employee orphanage pay amount, **distinct** from the
auto-computed orphanage-visit wages shown in the Orphanage step (id 4).

- State: `orphanageAmounts: Record<email, number>`; updater `updateOrphanageAmount(email, value|null)`
  (audited as `wizard.addition_edited` / field `orphanage_pay_php`).
- **Positive only** (input rejects negatives), added on top of Final / Total Pay.
- Present in **both** the Additions table (between Adj. and Final) and the HSL table (between
  Adjustment and Total Pay, with its own footer total).
- Dispatch: new field `pay_php.orphanage_pay` on `DispatchEmployee`, included in `final`.
- Persisted in the Additions draft alongside `bonusOverrides`.

> **n8n template note:** the dispatch route (`app/api/dispatch-paystubs/route.ts`) forwards the
> whole payload to n8n, which renders the actual paystub. The "Orphanage" paystub line must be
> added to the **n8n paystub template** to display `pay_php.orphanage_pay`; the value is already
> in the data.

---

## 4. Pay week & hours sourcing

Hours come from `payDaysByEmail` → `payHoursByEmail` (40h/week regular cap applied
chronologically), **not** the Hubstaff "Total worked" aggregate (which spans the whole uploaded
file, including an overlap day).

### Department pay weeks
- **HSL (Hogan):** Monday → Sunday.
- **All other departments:** **Sunday → Saturday**.

`payWeekFromUploadStart(uploadStart, isHsl)` returns the 7-day window; the window is anchored on
the current `calcSourceFile`'s start date.

### Canonical columns → true dates, then window
`hubstaff_hours` stores `monday`…`sunday` columns (+ `Total worked`), not per-date columns.
`payDaysByEmail` resolves them to **true ISO dates from the file range**
(`resolveCanonicalColumnsToIso`) and then clamps to the pay week — so a Mon→Sun or 8-day Sun→Sun
upload's **trailing Sunday is excluded** from a non-HSL Sun→Sat week instead of being relabeled
as the leading Sunday. (Same fix applied in `current-pay.ts`.)

### Cross-upload merge (boundary Sunday)
`payDaysByEmail` reads the **merged rows across all uploads** (`hubstaffRowsForPab`, each upload
resolved to true dates via its own filename), then windows. This recovers a pay week's leading
Sunday from the **adjacent upload** where that date is the trailing day.

See [hubstaff-sunday-overlap.md](../notes/hubstaff-sunday-overlap.md) for the underlying
last-wins collapse and the validated `ruthg@simple.biz` example (May 31–Jun 6 = ₱11,222.90).

---

## 5. Final-pay snapshot → Employee Dashboard + Payment Dispatch

Other surfaces don't know the wizard's accounting layer (KPI/dept, Adj., Orphanage, MESA
disbursement), so the wizard **publishes a per-employee snapshot** they read.

- `publishFinalPaySnapshot()` writes `app_settings` key `payroll.wizard.final_pay.<sourceFile>` =
  `{ source_file, finals: { [email]: { final, regularPay, otPay, regularHours, otHours, totalHours, initial } } }`,
  built from `dispatchData.rows`, keyed by **both** work and personal email (lowercased). The
  Regular/OT split + hours are included (not just `final`) so the dashboard's Regular + Overtime
  tiles reconcile exactly with the take-home.
- **Published LIVE** — a 1.5s-debounced effect on `dispatchData` writes it as accounting edits, plus
  immediate writes on **Lock in additions** and **Confirm & Dispatch**.
- **Dashboard** ([EmployeeDashboard.tsx](../../src/components/employee/EmployeeDashboard.tsx)) —
  `fetchPayrollFinal` refetches on mount, window focus, and a 30s interval. When the viewer's
  email/alias is present, the hero take-home **and** the Regular/OT/Initial stats come from the
  snapshot (note: "Includes payroll-confirmed bonuses & adjustments"). **Fallback:** client-side
  auto-estimate (`INIT + PAB + Tech − MESA`) when no snapshot / All-time view.
- **Payment Dispatch** ([useDispatchQueue.ts](../../src/components/payroll-clerk/useDispatchQueue.ts)) —
  `loadAll` overlays each queue row's `amountPHP`/`amountUSD` from the snapshot (by email). Without
  this it shows `/api/payroll-current-pay` which recomputes net pay WITHOUT the accounting layer.

Reg + OT = the wizard's Initial; take-home = `final`. When the employee has no bonus/MESA/Orphanage/
Adj, Reg + OT equals take-home exactly; otherwise take-home is higher by those (separate lines).

## 6. MESA membership

The per-paycheck ₱100 MESA deduction is driven by `mesa_member` (boolean) on
`employee_hourly_rates` — read via `ratesByEmail`. There are multiple rate rows per employee
(one per upload); the flag must be consistent across them.

**Remove someone from MESA (clears the deduction on the next calc):**

```sql
update employee_hourly_rates
set mesa_member = false,
    updated_at  = now()
where lower("Work Email") in ('someone@simple.biz')
  and mesa_member is distinct from false;
```

This only flips the payroll flag; it does **not** write an opt-out record in the `mesa_requests`
table (the opt-in/opt-out/disbursement workflow). Handle that separately if needed.

## 7. Contractors step — Actions column gating

Step 6 (`Contractors`) lists pending contractor invoices to review before dispatch. Each row's
**Actions** column renders state-dependent buttons; the on-click handler is `updateInvoiceStatus`
(`PayrollWizard.tsx:9852`), which PATCHes `/api/contractor/invoices/{id}` with the new status.

The opposite button is **hidden once a decision is made** so a decided row only offers an undo:

| `inv.status` | Buttons shown |
| --- | --- |
| `pending` | **Approve** + **Reject** (both gated on `inv.status === 'pending'`) |
| `approved` | **Reset** only (Reject no longer lingers) |
| `rejected` | **Reset** only (Approve no longer lingers) |

**Reset** is gated on `inv.status !== 'pending'` and calls `updateInvoiceStatus(inv.id, 'pending')`,
returning the row to pending and restoring both Approve and Reject. No backend
approve/reject/reset logic changed — this is purely a render-time gate on the same three buttons.
