# MESA · FPU classes with enrollment windows

Approved by Kane 2026-09-16 (session `7b4c4597`, log row 138).

- **Q1 → (a).** HR's Approve is a SEAT in the class. A later bulk **Mark completed** on the
  class stamps `mesa_fpu_completed_on` and enrolls the person into MESA effective the
  completion date. The whole pipeline lands on HR → MESA → FPU; the HR Opt-in Requests
  sub-tab retires and the employee Request form stops offering Opt-in.
- **Q2 → (a).** Tenure is measured against the **class start date**: eligible iff
  `start_date + 3 calendar months <= class_starts_on`. The verdict is fixed for the whole
  window.
- **Q3 → recommendation.** No parseable Start Date on the roster = **ineligible**, fails
  closed, with a "ask HR to fix your start date" reason. The old form failed open.
- **Q4 → recommendation.** Accounting gets nothing new beyond the verbosity trim.

## Finding that shaped the build

`EmployeeFpu.tsx` was mounted nowhere — the MESA sub-tab vocabulary was `about | request |
history` — so no employee could sign up for FPU from the dashboard. Prod: `fpu_enrollments`
1 row (2026-05-14 test), `mesa_requests` 0 `opt_in` rows, 276 rate rows with an FPU date.
`GET /api/hr/fpu-enrollments` was one of four ungated routes; this rebuild gates it.

## Invariants

- **The server decides eligibility.** `POST /api/fpu-enroll` re-derives every predicate
  (active GML · tenure at class start · window open in Manila · not already FPU-complete
  · one enrollment per class). The UI only paints the verdict it was handed.
- **Mark completed never mints a second MESA account.** The route refuses to complete
  anyone who is already `mesa_member` or holds an OPEN `mesa_accounts` row under any alias
  (`mesaEmailAliasesFor`), and the client only calls `toggle-mesa-member` for rows the
  server returned as `toEnroll`, with `since` = the completion date.
- **`toggle-mesa-member` is untouched** — it stays the single choke point for open/close.
- **Approve/Deny/Reset touch only `fpu_enrollments`.** No money moves until Mark completed.
- **Every roster read pages** (`selectAllPaged`).

## Tasks

- [x] 1. `references/sql/create/2026-09-16_fpu_classes.sql` — `fpu_classes` + the
      `fpu_enrollments` ALTER (class_id · status · review columns · start_date_used ·
      completed_on · unique (class_id, lower(email))).
- [x] 2. `scripts/apply-fpu-classes-migration.mts` — dry / apply / verify, negative controls.
      **Kane runs it.**
- [x] 3. `src/lib/mesa/fpu-class.ts` (+ test) — label, key, next batch, phase, input
      validation, pick-current-class.
- [x] 4. `src/lib/mesa/fpu-eligibility.ts` (+ test) — roster start-date parse, tenure cutoff,
      the verdict.
- [x] 5. `src/components/mesa/bulk-selection.tsx` — lifted from AccountingMesa; AccountingMesa
      re-imports.
- [x] 6. `app/api/hr/fpu-classes/route.ts` — GET (view) · POST / PATCH / DELETE (edit).
- [x] 7. `app/api/hr/fpu-enrollments/route.ts` — GET `?class_id=` (view) · PATCH bulk
      decision (edit). `app/api/hr/fpu-enrollments/complete/route.ts` — bulk complete.
- [x] 8. `app/api/fpu-enroll/route.ts` — GET self verdict · POST self enroll.
- [x] 9. `src/components/hr/HrFpuEnrollments.tsx` rewrite; `HrMesa.tsx` drops Opt-in Requests.
- [x] 10. `src/components/employee/EmployeeFpu.tsx` rewrite; `EmployeeMesa.tsx` gains the
      `fpu` sub-tab, drops the Opt-in request type, trims About.
- [x] 11. Verbosity trim: HrMesa header, AccountingMesa Non Members note.
- [x] 12. Docs: `fpu-enrollment.md` (new) · `mesa.md` · INDEX row · `data-sources.md` ·
      `api-reference.md` · `components.md` · `pre-release-security-readiness.md` · audit
      registry note · memory · log row 138.

## Deploy notes

- `scripts/Apply FPU Classes migration.cmd` (double-click) or `node --import tsx scripts/apply-fpu-classes-migration.mts --apply` — **PENDING, Kane
  runs it.** Until then both HR routes report `migrated: false` and the surfaces say so;
  nothing 500s.
