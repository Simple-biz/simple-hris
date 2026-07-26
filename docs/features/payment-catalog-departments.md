# Payment Catalog — Department tab (in-app departments)

The Accounting → **Payment Catalog** tab (see [bonus-catalog.md](./bonus-catalog.md))
gained a **Department** tab: a directory of every department — the built-in
payroll departments the Google-Sheet master-list sync populates, plus the
**in-app departments** created here — and a **"Create a Department"** wizard
that spins one up end-to-end: name → optional HSL-style sub-departments →
initial people (**at least one Manager required**) → optional department pay
rate, with a **streamed, staged creation animation**.

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
- **Department dropdowns everywhere** (`896f865`) — `GET /api/departments`
  returns active-roster labels **unioned with registry names**, so an in-app
  department is selectable in HR onboarding, Roles & permissions, transfer
  targets, etc. even before any roster row carries its label (best-effort: a
  registry read failure never takes down the roster-derived list).
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

## Deploy notes

None. **No SQL migration** — the registry rides `app_settings`, and the only
tables touched (`department_managers`, `payment_catalog_pay_structures`,
`audit_log`) already exist. All six commits are on `main`.
