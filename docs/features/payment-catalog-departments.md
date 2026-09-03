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
cards carry Edit as well, for **managers only** (§7).

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
| Master-list card Edit — managers only (§7) | `src/components/accounting/departments/EditBuiltinManagersDialog.tsx` |

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

## 7. Editing a master-list department — managers only (2026-09-03)

Every **master-list** card carries **Edit** too (Kane, same day: *"make sure
that the from the Master list sync should have it"*). A Sheet-synced
department owns almost nothing in the app — its name and alias map are code
(`DEPARTMENTS`, `normalize-dept-key.ts`), its people come from the Sheet sync
and move only via department transfers, and sub-departments exist only for HSL
as hard-coded `HSL_DEPT_KEYS`. The one in-app fact is **manager access**, so
the dialog edits exactly that: Managers → Review, then the same staged overlay.
Approved as managers-only; the Payment Catalog is thereby a **second write
path for `department_managers`** beside Admin → Roles & permissions — both use
the same `assignManagerDepartment` / `revokeManagerDepartment` helpers.

| Piece | File |
| --- | --- |
| Dialog (Managers step, Review, "what this dialog cannot change") | `src/components/accounting/departments/EditBuiltinManagersDialog.tsx` |
| `validateBuiltinManagersInput`, `diffBuiltinManagers`, `isBuiltinManagersEditable` | `src/lib/departments/registry.ts` (+ `registry-builtin-managers.test.ts`) |
| `PATCH { builtinKey, managers }` branch | `app/api/payment-catalog/departments/route.ts` (`patchBuiltinManagers`) |

Rules:

- **"Current" is every active grant whose raw label normalizes to the key.**
  Admin Roles writes whatever label its picker offered ("Lead Gen", "Lead
  Generation", …), so the dialog's manager list and the server's diff both go
  through `normalizeDeptToKey` — the same way the card's `managersForKey`
  already counted them. **Revoking a manager revokes every raw-label variant**
  that person holds for the key; otherwise a ghost grant under an alias would
  keep lighting their dashboard. New grants are written under the built-in
  display name (`DEPARTMENTS[].name`), which normalizes to the key.
- **HSL has no Edit.** Its grants are per-sub-team access keys (`hsl:<key>`),
  and `normalizeDeptToKey` collapses them to `hogan_smith_law`, so a "remove
  manager" here would silently revoke a manager's sub-team KPI access
  ([hsl-subdepartments.md](./hsl-subdepartments.md)). The card says "Managers
  per sub-team"; the validator refuses the key server-side too
  (`BUILTIN_MANAGERS_EDIT_EXCLUDED_KEYS`).
- **At least one manager stays**, mirrored client (Save gating) and server.
- The dialog lists what it **cannot** change — name, people, sub-departments —
  and why, with a Pay Structure link for rates. Adding a person to a built-in
  department is a transfer, not an edit; do not add a member picker here.
- Audit: `department.managers.update` on `department_managers` with granted /
  revoked / resulting sets.
- Payload discrimination: a PATCH body with a string `builtinKey` is the
  managers edit; anything else is the in-app edit (§6). A registry key is never
  a built-in key (Create refuses the collision), so the two cannot be confused.

## Deploy notes

None. **No SQL migration** — the registry rides `app_settings`, and the only
tables touched (`department_managers`, `payment_catalog_pay_structures`,
`audit_log`) already exist. All six commits are on `main`. Edit (2026-09-03)
adds optional `previousNames` / `updatedBy` / `updatedAt` fields to the
registry blob — the sanitizer tolerates their absence, so nothing to run.
