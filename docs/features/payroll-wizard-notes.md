# Payroll Wizard — Notes checklist (floating "Payroll Notes" board)

A shared running checklist of carry-over payroll items (missed bonuses, rate
changes, deductions in progress) that clerks tick off as they're applied in a
following week. It mirrors the "Phase 5: Adjustments" block of the old payroll
spreadsheet and lives behind a floating FAB on the Accounting → Payroll Wizard.

Built Jul 15–17, 2026. Sessions: notes board + FAB (Jul 15), Adjustment column
and weekly period selector (Jul 17, `f1f930d2`).

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

## Columns

`Date | Payroll Clerk | Done | Worker | Adjustment | Notes`

- All free text except `done` (boolean). **Adjustment** (added 2026-07-17) is
  the concrete pay change the note calls for ("+$50 bonus", "-2 hrs");
  **Notes** keeps the free-form context.
- New/edited fields flow through a shared field whitelist, so the API, blank
  row seeding, the open-count badge on the FAB, the skeleton row, and the CEO
  chat tool all pick up a column addition in one place.

## Weekly periods (`week_start`)

- A payroll week is **Monday-anchored in Asia/Manila** — same convention as
  the Hubstaff pay weeks, but computed from the calendar
  (`manilaWeekStart()` / `mondayOf()` in `manila-week.ts`), so "this week"
  exists before any CSV is uploaded for it.
- Every note carries a `week_start` DATE — the Manila Monday of the week it
  was **written**. It is stamped by the API on Add Row and when a blank seeded
  line is first filled in; it is **never editable from the client**.
- The board's **period selector** (top-left: prev/next arrows + dropdown, same
  pattern as the QC Overview picker) drives which week is shown:
  - **Live (current) week** — this week's notes, plus blank seed lines, plus
    still-**open** carry-overs from past weeks (so nothing pending ever
    disappears).
  - **Past weeks** — that week exactly as written; **Add Row is disabled**.
  - Ticking Done on a carry-over files it under its **original** week.
- Backfill: pre-existing rows with content (or already Done) were filed under
  the Manila week of their `created_at`; untouched blank seeds stay NULL until
  someone writes on them.

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
