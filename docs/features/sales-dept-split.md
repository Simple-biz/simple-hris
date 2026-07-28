# Sales / Sales Assistant split (2026-07-27)

Sales and Sales Assistant are **two different departments**. Until this change
the master-sheet label `Sales` was folded into the `sales_assistant` payroll
key, so the whole 18-person sales family rendered as one "Sales Assistant"
department everywhere.

## The split

| Cohort | Department | Key | People |
| --- | --- | --- | --- |
| US sales team | **Sales** (new) | `sales` | dee, will, brad, shawn, randy, chad, justin, locke |
| PH assistants | **Sales Assistant** | `sales_assistant` | aleighshaa, mar, vine, markf, deanm, debm, heartm, gladysp, jcr, larat |

> 2026-07-27: `vano@simple.biz` (Ortiz, Van Aeron — Lead Gen, PH/Lucena) was
> mislabelled "Sales" on the sheet for a few hours; not being on the pin list,
> he resolved to the **US** `sales` key — which is paused in the wizard's
> Configuration tab — and silently vanished from every wizard step after
> Initialize while logging 39:56:24. He is NOT part of either sales cohort:
> Kane corrected the sheet back to Lead Gen (roster seeded via
> `scripts/seed-vano-leadgen.mjs` when the sheet sync kept failing on network
> errors). Fallout hardening: the wizard now surfaces hour-logging workers with
> a real rate hidden behind a "Pay this week" pause (Step 2 banner + Validation
> check), and the master sync retries transient network failures.

The sheet labels **all of them `Sales`** (there is no "Sales Assistant" label
anywhere in the sheet), so the split cannot come from the label alone:

- **Membership** is pinned by an email override list —
  [`src/lib/departments/dept-email-overrides.ts`](../../src/lib/departments/dept-email-overrides.ts).
  The 10 PH emails' effective department label is rewritten `Sales` →
  `Sales Assistant` at roster-load time. Survives every sheet re-sync; the
  sheet itself is never written.
- **The label mapping** was split in
  [`normalize-dept-key.ts`](../../src/lib/payroll/normalize-dept-key.ts):
  `sales` → `sales` (was `sales_assistant`); `sales assistant` →
  `sales_assistant` unchanged. So after the rewrite, "Sales" means the US
  team and any future un-overridden hire labelled `Sales`.
- The override only ever disambiguates the label `Sales`. A PH person
  transferred to another department keeps the new label — the override never
  fights a transfer. To move someone between the two sales cohorts, edit the
  email list (one line), not the sheet.

## Where the override is applied

`mapEmployeeRow` in [`employees.ts`](../../src/lib/supabase/employees.ts) is
the main choke point — everything consuming `/api/employees` /
`getEmployees*` (Payroll Wizard, Readiness roster, People, Employee +
Manager dashboards, transfers UI, Admin) sees effective departments with no
per-surface logic. Direct `active_employees`/`global_master_list` readers
that use Department for person-level logic were patched individually with
`applyDeptOverrideToRawRow` / `overrideDeptLabel`:

| Surface | File |
| --- | --- |
| Rates & Profiles roster (People tab) | `src/lib/supabase/employee-rate-profiles.ts` |
| Team tab / My Team | `src/lib/supabase/team-roster.ts` |
| Leave requests (enrich + manager-by-dept fallback + name lookup) | `src/lib/supabase/leave-requests.ts` |
| Payment Dispatch pay context (PAB/Tech eligibility) | `src/lib/payroll/current-pay.ts` |
| Employee monthly pay (PAB/Tech eligibility) | `src/lib/payroll/member-monthly-pay.ts` |
| Readiness onboarding-exception candidates | `src/lib/payroll/payroll-readiness.ts` |
| Payroll Notes worker picker | `src/lib/supabase/global-master-list-db.ts` (`listActiveMasterListPeople`) |
| CEO financial reports dept grouping | `src/lib/ceo/financial-reports.ts` |
| Time-adjustment manager authorization (×2) | `src/lib/supabase/time-adjustments.ts` |
| Department dropdowns (HR onboarding, Roles chips, transfer targets) | `app/api/departments/route.ts` |

Deliberately **not** overridden: master-sheet sync paths
(`global-master-list-db.ts` sync ops) — they keep mirroring the sheet
verbatim — plus HSL-only email sets and identity/email-only lookups.

## The new `sales` department

- Added to `DEPARTMENTS`, `DEPT_INPUT_CONFIG` (roster-only, no formula),
  `DEPT_DESCRIPTION` in
  [`department-bonus.ts`](../../src/lib/payroll/department-bonus.ts). NOT in
  `FORMULA_DEPT_KEYS`; no `calculateDepartmentBonus` case — the ₱150/sale
  rule **stays on `sales_assistant`** (all ₱751.5k of KPI history belongs to
  the PH cohort, verified by email — the 12 US-email rows are all ₱0, so no
  history re-key was needed).
- SystemSettings' local dept list, both dept color maps
  (`DeptBonusCalculator` `#ef4444`, `ManagerBonusHistory` mirror), and
  `skill-set-titles.ts` gained `sales` entries.
- `HUBSTAFF_EXEMPT_DEPTS` now contains **both** `sales` and
  `sales assistant` — one dept was exempt before the split, so both cohorts
  keep the exemption (the PH cohort's effective label changed out from under
  the old single `sales` entry).
- The US team is salaried outside PHP payroll (no Hubstaff rows), so the
  wizard's Sales tab is a read-only roster card, its Readiness KPI row
  auto-reads Ready (`no_bonus`), and `sales` is intentionally absent from the
  PAB/Tech system-bonus allowlists.

## Data-side (scripts/split-sales-dept.mjs)

Dry-run by default, `--apply` writes; backs up to `references/backups/`.

- **Applied 2026-07-27**: the 6 managers holding a `Sales`
  `department_managers` grant (aliviah, alyson, carla, accounting, kaner,
  jackie) each got a second `Sales Assistant` grant — preserves their
  pre-split reach over both cohorts. Prune in Admin → Roles & permissions
  once ownership is decided.
- Probes confirmed: no pending sales-family transfers, no legacy
  leave-managers JSON, `sales_assistant` keeps its department-scope pay
  structure, KPI history needs no re-key.

## Tests

`src/lib/payroll/normalize-dept-key.test.ts` guards the split (label→key +
override behavior + composition); `stale-transfers.test.ts` asserts
Sales ↔ Sales Assistant are different teams (a pending transfer between them
is actionable, not stale).

## Edges / notes

- Master rows still labelled `Sales` but off the active roster: `teodya@`
  (inactive) and `marka@` (off-boarded from Sales 2026-07-16, active in Lead
  Gen) — both resolve like any other label, no override entry.
- Old per-week `dept_pay_paused` arrays that contain `sales_assistant` never
  covered the new `sales` key (per-week settings die with their week anyway).
- A new hire labelled `Sales` lands in the US Sales dept by default; add
  their email to the override list if they're actually a PH assistant.
