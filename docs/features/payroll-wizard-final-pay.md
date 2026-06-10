# Payroll Wizard — Initial Calculation & Final Pay

How the Payroll Wizard turns Hubstaff hours into each employee's final pay, and the
accounting-editable adjustments layered on top. Covers the **Initial Calculation** (step 2),
the **Additions** table (step 3), and the **HSL** table (step 5).

Source: [`src/components/PayrollWizard.tsx`](../../src/components/PayrollWizard.tsx).
Last substantive update: **2026-06-10**.

---

## 1. The final-pay formula

For every employee the wizard computes:

```
Final = Initial Pay
        + PAB bonus            (Perfect Attendance, ₱5,000, final PAB week only)
        + Tech bonus           (₱1,850, 3rd-paycheck week, 30-day tenure)
        + KPI / dept bonuses   (per department; SSD KPI, manager KPI submissions, etc.)
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

## 5. Employee Dashboard sync (Estimated Take-Home)

The Employee Dashboard's **Estimated Take-Home** normally computes a rough client-side estimate
(`INIT + PAB + Tech − MESA`) and has no access to KPI/dept bonuses or accounting's Adj./Orphanage
entries. To make it match the wizard exactly, the wizard **publishes a per-employee final-pay
snapshot**:

- `publishFinalPaySnapshot()` writes `app_settings` key `payroll.wizard.final_pay.<sourceFile>` =
  `{ source_file, finals: { [email]: pay_php } }`, built from `dispatchData.rows` (the authoritative
  dispatched amount), keyed by **both** work and personal email (lowercased).
- **Triggers:** when accounting clicks **Lock in additions** (`saveAdditionsProgress`) and on
  **Confirm & Dispatch**.
- The dashboard ([EmployeeDashboard.tsx](../../src/components/employee/EmployeeDashboard.tsx))
  fetches that key for the currently-selected file and, if its email (or an alias) is present, shows
  the wizard's exact `final` as the take-home (with an "Includes payroll-confirmed bonuses &
  adjustments" note). **Fallback:** if no snapshot exists for that file (or in All-time view), it
  shows the original client-side auto-estimate.

So the dashboard reflects the wizard's number **once accounting locks/dispatches** — not before.

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
