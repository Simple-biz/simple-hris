# Identity Resolution: Master Authority + Alternate-Email Bridging

How the app decides *who an employee is* when the same human appears under more
than one email across `global_master_list`, `employee_hourly_rates`,
`employee_ids`, and `hubstaff_hours`.

Two rules drive everything in this doc:

1. **The Global Master List is the source of truth for identity + Department.**
   The "All Dept" payroll rates CSV (and anything synced from it) is only a
   FALLBACK for those fields.
2. **Alternate work emails are aliases for the same human.** A row keyed on an
   alternate (e.g. `kevin@`) must resolve to the employee whose primary work
   email is different (e.g. `kevt@`).

---

## The problem (worked example: Kevin Tanjusay)

| Source | Work email | employee_id | Notes |
|---|---|---|---|
| `global_master_list` (Google master sheet) | `kevt@simple.biz` | `2308-0006` | PM Team. `Alternate Work Email = kevin@simple.biz` |
| `employee_hourly_rates` (Google "All Dept" rates sheet) | `kevin@simple.biz` | n/a | The PHP 285 / PHP 427.50 rate row |
| `employee_ids` | `kevin@simple.biz` | `PENDING-0032` | Placeholder id minted because the rate email never matched a master row |
| `hubstaff_hours` | `kevin@simple.biz` | n/a | Hubstaff exports him under the alias |

Before the fixes below:

- Rates & Profiles showed `kevin@simple.biz` / `PENDING-0032` because the merge
  let the rates value win over the master.
- The Payroll Wizard, Manager dashboard, and Employee dashboard either dropped
  him or showed zero hours/rate, because they matched by the canonical `kevt@`
  while Hubstaff and the rate row were keyed on `kevin@`.

The master sheet is correct (`kevt@` primary, `kevin@` alternate). The mismatch
lives in the rates/Hubstaff sources. The durable fix is in the **lookups**, not
the data: honor the master, and treat the alternate as an alias everywhere we
match by email.

---

## Rule 1: Master is authoritative (profile merge)

`src/lib/supabase/employee-rate-profiles.ts` merges rates + master into the
"Rates & Profiles" view. Helper `masterIdentityOverrides(master)` returns the
master's `{department, workEmail, personalEmail, organization}` (null when the
master lacks a field). Each builder applies it as `mo.x ?? finalized.x`, so the
master wins and the rates CSV only fills gaps:

- `getEmployeeRateProfiles` (bulk)
- `getEmployeeRateProfileByEmail` (single-profile modal, `/api/employee-rate-profiles?email=`)
- `getEmployeeRateProfileSummaries` (card list, `/api/employee-rate-profiles/summary`) -- both the matched-master loop and the unmatched-master loop

Pay/bank fields are untouched: the master never carries them, so the rates CSV
stays their source via the normal merge. Steering the work/personal email to the
master also steers `pickEmployeeId` off the stale `PENDING-` id and onto the
master's real `employee_id`.

**Tradeoff:** a stale master Department now wins over a correct rates-only
Department, so master-list hygiene matters more.

---

## Rule 2: Alternate-email bridging (hours + rate matching)

`EmployeeRow` (`src/lib/supabase/employees.ts`) now carries
`alternate_work_email` and `alternate_work_email_2`, parsed in `mapEmployeeRow`
and added to `GLOBAL_MASTER_SELECT`. The `active_employees` view already exposes
both columns. Every surface that matches an employee by email folds the
alternates into its match set:

### Payroll Wizard (`src/components/PayrollWizard.tsx`)
- `masterIndex`: a second pass aliases alternate work emails into `byWorkEmail`
  (primaries are mapped first and always win), so a Hubstaff row keyed on an
  alias resolves to the right master record.
- `ratesByEmail`: for each roster employee, if any of their emails hits a rate
  row, all of their emails are aliased to that row.

### Manager dashboard
- `ManagerMemberHoursMini` accepts `alternateWorkEmail` / `alternateWorkEmail2`
  props and folds them into `aliasNorms` (the Hubstaff calendar match set).
- `ManagerMemberDialog` passes `member.alternate_work_email*`.
- `/api/manager/department-members` `decorateWithHsl` checks the alternates for
  both the HSL detail and the `employee_hourly_rates` rate lookup.

### Server pay summary (`src/lib/payroll/member-monthly-pay.ts`)
- `fetchMasterRowsForEmail` selects the alternate columns and matches on them.
- `computeMemberMonthlyPay` adds them to `aliasNorms`, used for BOTH the Hubstaff
  hours query (`fetchHubstaffRowsForEmail`) and the rate-row find.
- Backs `/api/manager/member-monthly-pay`, consumed by the manager dialog AND the
  employee My Hours view.

### Employee dashboard
- `EmployeeMyHours` folds alternates into `aliasEmails` (the calendar match set)
  and resolves its rate row against a master-derived alias set. The rate match
  fetches the master row locally inside `fetchRatesAndFx` rather than reading the
  `aliasEmails` state -- `aliasEmails` depends on `rate`, so reading it there
  would create a `setRate -> aliasEmails -> setRate` render loop.
- `EmployeeDashboard` merged view goes through `/api/hubstaff-hours?merge_all=1`.

### Hubstaff hours endpoint (`app/api/hubstaff-hours/route.ts`)
- `expandEmailAliases(norm)` reads `active_employees` and returns the full set of
  a person's emails (work + personal + both alternates), degrading to just the
  input email on failure.
- Both the `merge_all=1&email=` mode and the `source_file=...&email=` mode expand
  the email and match any alias via `rowMatchesAnyEmail`.

---

## Failure mode to watch

All of Rule 2 is driven by `global_master_list."Alternate Work Email"`. If that
field is cleared on the master sheet, the bridge breaks and the employee's
Hubstaff hours + rate go dark again (the data is fine; nothing matches it). Keep
the alternate populated whenever someone is tracked under a different email than
their primary work email.

Cleanup that does NOT fix the root cause on its own: deleting the
`employee_ids` `PENDING-` row or editing the DB rate-row email. The "All Dept"
rates sheet still lists the alias, so the next sync recreates the alias-keyed
rows. The lookups above are what make that harmless.

---

## Related

- [data-sources.md](../reference/data-sources.md) -- `Alternate Work Email` columns, `active_employees` view, email normalization
- [business-logic.md](../reference/business-logic.md) -- email-drift / data-integrity policies
- [csv-imports.md](./csv-imports.md) -- Google master + rates sheet sync
