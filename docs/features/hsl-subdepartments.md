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
| `hslSubDeptOptions()` | the 16 `{value,label}` sub-team options (both keyspaces, see §1.1) |
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
they are calculated under one calculator."* **Simple Texting** is a real HSL team
people work in and transfer into — but it has no calculator of its own, and
putting it in `HSL_DEPT_KEYS` to make it placeable would have cost two things
nobody wanted:

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
**disjoint**: if anyone adds the key to `HSL_DEPT_KEYS` later, the suite fails
with the reason spelled out.

> **`lead_nurture` was retired 2026-08-13** — one day after it shipped. It named
> the **same team** as Simple Texting and collided with Lucky's separate Lead
> Nurture team. CJ: *"We can use HSL – SimpleTexting to avoid any confusion with
> Lucky's Lead Nurture Team."* Kane: *"we need to remove the other one."* Nobody
> was ever placed in it, so the withdrawal repriced nobody. See §7c. A test pins
> the key **absent** from both keyspaces so it cannot drift back in.

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

**The parent fallback is permanent** — *until the cutover retires it (§11).* A sub-team
Accounting has not priced yet resolves the parent ₱225, never ₱0. The parent row is
deleted only at cutover, by script, after every sub-team has its own row. **All 16
sub-teams have carried their own base rate since 2026-08-14**, so the fallback is no
longer load-bearing for anybody; the parent row itself is still present pending §11
step 5.

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
reaching anyone. For the same reason the sub-teams are on the **Pay Structure** rail
only, never the **Bonus Assignments** rail.

## 3. Setting a sub-department rate

Accounting → **Payment Catalog → Pay Structure**. The rail lists all 16 sub-teams as
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
| **Manager/HR transfer in** | a PARENT HSL grant expands to **every** labeled sub-team target, both keyspaces (16 as of 2026-08-14); plain `HSL` is **not** an offered target; submit blocked on a bare HSL |
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

## 7. Adding — or retiring — a sub-team

Adding: §7a (own calculator) or §7b (scored under another). Retiring: §7c.

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

#### 7a-roster-only: a real team with NO bonus program (`noKpi`)

Added 2026-08-14 for **Executive Guest Services**: a real ~31-person Hogan cohort
that was scored nowhere (`hsl_team_members.dept_key` NULL) and has **no defined
KPI rules** — and rules are never guessed, because they change pay (the
Attestation tier guess mispriced 11 rows). For that shape, take §7a but set
`noKpi: true` with `rules: []`:

- the KPI Calculator renders a **roster-only card** ("Roster only — no KPI
  inputs"), so managers can see and manage the team;
- the Admin Roles `hsl:<key>` checkbox, transfer targets, onboarding picker,
  Pay Structure rail and catalog export all derive as usual;
- **Payroll Readiness reads the dept `no_bonus`** ("Ready by definition"), not a
  permanent weekly `draft` — `payroll-readiness.ts` special-cases `noKpi` in its
  HSL branch, so the readiness cost above does NOT apply;
- `hsl-subdept.test.ts` pins the pairing both ways: a `noKpi` dept must have zero
  rules, and a rules-less dept must declare `noKpi` (or `perEmployee`).

**Executive Assistants** (`executive_assistants`) is the second dept of this
shape, added 2026-08-14 — Kane: *"Lets create a new department called HSL -
Executive Assistants and put them in there please."* Its cohort is the three
EA/assistant roles the bulk assignment could not map to any existing team
("Dan Smith EA", "Dan Smith EA- Med Rec", "Rick's Assistant"). Seeded by
`scripts/seed-hsl-executive-assistants.mts` (§10), which writes the placement
**and** the roster, because those are two different things.

> **Do not confuse it with the BARE `executive_assistants` slug**, which is a
> separate in-app registry department whose KPI card was *retired*
> (`KPI_CALCULATOR_RETIRED_DEPT_KEYS`, `department-bonus.ts:269`). That set holds
> **unnamespaced** slugs; this key only ever appears as
> `hsl:executive_assistants`, so a retired bare slug can never suppress the HSL
> sub-team's card. A test pins that every `HSL_DEPT_KEYS` entry is placeable only
> in its `hsl:` form and that a bare key never parses as a placement.

When the bonus program is defined later, add the `BonusRule` entries and drop
`noKpi` — the card, the Readiness row and weekly auto-dispatch derive on their
own. Roster seed for the initial cohort: `scripts/seed-hsl-egs-roster.mts`
(email-keyed, NULL-only, backup-first, `--apply` gated). The 2026-08-14 run set
31 rows; it deliberately left `jaya@`/`syr@` (already scored under Collections —
moving them is a scoring decision) and `arr@` ("Guest Services Manager") for
Kane to rule on.

### 7b. Its bonus is scored under another sub-team

1. `src/lib/departments/hsl-subdept.ts` — add the key to
   `HSL_PLACEMENT_ONLY_SUB_KEYS` **and** an entry to
   `HSL_PLACEMENT_ONLY_SUB_TEAMS` with its display name and the `scoredUnder`
   calculator (two edits, same shape as 7a).
2. Set its base rate on the Pay Structure rail — until you do, it rides the parent.
   Note the rail only lists a key **after the code deploys**, so a pre-deploy seed
   has to go through `scripts/seed-hsl-placement-subdept-rates.mts` (see below).
3. Tell the scoring manager to keep the people on the `scoredUnder` team's
   `hsl_team_members` roster — that is where the bonus is actually entered.

No Admin Roles checkbox, no KPI card, no Readiness row. Do **not** also add it to
`HSL_DEPT_KEYS`; the test suite fails on purpose if you do.

Either way the picker, the transfer targets, the onboarding sub-department
selector, the display label, the Pay Structure rail, the catalog export and the
placement validation all pick it up with no further edits.

Currently placement-only (two):

- **Simple Texting**, scored under **Callback Team** (Successfully Transferred
  Calls ₱50 · Sign ups from Transferred Calls ₱250). Seeded at **₱225.00 /
  ₱337.50 OT PHP** on 2026-08-12 (Kane) — department scope, identical to the
  parent base. **8 people** sit in it as of 2026-08-13.
- **Hearing Prep Team – Mail Sorting** (key `hearing_prep_mail_sorting`), added
  2026-08-14 (Kane), scored under **Pre-Hearing / Post-Hearing Prep** — where
  all 3 live members (role_raw "Hearing Prep Team-Mail Sorting") were already
  sitting on `hsl_team_members.dept_key='post_hearing_prep'` when it was added.
  No rate row of its own — it rides the parent fallback until Accounting sets
  one on the Pay Structure rail.

`lead_nurture` was seeded 2026-08-12 and **retired on 2026-08-13** (§7c).

### Seeding a placement-only rate before the code deploys

`scripts/seed-hsl-placement-subdept-rates.mts` (`--apply` gated) writes exactly
what a department-scope Pay Structure save writes — one row per `department_key`,
employee columns null, PHP, **no** `employee_rate_history` / rates-sheet / Pay Plan
sheet / notification side effects, since those are employee-scope only
(`pay-structures/route.ts:205`). It adds one `audit_log` row, which the UI route
omits for department saves: a script-driven production rate write should be
attributable.

Four guards, all failing closed: the payroll processing lock, key validity (checked
by importing `HSL_PLACEMENT_ONLY_SUB_KEYS` from the code, so it cannot seed a key
the app does not recognise), occupied-slot refusal (changing an existing base rate
is a rate CHANGE for everyone riding it, not a seed), and a disk backup of every
HSL-family structure before any write.

**The locked-cycle exemption.** The processing lock exists to stop a rate edit
desyncing STAGED amounts mid-run, which requires somebody in the run to resolve
their rate through the key being written. `--seed-while-locked-proven-no-op` is
honoured only when four preconditions prove nobody can: zero master-list cells on
the key, zero `employee_hourly_rates` rows, zero employee-scope structures, and
seeded figures exactly equal to the parent base. If any precondition fails the
script aborts **even with the flag** — the flag rides a proof, it never widens the
guard. The 2026-08-12 seed used it (Payment Dispatch was locked on the 08-02 cycle)
with all four proven.

### 7c. Retiring a sub-team

Added 2026-08-13, when `lead_nurture` was withdrawn one day after shipping. §7a and
§7b only covered *adding*, and a retirement touches a **rate row** — so it needs a
written path rather than improvisation.

**The order matters: code first, then the rate row.** Removing the key stops any
new placement immediately (`isPlaceableDeptLabel` rejects it, every picker drops
it). The leftover catalog row is inert while it waits, because nothing can hold the
key. Delete the row first and you have the opposite: a live, placeable, offered
sub-team with **no base rate of its own**, silently riding the parent.

1. **Prove it's unoccupied.** Zero master-list `Department` cells, zero
   `employee_hourly_rates` rows, zero employee-scope pay structures, zero
   `hsl_team_members` rows, zero **live** `department_managers` grants
   (`revoked_at IS NULL` — revoked rows are tombstones, not access), zero transfer
   requests. **Page every read**: PostgREST truncates at 1000 rows even with
   `.range()`, and `employee_hourly_rates` alone is 22k rows, so an unpaged probe
   reports a comfortable zero it has not earned.
2. **If anyone IS placed there, stop.** That is a department move for real people,
   not a retirement: transfer them to the surviving sub-team first, through the
   normal transfer flow, so the sheet write-back and rate history stay consistent.
3. **Remove the two code edits from §7b** — the key from
   `HSL_PLACEMENT_ONLY_SUB_KEYS` and the entry from
   `HSL_PLACEMENT_ONLY_SUB_TEAMS`. Everything else de-derives on its own.
4. **Pin it retired.** Add the key to the `RETIRED` list in the "retired sub-team
   keys stay retired" test in `hsl-subdept.test.ts`. It asserts the key resolves
   nowhere, is not placeable, appears in no picker, *and* still counts as
   HSL-family for pay (week model, +₱15/h weekend premium, parent ₱225 fallback) —
   a stale cell must degrade, never strand somebody outside HSL or at ₱0.
   Re-point any test that named the key rather than deleting the assertion: the
   invariants those lines were testing (a sibling target is not a no-op, the
   em-dash display form) still need a live subject.
5. **Delete the orphaned rate row** with a script, `--apply` gated, backup to
   `reports/` first — `scripts/remove-hsl-lead-nurture-rate.mts` is the worked
   example. Its Guard 1 is the **inverse** of the seed's: it imports both keyspaces
   and refuses to run while the key is still live, which is what enforces the
   code-first order above. It deletes **by primary key**, never by a
   `department_key` filter — a filter deletes whatever matches at execution time,
   an id deletes the row you proved. It refuses on any row count other than 1, and
   refuses if the figures **differ** from the parent base (a different figure means
   somebody set a real rate on purpose — a decision, not an orphan).
6. **Leave the audit trail alone.** The original `payroll.rate.set` row stays; the
   deletion adds a `payroll.rate.delete` row beside it. History is never rewritten.
7. **Do not delete the row if people are still in the key** — see step 2. Deleting a
   base rate that somebody rides is a rate CHANGE for them, and it belongs in
   Payment Catalog → Pay Structure with the normal guards.

The locked-cycle exemption applies exactly as it does to a seed, with the same
P1–P4 proof; for a delete, P4 means *the row being removed equals the parent
fallback that replaces it*, so resolution is numerically unchanged. The 2026-08-13
removal ran under it (`payroll.dispatch_locked` had been true since 08-11).

## 8. Still open (not shipped 2026-08-10)

These are the remaining plan tasks; nothing below is required for the two rules above.

- ~~**HARD HOLD**~~ — **RELEASED 2026-08-14 (§11 step 3)**, in the same change as
  `seed-hsl-subdept-rates.mts --apply` exactly as required. The release is
  deliberately **narrower** than this line described: `resolveDeptLabelForRate`
  prefers the master label **only when it is HSL-family**, because a blanket
  master-first flip was measured to move `carla@` from a ₱175 base to none.
- Sheet write-back is still `rowDept === from` exact
  (`update-master-sheet-department.ts:121`) — out-of-HSL midweek moves can still snap back.
- No transfer-aware stale-row guard in the master sync.
- ~~No bulk sub-department assignment tool~~ — **SHIPPED 2026-08-14, see §9.**
  **579 of 579** active HSL-family people now carry an `hsl:<key>` cell — the parent
  holds NOBODY (see §10).
- ~~No `seed-hsl-subdept-rates.mts`~~ — **SHIPPED 2026-08-14 (§11 step 2)**: all 16
  sub-teams now carry their own department-scope base rate. `remove-hsl-parent-base-rate`
  (§11 step 5) is still outstanding, blocked on the live payroll lock.
- HSL-as-separate-organization (a QuickBooks-style org toggle) is explicitly **out of
  scope**, recorded as the long-term direction from the 2026-08 meeting.

## 9. The bulk sub-department assignment (2026-08-14)

`scripts/bulk-assign-hsl-subdepartments.mts` — the tool §8 spent a month listing as
missing. It relabels the master `Department` cell of active, plain-`HSL` people to
`hsl:<sub-team>`, in `global_master_list` **and** the master Google Sheet.

**It is not a transfer.** Per §6 it writes **zero** `department_transfer_requests`
rows — those feed `buildHslTransferEffectiveMap`, and a row dated today would
re-scope the +₱15/h Sat/Sun premium for everyone in it. Consequence to state out
loud: the move appears in **no** Transfers tab and sends no `transfer.applied`
notification. The audit trail is one `hsl.subdept.bulk_assign` row plus the plan
and backup files in `reports/`.

### The source of truth is the KPI Role column

Kane, 2026-08-14: *"We will be using the KPI Role Column as their Sub
Departments"* and *"Please make sure people under EGS is under EGS use the KPI
Role Column as the sub department"*. That deliberately **overrides** the input
CSV's own `Proposed Sub-department` column, which was derived from
`hsl_team_members.dept_key` and predates the 2026-08-14 EGS + Mail-Sorting work.
23 people landed differently as a result — including `jaya@` and `syr@` → EGS,
the two the EGS roster seed had left for Kane (§7a-roster-only).

`ROLE_TO_SUBKEY` in the script is the whole decision and it is **declared, never
inferred**: 52 role strings → 14 keys. A role string not in the table is
**skipped and reported**, never guessed. Three roles are unmapped *on purpose* —
Kane ruled on 2026-08-14 that "Dan Smith EA", "Dan Smith EA- Med Rec" and
"Rick's Assistant" stay on the plain `HSL` cell. Leaving them out of the table is
what enacts that; do not "complete" it without asking.

Two translations worth knowing, because the role string names no key:

- **"Pre-Hearing Litigation" → `ssd_medical_records`.** Not a guess: all 55 live
  `hsl_team_members` rows for those roles already sat there.
- **"Intake Callback" → `callback_team`.** The one place the role column and the
  KPI roster genuinely disagree — the roster has these 34 people on
  `intake_specialist` and `callback_team` had zero roster rows. The role column
  wins by Kane's rule, which makes Callback Team a real 34-person priceable team.

### Rate neutrality is a guard, not a hope

Kane's constraint was *"we will take their current rates from the Hogan Smith Law
Department which was individually set"*. A relabel cannot move an individual rate:
`buildCatalogRateIndex` keys employee-scope structures by **email alone**
(`resolve-rate.ts:68-80`), and the sheet leg is email-keyed too. Only the
department leg reads a department, and §2's parent fallback makes an unpriced
sub-team numerically identical.

**Guard 6 proves it per run** and aborts if it ever stops being true: if any
target `hsl:<key>` department-scope structure exists whose figures differ from the
parent base, the script refuses — a differing figure would reprice whoever rides
the department base, which is a rate change, not a placement, and belongs in
Payment Catalog → Pay Structure.

### Guard 8: the DB write set is the SHEET-MATCHED set

Learned on the first run. `valeriec@` had a DB cell of `HSL` but a **Sheet** row
reading `Lead Gen` — the Sheet had drifted two weeks past the last sync
(2026-07-30). The Sheet matcher correctly declined her row; the DB write ran
anyway, so the DB briefly asserted an HSL sub-team the Sheet contradicted. It was
reverted by primary key the same session.

The Sheet is the roster's source of truth, so **a DB row the Sheet disagrees with
is not a placement, it is a pending clobber** (§6 of `department-transfers.md`).
The script now drops anyone whose Sheet cell is not sitting in the source
department from the DB write and reports what the Sheet actually says. It also
writes the **Sheet first**: if the DB half fails, the next sync resolves toward
the sub-team rather than away from it.

### Run record — 2026-08-14

483 planned · **482 relabeled** (`valeriec@` reverted) · 482 Sheet cells · 0
failures · 0 transfer rows · **₱0 movement**. 7 skipped: 3 unmapped by Kane's
ruling, 3 already moved to Lead Gen, 1 offboarded.

| Sub-team | +this run | live total |
|---|---|---|
| Intake Specialist | 142 | 196 |
| Filing Specialist | 57 | 68 |
| SSD Medical Records | 56 | 56 |
| Case Managers | 51 | 56 |
| Attestation | 41 | 42 |
| Callback Team | 34 | 34 |
| Executive Guest Services | 32 | 35 |
| Collections | 30 | 30 |
| Pre-/Post-Hearing Prep | 24 | 24 |
| Simple Texting | 5 | 13 |
| Hearing Prep – Mail Sorting | 5 | 6 |
| Care Team | 4 | 4 |
| Managers Weekly | 1 | 1 |
| Healthcare Team Lead | 1 | 1 |
| Medical Records | 0 | 10 |

**576 of 579** at this point; the last 3 were placed the same day by §10, taking
it to **579 of 579**. Backup:
`reports/backup_hsl_master_dept_2026-08-14T18-42-49-520Z.json`.

### Follow-ups, same day — `scripts/fix-hsl-subdept-followups.mts`

Guard 8's two reports were both real, and both were Sheet-side errors that Kane
ruled on. The fix script addresses every row **by primary key**, re-reads and
requires the expected state before writing, backs up to `reports/` first, and
writes the **Sheet and the DB** — a DB-only fix is re-minted on the next sync.

- **`valeriec@`** — Kane: *"valeriec@ is HSL she is pre hearing litigation in the
  CSV File I referenced for you."* So the SHEET was the wrong side, not the DB.
  Sheet `Lead Gen` → `hsl:ssd_medical_records`, DB likewise.
- **`chariso@` (Orbiso, Charisma)** — Kane: *"is clientVA please."* Two active
  master rows because the **Sheet carries two rows for her** (483 `Lead Gen`, 490
  `Client VA`); deleting the DB row alone would have been re-minted. Sheet 483 is
  set to `Client VA` — a **cell edit, not a row deletion**, so the sync's
  (Personal Email, Department) identity collapses to one and neither row can mint
  a wrong department. Row 483 is now redundant and is HR's tidy-up: deleting a row
  shifts every row beneath it in a live shared document, which is not a script's
  call. The duplicate DB row was deleted per `department-transfers.md` §6.

**Post-fix sweep: 579 of 579 active HSL-family people match between the Sheet and
the DB — zero mismatches, zero missing, zero duplicate active rows.** CJ's 14
Transfers-tab moves of 2026-08-14 were verified untouched: zero overlap with the
bulk write set, and zero of the 106 applied transfers into an `hsl:*` sub-team
ever intersected it.

## 10. HSL — Executive Assistants, and the Wizard-rail trap (2026-08-14)

Kane: *"Lets create a new department called HSL - Executive Assistants and put
them in there please - now I want you to make sure and hardenn that the Payroll
Wizard - Managers will get this please."*

`scripts/seed-hsl-executive-assistants.mts` (`--apply` gated). Placed
`vanessad@` ("Dan Smith EA"), `angelicai@` ("Dan Smith EA- Med Rec") and
`amiea@` ("Rick's Assistant") — the three §9 could not map. **Plain `HSL` now
holds ZERO people: 579 of 579 are sub-labeled.**

### The trap: placement and roster are two different writes

This is the part that is easy to get wrong, and it is what "make sure the
Payroll Wizard - Managers will get this" is actually about.

| Write | Table | Governs |
|---|---|---|
| **Placement** | `global_master_list."Department"` + the Google Sheet | pricing, every picker, transfers, Payment Catalog |
| **KPI roster** | `hsl_team_members.dept_key` | **the Payroll Wizard's HSL rail, and nothing else** |

`PayrollWizard.tsx:14504` maps a row with
`k = hslDeptByEmail[email]; return k && hslKeySet.has(k) ? k : 'unassigned'`,
where `hslKeySet = new Set(HSL_DEPT_KEYS)`. So a person is bucketed **Unassigned**
in the Wizard — and drops out of the manager-facing KPI Bonus Period cards — if
*either*:

- their `hsl_team_members` row is missing or has a NULL `dept_key`, **or**
- their `dept_key` is not in `HSL_DEPT_KEYS`.

Doing the placement write alone leaves them correctly priced and still
Unassigned. The seed script does both, and reports loudly when a person has no
roster row at all.

### Why §7a-roster-only rather than §7b

A §7b placement-only key is **deliberately absent** from `HSL_DEPT_KEYS`, so it
fails the rail's gate by construction (§1.1 — "a display bucket, not a pay
path"). Choosing §7b here would have put all three in Unassigned with no manager
card and no Admin Roles checkbox — the opposite of the request. §7a with
`noKpi: true` + `rules: []` gives the rail entry, the
`hsl:executive_assistants` grant checkbox and a roster-only card, while
Payroll Readiness reads the dept `no_bonus` rather than a permanent weekly
`draft` (`payroll-readiness.ts:591`). No bonus rules were invented.

### What the tests pin

`hsl-subdept.test.ts` gained two, both stating the failure in the message:

- **"the Payroll Wizard HSL rail only recognises HSL_DEPT_KEYS"** — asserts
  `executive_assistants` is in `HSL_DEPT_KEYS`, *and* asserts the converse for
  every placement-only key, so nobody "fixes" a §7b team's Unassigned bucket by
  widening `HSL_DEPT_KEYS` and silently buying a duplicate calculator card plus a
  permanent Readiness draft.
- **"HSL sub-team keys never collide with a retired in-app registry slug"** —
  every `HSL_DEPT_KEYS` entry is placeable only as `hsl:<key>`, and a bare key
  never parses as a placement. This is what keeps `hsl:executive_assistants`
  clear of the retired bare `executive_assistants` registry dept.

### Verified after the run

3 placed (DB + Sheet), 3 roster `dept_key` set NULL→`executive_assistants`, all
three bucket to `executive_assistants` in a rail simulation, Readiness reads
`no_bonus`, zero `department_transfer_requests` rows, and no rate moved — the
team has no base rate row so it rides the parent ₱225, and all three hold
individual catalog rates that outrank it anyway. Backup:
`reports/backup_hsl_executive_assistants_2026-08-14T19-30-30-670Z.json`.

## 11. Cutover: annihilating the parent department (2026-08-14, IN PROGRESS)

Kane: *"the main goal in here is to break Hogan Smith Law from being a general
department into sub departments … and anhiallate the Main Department"*, then
*"lets go and migrate"*.

**What "annihilate" means — and the one thing it cannot mean.** `hogan_smith_law`
is two things wearing one name: (a) a **placement and a base rate**, which is what
dies; and (b) the **family key** every `hsl:*` label collapses into via
`normalizeDeptToKey`, which drives the Mon–Sun HSL week model, the +₱15/h weekend
premium, `isHslFamilyLabel`, and dept-scoped bonus matching. Deleting (b) would
strip the weekend premium from all 579 people. **The department dies; the family
key survives.**

| Step | State |
|---|---|
| 1. People out of the parent | ✅ 579/579 (§9, §10) |
| 2. A base rate per sub-team | ✅ 15 seeded 2026-08-14 |
| 3. HARD HOLD released in both payout engines | ✅ scoped — see below |
| 4. Employee-scope structures re-keyed off the parent | ⛔ blocked, live payroll lock |
| 5. Parent base row deleted | ⛔ blocked, live payroll lock |

### Step 2 — `scripts/seed-hsl-subdept-rates.mts`

One department-scope row per sub-team, figures = each team's **modal effective
rate** (approved by Kane with the per-team evidence). ₱225 Intake · ₱235 Filing ·
₱305 Case Managers · ₱265 SSD Med Rec · ₱235 Attestation · ₱355 EGS · ₱225
Callback · ₱265 Collections · ₱265 Pre-/Post-Hearing · ₱175 Medical Records ·
₱265 Mail Sorting · ₱265 Care · ₱265 Executive Assistants · ₱355 Healthcare TL ·
₱500 Managers Weekly. Simple Texting already had ₱225 and was skipped, not
rewritten. OT = 1.5× (an audit figure for HSL — pay is column AN and OT is a
derived differential).

**Guard 4 is the one that matters:** it counts the people who *actually* resolve
the department base — no individual catalog rate, no sheet rate — for each target
key, and aborts naming them if any exist. It measured **zero**, so the seed
repriced nobody. Two figures were flagged to Kane rather than silently accepted:
**Medical Records ₱175** (all 10 members, but that is the old Lead Gen rate and is
*below* the HSL parent — they transferred in on 2026-08-14 and may simply not have
been repriced) and **Managers Weekly ₱500** (n=1).

### Step 3 — the HARD HOLD release is NARROWER than §8 described

§8 said both engines must "prefer the master label". Measured against live data
first, a blanket flip changed exactly one person — **`carla@`** (master `USEE`,
rates row `Lead Gen`) — from a ₱175 base to **no base at all**, because `USEE` has
no rate row. Broadening the change to fix HSL would have imported that regression
for a population the cutover has nothing to do with.

So `resolveDeptLabelForRate(masterRaw, ratesRaw)` (`resolve-rate.ts`) states the
**actual** defect: prefer the master label **only when it is HSL-family**, which is
exactly the case the HSL rates mirror flattens to `"Hogan Smith Law"`
(`hsl-upload-db.ts`). Everywhere else the rates-row label stays authoritative.
Wired into `current-pay.ts` and `disbursement-reports.ts` — the latter had **no
master-dept map at all**, so its department leg could only ever see the flattened
label; it now builds one alongside `hslEmails`.

Four tests pin it, including the regression that shaped it: *"a NON-HSL master
label never displaces the rates-row label"* names `carla@` and the measurement.

### Steps 4–5 are BLOCKED — and the guard is what caught it

`payroll.dispatch_locked` flipped to **true at 2026-08-14T20:18:46**, one minute
after the seed finished, and `aliviah@` had locked the `2026-08-02_to_2026-08-08`
cycle at 18:32. That is a **live payroll run**. Both remaining scripts refuse to
run while the global flag is true, and neither was forced.

Nothing already applied touches that run: **zero HSL-family people resolve the
department base** (re-verified after the seed), so neither the new sub-team rates
nor the label rule can move a staged amount. The code change is also not deployed.

Remaining when the lock clears:

- **Step 4** `scripts/rekey-hsl-employee-pay-structures.mts` — moves the 522
  employee-scope rows off `hogan_smith_law` (465) and the dead literal `hsl` (57)
  onto each person's sub-team. Pay cannot move: `buildCatalogRateIndex` keys
  employee rows by **email** and never reads `department_key`. It also fixes a live
  bug — the 57 rows keyed to the literal `hsl` match **no** entry in the Pay
  Structure rail or the export's department list, so those individual rates are
  invisible on that screen and **silently dropped from every catalog export**
  (`catalog-export.ts:113`).
- **Step 5** delete the parent `hogan_smith_law` department-scope row. Safe only
  after step 2 (done) — and it must be **last**.
