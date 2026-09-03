# Edit Department — Payment Catalog → Departments

**Date:** 2026-09-03 · **Approved:** Kane, same day (Q1: rename allowed, behind an animated
warning modal; Q2: removing a sub-department deletes its own base-rate row in the same save;
Q3: existing sub-department rates are read-only here — Pay Structure stays the one write path).

Every "In-app" card on Accounting → Payment Catalog → Departments gets an **Edit** button that
opens the same modal shell as Create a Department, prefilled: rename, add / rename / remove
sub-departments (new ones may carry an initial base rate), add / remove people, toggle
Manager, reassign sub-departments, then a Review step and the same staged progress overlay.

Precedent: `CreateDepartmentWizard` + `POST /api/payment-catalog/departments` (ndjson
stages). Governing doc: `docs/features/payment-catalog-departments.md`.

## The rename rule

The registry `key` is the slug of the ORIGINAL name and it never changes — it is the
`PayStructure.departmentKey`, the prefix of every `<key>:<sub>` rate row, and what three
live paths reach by SLUGGING a raw label (`resolve-rate.ts` slug fallback, the manager KPI
card's `customManagedKeys`, Readiness). A rename therefore:

- keeps `key`, sets `name`, appends the old name to `previousNames[]`;
- every registry resolver (`resolveDeptKeyWithRegistry`, `rawDeptMatchesEntry`, the rail's
  `deptCellMatchesEntry`) matches current AND former names;
- `buildCatalogRateIndex(structures, registry)` files alias slugs so a master cell carrying
  the NEW name still resolves the department base;
- the `department_managers` grant stays on the label whose slug IS the key
  (`managerGrantLabel`) — new managers are granted under it too — so the manager card keeps
  working. Managers therefore keep seeing the original label until engineering re-keys.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `src/lib/departments/registry.ts` — `previousNames` / `updatedAt` / `updatedBy` on
      the entry; `deptEntryLabels`, `managerGrantLabel`, `deptKeyAliasSlugs`; alias-aware
      `resolveDeptKeyWithRegistry` + `rawDeptMatchesEntry`; `EditDepartmentInput`,
      `validateEditDepartmentInput`, `diffDepartmentEdit`, `applyDepartmentEdit`,
      `EDIT_DEPARTMENT_STAGES`, `EditDepartmentEvent`/`Summary`. Tests in `registry.test.ts`.
- [x] 2. `src/lib/departments/registry-db.ts` — sanitizer reads the new fields;
      `getDepartmentRegistryWithRevision()`; `replaceDepartmentRegistryEntry(entry, revision)`
      via `casUpdateAppSetting` → `conflict`.
- [x] 3. `src/lib/payroll/resolve-rate.ts` — `buildCatalogRateIndex(structures, registry?)`
      alias slugs (+ tests). Thread the registry at current-pay, member-monthly-pay,
      PayrollWizard ×3; best-effort registry read at disbursement-reports, people-roster,
      accounting-transfers, employee-hourly-rates route.
- [x] 4. `src/lib/payment-catalog/dept-rail.ts` — `DeptRailEntry.aliases?`;
      `deptCellMatchesEntry` honours them (+ test). `BonusCatalog.customDepartments` carries
      `previousNames` as aliases.
- [x] 5. `app/api/payment-catalog/departments/route.ts` — GET returns `revision`; PATCH
      (`requireFeatureEdit('accounting','bonus_catalog')`) validates, 404 / 409, then streams
      `department` (CAS write) → `managers` (grant diff on `managerGrantLabel`) → `rates`
      (new sub rates upserted, removed subs' dept-scope rows deleted). Audit `department.update`.
- [x] 6. `src/components/accounting/DepartmentsTab.tsx` — Edit button; `EditDepartmentDialog`
      reusing StepName / StepSubDepartments (edit mode: existing rate read-only + link, name
      editable, key pinned) / StepPeople (`subs` become `{key,name}`) + `StepEditReview`;
      rename → `RenameWarningDialog` before save; generic progress overlay; 409 → "reload".
      `BonusCatalog.tsx` passes `registryRevision`, `onChanged`.
- [x] 7. `tsc --noEmit` + `node --import tsx --test` on the touched test files (dev server is
      live on :3000, so no `next build`).
- [x] 8. Docs: §6 in `payment-catalog-departments.md`, INDEX row Memory cell, memory
      `edit-department-dialog` + MEMORY.md pointer. One commit with the code.

## Follow-up, same day — Edit on master-list cards (managers only)

Kane: *"Created in app has the edit but please make sure that the from the Master list sync
should have it."* Brief posted; approved Q1 = managers-only, Q2 = Payment Catalog may be a
second write path for `department_managers`.

- [x] 9. `registry.ts` — `isBuiltinManagersEditable` (HSL excluded), `validateBuiltinManagersInput`,
      `diffBuiltinManagers`, `BUILTIN_MANAGERS_STAGES` + event/summary types; tests in
      `registry-builtin-managers.test.ts`.
- [x] 10. Route — PATCH body with a string `builtinKey` → `patchBuiltinManagers`: current = active
      grants whose raw label normalizes to the key; revoke every raw-label variant; grant under
      `DEPARTMENTS[].name`; audit `department.managers.update`.
- [x] 11. `EditBuiltinManagersDialog.tsx` — Managers (roster typeahead, ≥1) → Review (diff +
      "what this dialog cannot change" + Pay Structure link); shared staged overlay.
- [x] 12. DepartmentsTab — Edit on every master-list card; HSL shows "Managers per sub-team".
- [x] 13. Docs §7, INDEX sentence, memory update. Second commit.
