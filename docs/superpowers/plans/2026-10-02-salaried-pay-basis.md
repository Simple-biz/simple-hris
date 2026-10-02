# Payment Catalog — Salaried pay basis (flat weekly salary on an individual Pay Structure)

**Brief:** in-session 2026-10-02. Kane: *"Payment - Catalog - Pay Structure - Lets add an option in here
instead of the regular hourly and ot hourly - we can get a flat rate per day, week, month - as a salary
so its a flat rate everytime no matter their hubstaff hours"*. Built under the 2026-09-26 blueprint
rule: CHOSEN 1–7 taken, NEEDS 1–4 left out behind seams.

**Governing ruling:** `docs/features/salaried-pay-basis.md` §2 (designed 2026-08-29, never built) — a
salary is a **dated fact about a person**, never a property of a department. This plan builds that
ruling, narrowed to the weekly period.

## Task 1 — data layer

- [x] `references/sql/alter/2026-10-02_salary_pay_basis.sql`
  - `payment_catalog_pay_structures` + `pay_basis text not null default 'hourly'` (`hourly|salary`),
    `salary_period text` (`day|week|month`), `salary_amount numeric(14,2)`.
  - CHECK `pay_structures_salary_shape`: hourly ⇒ both salary columns null; salary ⇒ scope
    `employee`, period + amount not null, amount ≥ 0.
  - `employee_salary_history` (uuid id, `employee_email`, `effective_from date`, `pay_basis`,
    `salary_period`, `salary_amount`, `currency` PHP/USD/COP, `structure_id`, `note`, `created_by`,
    `created_at`). Same shape CHECK. Unique `(lower(employee_email), effective_from)`. Email
    normalise trigger. RLS on, no policies (service role only) — the pay-structures table precedent.
- [x] `scripts/apply-salary-pay-basis-migration.mts` — `--dry` (default, rolled back) / `--apply` /
  `--verify`; controls prove each CHECK bites inside a rolled-back SAVEPOINT.

## Task 2 — pure resolver

- [x] `src/lib/payroll/salary-basis.ts`
  - `SalaryHistoryRow`, `buildSalaryHistoryByEmail(raw)` (DESC by effective, then created).
  - `resolveSalaryBasis({ history, emails, weekStart, weekEnd, structureBasis, historyUnavailable,
    startDate, offboardDate })` → `{kind:'hourly'} | {kind:'salary', …} | {kind:'unknown', reason}`.
    Never null. Rules: a basis/amount change dated INSIDE the week → unknown; structure vs the
    LATEST history row disagree → unknown; history unavailable and the structure says salary →
    unknown; a salary week whose start or offboard date falls inside it → unknown (NEEDS 3); a day
    or month period → unknown (NEEDS 1/2).
  - `priceSalaryWeek(basis, fx)` → `{ amountPhp, amountNative, currency, period }`.
  - `isPayWeekSunday(iso)`.
- [x] `src/lib/payroll/salary-basis.test.ts`.

## Task 3 — catalog model + persistence

- [x] `pay-structure.ts`: `PayBasis`, `SalaryPeriod`, `payBasis?`/`salaryPeriod?`/`salaryAmount?`
  on `PayStructure`; `validatePayStructure` salary rules; `formatSalary`; `isSalaryStructure`.
- [x] `pay-structures-db.ts`: map the columns; probe once whether they exist; hourly saves omit
  them before the migration, salary saves refuse.
- [x] `src/lib/supabase/salary-history-db.ts`: paged list, latest-for-email, supersede + insert.

## Task 4 — routes

- [x] `pay-structures` POST: salary ⇒ week only, Sunday effective date, PHP/USD, no other
  employee-scope structure for the person; `regular_rate` 0 / OT null; skip `syncRateHistory`;
  write the dated history row awaited (switch back to hourly writes an `hourly` row, Sunday too);
  audit carries the basis. DELETE refuses a salary structure.
- [x] `app/api/payroll/salary-history-bulk/route.ts` — rate-visible gate, paged, `configured`.
- [x] `update-employee-rates`: never overwrite a salary structure.

## Task 5 — engines

- [x] `current-pay.ts`: read salary history; per-row basis; salary → regular = salary PHP, OT 0;
  unknown → no pay (Dispatch excludes `no_pay`); entry carries `payBasis`.
- [x] `paystub-fresh.ts` claims: a salary structure's claim rejects a snapshot priced hourly.
- [x] `PayrollWizard.tsx`: load salary history; `CalcRow.basis` replaces `regularRate`/`otRate`
  (every read site decides); salary branch; time-adjustment fold skipped; payload `salary` block;
  snapshot carries it; Step 2 chip; rate-consistency skips salary; "not in Hubstaff" list.

## Task 6 — statement

- [x] `paystub-view.ts` salary fields + `showsSalaryLine`; `PayStubStatement.tsx` and
  `paystub-email-html.ts` render "Salary (weekly)" instead of Regular/OT.

## Task 7 — catalog UI

- [x] `BonusCatalog.tsx`: `PayBasisToggle`, `SalaryPeriodToggle` (Day/Month disabled with the
  reason); `PayRateEditor` salary mode on individual editors only; salary chips on the individual
  row, member list and Search card; effective date defaults to next Sunday in salary mode.
- [x] `person-comp.ts` `winningRate` carries the basis.

## Task 8 — docs + commit

- [x] `salaried-pay-basis.md` rewritten as shipped rules · `bonus-catalog.md` §5 · INDEX + README rows ·
  `api-reference.md` · memory · Open items row · one commit by explicit path.
