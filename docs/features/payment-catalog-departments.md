# Payment Catalog — Department tab (in-app departments)

The Accounting → **Payment Catalog** tab (see [bonus-catalog.md](./bonus-catalog.md))
gained a **Department** tab: a directory of every department — the built-in
payroll departments the Google-Sheet master-list sync populates, plus the
**in-app departments** created here — and a **"Create a Department"** wizard
that spins one up end-to-end: name → optional HSL-style sub-departments →
initial people (**at least one Manager required**) → optional department pay
rate, with a **streamed, staged creation animation**. Since 2026-09-03 every
in-app card also carries **Edit** (§6): rename, restructure sub-departments,
change people — the key never changes and stale saves are refused. Master-list
cards carry Edit as well: **manager access** by grant SCOPE — one list for a
flat department, one per sub-team for HSL — **people**, who move as real
department transfers, and since 2026-09-21 **their own sub-departments** (§7).

Built Jul 24, 2026: `5359889` (tab + wizard), `ec4482f` (self-contained
refactor, same day), `83d81c5` (manager KPI surfaces + bonus assignments),
`896f865` (dashboards + Readiness), `cbdd962` (rate resolution), `7c8e314`
(Payroll Wizard wiring + the Executive Assistants transfer script).

## Key files

| Piece | File |
| --- | --- |
| Department tab UI + wizard + staged animation | `src/components/accounting/DepartmentsTab.tsx` |
| Registry model, slugs, validation, stream protocol (client-safe) | `src/lib/departments/registry.ts` (+ `registry.test.ts`) |
| Registry storage (app_settings JSON) | `src/lib/departments/registry-db.ts` |
| API (GET registry+managers / POST create, ndjson stream) | `app/api/payment-catalog/departments/route.ts` |
| Host tab (fetch, realtime, tab switch, `customDepartments`) | `src/components/accounting/BonusCatalog.tsx` |
| Dept-key resolution slug fallback | `src/lib/payroll/resolve-rate.ts` (`resolveDeptCatalogRate`, + `resolve-rate.test.ts`) |
| Department dropdown union | `app/api/departments/route.ts` |
| Onboarding rate prefill | `src/lib/supabase/department-rates.ts` |
| Readiness integration | `src/lib/payroll/payroll-readiness.ts` |
| Payroll Wizard integration | `src/components/PayrollWizard.tsx` (`customDepartments`, `allWizardDepartments`) |
| One-off EA master-list transfer (Jul 24) | `scripts/transfer-eas-to-executive-assistants.mts` |
| Edit Department dialog (§6) | `src/components/accounting/departments/EditDepartmentDialog.tsx` |
| Shared Create/Edit steps + staged overlay | `src/components/accounting/departments/department-wizard-steps.tsx` · `staged-run.tsx` |
| Master-list card Edit — managers + people (§7) | `src/components/accounting/departments/EditBuiltinManagersDialog.tsx` |

## 1. Storage — an `app_settings` registry, **no migration**

The registry is a single JSON array in `app_settings` under
`payment_catalog.departments.registry`
(`DEPARTMENTS_REGISTRY_SETTING_KEY`) — deliberately **no new table and no SQL
migration**; department creation is rare and single-writer in practice.

Each `DepartmentRegistryEntry` carries:

| Field | Notes |
| --- | --- |
| `key` | Stable slug (`slugifyDeptKey`: "Executive Assistants" → `executive_assistants`). Doubles as the `PayStructure.departmentKey` for the department's catalog rates. Collisions with built-in `DEPARTMENTS` keys/aliases are rejected. |
| `name` | Display name (≤60 chars). |
| `subDepartments` | `{key, name}[]` — HSL-style internal teams (≤24, slug-deduped). |
| `members` | `DepartmentMemberRecord[]` — the department's people, **managers included**. Lower-cased work email is the identity key; optional personal email, sub-department key, informational `startDate`, `addedBy`/`addedAt` attribution. |
| `createdBy` / `createdAt` | Immutable across retries. |

`registry-db.ts` sanitizes every entry on read, **throws** on a failed read
(so a transient DB error is never mistaken for "no custom departments" and
later clobbered by a save), and upserts by `key`. `BonusCatalog.tsx`
subscribes to `postgres_changes` on `app_settings` **filtered to this one
key**, so a teammate's creation shows up live without refetching on unrelated
setting bumps.

## 2. Self-contained by design (2026-07-24 decision)

In-app departments do **NOT** depend on the Global Master List. Their people
live as member records **on the registry entry itself**; creation writes
**nothing** to `global_master_list` / `active_employees` or the master Google
Sheet. The roster prop is used only as an autofill convenience in the people
picker (and for built-in departments' headcounts) — picking a roster person
copies their name/email, "their roster row is not touched".

> History: the original `5359889` POST reused the transfer engine
> (`applyDepartmentTransfer` + Sheet dept write-back) and mirrored HR
> promotion for inserts. `ec4482f` — same day, per Kane's call — stripped all
> of that. The only outward writes now are **`department_managers` oversight
> grants** (keyed on the department's display name, so the department shows on
> the manager's dashboard) and the **department-scoped Payment Catalog pay
> structure** — neither is the master list.

## 3. The Create-a-Department wizard

Four steps (`STEPS = ['Department', 'Sub-departments', 'People', 'Pay & review']`),
each gating **Continue**; `validateCreateDepartmentInput` is mirrored
client-side (button gating) and server-side (the route re-runs it before
writing anything):

1. **Department** — name, with a live collision check against built-in
   departments (name or alias) **and** the registry. Deliberately *not*
   checked against Global Master List department strings.
2. **Sub-departments** — "No, keep it flat" / "Yes, add sub-departments"
   (like HSL's Callback Team / Case Managers / Medical Records). If yes, at
   least one is required.
3. **People** — add from the roster (typeahead) or "Someone new" (name, work
   email, optional personal email, start date defaulting to today in Manila).
   The first person defaults to Manager; each row toggles Manager/Member and
   (when subs exist) picks a sub-department. **At least one person and at
   least one Manager are required** (max 200 initial people).
4. **Pay & review** — optional department-wide starting rate in
   **PHP / USD / COP**, OT auto (1.5× via `defaultOtRate`) or custom; skippable
   ("set it any time in Pay Structure").

### Streamed, staged creation

**Create Department** POSTs to `/api/payment-catalog/departments`, which
**streams one ndjson `CreateDepartmentEvent` per stage** so the overlay's
checklist advances on **real** progress, not a timer:

| Stage | Server work |
| --- | --- |
| `department` — "Creating department" | Registry entry upsert (name + merged sub-departments). |
| `managers` — "Adding managers" | Manager member records merged in + a `department_managers` grant per manager. |
| `members` — "Adding members" | Remaining member records merged in. |
| `rates` — "Setting pay rates" | Department-scoped pay structure upsert (reuses the existing structure's id on retry). |

Stage order + labels live in `CREATE_DEPARTMENT_STAGES` (shared, so the
overlay and the route can't drift). The client reveals queued events one at a
time (150 ms first, 420 ms after; reduced motion drops the pacing) so the
checkmarks read as steps even when the server finishes fast. Mid-creation the
modal cannot be dismissed; a dropped connection or stage failure shows the
failing stage with **Try again** — **every step is idempotent** (registry
upserts by key, member merge keys on work email, grants no-op, rate reuses its
id), so retrying is safe. Success fires an `insertAuditLog`
(`department.create`, best-effort) and offers "Open pay structure" focused on
the new key.

**Access:** GET shares the Pay Structures read gate
(`requireRateVisibilitySession`); POST requires
`requireFeatureEdit('accounting', 'bonus_catalog')` — the same feature that
governs the whole Payment Catalog tab
([rbac-feature-permissions.md](./rbac-feature-permissions.md)).

## 4. Where in-app departments surface

The connective tissue is `resolveDeptKeyWithRegistry(raw, registry)`
(`registry.ts`): built-in alias map first, then registry name-or-slug match —
same null-for-unknown contract as `normalizeDeptToKey`.

- **Payment Catalog itself** — `customDepartments` (registry minus any
  built-in-colliding key) feeds the Pay Structure tab rail + exports, the
  Overview, and the **Bonus Assignments** tab (`83d81c5`): the dept rail /
  mobile select list in-app departments so library bonuses can be assigned to
  them; the assignment roster falls back to an exact department-label match
  (custom keys have no alias-map entry). `overview-metrics.ts` humanizes
  unknown slugs back to display names.
- **Manager KPI surfaces** (`83d81c5`) — a managed in-app department renders
  as a **catalog-driven card** in `DeptBonusCalculator`: grant strings that
  miss the alias map (and aren't `hsl:*` access keys) resolve to their slug
  (`customManagedKeys`), the roster groups under that slug, catalog bonuses
  assigned under it are appliable, and **Mark Ready feeds the same status
  table Readiness reads**. `ManagerApp`'s "no departments assigned" gate and
  `ManagerBonusHistory` recognize them too.

  > **Exception (2026-08-10):** a slug listed in
  > `KPI_CALCULATOR_RETIRED_DEPT_KEYS` gets **no card**, even when it is a real
  > registry department — `executive_assistants` is one of the eleven retired
  > keys. All three sites that walk the grant-slug path
  > (`customManagedKeys`, `use-bonus-scoring-queue`, `ManagerApp`) funnel
  > through `isKpiCalculatorDeptKey`, so they cannot drift. The department
  > itself, its members, its pay structure and its manager grants are
  > unaffected — only the calculator card is gone. See
  > [bonus-catalog.md §3.1](./bonus-catalog.md).
- **Department dropdowns everywhere** (`896f865`) — `GET /api/departments`
  returns active-roster labels **unioned with registry names**, so an in-app
  department is selectable in HR onboarding, Roles & permissions, transfer
  targets, etc. even before any roster row carries its label (best-effort: a
  registry read failure never takes down the roster-derived list).
- **System-bonus eligibility** (2026-08-11) — PAB and Technology Bonus carry an
  explicit `department_keys` allowlist seeded with the built-in `DEPARTMENTS`
  keys only, so an in-app department is **not** eligible by design. Getting that
  right depends entirely on which resolver a surface uses, because
  `isDeptEligible` **fail-opens when the key is `null`** (deliberate — an
  unmapped or mistyped department string must not silently lose a bonus
  everyone else gets, `system-bonus.ts:194-206`). A surface using
  `normalizeDeptToKey` alone therefore resolved every custom department to
  `null` and fell straight through that fail-open, reading them as **eligible**.
  Four surfaces did: `current-pay.ts`, `member-monthly-pay.ts`, `Overview.tsx`
  (PAB accrual counts + calendar) and `EmployeeDashboard.tsx`. The first is the
  one Payment Dispatch falls back to when a week is dispatched **before** the
  wizard locks it, so that was a live overpay path, not just a display bug —
  the Payroll Wizard itself always resolved through the registry, so its
  published pay was correct and the two disagreed.

  All but the employee dashboard now resolve with `resolveDeptKeyWithRegistry`.
  **`isDeptEligible`'s fail-open is deliberately untouched** — the fix is to
  stop producing a spurious `null`, not to change what `null` means. Every
  registry read on these paths is best-effort (`.catch(() => null)`, then
  `?? []`), matching `payroll-readiness.ts` and `/api/departments`: a failed
  read degrades to the built-in-only behaviour that shipped before, never to
  something worse. `Overview.tsx` gets the registry from
  `prefetchAccountingData` (`src/lib/accounting/prefetch.ts`) rather than
  fetching it, because the registry endpoint is gated by
  `requireRateVisibilitySession`.

  > **Still open — `EmployeeDashboard.tsx`.** The employee's own "My Hours"
  > view still resolves built-in-only, so a custom-department employee sees
  > PAB/Tech they will not be paid. Employees do **not** hold
  > `requireRateVisibilitySession`, so it cannot simply fetch the registry; it
  > needs the eligibility decided server-side and shipped on a payload the
  > employee may read. Display-only — no money moves on this path.

- **Rate resolution** (`cbdd962`) — `resolveDeptCatalogRate` accepts a raw
  name, a canonical key, **or the label's slug**: when the built-in alias map
  misses, it tries `slugifyDeptKey(deptRaw)` against the catalog index. So a
  custom department's base rate resolves for Readiness / People / live
  dispatch exactly like a built-in one. Onboarding's rate prefill
  (`department-rates.ts`) maps custom structure keys back to the registry
  display name so the modal finds them.
- **Payroll Wizard** (`7c8e314`, Jul 24) — the wizard fetches the registry
  once on mount into `customDepartments`; `allWizardDepartments` adds every
  registry entry (plus derived master-list slugs) to the built-in list, so a
  catalog-created department gets its **own Additions tab** and every
  dept-name lookup resolves against it. Dept resolution
  (`resolveDeptKeyWithRegistry`) runs at all three grouping sites, so its
  people's Hubstaff rows land under the department's bucket **and get paid**
  instead of falling into the unassigned pile; master-roster members without
  Hubstaff hours show on the tab's read-only roster card. The step-1
  Configuration tab's per-department **Pay this week / Overtime** switches
  cover custom keys too (see
  [payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md)),
  and the Notes board's worker picker honors a paused custom department
  (`payroll-wizard-notes.ts`). Jul 24 example: **"Executive Assistants"**
  (manager `jamec@simple.biz`, members `cjm@simple.biz` + `ellyt@simple.biz`),
  whose people were then **hard-transferred into it on the master list** by
  `scripts/transfer-eas-to-executive-assistants.mts` (dry-run by default,
  `--apply` to write; also flips the master Sheet cell so the next sync
  doesn't resurrect the old label) — a deliberate one-off *outside* the
  feature, precisely because the feature itself never touches the roster.
- **Readiness** (`896f865`; see [payroll-readiness.md](./payroll-readiness.md)) —
  the KPI list includes every registry department (source `'custom'`,
  "In-app" chip): auto-**Ready** (`no_bonus`) when no catalog bonus targets
  its slug this week, normal draft/applied logic when one does, `excluded`
  when pay-paused. A registry read failure is reported via `degraded[]`
  rather than silently dropping them. For the **missing-rates** check, workers
  resolve through `resolvePeopleRate` (individual catalog → sheet → dept
  base), and thanks to the `cbdd962` slug fallback **a member of an in-app
  department with a Payment Catalog flat rate counts as having a rate** — they
  never appear in the no-rate list.

## 5. Known gaps

- **Registry members are not a people source for pay surfaces.** The Payroll
  Wizard reads registry *keys/names* only — the people it pays still come from
  the week's Hubstaff CSV + the master roster (`entry.members` is never read
  there). Likewise the manager KPI calculator and Bonus Assignments rosters
  group **master-roster people by department label/slug**, not registry member
  records. So a registry-only person (added via "Someone new", never placed on
  the master list or a Hubstaff upload) shows on the Department tab card but
  not in those rosters — the EA hard-transfer script above exists exactly to
  close that gap for real hires.
- **Missing-bank readiness** iterates `active_employees`, so a registry-only
  member is invisible to the bank check too.
- **Sub-departments on a built-in are no longer HSL-only** (§7.4); HSL's 16 code teams stay pinned because they carry KPI calculators, and data teams can be added beside them.
- The Department tab's own footnote sets the expectation: built-in KPI
  calculators with bespoke inputs (`DEPT_INPUT_CONFIG`) remain per-department
  code; a custom department gets the generic catalog-driven card, not a
  bespoke calculator.


## 6. Editing a department (2026-09-03)

Every **In-app** card carries **Edit** (built-in master-list cards do not — their
shape comes from the Sheet sync). It opens the Create shell prefilled:
Department → Sub-departments → People → **Review**, then the same staged
overlay, fed by **`PATCH /api/payment-catalog/departments`** (same
`requireFeatureEdit('accounting', 'bonus_catalog')` gate as POST). Approved by
Kane 2026-09-03: rename allowed behind a warning layer; removing a
sub-department deletes its own base-rate row; existing sub-department rates
stay read-only here.

| Piece | File |
| --- | --- |
| Edit dialog (steps, Review diff, rename warning layer) | `src/components/accounting/departments/EditDepartmentDialog.tsx` |
| Shared steps — Create and Edit render the SAME controls | `src/components/accounting/departments/department-wizard-steps.tsx` |
| Shared ndjson consumer + staged overlay | `src/components/accounting/departments/staged-run.tsx` |
| Edit input, validator, `diffDepartmentEdit`, `applyDepartmentEdit`, rename helpers | `src/lib/departments/registry.ts` (+ `registry-edit.test.ts`) |
| Revision read + compare-and-swap replace | `src/lib/departments/registry-db.ts` |
| Alias-aware rate index | `src/lib/payroll/resolve-rate.ts` (+ `resolve-rate-aliases.test.ts`) |
| Rail aliases | `src/lib/payment-catalog/dept-rail.ts` (+ `dept-rail-aliases.test.ts`) |

### 6.1 The key never changes — a rename is an alias

The registry `key` is the slug of the **original** name, and it is load-bearing
three ways: it is `PayStructure.departmentKey`, it prefixes every `<key>:<sub>`
rate row, and three live paths reach it by **slugging a raw label** —
`resolveDeptCatalogRate`'s fallback (`resolve-rate.ts`), the manager KPI card's
`customManagedKeys` (`DeptBonusCalculator.tsx`) and Readiness. Re-keying on
rename would mean migrating rate rows, bonus assignments and grants; instead:

- `applyDepartmentEdit` keeps `key`, sets `name`, and appends the old name to
  **`previousNames`** (renaming back to a former name removes it from the list).
- **Every registry resolver honours former names**: `deptEntryLabels(entry)` is
  "current + former", and `resolveDeptKeyWithRegistry` / `rawDeptMatchesEntry`
  match any of them by label or slug. So the Payroll Wizard, current-pay,
  Readiness, Overview and Notes all keep grouping a cell that still says the old
  name — and a cell that says the new one.
- **The catalog rate index takes the registry**:
  `buildCatalogRateIndex(structures, registry)` files
  `deptKeyAliasSlugs(registry)` (slug → key for every label whose slug is not the
  key) in `index.aliasKeys`, and the resolver consults it after the plain slug
  miss. Without it a master cell carrying the NEW name resolves **no department
  base** — the person is silently paid the sheet rate or nothing. All nine
  index builders pass the registry (current-pay, member-monthly-pay, the three
  in PayrollWizard, disbursement-reports, people-roster, accounting-transfers,
  `/api/employee-hourly-rates`); the four that had no registry load it
  best-effort (`.catch(() => [])`), matching every other registry read.
  A label that would slug to a **built-in** key is never filed as an alias.
- **The Pay Structure rail carries `aliases`** on the parent entry
  (`BonusCatalog.customDepartments` passes `previousNames`), and
  `deptCellMatchesEntry` matches them, so old-label and new-label people home on
  the same entry.
- **The `department_managers` grant stays on the ORIGINAL label.**
  `managerGrantLabel(entry)` returns the label whose slug equals the key; the
  PATCH route writes and revokes grants under it, for existing AND newly added
  managers. Manager surfaces have no registry — they slug the grant string — so a
  grant under the new name would silently drop the manager's KPI card.
  **Known limitation, said in the warning layer:** managers therefore keep
  seeing the original label on their dashboard until engineering re-keys the
  grant path. A grant assigned later from Admin Roles under the NEW name (which
  `/api/departments` offers) will not slug to the key and yields no card — the
  fix is the same re-key, not a second grant convention.
- The Edit dialog **refuses** a rename to a built-in name, to another registry
  department's current or former name, or to a name whose slug is a built-in
  key. Create likewise now refuses a name that is another department's former
  name (`existingNames` includes `previousNames`).
- The rename runs only after the **`RenameWarning`** layer is confirmed; "Keep
  the old name" reverts the field. The layer says exactly what moves and what
  does not, including the manager-dashboard limitation above.

### 6.2 Sub-departments

- An existing sub-department's **key is pinned** (`EditSubDepartment.key`);
  renaming it changes the label only, so its `<key>:<sub>` rate row and every
  member's placement stay attached. The rail/export label re-derives from the
  new name via `buildCatalogDeptNameMap`.
- A **new** sub-department may carry an initial base rate, exactly as in Create.
  An **existing** one's rate is **read-only** in the dialog (shown with a "Pay
  structure" link): Pay Structure remains the ONE write path for a live rate
  ([[pay-structure-department-members]]). The validator refuses a
  `payStructure` on an existing key.
- **Removing** a sub-department is refused while any member still points at it
  (the People step names them). Once it goes, the route **deletes its own
  dept-scope `<key>:<sub>` structure** so no orphaned row lingers (Kane,
  2026-09-03). Employee-scope rows filed under that key are untouched (they
  re-home by placement — `bonus-catalog.md` §5.5) and rate history is never
  written: dept-scope saves never call `syncRateHistory`.
- Removing a sub and re-adding a new one under the same slug counts as removed
  AND added: the old rate row is deleted, then the new one (if any) written.
- A **flat department that gains sub-departments keeps its department-wide
  rate**. Create refuses that combination (§3); an edit cannot, because deleting
  a live base rate as a side effect of restructuring would be a rate change
  nobody asked for. The row stays as the fallback for unpriced subs and the
  Review step + success screen say so, pointing at Pay Structure.

### 6.3 People

Same rules as Create, shared in `memberListError`: at least one person, **at
least one Manager**, unique valid work emails, sub-department picks that exist
in the resulting set. `diffDepartmentEdit` computes `managersGranted` /
`managersRevoked` (added-as-manager or promoted; removed-while-manager or
demoted) and the route diffs grants accordingly. Kept members keep their
original `addedBy` / `addedAt`; new ones are attributed to the editor.

### 6.4 Stale edits are refused, never merged

GET returns the registry **`revision`** (`app_settings.updated_at`). The dialog
hands it back as `expectedRevision`; the route answers **409** when it differs,
and the stage-1 write itself is `replaceDepartmentRegistryEntry` →
`casUpdateAppSetting`, so two accountants editing at once cannot silently
overwrite each other — the loser's overlay offers **Reload and start over**
(refetch + close) instead of a retry that would fail the same way. The whole
entry (name, sub-departments, members) lands in that ONE write, so there is no
separate members stage: `EDIT_DEPARTMENT_STAGES` = Saving changes → Updating
manager access → Updating base rates.

### 6.5 Audit

Success writes `department.update` to `audit_log` (best-effort) with the diff,
the grant label used, and the rate rows set / deleted.

**Verification (2026-09-03):** typecheck clean, 78 node tests green across the
registry, edit, rate-alias and rail-alias suites. Not browser-verified in the
building session (no signed-in browser); the dev server compiled both the GET
and the PATCH route.

## 7. Editing a master-list department — managers, people and sub-departments (2026-09-03, extended 2026-09-21)

Every **master-list** card carries **Edit** too (Kane, 2026-09-03: *"make sure
that the from the Master list sync should have it"*). A Sheet-synced
department owns almost nothing in the app — its name and alias map are code
(`DEPARTMENTS`, `normalize-dept-key.ts`), and its people come from the Sheet
sync. The dialog edits the three things the app can legitimately change:
**manager access** (§7.1), **its sub-departments** (§7.4) and **who is placed
there** (§7.3, as a real department transfer). Managers → Sub-departments →
People → Review, then the same staged overlay. The Payment Catalog is
thereby a **second write path for `department_managers`** beside Admin →
Roles & permissions — both use the same `assignManagerDepartment` /
`revokeManagerDepartment` helpers.

**HSL is included since 2026-09-21** (Kane: *"LET US MAKE SURE THAT THE
DEPARTMENT CREATED FROM THE MASTER LIST CAN BE EDITED THE SAME WAY THE ONES
CREATED FROM THE APP"*). It is included because the editor stopped collapsing
its grants, not because the old objection went away — see §7.1.

| Piece | File |
| --- | --- |
| Dialog (scoped Managers step, Review, "what this dialog cannot change") | `src/components/accounting/departments/EditBuiltinManagersDialog.tsx` |
| `builtinManagerScopes`, `partitionBuiltinGrants`, `validateBuiltinManagersInput`, `diffBuiltinManagerScopes` | `src/lib/departments/registry.ts` (+ `registry-builtin-managers.test.ts`) |
| `PATCH { builtinKey, scopes }` branch | `app/api/payment-catalog/departments/route.ts` (`patchBuiltinManagers`) |
| Read-only grant-shape audit | `scripts/audit-department-manager-grants.mts` |
| People step — direct transfer orchestrator | `src/lib/transfers/direct-transfer.ts` |
| `classifyBuiltinPersonMove`, `validateBuiltinPeopleInput`, `diffBuiltinPeople` | `src/lib/departments/registry.ts` (+ `registry-builtin-people.test.ts`) |

### 7.1 A grant SCOPE, not a department

Manager access is a raw `department_managers.department` **string**, and "which
strings belong to this department" turned out to be two different questions.
`builtinManagerScopes(key)` answers both:

- **A flat built-in has ONE scope**, its `DEPARTMENTS[].name`. Admin Roles
  writes whatever label its picker offered ("Lead Gen", "Lead Generation", …),
  so the scope claims **every raw variant that `normalizeDeptToKey`s to the
  key** and a revoke still clears them all — otherwise a ghost grant under an
  alias would keep lighting the manager's dashboard. Unchanged since
  2026-09-03; these cards look and behave exactly as they did.
- **HSL has one scope PER SUB-TEAM** (`hsl:<key>`, both keyspaces — the
  KPI-scoring `HSL_DEPT_KEYS` and the placement-only ones). Its raw grant
  string *is* the sub-team access key, and `normalizeDeptToKey` collapses all
  of them to `hogan_smith_law`. Measured live 2026-09-21
  (`scripts/audit-department-manager-grants.mts`): **113 HSL-family grant rows
  across 14 sub-team labels**. One collapsed list would have merged those 14
  into a single ~15-person roster where removing anybody revoked them from
  **every** team at once. That is the whole reason HSL had no Edit before, and
  scoping is what retired the exclusion rather than waiving it.

**A scope owns only the labels it claims.** Anything else that normalizes to the
department is **unscoped**: shown read-only in Review, never granted, never
revoked. Live today that is exactly two labels — `"HSL"` (9 managers) and
`"Hogan Smith Law"` (2) — which the sub-team lists must not be allowed to
swallow. Change those in Admin → Roles & permissions.

### 7.2 Rules

- **"Current" per scope.** A flat scope matches by `normalizeDeptToKey`; an HSL
  scope matches the **exact** raw label. `partitionBuiltinGrants` is shared by
  the dialog and the route, so client and server cannot disagree about which
  grant belongs to which list.
- **Revokes are written inside their scope.** For a flat department that is
  still every raw-label variant the person holds for the key. For HSL it is
  only that sub-team's spelling, so removing someone from Intake leaves Filing
  untouched — pinned by `registry-builtin-managers.test.ts`.
- **At least one manager stays on the DEPARTMENT**, mirrored client (Save
  gating) and server. Deliberately *department*-level, not per sub-team: plenty
  of HSL teams have no manager today and a per-team requirement would refuse
  every save. A sub-team going from some managers to **none** is named in
  Review and in the save's warnings, because an unmanaged sub-team has no KPI
  card and its sheet goes unscored.
- **The client cannot invent a scope.** The validator refuses a payload whose
  grant-label set is not exactly `builtinManagerScopes(builtinKey)` — no
  extras, no omissions, no duplicates.
- **Every live `hsl:*` label must have a scope.** A sub-team label with no scope
  falls into `unscoped` and becomes invisible *and* uneditable, which is how a
  manager quietly loses a team. The 14 labels measured live are pinned in the
  test suite; retiring a key from `HSL_DEPT_KEYS` while grants still point at it
  fires it.
- The dialog lists what it **cannot** change — the name, and (for HSL) the 16
  code teams, which are pinned — and why, with a Pay Structure link for rates.
- Audit: `department.managers.update` on `department_managers` with the granted /
  revoked / resulting sets **per scope**, plus the unscoped labels left alone.
- Payload discrimination: a PATCH body with a string `builtinKey` is the
  managers edit; anything else is the in-app edit (§6). A registry key is never
  a built-in key (Create refuses the collision), so the two cannot be confused.

**Verification (2026-09-21):** typecheck clean; 11 tests green in
`registry-builtin-managers.test.ts` (including the live-label coverage guard and
the per-sub-team revoke isolation); 71 of 72 green across
`src/lib/departments/*.test.ts` — the one failure,
`dept-label-render.test.ts` naming `ManagerApp.tsx:1859`, is **pre-existing on
`main`** in a file this change never touched. Not browser-verified.

### 7.3 People — a real transfer, never a member record (2026-09-21)

Kane ruled the master-list card's **People** step must write. It writes a
**department transfer** and nothing else:

1. `global_master_list` via `applyDepartmentTransfer` (authoritative; a failure
   here is fatal and stops before anything else is touched),
2. the master Google Sheet via `updateMasterSheetDepartment` (best-effort),
3. a `department_transfer_requests` row marked **`applied`**, carrying the
   Sheet outcome.

`src/lib/transfers/direct-transfer.ts` (`applyDirectDepartmentMove`) is the one
orchestrator; the route's `members` stage calls it per person.

**Why not a member record.** §5 already says registry members are not a people
source for pay surfaces: someone "added" that way appears on the card, is paid
nothing, and is invisible to the missing-bank readiness check. A built-in
department's people **are** the roster, so moving one is a transfer or it is
nothing.

**Why a transfer ROW and not just the two writes.**
[[hris-is-dept-source-of-truth]] (Kane, 2026-08-21) makes the DB authoritative
over the Sheet, and names the `applied` row as *"the strongest evidence of the
DB's value being deliberate"*. A move that skipped the row would be
indistinguishable from drift the next time anyone reconciles. The row is also
where `sheet_synced` / `sheet_sync_error` live, which is what drives
Accounting's **Retry** badge — and the paystub's mid-week transfer disclosure
and the HSL weekend-premium map are both built from this table.

Rules:

- **A bare family label is refused.** `isPlaceableDeptLabel` gates every
  destination, mirrored client and server, so an HSL arrival must name a
  sub-team. Accepting `"HSL"` would place someone on a parent base rate that
  **was deleted** in the 2026-08-14 cutover, so they would resolve no
  department base at all ([[hsl-parent-department-cutover]]). The tab's
  `departmentOptions` therefore omits the bare HSL label entirely.
- **A move must touch this department on one side.**
  `classifyBuiltinPersonMove` returns `in` / `out` / `within` / `unrelated`,
  and `unrelated` is refused — this dialog is not a general-purpose transfer
  tool.
- **`within` is legal and is the point for HSL.** A sub-team reshuffle stays in
  the family, and `buildHslTransferEffectiveMap` skips rows whose
  `from_department` is already HSL-family, so it does **not** reset a
  long-tenured person's +₱15/h weekend-premium day-scoping. A move in from
  outside HSL correctly does set it. Do not change the from/to labels written
  by `applyDirectDepartmentMove` without re-reading that filter.
- **Removing somebody needs a destination.** There is no "no department" to
  drop a person into, so the UI asks where they go. For a flat department the
  picker deliberately offers **no** same-department option: the person's cell
  may hold an alias spelling ("Lead Generation" vs "Lead Gen") which would slip
  past the literal from-equals-to check and write a pointless relabel.
- **A per-person failure is collected, never thrown.** One bad row must not
  abandon the moves that already landed, so the stage reports
  `moved` / `notOnRoster` / `sheetUnsynced` / `failed` and the success screen
  warns on each. **A Sheet write that did not land is surfaced, never
  swallowed**: the only two outcomes that mean the Sheet is correct are "a cell
  was flipped" and "an email-matched row already reads the target". Anything
  else and the next master sync can snap the person back.
- **Not on the active roster** is reported, not treated as success — nothing
  moved and no transfer row is written.
- Audit `department.managers.update` now also carries `people_moved`,
  `people_sheet_unsynced`, `people_not_on_roster`, `people_failed` and the full
  move list with its `kind`.

**Verification (2026-09-21):** typecheck clean; 7 green in
`registry-builtin-people.test.ts`; **78 of 79** across
`src/lib/departments/*.test.ts` — the one failure is the pre-existing
`ManagerApp.tsx:1859` raw dept render (item 96 / item 131), untouched here.
**Not browser-verified, and no move has been executed against production**: the
write path is typed and unit-tested but has never run end to end, so the first
real move should be a single low-stakes person with the Sheet checked by eye.

### 7.4 Sub-departments on a built-in department (2026-09-21)

Kane: *"I want us to make sure that if we edit these departments we can add sub
departments in it!"* Until now only HSL had sub-teams, hard-coded. They are now
**data** for every other built-in, stored as one JSON object in `app_settings`
under `payment_catalog.departments.builtin_subs` — no new table, no migration,
exactly like the in-app registry.

| Piece | File |
| --- | --- |
| Model, validation, diff, occupancy (client-safe) | `src/lib/departments/builtin-subs.ts` (+ `builtin-subs.test.ts`) |
| Storage — sanitize on read, CAS on write | `src/lib/departments/builtin-subs-db.ts` |
| Sub-departments step | `src/components/accounting/departments/EditBuiltinManagersDialog.tsx` |
| Rail / options seam | `src/components/accounting/BonusCatalog.tsx` (`customDepartments`) |
| Read-only namespaced-cell audit | `scripts/audit-namespaced-dept-cells.mts` |

**Key convention: `<builtinKey>:<subKey>`** (`lead_gen:nurture`) — the same
namespacing `subDeptStructureKey` already uses for in-app departments. **Two
legs needed no change at all**: `parentOfDeptKey` nests any
`<parentKey>:<subKey>` whose parent is on the rail, and
`resolveDeptCatalogRate` resolves any namespaced key *before*
`normalizeDeptToKey` collapses it. HSL keeps `hsl:<sub>` because its prefix is
not its key, which is why that one stays special-cased.

#### HSL: code teams pinned, data teams allowed (2026-09-21, second pass)

The first pass excluded HSL outright. Kane, on seeing the lock in the running
app: *"Why cant I edit HSL? ?? LET US REFACTOR this for HSL if needed"* — so
HSL is in, with one exception to the convention and one boundary:

- **Its data sub-teams are labelled `hsl:<subKey>`, never
  `hogan_smith_law:<subKey>`** (`builtinSubLabel`). `normalizeDeptToKey`'s
  `hsl:` branch is what keeps a cell inside the HSL family — the Mon–Sun week
  model, the +₱15/h weekend premium and dept-scoped bonus matching all hang off
  it (hsl-subdepartments.md §11). The generic form would drop the person out of
  HSL. Rate rows and the occupancy count use the same `hsl:` prefix, so the
  three keyspaces stay one.
- **The 16 code teams are pinned** (`pinnedSubDepartments`): shown locked in
  the step with their headcounts, never renamed or removed here, because 14 of
  them carry a KPI calculator and a Payroll Readiness row. A data key that
  shadows one is refused; so is `lead_nurture`, retired 2026-08-13
  ([[hsl-placement-only-subteams]]) — the test that pins it absent from code
  now also pins it absent from data.
- **A data HSL team has no KPI calculator of its own.** It is exactly what
  Simple Texting already is: placeable, priceable, transferable, and scored
  either under another team's calculator or not at all. The step says so. If a
  data team should later be *scored* under an existing calculator (the
  `scoredUnder` pattern), that is a follow-up in `hsl-subdept.ts`, not a
  dialog change.
- **A data HSL team is a manager scope of its own** (`hsl:<sub>`, §7.1), built
  from the **prospective** map so a team added on the Sub-departments step can
  be given a manager on the Managers step by going back. The dialog seeds its
  manager lists from the *stored* map rather than from `subs` state — that
  state is `[]` until the seed effect sets it, and seeding from it would have
  left every data team's list empty and a save would have revoked them.
- `isPlaceableDeptLabel`'s HSL-family branch consults the map: a code team is
  always placeable, a data team is placeable when the map holds it, a bare
  `HSL` still never is. `formatDeptLabel` humanises any `hsl:*` key not in code
  (`hsl:spanish_intake` → "HSL — Spanish Intake"); two assertions in
  `hsl-subdept.test.ts` that pinned the old slug display were re-pinned to the
  new one, with the retirement guards untouched.

**Known gap, deliberately not widened into:** the manager Transfer dialog and
the HR onboarding sub-team picker read `hslSubDeptOptions()` with no map, so a
data HSL team is a destination from the Catalog's People step immediately and
from those two surfaces only once they load the map. Both are manager/HR
surfaces with their own governing docs.

#### What changed in the shared department functions

Both are load-bearing far beyond this feature, so both were widened as narrowly
as possible and pinned by tests.

- **`normalizeDeptToKey`** gained a namespaced branch: `<parent>:<sub>` resolves
  to the parent when the prefix is a known label **or** a canonical key.
  An **unknown** prefix still returns `null`, and a bare sub-team display name
  is still **not** inferred — the rule that keeps "Callback Team" and
  "Executive Assistants" out of the HSL cohort is untouched.
  **Measured read-only before shipping** (`scripts/audit-namespaced-dept-cells.mts`):
  across **2,833 `global_master_list` rows, 1,215 `active_employees` and 22,610
  `employee_hourly_rates`**, every colon-bearing Department cell is `hsl:*` —
  **zero non-HSL**. So the branch regroups nobody and moves no money.
- **`isPlaceableDeptLabel(raw, subsByParent?)`** takes an optional sub index.
  **Called with nothing it behaves exactly as before**, so every existing caller
  is unchanged. With one, a department that *has* sub-teams stops accepting a
  bare parent placement — the same rule HSL has had since its cutover, because
  the sub-team is what carries the base rate. It gates **new writes only, never
  reads**: everyone already sitting on a bare `Lead Gen` cell is untouched.
- **`formatDeptLabel`** renders any namespaced cell as "Parent — Sub" instead of
  a bare slug. The sub is humanised from its key, because the stored display
  name lives in `app_settings` and this function is pure.

> **Trap worth knowing.** `normalizeDeptToKey`'s alias map is keyed on *display
> labels* (`"lead gen"`), so the canonical key `"lead_gen"` does **not** resolve
> on its own. Normalize the **whole** namespaced label, never the prefix you
> split off it — doing the latter is a bug the tests caught during this build.

#### Rules

- **An existing sub's key is pinned.** Renaming changes the label only, so its
  `<parent>:<sub>` rate row and every master cell pointing at it stay attached —
  `diffBuiltinSubs` reports a rename as a rename, never a remove-plus-add,
  which would orphan the rate row.
- **A sub-key may not contain a colon.** `parentOfDeptKey` splits at the FIRST
  colon, so `<parent>:<a>:<b>` would make the rail and the rate row disagree
  about who the parent is. Refused in the validator and in the storage
  sanitizer.
- **A populated sub cannot be removed.** Counted against the **live**
  `global_master_list`, not the payload, so a stale dialog cannot talk its way
  past it. The count **fails closed**: anything that is not a real number —
  including `count: null` with no error, which is what a `head: true` query
  returns for a missing table ([[postgrest-head-true-hides-missing-table]]) —
  reads as occupied. `?? 0` there would be a silent fail-open that deletes a
  sub-department out from under its people.
- **A removed sub's own dept-scope rate row is deleted** in the same save, so no
  orphan `<key>:<sub>` structure lingers (same rule as §6.2).
- **Sub-departments are written BEFORE people** in the same save, so a sub added
  and staffed in one go works: the People step validates against the
  **prospective** map (`placeableSubIndex({...stored, [key]: next})`), not the
  stored one.
- **Saves are CAS'd** on the sub map's own `app_settings` revision — 409, never
  merge, like the registry. A failed GET leaves the map *and* its revision
  untouched rather than nulling the revision, which would turn the next save
  into a silent overwrite.
- **A department that gains sub-teams drops out of the placement picker** in
  favour of its teams, because a bare placement is no longer valid for it.
- **A sub-team CAN be a bonus target** *(2026-09-21, later the same day)*. Its
  people still inherit the parent's bonuses (PAB/Tech, department-scoped
  library bonuses, the parent's KPI card — all via the `normalizeDeptToKey`
  collapse), **and** a library bonus assigned to `lead_gen:nurture` now reaches
  only the members whose cell is that sub-team, scored on the Lead Gen card.
  Resolver + rules: `bonus-catalog.md` "Sub-team-targeted assignments"
  (`src/lib/bonus-catalog/assignment-scope.ts`). Exceptions that stay: HSL
  sub-teams (dead target — HSL bonuses are code) and System Bonuses (PAB/Tech
  eligibility is parent-keyed).
- **Review shows the sub-department diff** — added / renamed / removed, with the
  `<key>:<sub>` a new one will be placed under, and a warning the first time a
  flat department gains teams (new people must then be placed in one; everyone
  already there is untouched). The Review empty state and the success line both
  count sub-department edits: a subs-only save previously read
  *"Nothing has changed yet"* next to an enabled **Save changes**, and then
  reported *"No change."* — caught while verifying, not in the browser.

**Verification (2026-09-21, after the HSL pass):** typecheck clean; 14 green in
`builtin-subs.test.ts` (4 HSL-specific), 12 in `registry-builtin-managers.test.ts` — including the same-save "add a sub then staff it"
composition and the bare-placement refusal; **4,087 of 4,089** across `src/lib` — the two failures are the pre-existing
`ManagerApp.tsx:1859` pair (item 96).
**Not browser-verified, and no sub-department has been created against
production.** The migration-free storage means there is nothing to run, but the
first real sub should be made on a low-stakes department and its Pay Structure
rail entry checked by eye.

## Deploy notes

None. **No SQL migration** — including the 2026-09-21 built-in sub-departments,
which ride a second `app_settings` key (`payment_catalog.departments.builtin_subs`);
an absent key reads as "no sub-departments" and needs no seeding.
Historic note: **no SQL migration** — the registry rides `app_settings`, and the only
tables touched (`department_managers`, `payment_catalog_pay_structures`,
`audit_log`) already exist. All six commits are on `main`. Edit (2026-09-03)
adds optional `previousNames` / `updatedBy` / `updatedAt` fields to the
registry blob — the sanitizer tolerates their absence, so nothing to run.
