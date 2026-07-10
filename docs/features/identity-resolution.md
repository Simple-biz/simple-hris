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

### Tech Bonus 30-day-service gate (`startDateByEmail`)

The Tech Bonus requires 30 days of service before an employee's first cycle, so
the gate resolves each person's `start_date` by email. That lookup map
(`startDateByEmail`) originally indexed only the master's primary **work** and
**personal** email. An employee whose hours/rates key on an *alternate* work
email therefore had no entry in the map and was silently skipped by the
`if (!sd) continue` guard — eligible, but never granted the bonus.

The fix folds alternates into the same map (the primary still wins; an alternate
only fills a slot that isn't already taken):

- **`src/components/PayrollWizard.tsx`** — the `startDateByEmail` memo now also
  maps `emp.alternate_work_email` / `emp.alternate_work_email_2`
  (`PayrollWizard.tsx:3756`, primary wins via `!map.has(a)`). It is consumed by:
  - the `techBonusEligible` memo that drives the Additions tab's **Tech** pill
    (`PayrollWizard.tsx:3795`), and
  - `dispatchData`'s `hasThirtyDaysByWeek` (`PayrollWizard.tsx:4263`), which now
    **reuses the single memoized map** instead of rebuilding a divergent one, with
    `startDateByEmail` added to the memo deps (`PayrollWizard.tsx:4396`). This
    keeps the staged paystub amount and the on-screen pill from drifting apart.
- **`src/lib/payroll/current-pay.ts`** (the Payment Dispatch server mirror) —
  `fetchMasterMin` now `SELECT`s `"Alternate Work Email"` /
  `"Alternate Work Email 2"` (`current-pay.ts:235`), and the server-side
  `startDateByEmail` bridges them the same way (`current-pay.ts:570`).

**No change needed** elsewhere: `member-monthly-pay.ts` already bridges alternate
work emails (see above), and both employee dashboards already resolve the
employee's own record across all of their emails (work + personal + alternates).

#### Data fix — Sheen Gobalani (PENDING)

The trigger case: Kyle Sheen "Sheen" Gobalani's master row carried a vestigial
primary Work Email `shannong@simple.biz` while every operational system (Hubstaff
hours, `employee_hourly_rates` rate row) keyed her on `sheeng@simple.biz`, which
sat in her *Alternate* slot. The lookup fix above resolves her start date in code;
`references/fix_sheen_gobalani_work_email.sql` (**PENDING**) makes the data itself
canonical by swapping the two — `Work Email → sheeng@simple.biz`,
`Alternate Work Email → shannong@simple.biz` — keyed on the old work email +
Personal Email `gobalanik@gmail.com` + `Department = 'Accounting Team'`. It is
non-lossy (old value preserved as the alternate), reversible (rollback block
included), and idempotent.

> **Gotcha:** if the MASTERLIST Google Sheet still lists `shannong@simple.biz` as
> her work email, a future sheet sync could re-introduce it. Update the Sheet too
> for the correction to be durable.

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

## Alternate-work-email RBAC & identity bridge (2026-07-09)

Rule 2 above bridged **hours, rates, and payroll** across a person's linked work
emails, but **RBAC and self-identity did not** until this change. Symptom (April
G.): she signs in via her *alternate* work email (`aprilg@`) while her role,
feature permissions, and master identity are all keyed on her *primary*
(`april@`) — so she got no ViewSwitcher, an empty My Team, no MESA tab, and a
redirect loop. The durable fix is one shared resolver used at every point that
keys on the login email.

Key files:

- [work-email-aliases.ts](src/lib/email/work-email-aliases.ts) — `expandWorkEmailAliases()`, the shared resolver.
- [auth-options.ts](src/lib/auth/auth-options.ts) — JWT role lookup bridge.
- [employee-roles/route.ts](app/api/employee-roles/route.ts) — live `GET` role lookup bridge.
- [feature-permissions.ts](src/lib/rbac/feature-permissions.ts) — `fetchFeaturePermissionsForEmail` overlay bridge.
- [employee-feature-permissions/route.ts](app/api/employee-feature-permissions/route.ts) — `GET` self-read overlay bridge.

`expandWorkEmailAliases(email)` takes ANY address a person signs in with (or is
looked up by) and returns the full lowercased set of that person's **work**
addresses — primary `"Work Email"` plus `"Alternate Work Email"` /
`"Alternate Work Email 2"`, always including the input. It runs three sequential
single-column `.ilike()` queries against `global_master_list` (one per column —
not a combined `.or(...)`, because PostgREST's filter string mis-parses the
quoted, space-containing column names) and **excludes off-boarded rows**
(`off_boarded_at is null`), because a released address gets recycled to a new
hire and could otherwise leak a now-different person's aliases. It degrades to
just `[email]` on any error or missing client, so a failure never loses the
caller's own address (it just loses the bridge that once).

Where the bridge is applied:

| Surface | What it bridges | How |
|---|---|---|
| JWT role resolution ([auth-options.ts](src/lib/auth/auth-options.ts)) | dashboards baked into the token | `employee_roles` selected with `.in("role"-set, aliases)`; a role on any linked address counts |
| Live role fetch ([employee-roles/route.ts](app/api/employee-roles/route.ts) `GET`) | ViewSwitcher's own-role list | `q.in('work_email', await expandWorkEmailAliases(authz.effectiveEmail))` |
| Self-identity + Department | which master row is "me" | `getEmployeeMasterRecord` / `/api/employees` / the EmployeeApp matcher union the linked emails |
| Feature-permission overlay ([feature-permissions.ts](src/lib/rbac/feature-permissions.ts)) | per-tab access | `fetchFeaturePermissionsForEmail` selects rows `.in("work_email", emails)`; on a `(view, feature)` collision the **most-permissive** access wins (`edit` > `view` > `hidden`) |

**Grants stay on the primary.** Roles and feature-permission rows are still
assigned to (and provisioned/revoked on) the person's PRIMARY work email — see
`provisionDashboardTabs` / `deprovisionDashboardTabs` in
[employee-roles/route.ts](app/api/employee-roles/route.ts). The bridge only
happens on the *read* side, so those grants resolve no matter which linked
address the person authenticates as.

**Self-read vs. admin cross-read.** The overlay/permission bridge only unions the
alias set on a **self-read** (`authz.effectiveEmail === authz.sessionEmail`). An
admin reading someone else's rows passes `[email]` and stays **exact**
(`isSelfRead ? await expandWorkEmailAliases(email) : [email]` in
[employee-feature-permissions/route.ts](app/api/employee-feature-permissions/route.ts)),
so the admin grid still shows the row keyed on the address you're editing.

---

## Hubstaff ↔ Master reconciliation exception buckets (2026-07-09)

The Accounting Overview's "Hubstaff ↔ Master matches" tile (mirrored to the CEO
board) buckets every person into a `HubstaffReconStatus`. This change hardened
the buckets so fewer legitimate no-hours / off-directory cases read as real
directory gaps.

Key files:

- [hubstaff-reconciliation.ts](src/lib/payroll/hubstaff-reconciliation.ts) — status literals, exempt-dept + excluded-email sets, row shape, CSV.
- [Overview.tsx](src/components/Overview.tsx) — `classifyNoHours` + the `masterRecon` memo that builds the rows.
- [HubstaffMasterMatchesModal.tsx](src/components/accounting/HubstaffMasterMatchesModal.tsx) — the searchable drill-down with the status filter chips.

The five statuses: `On Master & worked`, `On Master, no hours` (an unexplained
gap), `Exception` and `On Leave` (both EXPECTED no-hours, not gaps), and
`In Hubstaff, not on Master`. `classifyNoHours` tags a no-hours master employee
in priority order — no-Hubstaff dept → approved leave → onboarding timing →
unknown gap:

- **Off-directory Hubstaff workers = offboarded exceptions.** Anyone who logged
  hours but is missing from the *active* master list has already been dropped
  from the directory (offboarded), so they are no longer counted as a gap
  (`hubstaffOnly` stays 0). Each is enriched from the Offboarded tab of the
  master Google Sheet (loaded via `/api/hr/offboard-history` into
  `offboardedByEmail`, indexed by **both** normalized work AND personal email so
  a Hubstaff row matched on work email still resolves when only the personal
  email is on file). The reason reads "Already offboarded … — on the Offboarded
  sheet, not a directory gap" when matched, else a generic "treated as
  offboarded" note.
- **Dept-exempt teams.** `isHubstaffExemptDept()` matches (case-insensitively)
  `smm freelancer`, `site building`, `sales`, and `usee` — teams with no
  Hubstaff time tracking by nature (freelance/project-based, commission-based
  sales, salaried US staff). No-hours members are tagged `Exception`, not a gap.
- **Hard exclusions.** `HUBSTAFF_RECON_EXCLUDED_EMAILS`
  (`isHubstaffReconExcluded()`) drops a seat from the recon **entirely** — not a
  gap AND not an exception — for retired seats that would otherwise linger as
  noise (currently `seungyong@simple.biz`). Applied in both the master loop and
  the Hubstaff-only loop.
- **On Leave.** A no-hours employee excused by an **approved** leave gets the
  dedicated `HUBSTAFF_LEAVE_STATUS` (`On Leave`) — a specialization of the
  exception bucket broken out so the modal offers its own filter chip. A leave
  counts when its **`end >= period start`** (i.e. it overlaps the pay period OR
  is upcoming; a leave that already ended before the period does not count). In
  All-Time view the same test runs against today. Pending (un-approved) requests
  do NOT clear anything and stay flagged.

The modal derives the **Exceptions** and **On Leave** chip counts from the rows
by exact status (the tile's single `counts.exceptions` is the combined
expected-no-hours tally), so each chip's number matches the rows it filters to.
`counts` are `null` until the payroll scope loads (chips show "—"); the rows are
always built. The Accounting Overview publishes these same rows into its hero
snapshot so the CEO board renders a byte-identical drill-down.

---

## Related

- [data-sources.md](../reference/data-sources.md) -- `Alternate Work Email` columns, `active_employees` view, email normalization
- [business-logic.md](../reference/business-logic.md) -- email-drift / data-integrity policies
- [csv-imports.md](./csv-imports.md) -- Google master + rates sheet sync
