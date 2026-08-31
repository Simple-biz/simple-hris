# Salaried pay basis — HSL Attorneys (design ruling — NOT BUILT)

**Status: designed 2026-08-29, nothing shipped.** No `employee_salary_history` table, no
`pay_basis` column, no `salary-week-pay.ts`. This doc exists so the ruling and the eight
hazards behind it are not re-derived from scratch — three competing designs were built and
all three were killed by the same root cause.

Related: `bonus-catalog.md` · `department-transfers.md` · `payment-dispatch.md` ·
`hsl-subdepartments.md` · memory [[transfer-sheet-sync-false-success]] ·
[[sheet-readd-dept-clobber]] · [[midweek-transfer-proration-ruling]] ·
[[hris-is-dept-source-of-truth]] · [[transfer-does-not-rerate]].

---

## 1. The requirement (Kane, 2026-08-29)

Attorneys join HSL on a **fixed weekly salary** — Hubstaff hours do not price them. Kane's
answers to the scoping questions:

| Q | Answer |
|---|---|
| Do they have Hubstaff hours? | Yes — they were bypassed at onboarding, so they hold a `simple.biz` email and track time. **Hours exist; they just don't set pay.** |
| Salary granularity | **Weekly amount.** |
| Partial weeks | **Weekly ÷ prorated.** |
| Overtime | They have OT rates like hourly staff — OT adds on top of the weekly salary. |
| Weekends | Attorneys are HSL, so the HSL weekend rate applies if they ever work one. |
| Where does it live? | *"Salaried should be another thing by itself."* |

## 2. The ruling — a salary is a dated fact about a **person**, not a property of a department

All three candidate designs keyed the pay basis on the **department label**, and three
independent adversarial passes killed all three for it. Scores were 6.5 / 5.7 / 5.0 —
none shippable.

> **`employee_salary_history`, keyed on email + effective date**, mirroring
> `employee_rate_history` — the temporal spine payroll already trusts.
> The `hsl:attorneys` department row holds only the **template** (what a new attorney
> starts on), exactly as department base rates are the onboarding prefill today.
> **No pay resolution ever reads it.**
> `resolveSalaryBasis(emails, asOfDate)` keys on person and date, never on a department
> string.

This is *"salaried is its own thing by itself"* taken literally.

## 3. Why the department label cannot carry a pay basis — the measured evidence

Each of these was verified against the codebase; they are the reason the ruling looks the
way it does.

### 3.1 The department label is the most-clobbered field in the system

197 of the last 200 applied transfers report `sheet_synced=true`; **at least 7 provably
never landed** ([[transfer-sheet-sync-false-success]]). And `masterDeptByEmail` is
**first-wins over unordered rows** —
[current-pay.ts:951-954](../../src/lib/payroll/current-pay.ts#L951-L954) sets a person's
department only `if (!masterDeptByEmail.has(e))`. With a duplicate GML row present,
**PostgREST row order decides the pay basis.**

### 3.2 It fails silently toward hourly, not toward zero

An unpriced or mistyped `hsl:*` key falls through `normalizeDeptToKey` to the HSL **parent
base** and pays hourly × hours. This is deliberate and documented:
[hsl-subdept.ts:197-200](../../src/lib/departments/hsl-subdept.ts#L197-L200) — *"a placement
here can never resolve ₱0."*

The premise that "un-taught sites fail loud" is therefore **false**. A missing salary row
produces a plausible number on a plausible paystub.

### 3.3 A mid-week offboard loses the label on exactly the final-pay week

`fetchMasterMin` reads the **`active_employees`** view
([current-pay.ts:297](../../src/lib/payroll/current-pay.ts#L297)) and, on a partial read,
returns whatever pages it already pulled — it degrades **silently**. Payroll runs a week in
arrears, so the off-board stamp lands before the final-pay run every time.

### 3.4 No effective date

A transfer released on a Friday would reprice the **whole current week** retroactively. The
hourly path does not have this bug — it prices per-day off dated history. Note that
snap-to-Sunday was deleted as a root cause on 2026-08-18
([[midweek-transfer-proration-ruling]]); do not reintroduce it here.

### 3.5 The paystub re-lock freshness guard is OFF for salaried people, by construction

`getCatalogRateClaimsByEmail` ([paystub-fresh.ts:74](../../src/lib/payroll/paystub-fresh.ts#L74))
reads **EMPLOYEE-scope PHP structures only** and returns `{}` on failure. A salaried person
has no such structure. Combined with [[paystub-staged-snapshot-stale]] — re-lock
**overwrites paid rows** and there is no post-pay detector — an overwritten salary block is
unrecoverable.

### 3.6 Salaried OT reads ₱0 in every analytic

`buildOtRateByEmail` books `rate.ot != null ? … : 0`
([people-roster.ts:703](../../src/lib/people/people-roster.ts#L703)), so a salaried person
with no hourly OT rate costs ₱0 everywhere that map is consumed.

### 3.7 OT toggles are keyed per DEPARTMENT, and a sub-dept has no toggle

`otDeptEnabled` (`PayrollWizard.tsx`) is per-department, so attorneys inherit HSL's OT
switch whether or not that is intended.

### 3.8 Replay would re-price at today's salary

`ratesByEmail` skips the catalog when `isReplay`. Without a dated ledger, a replayed week
prices at the **current** salary — see [[wizard-week-replay-fidelity]]. The dated ledger
fixes this for free.

## 4. Two hardening rules the adversarial pass earned

1. **`resolveSalaryBasis` returns `{kind:'salary'} | {kind:'hourly'} | {kind:'unknown', reason}` — never `null`.**
   A degraded read must not be able to `if (salary)` its way into the hourly chain.
2. **Delete `regularRate` / `otRate` from `CalcRow`** and replace them with a required
   discriminated `basis` field. *Deleting rather than adding a sibling is the whole trick*:
   all 14 read sites become `Property 'regularRate' does not exist`, with no `?? 0` escape.

## 5. Scope sketch, if this is picked up

```
in:  employee_salary_history (dated, person-keyed) + salary TEMPLATE on the dept structure
     `attorneys` in HSL_DEPT_KEYS as noKpi roster-only
     src/lib/payroll/salary-week-pay.ts (pure) at all five paired engine sites
     CalcRow.basis discriminated union (deletes regularRate/otRate)
     listPayStructures -> listHourlyPayStructures (renames 9 server call sites)
     PAB exemption resolved from the SALARY BASIS, not from a department key
     paystub-fresh salary claim · validation-breakdown · readiness · zero-hours

out: the COP write-path collapse · the disbursement-reports single-email vs alias-set
     divergence (PRE-EXISTING — named, not fixed) · MESA · bank routing · KPI calculators
```

`DATA` — new table `employee_salary_history` plus `pay_basis` / `weekly_salary` /
`salary_template` on `payment_catalog_pay_structures` (additive, defaulted; all 731 rows
stay hourly). Ships as `references/sql/create/` + a `--apply`-gated Node script, with a
read-only probe running first.

Model to copy: `src/lib/payroll/hogan-week-pay.ts` — a pure pay-FORM module with five paired
call sites. Ledger to copy: `employee_rate_history`.

## 6. The risk that outranks all the others

**The master cell pays before the code does.** HR placing someone on `hsl:attorneys` in the
Google Sheet is a live pay event the moment the sheet syncs — it does not wait for a
salary row to exist. Whatever ships must make an attorney placement with no dated salary row
**refuse to price**, not fall through to §3.2's hourly parent base.

## 7. Open

- [ ] Kane to confirm the §2 ruling before any build starts (the three department-keyed
      designs are dead; this replaced them after the GO, not before it).
- [ ] Decide the Stage 2/3 surface deferral — it has a real employee-facing cost.
