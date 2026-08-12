# HSL sub-departments — one department, a required sub-team

**The rule (Kane, 2026-08-10):** *"We need to only have 1 department for HSL. When a
worker is added to the HSL department a manager or acct person should also select the
subdepartment so that the correct base rate is set."*

So: **HSL appears exactly once in every department picker and filter**, and choosing it
reveals a **required Sub-department** selector. The sub-team is what carries the base
rate — not a second department.

Related: [payment-catalog-departments.md](./payment-catalog-departments.md) ·
[department-transfers.md](./department-transfers.md) ·
[bonus-catalog.md](./bonus-catalog.md) ·
[hsl-kpi-calculator-2026-07.md](./hsl-kpi-calculator-2026-07.md).
Full restructure plan (Saturday cutover still pending):
`docs/superpowers/plans/2026-08-06-hsl-subdepartment-restructure.md`.

---

## 1. The storage model — one cell, one canonical string

The sub-team lives **inside the master-list `Department` cell** as `hsl:<HslDeptKey>`
(e.g. `hsl:intake_specialist`) — the same string as the `department_managers` access
grant. Kane chose this over a separate column on 2026-08-10: no Sheet migration, no
sync changes, and the rate engine already resolves it.

| Layer | Value |
|---|---|
| Master `Department` cell / Google Sheet | `hsl:intake_specialist` (canonical, raw) |
| Every picker / filter | one entry: **`HSL`** |
| Sub-department selector | value `hsl:intake_specialist`, label **HSL — Intake Specialist** |
| Displayed anywhere a human reads it | **HSL — Intake Specialist** (em-dash, never `HSL:`) |
| Pay-structure `department_key` | `hsl:intake_specialist` |
| Dept-scoped **bonus** assignments | **`hogan_smith_law`** — the PARENT, unchanged |

Everything that knows these rules lives in one client-safe module:
[`src/lib/departments/hsl-subdept.ts`](../../src/lib/departments/hsl-subdept.ts).

| Helper | Use it for |
|---|---|
| `HSL_FAMILY_DEPT_LABEL` | the single label (`'HSL'`) every picker shows |
| `collapseHslFamilyLabel(raw)` | building a picker/filter option list — **never** a value written to the cell |
| `hslSubDeptOptions()` | the 14 `{value,label}` sub-team options (both keyspaces, see §1.1) |
| `isHslKpiDeptKey(key)` | "does this sub-team have its OWN calculator?" |
| `isHslPlacementOnlySubKey(key)` | "is this sub-team scored under a different one?" |
| `hslSubTeamName(key)` | display name, from whichever keyspace owns the key |
| `isPlaceableDeptLabel(raw)` | gate on any NEW placement: refuses a bare `HSL` |
| `formatDeptLabel(raw)` | display |
| `isHslFamilyLabel(raw)` | "is this person HSL?" — **use this, never `dept === 'hsl'`** |
| `hslSubKeyFromRaw` / `hslSubDeptLabel` / `isHslSubDeptLabel` | parse / compose / test a sub label |
| `deptCellMatchesSource` / `deptCellSatisfiesTarget` | transfer + sheet matching |

## 1.1 Two keyspaces: "can I place someone here?" ≠ "does it have a calculator?"

Added 2026-08-12. These are **different questions** and they now have different
answers, in different files.

| Keyspace | Lives in | Means |
|---|---|---|
| `HSL_DEPT_KEYS` / `HSL_DEPTS` | `src/lib/hsl-bonus/schema.ts` | the sub-team has its **own KPI calculator** |
| `HSL_PLACEMENT_ONLY_SUB_KEYS` / `HSL_PLACEMENT_ONLY_SUB_TEAMS` | `src/lib/departments/hsl-subdept.ts` | placeable + priceable, but **scored under another sub-team's calculator** |

**Why.** Kane relaying Carla, 2026-08-12: *"Successfully Transferred Calls - 50
each / Sign ups from Transferred Calls - 250 each. We calculate it under the
callback team bonus on HSL. Callback and Simpletexting have the same bonus, so
they are calculated under one calculator."* **Simple Texting** and **Lead
Nurture** are real HSL teams people work in and transfer into — but they have no
calculator of their own, and putting them in `HSL_DEPT_KEYS` to make them
placeable would have cost two things nobody wanted:

- **a duplicate KPI Calculator card** for a bonus Carla already scores under
  Callback Team. `simple_texting` was deleted from `HSL_DEPT_KEYS` on 2026-08-04
  precisely to remove that card; **that removal stands.**
- **a permanent `draft` row in Payroll Readiness → KPI Submissions.**
  `payroll-readiness.ts:571` iterates every `HSL_DEPT_KEYS` with **no grant
  filter and no roster filter**, and its HSL branch has **no zero-roster
  `no_bonus` downgrade** — that exists only for custom departments (`:550`). A
  sub-team with nobody in it counts in `kpiDue` (`:1879`) and never in
  `kpiSubmitted` (`:1880`), so each one would hold the 25 %-weight KPI dimension,
  and the headline readiness score, under 100 **every week, forever**, unless a
  manager marked an empty department "ready".

`scoredUnder` is typed `HslDeptKey`, so the calculator a placement-only team
rides cannot be renamed or retired without a compile error — the pointer can't
rot into a dangling string. `hsl-subdept.test.ts` pins the two keyspaces
**disjoint**: if anyone adds either key to `HSL_DEPT_KEYS` later, the suite fails
with the reason spelled out.

**Nothing in this keyspace reaches a KPI surface.** Every KPI consumer
(`HslBonusCalculator`, `AdminRoles`, `use-bonus-scoring-queue`,
`ManagerBonusHistory`, `payroll-readiness`, `PayrollWizard`,
`employee-kpi-results`, `Overview`) reads `HSL_DEPT_KEYS` / `HSL_DEPTS` directly
and never routes through `hsl-subdept.ts` — which is what makes widening the
placement helpers safe.

Consequences worth knowing:

- **Pay is unaffected and needed no edits.** `normalizeDeptToKey` already
  collapses any `hsl:*` → `hogan_smith_law` (`normalize-dept-key.ts:11`), so the
  HSL week model, the +₱15/h weekend premium and every payout path treat
  `hsl:simple_texting` as HSL on day one.
- **Rates work on day one too.** `resolveDeptCatalogRate('hsl:simple_texting')`
  tries the sub-team's own row, then the parent ₱225 — never ₱0 (§2).
- **They get no Admin Roles grant checkbox** (`AdminRoles.tsx:1291` iterates
  `HSL_DEPT_KEYS`), which is correct: there is no calculator to gate. Transfer
  targets and release ownership therefore run through the **parent** HSL grant,
  the same as the other twelve.
- **The Payroll Wizard's HSL rail buckets them "Unassigned"** — that rail keys on
  `hsl_team_members.dept_key` (the KPI roster), not the master cell. A display
  bucket, not a pay path.

## 2. Rate resolution — sub first, parent as fallback

Precedence is unchanged (`INDIVIDUAL → SHEET → DEPARTMENT base`, see
[bonus-catalog.md §5.1](./bonus-catalog.md#51-compute-time-overlay-srclibpayrollresolve-ratets)).
The department leg gained one step:

```
resolveDeptCatalogRate('hsl:intake_specialist')
  1. byDeptKey['hsl:intake_specialist']   ← the sub-team's OWN base rate
  2. normalizeDeptToKey → 'hogan_smith_law'  ← parent, the fallback
```

`resolve-rate.ts:137-146` runs the namespaced lookup **before** `normalizeDeptToKey`,
which collapses every `hsl:*` label to the parent and would otherwise make sub-team
structures unreachable. It is generalized — `medical_billing:intake_team` resolves the
same way for in-app departments (`subDeptStructureKey`).

**The parent fallback is permanent.** A sub-team Accounting has not priced yet resolves
the parent ₱225 — never ₱0. The parent row is deleted only at cutover, by script, after
every sub-team has its own row.

### Surfaces that MUST mirror this

Any surface that claims what a person is paid has to mirror the resolver exactly —
that is the standing contract from
[bonus-catalog.md §3 (Search tab)](./bonus-catalog.md#search-tab-added-2026-07-29).
Mirrored as of 2026-08-10:

| Surface | File |
|---|---|
| Engine | `src/lib/payroll/resolve-rate.ts` |
| Payment Catalog Search comp card | `src/lib/payment-catalog/person-comp.ts` |
| Accounting Transfers "Rate change" | `src/lib/transfers/accounting-transfers.ts` |
| HR onboarding rate seeding (×2) | `app/api/hr/onboarding-bypass/route.ts` · `app/api/hr/onboarding-submissions/[id]/set-work-email/route.ts` |

`person-comp` resolves the sub rate but keeps `deptKey` on the **parent** on purpose:
the same key drives dept-scoped bonus matching, and HSL bonuses are assigned on
`hogan_smith_law`. Splitting them per sub-team would stop every HSL common bonus
reaching anyone. For the same reason the 12 sub-teams are on the **Pay Structure** rail
only, never the **Bonus Assignments** rail.

## 3. Setting a sub-department rate

Accounting → **Payment Catalog → Pay Structure**. The rail lists the 12 sub-teams as
`HSL — <Name>` directly under the built-ins; saving one writes a dept-scope structure
keyed `hsl:<key>` through the existing `saveDept` path (`pay_structures_dept_uniq` keys
on `department_key`, so each sub-team gets exactly one row).

**Gotcha:** an **employee**-scope structure saved while a sub-team is selected still
mirrors to the Hogan Agents Pay Plan sheet — `pay-structures/route.ts` gates that mirror
on `departmentKey === 'hogan_smith_law' || isHslSubDeptLabel(departmentKey)`. A bare
`=== HOGAN_DEPT_KEY` test there silently stops mirroring. Department-scope saves never
call `syncRateHistory` at all, so a rail entry cannot touch PHP rate history.

### Anything listing departments by key must include the sub-teams

`hsl:<key>` is a real `payment_catalog_pay_structures.department_key`, so every list that
enumerates departments has to carry it or the rate goes missing:

| Surface | Handling |
|---|---|
| Pay Structure rail | `hslSubDeptOptions()` — where the rate is set |
| Catalog **export** (CSV/XLSX/PDF) | `hslSubDeptOptions()` — the builder matches structures by `dept.key`, so an omitted key **silently drops the rate row**. Pinned by `catalog-export.test.ts`, including a regression witness for the pre-fix list |
| Summary tab charts | `deptName()` routes `hsl:*` through `formatDeptLabel`; the generic slug-humanizer would render `Hsl:intake Specialist` |
| Bonus Assignments rail | **excluded on purpose** — HSL bonuses stay on `hogan_smith_law` |

The rail and the export both derive from `hslSubDeptOptions()` deliberately: one source,
so they cannot drift.

## 4. Where the sub-department is chosen

| Surface | Behavior |
|---|---|
| **HR → Onboarding → Bypass** (writes master + Sheet) | `DepartmentSelect hslSubDepartment` — Verify/Add gated by `isPlaceableDeptLabel`; the route **400s** on a bare HSL |
| **HR → Onboarding → set work email** (stages the hire) | same selector; the route 400s on a bare HSL, including one inherited from `invite_department` |
| **HR → Onboarding → bulk group** | same selector; a whole batch can't be set without a sub-team |
| **Manager/HR transfer in** | a PARENT HSL grant expands to **every** labeled sub-team target, both keyspaces (14 as of 2026-08-12); plain `HSL` is **not** an offered target; submit blocked on a bare HSL |
| **Admin → Roles & permissions** | unchanged — sub-team **access grants** already come from `HSL_DEPT_KEYS`, not from `/api/departments` |

Deliberately **left on the plain family label** — the department there selects a
**pay-plan PDF** (matched by department + country), and a sub-key would match no pay
plan at all: the **invite** dialog and the **pay-plan upload** dialog.

### The single-HSL choke point

`GET /api/departments` derives its list from distinct `active_employees."Department"`
and now runs `collapseHslFamilyLabel` over it. That route is the sanctioned place for
this kind of rewrite — the same choke point the Sales/Sales Assistant override uses
([sales-dept-split.md](./sales-dept-split.md)). Before the collapse the list carried
`HSL` **plus** one bogus raw department per sub-team in use (four, on 2026-08-10).

**Never** collapse inside a master-sheet **sync** path. Those mirror the sheet verbatim.

## 5. HR → Global Master List

The department chip, table cell, card and View dialog render `formatDeptLabel`, and the
Dept filter offers a single **HSL** matching the whole family.

Two deliberate carve-outs:

- **The raw cell is preserved.** Every prettified spot carries the literal value as a
  `title` tooltip, and the **CSV / XLSX / PDF export keeps the raw string**
  (`global-master-list-export.ts` reads `r.department` directly). The sheet-vs-DB
  consistency sweep that catches clobbered transfers compares literal Department
  strings — prettifying the export would break it.
- **The filter no longer narrows to one sub-team.** Search still does: the raw label
  stays in the row haystack, so typing `intake` finds them.

> This supersedes the earlier plan note that Admin/HR Global Master List views
> "deliberately keep showing the literal sheet cell" — Kane reversed that on
> 2026-08-10, which is the whole point of "only 1 department for HSL".

## 6. Transfers

- **Targets** come from the manager's grants **expanded**, never raw. `myDepartments`
  is the access-control keyspace; feeding it in directly is how `hsl:intake_specialist`
  got written into master `Department` cells and rendered as a department. A parent
  grant now yields **every** labeled sub-team target — placement-only teams included
  — and **no silent default**: `soleDept` defaults only when exactly one real choice
  remains.
- **Release queues** use `managerOwnsSourceDept(grants, from_department)`: exact match
  first; a parent Hogan grant owns every family source; an `hsl:<sub>` grant owns
  exactly its own sub-team — not siblings, not the family. A raw `Set.has` left
  requests out of `hsl:*` with no owner at all, so nobody could release them.
- **Within-family moves do not reset the weekend premium.** `buildHslTransferEffectiveMap`
  skips rows whose `from_department` is already HSL-family, so a plain→sub relabel or a
  sub→sub reshuffle can't re-scope someone's +₱15/h Sat/Sun day-scoping. A **bulk**
  relabel must never write `department_transfer_requests` rows at all.

## 7. Adding a new sub-team

**First decide which keyspace it belongs in (§1.1):** does this team get its *own*
KPI calculator, or is its bonus scored under an existing one? Getting this wrong
is not cosmetic — the wrong choice costs a duplicate calculator card and a
permanent Readiness "Pending" row.

### 7a. It has its own KPI calculator

1. `src/lib/hsl-bonus/schema.ts` — add the key to `HSL_DEPT_KEYS` **and** a config to
   `HSL_DEPTS` (two edits; everything else derives from these).
2. `hsl_team_members.dept_key` — SQL to populate the roster.
3. Grant it in Admin → Roles & permissions (the `hsl:<key>` checkbox appears itself).
4. Set its base rate on the Pay Structure rail — until you do, it rides the parent.

**Cost of this path:** the dept joins Payroll Readiness → KPI Submissions
immediately and reads `draft` until a manager marks it ready, **every week**, even
with nobody in it. Only take it when the team really is scored on its own.

### 7b. Its bonus is scored under another sub-team

1. `src/lib/departments/hsl-subdept.ts` — add the key to
   `HSL_PLACEMENT_ONLY_SUB_KEYS` **and** an entry to
   `HSL_PLACEMENT_ONLY_SUB_TEAMS` with its display name and the `scoredUnder`
   calculator (two edits, same shape as 7a).
2. Set its base rate on the Pay Structure rail — until you do, it rides the parent.
3. Tell the scoring manager to keep the people on the `scoredUnder` team's
   `hsl_team_members` roster — that is where the bonus is actually entered.

No Admin Roles checkbox, no KPI card, no Readiness row. Do **not** also add it to
`HSL_DEPT_KEYS`; the test suite fails on purpose if you do.

Either way the picker, the transfer targets, the onboarding sub-department
selector, the display label, the Pay Structure rail, the catalog export and the
placement validation all pick it up with no further edits.

Currently placement-only: **Simple Texting** and **Lead Nurture**, both scored
under **Callback Team** (Successfully Transferred Calls ₱50 · Sign ups from
Transferred Calls ₱250).

## 8. Still open (not shipped 2026-08-10)

These are the remaining plan tasks; nothing below is required for the two rules above.

- **HARD HOLD:** `current-pay.ts:970` and `disbursement-reports.ts:1192` still prefer the
  `employee_hourly_rates."Department"` label, which the HSL mirror flattens to
  `"Hogan Smith Law"`. Flipping them to master-label-first **before** the 12 sub-rate rows
  exist would strand the sub-labeled people with no department base. That edit ships in
  the **same change** as `seed-hsl-subdept-rates.mts --apply`, never on its own.
- Sheet write-back is still `rowDept === from` exact
  (`update-master-sheet-department.ts:121`) — out-of-HSL midweek moves can still snap back.
- No transfer-aware stale-row guard in the master sync.
- No bulk sub-department assignment tool: 528 of 598 active HSL people are still plain
  `HSL` and ride the parent rate.
- No `seed-hsl-subdept-rates.mts` / `remove-hsl-parent-base-rate.mts`. **Zero `hsl:*`
  rate rows exist yet** — the rail can now create them; the figures are Kane's to supply.
- HSL-as-separate-organization (a QuickBooks-style org toggle) is explicitly **out of
  scope**, recorded as the long-term direction from the 2026-08 meeting.
