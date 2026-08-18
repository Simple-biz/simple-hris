# Payroll Wizard — Notes checklist (floating "Payroll Notes" board)

A shared running checklist of carry-over payroll items (missed bonuses, rate
changes, deductions in progress) that clerks tick off as they're applied in a
following week. It mirrors the "Phase 5: Adjustments" block of the old payroll
spreadsheet and lives behind a floating FAB on the Accounting → Payroll Wizard.

Built Jul 15–17, 2026. Sessions: notes board + FAB (Jul 15), Adjustment column
and weekly period selector (Jul 17, `f1f930d2`).

> **The FAB is now "Adjustments and Notes" and hosts sibling panes:** the
> **Readiness** pre-flight dashboard (KPI submissions / pay rates / bank info /
> exceptions, with a scored dial and inline fixers), built Jul 23–25 2026 — see
> [payroll-readiness.md](./payroll-readiness.md) — and the **Offboarded**
> final-pay tab (2026-08-04). The read-only **Rates** glance was REMOVED
> 2026-08-18 (Kane: "useless") — rates live in the Payment Catalog tab. This
> doc covers the Notes checklist pane only.

## Surfaces

| Piece | File |
| --- | --- |
| Floating button + board UI | `src/components/accounting/PayrollWizardNotesFab.tsx` |
| Data layer | `src/lib/supabase/payroll-wizard-notes.ts` |
| API (access-gated) | `app/api/payroll-wizard/notes` |
| Week math (shared server/client) | `src/lib/payroll/manila-week.ts` |
| Adjustment ↔ Adj. bridge (+ tests) | `src/lib/payroll/adjustment-bridge.ts` · `adjustment-bridge.test.ts` |
| Bridge diagnostic (read-only) | `scripts/diagnose-notes-adjustments.mjs` |
| CEO assistant read tool | `src/lib/anthropic/ceo-tools.ts` (reports `week_of` + `adjustment`) |
| Table DDL | `references/sql/create/create_payroll_wizard_notes.sql` |
| Column migration (Jul 17) | `references/sql/alter/add_adjustment_and_week_start_to_payroll_wizard_notes.sql` |
| Period re-anchor migration (Jul 20) | `references/sql/alter/reanchor_payroll_wizard_notes_week_start_to_pay_period_sunday.sql` |

## Columns

`Date | Payroll Clerk | Done | Worker | Adjustment | Notes`

- All free text except `done` (boolean). **Adjustment** (added 2026-07-17) is
  the concrete pay change the note calls for. To reach the wizard it must be
  **just the figure** — `+500`, `-250.50`, `-₱900`, `$50`, `COP 50,000` (a bare
  number is PHP). Prose like `+500 bonus` or `-2 hrs` deliberately does **not**
  parse — the reason belongs in **Notes**. The board now prints a small amber
  reason under any cell that won't apply, so a skipped row says so instead of
  looking accepted (see the bridge section below).
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

## No reload on the way back (caching, 2026-08-03; Offboarded joined 2026-08-18)

The FAB is mounted only while the Payroll Wizard tab is active, and the modal's
panes unmount on every inner tab switch — so each visit used to re-pull
everything from scratch, skeletons and all. All of it now goes through the shared
Accounting tab cache (`src/lib/accounting/tab-cache.ts`: in-memory + `sessionStorage`,
so it also survives a reload of the same browser tab):

| Dataset | Behaviour on a return visit |
| --- | --- |
| Notes rows (`/notes`) | Painted from cache; refreshed in the background on mount + on open. `Loading notes…` only ever shows on the session's first pull. |
| Readiness snapshot (`/readiness`) | Painted from the cached snapshot **for that week**. Younger than 30s (the pane's own poll) → no refetch at all; older → silent revalidate behind the visible numbers; older than 6h → treated as a cold load. |
| Worker suggestions, Hubstaff upload list | Fetched once per page session. |
| Offboarded final-pay list (`/offboarded`) | Same per-week stamped cache as the readiness snapshot (30s fresh window / 6h max age / 4-week trim), added 2026-08-18 — the tab shipped a day after the caching pass and had been the one pane that re-pulled on every visit. |

(The Rates glance had its own cached row here until the tab was removed
2026-08-18.)

### Every pane says when its data was pulled (2026-08-18)

Each pane renders a **"Last data pull HH:MM:SS · Xs ago"** line at the top
(`PaneFreshness`), stamped **only by successful loads** — a failed background
poll keeps the previous, honest time — and ticking every 10s. Cached paints
show the cache's own stamp (that IS when the data left the server), not the
paint time.

The line carries a **signal dot** (added same day, Kane's ask) fed by
`useLiveRefresh`'s `onStatusChange`: **emerald (pinging)** = the Realtime
websocket is SUBSCRIBED, changes land in ~1s; **amber** = polling only,
changes land within ~30s. Until the channel's SUBSCRIBED fires the dot reads
amber, because the poll genuinely is the coverage at that moment. Either
color, the 30s poll keeps running — the tooltips say so, since a SUBSCRIBED
channel still can't deliver events for a table missing from the
`supabase_realtime` publication.

### Live refresh coverage (2026-08-18)

Readiness (12 tables) and the notes board (`payroll_wizard_notes`) were already
live via `useLiveRefresh` (Realtime + 30s poll + focus refresh). The
**Offboarded** pane now runs the same hook on `employee_ids`,
`payment_catalog_pay_structures`, and `employee_hourly_rates` (the Set rate /
Set bank write targets — an inline fix from either tab lands live), with the
30s poll carrying the offboard sources themselves (master-list stamps, queue
completions have no Realtime channel). Its loads carry a monotonic request
token and a background-mode guard, mirroring the Readiness pane's. The closed
FAB's score ring deliberately keeps NO always-on channel of its own — the
subscriptions live inside the open modal panes only.

The Offboarded pane also gained a **search box and a department filter**
(2026-08-18), mirroring the Bank Info pane's: `matchesQuery` over
name/emails/department/off-board reason, a per-department dropdown with counts
(plus a "No department" bucket), and a stranded-filter release when a refresh
drops the selected department's last row.

Notes:

- The FAB's score ring and the Readiness pane share **one** readiness cache
  entry per week, so whichever reads first spares the other the query (it used
  to be fetched twice over). The ring still force-refetches when the modal
  closes — an inline "Set rate"/"Set bank" fix may have just moved the score.
- Row-cache writes are driven off the saved-server-copy map, never off
  keystroke state, so a half-typed draft can't be what a later mount seeds from.
- A cache-seeded snapshot never counts as a live payload for the 100% confetti —
  otherwise a week that turned ready while you were on another tab would
  celebrate on arrival.
- Background refreshes (cache revalidate, Realtime, poll, refocus) no longer
  replace visible readiness numbers with an error card when a request blips;
  foreground loads (first pull, week switch, Retry) still report failures.

## Deploy note

The Jul 17 columns require running
`references/sql/alter/add_adjustment_and_week_start_to_payroll_wizard_notes.sql`
in the Supabase SQL Editor (idempotent). Until it runs, board edits fail.

## Adjustment ↔ wizard "Adj." bridge (hardened 2026-07-28)

The board's Adjustment column and the wizard's Additions/HSL **Adj.** override
hold the same fact. `src/lib/payroll/adjustment-bridge.ts` owns the translation
(`parseAdjustmentAmount`, `adjustmentToPhp`, `formatAdjustmentText`,
`payWeekStartFromSourceFile`) and is covered by `adjustment-bridge.test.ts`.

- **Wizard → board**: every manual Adj. edit is mirrored (debounced) onto the
  worker's live-week row; clearing it clears that row's Adjustment text. **Not
  mirrored when the worker already has several amounts on the board** — the
  wizard figure is their combined total, so writing it into one of those rows
  would add it on top of the others. The clerk is told (toast) rather than left
  with two surfaces quietly disagreeing.
- **Board → wizard**: entering step 4/5/7/8 pulls open rows (merge-only), and a
  clerk's **Apply Changes** force-applies their rows and files them Done.

### Several rows for one worker: combined (changed 2026-07-29)

Two notes about the same person in the same pay week used to mean **the newest
row won** and the other amount was simply not paid. Now
`combineAdjustments` (in `adjustment-bridge.ts`, covered by its test file) folds
the whole group into the single figure the Adj. column holds:

| On the board | Applied | Why |
| --- | --- | --- |
| `+500` and `-200` | `+300` | Different amounts are **added**, signed — a bonus and a deduction net out. Two notes are two pay changes and payroll owes both. |
| `+500` and `+500` | `+500`, **warned** | The same figure in the same currency twice is far more likely one item entered twice. Paying a duplicate is the expensive mistake, so it is counted **once** and flagged — never silently doubled. |
| `+500`, `+500`, `-200` | `+300`, **warned** | The repeat drops out; everything else still adds. |
| `500` and `$8.93` | both added | "The same amount" means same currency **and** same figure, so a near-equal conversion is not treated as a duplicate. |

Mechanics worth knowing:

- **The warning is loud on both surfaces.** The board prints `possible
  duplicate` / `combined with N more` under the cell (with the arithmetic in the
  tooltip), and the wizard toasts by name — on **Apply Changes** *and* on the
  automatic pre-fill (once per distinct set of amounts, so a step re-entry
  doesn't nag), because nobody may click Apply Changes all week.
- **A repeat is left OPEN on the board.** Only rows that were counted are filed
  Done, so the pending decision stays visible. If both amounts really are owed,
  put the sum in one cell and delete the other row.
- **The automatic pull can now raise an existing override**, but only when the
  value it finds is one this same board group produced — its current total or
  its total before a row was added (`isBoardDerivedTotal`). Anything else is
  treated as hand-typed and left alone. Without this, adding a second note
  mid-week would only take effect through an explicit Apply Changes.
- **Removing one of several rows subtracts just that row.** The board sends the
  worker's surviving cells with the removal event; the wizard drops the override
  to their combined total (or clears it when none are left), still guarded by a
  value match against what the board held a moment earlier. Removing a row that
  was a *duplicate* correctly changes nothing.
- **Apply Changes is scoped per worker, not per row.** Clicking one clerk's
  section applies the full board total for the workers that section mentions —
  otherwise a partial sum would overwrite the amount another clerk wrote for the
  same person.
- Multi-row totals reach the pay stub with their arithmetic in
  `adjustment_note`: `…reasons… · combined 2 Payroll Notes rows: 1850 + 4750 =
  ₱6,600.00`.

### What went wrong (2026-07-28) and what now prevents it

The week of Jul 19–25 was found with **101 board rows carrying real amounts
against `bonusOverrides: {}` on file** — every row ticked Done, so nothing could
re-apply them. Three compounding causes, all now closed:

1. **`Done` was the eligibility gate.** The pull skipped every Done row, and
   Apply Changes set Done. Once the wizard's in-memory copy was lost, the
   amounts were unreachable from the board. → Eligibility is now decided by
   **`week_start` vs. the cycle's pay week** (parsed from the loaded CSV's
   `…_YYYY-MM-DD_to_YYYY-MM-DD` range). A Done row stamped to the week being
   paid stays eligible, so the column **self-heals**; a Done row from an earlier
   week stays history and is never paid twice. Rows staged on an **upcoming**
   week are now excluded from the current cycle (they used to price it).
2. **The additions blob was a blind whole-map replace.** `loadAdditionsProgress`
   overwrote `bonusOverrides` with whatever was on file — including `{}` — even
   when it resolved *after* the board had applied amounts. The next manual
   "Lock in additions progress" then persisted that empty map. → An edit
   generation counter (`additionsEditGenRef`) makes a hydration that raced a
   local write **merge under** it, and a payload for a file the clerk has since
   switched away from is dropped.
3. **Applied amounts were only in memory** until someone remembered to click
   "Lock in additions progress". → An apply (and a board retract) now persists
   the blob itself, silently. Auto-saves are gated on `additionsHydratedFor` so
   they can never write a half-hydrated payload.

Also hardened:

- **Nothing is skipped in silence.** Apply Changes reports unlinked workers,
  cells that aren't plain amounts, workers absent from the loaded timesheet, and
  workers whose rows had to be combined or whose amounts repeat (see the section
  above). The board shows the same reasons per row.
- **A bare `0` no longer blocks a pull.** Clicking the `—` placeholder opens the
  Adj. input at 0 without committing anything; that empty shell used to make the
  merge-only pull skip the worker forever.
- **Key-casing agreement.** The Adj. column reads through the same raw-then-
  lowercased resolution the pay computation and dispatch payload use
  (`overrideKeyFor`), so it can't show "—" beside an adjustment that is paid.
- While a cycle is **LOCKED** for Payment Dispatch the automatic pull stays
  suspended by design — Unlock in Validation, apply, then lock again.

`scripts/diagnose-notes-adjustments.mjs` is a read-only replay of all of these
rules against live data: it prints what would pre-fill, what is recovered, what
is history, which workers get **combined** totals, which look like
**duplicates**, and any gap between the board and the saved additions blob.

Run on 2026-07-29 against week `2026-07-19` it found exactly what the combine
rule was asked for: three workers (`reat@`, `josec@`, `rafa@`) whose saved
adjustment was the newest row only — short by ₱1,850 / ₱500 / ₱3,700 — and one
(`allans@`) with `8450` written twice, which is now paid once. That cycle was
**LOCKED**, so the new totals land only after Unlock in Validation.

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
