# Payroll Wizard — Notes checklist (floating "Payroll Notes" board)

A shared running checklist of carry-over payroll items (missed bonuses, rate
changes, deductions in progress) that clerks tick off as they're applied in a
following week. It mirrors the "Phase 5: Adjustments" block of the old payroll
spreadsheet and lives behind a floating FAB on the Accounting → Payroll Wizard.

Built Jul 15–17, 2026. Sessions: notes board + FAB (Jul 15), Adjustment column
and weekly period selector (Jul 17, `f1f930d2`).

> **The FAB is now "Adjustments and Notes" and hosts a second pane:** the
> **Readiness** pre-flight dashboard (KPI submissions / pay rates / bank info /
> exceptions, with a scored dial and inline fixers), built Jul 23–25 2026 — see
> [payroll-readiness.md](./payroll-readiness.md). This doc covers the Notes
> checklist pane only.

## Surfaces

| Piece | File |
| --- | --- |
| Floating button + board UI | `src/components/accounting/PayrollWizardNotesFab.tsx` |
| Data layer | `src/lib/supabase/payroll-wizard-notes.ts` |
| API (access-gated) | `app/api/payroll-wizard/notes` |
| Week math (shared server/client) | `src/lib/payroll/manila-week.ts` |
| CEO assistant read tool | `src/lib/anthropic/ceo-tools.ts` (reports `week_of` + `adjustment`) |
| Table DDL | `references/sql/create/create_payroll_wizard_notes.sql` |
| Column migration (Jul 17) | `references/sql/alter/add_adjustment_and_week_start_to_payroll_wizard_notes.sql` |
| Period re-anchor migration (Jul 20) | `references/sql/alter/reanchor_payroll_wizard_notes_week_start_to_pay_period_sunday.sql` |

## Columns

`Date | Payroll Clerk | Done | Worker | Adjustment | Notes`

- All free text except `done` (boolean). **Adjustment** (added 2026-07-17) is
  the concrete pay change the note calls for ("+$50 bonus", "-2 hrs");
  **Notes** keeps the free-form context.
- New/edited fields flow through a shared field whitelist, so the API, blank
  row seeding, the open-count badge on the FAB, the skeleton row, and the CEO
  chat tool all pick up a column addition in one place.

## Weekly periods (`week_start`)

- The board is keyed on the **pay period being paid**, not the calendar week
  the clerk is sitting in. Payroll runs **a week in arrears**: while it's the
  week of the 19th–25th, accounting is processing the 12th–18th. So a period is
  the just-completed **Sunday–Saturday** week, read in Asia/Manila — one
  calendar week before "now" — labelled e.g. "Jul 12 – Jul 18".
  (`payrollNotesWeekStart()` in `manila-week.ts`; computed from the calendar,
  so the period exists before any CSV is uploaded for it. `manilaWeekStart()` /
  `mondayOf()` stay Monday-anchored for the HR master-list snapshots.)
- Every note carries a `week_start` DATE — the **Sunday** of the pay period it
  belongs to. It is stamped by the API on Add Row and when a blank seeded line
  is first filled in; it is **never editable from the client**.
- The board's **period selector** (top-left: prev/next arrows + dropdown, same
  pattern as the QC Overview picker) drives which week is shown. The arrows step
  **one pay period at a time in either direction** — freely, not just across
  weeks that already have notes — so any past or upcoming week is reachable;
  each period is tagged **Live / Upcoming / Past**:
  - **Live (current) period** — the paid week's notes, plus blank seed lines,
    plus still-**open** carry-overs from past periods (so nothing pending ever
    disappears). Future-staged rows stay on their own upcoming page — they
    aren't due yet, so they don't clutter "now".
  - **Upcoming periods** — stage next week's notes ahead of time: **Add Row is
    enabled** and stamps the row to that week (the server accepts the current
    week or any future one, snapped to its Sunday, and refuses past weeks).
    "Apply Changes" is hidden here — it pushes into the *current* wizard run.
  - **Past periods** — that week exactly as written; **Add Row is disabled**.
  - Ticking Done on a carry-over files it under its **original** period.
- Backfill: the original Jul 17 migration filed pre-existing rows under the
  Manila **Monday** of their `created_at`. The Jul 20 re-anchor migration
  (`reanchor_payroll_wizard_notes_week_start_to_pay_period_sunday.sql`) shifts
  every such Monday back 8 days to the corresponding pay-period Sunday; it only
  touches Mondays, so it is idempotent and safe in any deploy order. Untouched
  blank seeds stay NULL until someone writes on them.

> Possible refinement (not built): derive the period straight from the Payroll
> Wizard's loaded Hubstaff CSV instead of the calendar heuristic, so the board
> tracks the exact period being processed even if payroll ever runs more than a
> week behind. The calendar rule above matches today's one-week-arrears cadence.

## Access + realtime

- One flat table, no RLS: access is enforced at the API layer via the
  accounting `payroll_wizard` feature grant, same as the other wizard tables.
- The table is in the `supabase_realtime` publication — every clerk with
  wizard access sees adds/ticks/edits live (`useLiveRefresh`'s poll covers the
  degraded case).
- `updated_at` is maintained by the `payroll_wizard_notes_touch()` trigger.

## Deploy note

The Jul 17 columns require running
`references/sql/alter/add_adjustment_and_week_start_to_payroll_wizard_notes.sql`
in the Supabase SQL Editor (idempotent). Until it runs, board edits fail.

## Worker cell autocomplete

The Worker cell is a typeahead fed by the **current Hubstaff timesheet upload** —
exactly the people (name + email) the wizard's Initial Calculation ("CSV") step
lists, served by `GET /api/payroll-wizard/notes/workers`
(`listPayrollWorkerOptions` in `payroll-wizard-notes.ts`, via
`fetchHubstaffRowsOrdered`). Each option is keyed on the **Hubstaff email**, the
same key the wizard's Additions "Adj." overrides use, so a picked worker links
(`worker_email`) and bridges cleanly to/from the wizard. Someone getting a Last
Pay is simply in that week's CSV, so the picker no longer needs a separate
offboarded lookup. Changed Jul 17, 2026 (was: Global Master List + 90-day
offboarded).
