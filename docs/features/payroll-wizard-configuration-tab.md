# Payroll Wizard — step-1 "Configuration" tab

Per-department pay controls on the wizard's Initialize Payroll Data step (a
third tab next to Current Files / Upload, `hubstaffActiveTab === 'config'`).
Every department the wizard knows about gets exactly two switches: **Pay this
week** and **Overtime**.

Built Jul 25, 2026: tab + switches (`adc07ec`), label double-fire fix
(`6378bde`), Readiness "Excluded" status (`845d724`), per-pay-week scoping
(`bcbe853`).

## Key files

| Piece | File |
| --- | --- |
| Tab UI, toggle handlers, `effectiveCalcResults` filter | `src/components/PayrollWizard.tsx` |
| Setting keys + parse/serialize helpers (client-safe, no Supabase) | `src/lib/payroll/dept-pay-config.ts` |
| Readiness score + "Excluded" KPI status | `src/lib/payroll/payroll-readiness.ts` |
| Payroll Notes worker picker filter | `src/lib/supabase/payroll-wizard-notes.ts` (`listPayrollWorkerOptions`) |
| Notes FAB (Readiness board UI, rates glance) | `src/components/accounting/PayrollWizardNotesFab.tsx` |

## The department roster

The tab lists **every** department (`allWizardDepartments`): built-in
`DEPARTMENTS`, Payment Catalog registry departments (badged "Payment
Catalog"), every label on the active master list (unmapped ones get a slug
key), and any dept key people in the current run resolved to — nobody sits in
an invisible bucket. Rows are searchable, show this week's worker count, and
the header shows paying / excluded / OT-suspended tallies.

## "Pay this week" switch

Off = the department sits **this pay run** out:

- Its workers are filtered out of `effectiveCalcResults`, so they disappear
  from every downstream step — Additions, HSL, Validation, Dispatch, Reports,
  and the paystub snapshot. Its tab leaves the Additions rail (with an
  active-tab snap so the step never opens on an empty bucket).
- The Payroll Notes worker picker skips its people (`listPayrollWorkerOptions`
  reads the same setting off the current upload's own `source_file`).
- The Readiness score drops it from every numerator **and** denominator, so
  the score re-curves over the departments actually being paid. Since
  `845d724` the department is not silently dropped from the Readiness KPI
  list: it stays listed with an explicit red **"Excluded"** status
  (`KpiDeptStatus 'excluded'` — PowerOff pill, dimmed row, "off in wizard
  Configuration" sub-note), counts as settled, and leaves the KPI-due
  denominator ("all in · N excluded"). Pausing Hogan Smith Law marks every
  HSL sub-department Excluded. See [payroll-readiness.md](payroll-readiness.md).

KPI standing is untouched — switching the department back on restores
everything.

### Scoped to a single pay week (`bcbe853`)

The paused set is stored **per Hubstaff source file**, one `app_settings` JSON
array of dept keys under
`payroll.wizard.dept_pay_paused.<sourceFile>`
(`deptPayPausedSettingKey`), following the wizard's do-not-pay
exclusions/additions convention (one Hubstaff file = one pay period). A new
week's upload has no entry, so **every department starts each week paying
again** — the exclusion dies with its week. Consequences:

- The tab header shows a "Setting week: <label>" pill; with no week selected
  the switches are guarded (toast: pick a Hubstaff week first).
- Replaying an old week shows and edits *that* week's config.
- Readiness resolves the week's own key (best-effort: a failed read never
  takes readiness down, it just skips the exclusion and reports it in
  `degraded`); the Notes FAB rates glance follows the wizard's broadcast week.
- `parsePausedDeptKeys` reads malformed/absent values as "nothing paused" —
  the safe default is everyone gets paid.
- The pre-`bcbe853` sticky global key (`payroll.wizard.dept_pay_paused`, no
  suffix) is simply orphaned.

Saves are optimistic whole-set writes with per-control saving/saved/error
dots, revert on failure, and audit as `wizard.config.dept_pay`.

## "Overtime" switch

Off = OT hours are zeroed for the department and `initialPay` is recalculated
as regular pay only (applied in `effectiveCalcResults`). It **reuses the
existing per-department `ot_dept_<key>` keys System Settings writes**
(`otDeptSettingKey`), so both surfaces stay in lockstep — and unlike the pay
switch it is a *standing* setting, not week-scoped. Registry (Payment
Catalog) departments get OT flags through the same mechanism. A banner warns
when `ot_global_suspended` is on, which overrides every per-dept switch.
Audits as `settings.ot.department`.

## The label double-fire bug (`6378bde`)

The switches were originally wrapped in `<label>` elements. Base UI's Switch
renders a `<button>` — a labelable element — so the label's activation
behavior re-dispatched every click back onto the switch: one click fired
`onCheckedChange` **twice** (off, then straight back on), and the two saves
raced with the second winning. Fixed by:

- swapping the wrapping labels for plain `div`s (a code comment at the
  switch marks why), and
- hardening the pay handler: it reads/updates the paused set through a
  synchronously-updated ref (`pausedDeptKeysRef`) so two toggle events in the
  same tick never compute from a stale render closure, plus a no-op guard
  when the switch is already in the asked state.

## Deploy notes

**No migration.** Both switches live in existing `app_settings` rows created
on first toggle (`payroll.wizard.dept_pay_paused.<sourceFile>` and
`ot_dept_<key>`).
