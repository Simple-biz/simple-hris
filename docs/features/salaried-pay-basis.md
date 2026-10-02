# Salaried pay basis — a flat weekly salary on an individual Pay Structure

A person's individual (employee-scope) Pay Structure in **Payment Catalog → Pay Structure** can be
**Hourly** (regular rate × Hubstaff hours, plus OT, exactly as before) or **Salary**: a flat amount
per pay week that Hubstaff hours do not change. Both pay engines (the Payroll Wizard's calc and the
server's `computeCurrentPay`, which Payment Dispatch falls back to) resolve the basis from one pure
function, and the paystub prints one **Salary (weekly)** line instead of Hours × Rate.

Built 2026-10-02 (session `1c11c3eb`, `blueprint`), local commit, **not pushed**, not clicked
through signed in. The 2026-08-29 design ruling this doc held before is §2, unchanged. **The
migration is PENDING** (Deploy notes): until it runs the Salary option shows disabled and every
structure stays hourly.

Related: `bonus-catalog.md` §5 · `payment-dispatch.md` · `paystub-dispatch.md` ·
`department-transfers.md` · memory [[salaried-pay-basis-is-person-dated]] ·
[[transfer-sheet-sync-false-success]] · [[midweek-transfer-proration-ruling]] ·
[[wizard-week-replay-fidelity]] · [[paystub-staged-snapshot-stale]] · [[final-pay-roster-overlay]].

## Key files

| Piece | File |
| --- | --- |
| Migration + its `--apply` gate | `references/sql/alter/2026-10-02_salary_pay_basis.sql` · `scripts/apply-salary-pay-basis-migration.mts` |
| The resolver both engines call (pure, 27 tests) | `src/lib/payroll/salary-basis.ts` · `salary-basis.test.ts` |
| Structure model + write validation | `src/lib/payment-catalog/pay-structure.ts` (`PayBasis`, `validatePayStructure`, `formatSalary`) · `pay-structure-salary.test.ts` |
| Persistence | `src/lib/supabase/pay-structures-db.ts` (salary columns, migration probe) · `src/lib/supabase/salary-history-db.ts` |
| Write route | `app/api/payment-catalog/pay-structures/route.ts` (`planSalaryHistoryWrite`) |
| Read route | `app/api/payroll/salary-history-bulk/route.ts` |
| Wizard engine | `src/components/PayrollWizard.tsx` (`CalcBasis`, `calcResults` salary branch, payload `salary`, snapshot `salary`) |
| Server engine (Dispatch fallback C) | `src/lib/payroll/current-pay.ts` (`payBasis`, `salary`, `salaryHeldDetail`) |
| Freshness guard | `src/lib/payroll/wizard-dispatch-values.ts` (`catalogClaimFromStructure`, `snapshotRateContradictsCatalog`) · `paystub-fresh.ts` |
| Statement | `src/lib/payroll/paystub-view.ts` (`SalaryView`, `salaryLineLabel`, `formatSalaryDetail`) · `PayStubStatement.tsx` · `paystub-email-html.ts` · `CurrentPaycycle.tsx` |
| Catalog UI | `src/components/accounting/BonusCatalog.tsx` (`PayBasisToggle`, `SalaryPeriodToggle`, `PayRateEditor` salary mode) · `src/lib/payment-catalog/person-comp.ts` (`winningRate().salary`) |

## 1. What Kane asked, and his rulings

| Date | Kane | Status |
|---|---|---|
| 2026-10-02 | *"Payment - Catalog - Pay Structure - Lets add an option in here instead of the regular hourly and ot hourly - we can get a flat rate per day, week, month - as a salary so its a flat rate everytime no matter their hubstaff hours"* | the requirement |
| 2026-10-02 | Salary replaces **Regular AND OT**; Hubstaff hours move no money | **in force.** Supersedes the 08-29 attorney answers *"OT adds on top of the weekly salary"* and *"the HSL weekend rate applies"*. That reversal was taken from the 10-02 message as CHOSEN 1 and can be overturned by Kane in one message |
| 2026-08-29 | Partial weeks are *"weekly ÷ prorated"* | stands, but the **divisor is not ruled** (NEEDS 3), so partial weeks are held |
| 2026-08-29 | *"Salaried should be another thing by itself"* | §2 |

**Open rulings (NEEDS, Kane's).** Built behind honest seams, never guessed:

1. **Monthly.** How a monthly amount pays on a weekly run: ×12÷52 every week, ÷ that month's pay
   weeks, or once a month. *Built:* `month` is in the schema and shown disabled in the editor
   (with the reason). The server refuses it, and the resolver holds it (`period_not_priced`).
2. **Daily.** Which days pay: every Mon–Fri regardless of hours, only days with tracked time, or
   all 7. *Built:* the same seam as Month.
3. **Partial-week divisor.** ÷5 workdays or ÷7 days, and which days count. *Built:* a salaried
   person whose start date or last day falls inside the pay week is **held** (`partial_week`). So
   is a leaver with no recorded last day, or any week the leaver list could not be read
   (`leavers_unavailable`). A salary change can only be dated to a pay-week Sunday, so the editor
   cannot create a partial week.
4. **No Hubstaff time.** Is a salaried person with no row in the week's export paid anyway? The
   wizard and Dispatch are built from the export and never add a row
   ([[final-pay-roster-overlay]]). *Built:* Step 2 lists them as *"Salaried, but not in this
   week's Hubstaff export — not paid"*.

## 2. The ruling: a salary is a dated fact about a PERSON, never a department property

> **`employee_salary_history`, keyed on email + effective date**, mirroring
> `employee_rate_history`. A salary is legal **only on an employee-scope structure**: the DB CHECK
> `pay_structures_salary_shape` makes a department salary unrepresentable, and
> `validatePayStructure` refuses one first. **No pay resolution ever reads a department label for
> the basis.**

Three department-keyed designs were killed for this (adversarial scores 6.5 / 5.7 / 5.0); the
evidence is in §9 and is why the rule is shaped this way. The 08-29 open item *"Kane to confirm the
§2 ruling before any build starts"* was not answered separately. The 10-02 ask was taken as the go,
and the build follows §2 as written (CHOSEN 2: individual structures only). A department-wide salary
would need Kane to repeal §2.

The 08-29 sketch's salary TEMPLATE on an `hsl:attorneys` department structure was **not built**.
Nothing reads a department for the basis, so no placement can turn someone salaried. An HSL
"attorney" **data** sub-team (a placement in `app_settings`, [[builtin-sub-departments]]) prices
its people **hourly** from that sub-team's base rate, like any sub-team, until each person's own
structure is switched to Salary. The 08-29 risk *"the master cell pays before the code does"* is
therefore still true for that placement, but what it pays is the documented sub-team hourly rate,
never a salary.

## 3. How a week's basis resolves (`resolveSalaryWeek` → `resolveSalaryBasis`)

One function, called by **both** engines with the person's own pay week (non-HSL Sun→Sat; HSL is
Sun→Sat since the 2026-05-31 cutover). It returns `hourly`, `salary` or `held`, **never null**
(§4.1 of the original design). A degraded read cannot `if (salary)` its way into the hourly chain.
The checks run in this order, safest refusal first:

1. **History unreadable** → anyone whose Pay Structure says salary is **held**
   (`history_unavailable`). Everyone else is hourly. The wizard *starts* in `unavailable` and moves
   to `loaded` only when the read lands, so the window before the load can never price a salaried
   person hourly.
2. **Structure ⇄ latest history row disagree** → **held** (`structure_mismatch`). Examples: a
   salary save whose history write failed; a salary structure deleted out from under its history;
   a shadow structure under another department winning the catalog (rate resolution is email-only
   and newest-created wins, bonus-catalog.md §5.6). The structure compared is
   `resolveEmployeeCatalogStructure`, the exact row the rate came from. The comparison is against the
   **latest** row, not the row in force, so a scheduled change (salary from next Sunday) agrees.
3. **A change dated inside the week** → **held** (`changed_mid_week`). A row that only re-states
   the same salary is not a change.
4. **The row in force on the week's first day decides.** No row, or `hourly` → hourly. `salary` →
   then period (week only), currency (PHP/USD only), start date / last day inside the week
   (`partial_week`), and FX (a USD salary with no cycle FX is held, `fx_unavailable`).

The wizard additionally holds a salaried week while the final-pay overlay has not loaded cleanly
for the cycle (`offboardedRosterReady`). The server holds it when `listRecentlyOffboardedPeople`
fails. That read is the heavy roster merge, so `computeCurrentPay` makes it **only** when somebody
is on record as salaried.

**Rows filed under any alias count.** History is filed under the address the structure was saved
with; `salaryRowsForEmails` merges every alias. Two aliases carrying different rows on the same date
→ held.

## 4. What a salaried week pays

- **Regular = the flat amount** (PHP; USD × the cycle FX, the same conversion as a USD hourly rate),
  **OT = 0**, no HSL weekend premium, no Hogan sheet block, no proration block. Hubstaff hours stay
  on the row for reference only.
- **Approved time adjustments move no money** on a salaried row. The hours are still staged in
  `time_adjustment` so the correction is disclosed.
- **Bonuses, Adj., MESA and Orphanage ride on top, unchanged** (CHOSEN 3). A salaried row is "rated"
  for every `hasRates` gate (`calcRowHasPay`). A held row is not, exactly like a person with no rate.
- **Orphanage hours are refused for a salaried row** (*"a salary has no hourly rate to price
  orphanage hours at"*). Without that refusal the rates-index fallback would read the structure's
  pinned 0 and price the line at ₱0. How a salaried person's orphanage hours pay is not ruled (Open
  items).
- **A held week pays nothing** and is shown everywhere a "No rate" row is: amber on Step 2, its own
  *"N salaried people not paid"* popover with the reason, a red `salary_held` Validation flag, and
  Payment Dispatch `no_pay` via fallback C. It is never priced as a guess.

## 5. Writing a salary (the route)

`POST /api/payment-catalog/pay-structures`. For an employee structure, `planSalaryHistoryWrite`
decides before the upsert, so a refusal writes nothing:

- **A salary save** needs the migration (`409` otherwise), a readable history, **no other
  employee-scope structure for the person in another department** (`409`, naming it: one person,
  one structure while salaried), `period = week`, PHP or USD, and an **explicit effective date that
  is a pay-week Sunday**. There is no default: the date moves money, so the clerk states it. Every
  editor sends one and defaults it to next Sunday in salary mode.
- **An hourly save for someone whose latest history row is a salary** is a switch-off. It needs the
  same Sunday date and writes an `hourly` history row on that day. The hourly rate history that
  `syncRateHistory` writes starts on the same `body.effectiveDate`.
- **The structure row of a salary stores `regular_rate = 0`, `ot_rate = null`**, whatever the
  caller sent (`upsertPayStructure`, and `validatePayStructure` refuses otherwise). This is the
  backstop. Any reader that was never taught the salary basis prices ₱0, which is loud, and never a
  plausible hourly figure (§9.2). `resolve-rate.ts` `toResolved` pins both to 0 again on read.
- **A salary save skips `syncRateHistory` entirely.** Nothing goes to `employee_rate_history`, the
  `employee_hourly_rates` cache, the Google rates sheet or the Hogan Pay Plan sheet. Each is
  PHP-per-hour, and a weekly amount there is the §5.3 corruption class. The employee's "hourly rate
  updated" notification is not sent either (CHOSEN 6).
- **The history row is written AWAITED** (`writeSalaryHistoryRow`: supersede `>= today OR ==
  effective`, then insert; unique on `(lower(email), effective_from)`). A failure returns `500`,
  *"…until it lands this person's week is held, not paid"*. Rule 2 above then holds the week instead
  of letting the catalog's salary go unpaid silently.
- **`DELETE` refuses a salary structure** (`409`). Ending a salary is dated, so it is a switch to
  Hourly, never a removal. A removal would leave history saying salary with no structure, and every
  later week would be held.
- **`update-employee-rates` never overwrites a salary structure** with hourly figures. It reads
  `select('*')`, never a named `pay_basis`, so the lookup still works before the migration.
- Before the migration, hourly saves send **no** salary columns (`payStructuresSupportSalary`
  probes once; a positive answer is cached, a negative one is re-probed after a minute). Sending
  them would have failed every save.

## 6. The freshness guard is ON for salaried people (§9.5 closed)

`getCatalogRateClaimsByEmail` and Payment Dispatch's client queue build their claims through **one**
function, `catalogClaimFromStructure`. A salary structure claims its salary (any currency, compared
natively, with no FX float). `snapshotRateContradictsCatalog` then rejects:

- an **hourly-priced** snapshot of a now-salaried person (the 2026-07-29 stale-tab class),
- a **salary** snapshot of a person switched back to hourly, and
- a salary snapshot at a different amount, currency or period.

The snapshot entry and the payload both carry the `salary` block. `mergeSnapshotIntoStaged` moves it
under the same tri-state as the weekend, proration and time-adjustment blocks (`undefined` = older
snapshot, keep staged; `null` = hourly week, clear; value = this salary). A salary structure missing
its figures claims `NaN` and matches nothing, so the lock prices the week. **Known false
rejection:** after a salary is saved for a future Sunday, the current week's legitimately hourly
snapshot contradicts the structure and falls back to the lock. That is the same fail-safe as a
future-dated hourly raise.

## 7. The statement

`mapPayloadToPayStub` reads `salary` into `PayStubView.salary`. When set, the in-app statement, the
emailed HTML (rendered in-app, [[paystub-email-rendered-in-app]]) and the employee's Current Pay
Cycle pane print ONE line, **Salary (weekly)**. Its detail is *"Flat · hours not counted"*, or for USD
*"$500.00 USD / week · flat"*, from the shared `formatSalaryDetail`, and its amount is `mfPay`. **None**
of the Regular / Overtime / Weekend Hours × Rate lines render, because they would print `40.00h ×
₱0.00` beside real money. Every hourly payload, and every payload staged before 2026-10-02, renders
byte-identical. Both reconstruction paths in `employee-paystubs.ts` carry it: the snapshot fast path
and the `computeCurrentPay` slow path via `CurrentPayEntry.salary`.

## 8. In the wizard: `CalcRow.basis` replaced `regularRate`/`otRate`

The §4.2 rule, applied. The two fields were **deleted**, not joined by a sibling, so all ~20 read
sites became compile errors and each one decided:
`calcRowRates` (display rates, null for salary/held), `calcRowHasPay` (the old
`regularRate != null || otRate != null`) and `calcRowHasRegularPay` (the matched/missing counter).
**Do not re-add a `regularRate` field to `CalcRow`:** a salaried row would read null there and
silently lose its bonuses at every `hasRates` gate. The Step 2 rate cell shows the salary and a
**Salary** pill. The "N missing rates" popover lists hourly rows only, because *"add their rates"* is
the wrong fix for someone salaried. The rate-consistency checker skips salary rows: there is no
Hours × Rate line to check.

`startDateByEmail` now sits **above** `calcResults` (the partial-week hold reads it there). It was
declared after it. Moving it back below re-creates a temporal-dead-zone crash on every render.

## 9. Why the department label cannot carry a pay basis — the measured evidence (2026-08-29)

Kept verbatim in substance: this is what the ruling in §2 rests on.

1. **The department label is the most-clobbered field in the system.** 197 of the last 200 applied
   transfers report `sheet_synced=true`, and **at least 7 provably never landed**
   ([[transfer-sheet-sync-false-success]]). `masterDeptByEmail` is **first-wins over unordered
   rows** (`current-pay.ts`, `if (!masterDeptByEmail.has(e))`), so with a duplicate GML row,
   PostgREST row order decides.
2. **It fails silently toward hourly, not toward zero.** An unpriced `hsl:*` key inherits the
   parent base by design (`hsl-subdept.ts`, *"a placement here can never resolve ₱0"*). A missing
   salary row would produce a plausible number on a plausible paystub.
3. **A mid-week offboard loses the label on exactly the final-pay week.** `fetchMasterMin` reads
   `active_employees` and degrades silently on a partial read.
4. **No effective date.** A Friday transfer would reprice the whole current week. Snap-to-Sunday
   was deleted as a root cause on 2026-08-18 ([[midweek-transfer-proration-ruling]]). Do not
   reintroduce it.
5. **The re-lock freshness guard was OFF for salaried people by construction.** It read
   EMPLOYEE-scope PHP **hourly** structures only. Closed by §6.
6. **Salaried OT reads ₱0 in every analytic.** `buildOtRateByEmail` books `rate.ot != null ? … : 0`
   (`people-roster.ts`). Still true; it is correct for a salary (no OT).
7. **OT toggles are keyed per department** (`otDeptEnabled`). Irrelevant now: a salary has no OT.
8. **Replay would re-price at today's salary without a dated ledger.** The ledger fixes it: a
   replayed week resolves the salary that was in force then.

## 10. What still reads a salaried person as hourly (display only, Open items)

None of these move money; each shows the pinned `0` or the old sheet rate: the People tab rate
(`resolvePeopleRate`, `/hr`), the employee's monthly estimate (`member-monthly-pay.ts`: a salaried
employee's My Hours estimate reads ₱0), `disbursement-reports.ts` seeded estimates, Payment Catalog
Overview metrics and exports (`catalog-export.ts` *"PAY STRUCTURE (hourly rates)"*), Penny's
`get_rate_history`, the external-API `pay-rates` dataset (planned), the wizard's Preview-Emails
rate-snapshot panels and Reports columns (`rates_php` null), and the Readiness / Offboarded
`SetRateDialog` (hourly only: saving there switches a salaried person to hourly, Sunday-dated or
refused). The **COE refuses** a salaried person (*"Accounting will need to issue your Certificate of
Engagement manually"*) rather than certify a salary as an hourly rate.

## Deploy notes

- **Measured 2026-10-02 ~21:00Z (session `334b41c6`, read-only, a Monday board pass): the columns are PRESENT.**
  `payment_catalog_pay_structures.pay_basis` and `employee_salary_history.pay_basis` both select, and a
  negative-control column on the same table errors `42703`. So the migration, or part of it, has run.
  `--verify` was **not** run, so the constraints, the index and the service-role-only history are
  unchecked. The PENDING note below stays until Kane confirms, or until `--verify` passes.
- **Migration — PENDING (Kane).** `references/sql/alter/2026-10-02_salary_pay_basis.sql`, via
  `node --import tsx scripts/apply-salary-pay-basis-migration.mts --apply` (needs `DATABASE_URL`,
  the session pooler, [[migration-apply-needs-database-url]]). Run it without a flag first: that is
  a dry run, rolled back. The script checks every column, constraint and index, that the history is
  service-role only, that **every existing structure is still hourly**, and that each CHECK refuses
  a department salary, a missing period or amount, a negative salary, an hourly row with salary
  figures, and a duplicate same-day history row. **This session did not run the dry run:** it
  executes DDL against production inside a rolled-back transaction, which is Kane's call.
- Safe in either order. Before the migration the Salary option is disabled with the reason, and the
  server refuses a salary save with *"Salaries are not set up yet"*.
- No env vars, no n8n import (the email HTML is rendered in-app).
- **Not clicked through signed in.** Typecheck clean, 5,619/5,619 tests, and the two routes compile on
  the dev server (401 before any read). Owed: a signed-in pass that sets a salary on a test person,
  re-runs the wizard week, and reads the payslip.
