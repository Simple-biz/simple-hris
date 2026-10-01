# NPD — New Payroll Dashboard (Accounting → NPD)

The manual version of the Payroll Wizard: a spreadsheet Accounting fills by pasting from the Google
Sheet it replaces (or by typing), one sheet per tab per pay week, saved to Supabase. Two tabs,
**All Departments** (30 columns) and **HSL** (32 columns), each with exactly the header row
Accounting supplied. **Nothing is imported from HRIS, nothing is computed, and nothing here pays
anyone.** It sits in the Accounting rail directly below Payroll Wizard; the label reads **NPD** and
wipes to **New Payroll Dashboard** on hover, like S-Wall's. Built 2026-10-01 from Kane's brief
(blueprint, CHOSEN 1–7, no NEEDS); session log item 309. Plan:
`docs/superpowers/plans/2026-10-01-npd-dashboard.md`.

## Key files

| Piece | File |
| --- | --- |
| Tables + save function | `references/sql/create/2026-10-01_npd_sheets.sql` |
| Apply / verify script (dry by default) | `scripts/apply-npd-sheets-migration.mts` |
| The two column lists (= the pasted headers) | `src/lib/npd/columns.ts` |
| Google Sheets clipboard ⇄ grid | `src/lib/npd/clipboard.ts` |
| Row model, paste, weeks, save contract | `src/lib/npd/sheet.ts` |
| Tests (pure + wiring source guards) | `src/lib/npd/clipboard.test.ts` · `sheet.test.ts` · `npd-wiring.test.ts` |
| DB layer (service role) | `src/lib/supabase/npd-db.ts` |
| Route | `app/api/accounting/npd/route.ts` |
| Page · grid · client save logic | `src/components/npd/NpdDashboard.tsx` · `NpdSheetGrid.tsx` · `useNpdSheet.ts` |
| Rail label | `src/components/npd/NpdNavLabel.tsx` (wired in `src/components/Sidebar.tsx`) |
| Tab registration | `rbac/accounting-tabs.ts` · `rbac/view-tabs.ts` · `rbac/feature-permissions.ts` · `pages/visibility.ts` · `presence/page-label.ts` · `collab/CollabLayer.tsx` · `App.tsx` |

## Every cell is text, exactly as pasted

`₱1,234.56`, `$20.00`, `#N/A`, `Yes`, a two-line note: each is stored byte for byte in a `text`
column (NULL = empty cell). **Never retype a cell column to `numeric`**, never trim, never reformat
on paste or save. The sheet this replaces mixes currencies, symbols and words in the same columns,
and a typed column would refuse or quietly coerce them, which changes what Accounting recorded. A
future feature that needs numbers (an HRIS-vs-NPD read, a total) parses them **with its own tested
parser**, and refuses rather than guesses. The right-alignment of figure columns is display only.

There are **no formulas and no totals**. "Manual version" is the brief. Adding a computed column
or a footer total is a new feature, not a fix, and summing pasted money is a money ruling.

## The columns are the pasted header rows

`columns.ts` lists each tab's columns in Kane's order. Each `key` is that tab's column in its row
table: `npd_all_departments_rows` (30) or `npd_hsl_rows` (32). The SQL, the registry and the apply
script's counts move **together**. `sheet.test.ts` reads the SQL file and fails if a key and a
column disagree or fall out of order. HSL's hour/rate columns (M-F, WE, Hogan WE Rate, OT
Differential, Mid-week **Transition** rate) are **not** the All Departments ones (Regular, OT,
Mid-week **New** rate). They are separate columns on purpose. Never merge them into one.

Two typos in the pasted headers are corrected **on screen only**: "Conversoin" → "Conversion",
"Perfornance" → "Performance". The misspelt forms stay as `headerAliases`, so a header row copied
from the old sheet is still recognised.

## One sheet per tab per pay week

A sheet is keyed by `(sheet, week_start)`, where `week_start` is the **Sunday** that starts the
Sun–Sat pay week (CHECK in the SQL, `isSundayIso` in the route). The page opens on the newest week
that has rows on either tab, otherwise on the last **completed** week (`defaultNpdWeek`, Manila
date). The ◀ ▶ stepper and the week menu are shared by both tabs. The **Week** column is a free
cell Accounting pastes. It is never checked against the sheet's week, and that is not a bug.

## Saving: autosave, whole sheet, atomic, version-checked

- The client PUTs the **whole sheet** 1.2 s after the last edit (`SAVE_DEBOUNCE_MS`). Trailing
  blank rows are UI spares and are never sent; a blank row between filled rows is kept.
- `npd_save_sheet` (one plpgsql transaction) creates the sheet if needed, **locks it**, refuses a
  stale `expectedVersion` with `npd_version_conflict:<current>`, deletes and re-inserts the rows,
  and bumps `version`. Delete-then-insert outside one transaction could lose a sheet; never split it.
- **A 409 stops autosave.** The page names who saved and when, and offers **Load their version**
  (drops local edits) or **Keep mine** (saves over theirs at their version). Nothing is overwritten
  silently, and nothing resolves a conflict automatically.
- A failed save keeps the edits on screen, says so, and retries on the next edit or **Retry now**.
  Green **Saved** means the server confirmed a save. A week nobody saved reads *Nothing saved yet*,
  in grey.
- A failed **load** is an error, not an empty grid. An empty grid would invite pasting the week
  again over rows that are really there.
- Switching tab or week **flushes first**, and refuses to switch if the flush failed. Each
  tab × week is its own client session object (`useNpdSheet`), so leaving a sheet mid-save still
  saves its edits, with its own version, and never into another week's state.
- `saved_by` / `updated_by` is the **session** email (`authz.sessionEmail`), never the body.
  Source-guarded in `npd-wiring.test.ts`.

## Removed rows are audited first

Rows carry a client-minted UUID that stays stable across saves, so the route can say **which**
filled rows a save drops. When a save drops any, the route writes `npd.rows.removed` with the
**full contents** of every removed row before anything is deleted, and **refuses the save** if
that audit fails. This is the orphanage / QC Compare rule: another person typed those rows. Every
save then writes `npd.sheet.saved` (tab, week, version, row counts). A removal that was recorded
but whose save then failed writes `npd.sheet.save_failed`. All three are the `npd.` family in
`src/lib/audit/registry.ts`. Undo (Ctrl+Z, 50 steps) lives in the browser only, until the sheet
is left.

## Access: service role only, behind the `npd` grant

- The route gates the **`npd`** accounting feature: `view` to read and `edit` to save, with the
  admin bypass inside `requireFeatureAccess`. It is **hidden until granted**: an Accounting user
  with the Payroll Wizard does **not** get NPD automatically (CHOSEN 1). Grant it in Admin → Roles.
- The rows carry per-person pay and bank last-4s. All three tables have RLS on with **zero
  policies**, privileges revoked from `anon`/`authenticated`, and they are not in
  `supabase_realtime`. The function's EXECUTE is revoked from PUBLIC/anon/authenticated and it pins
  `search_path`. **Never add a policy, a realtime publication or a client-side Supabase read.**
  The apply script proves each of these against the live catalog.
- **Not** `app_settings`: that family is readable by every signed-in user
  ([[app-settings-final-pay-readable-by-every-employee]]). This is the "share it on QC Compare's
  pattern" that `payroll-wizard-hris-vs-npd.md` reserved for NPD data.
- View-only users can select and copy. The grid opens no editor, and the server refuses a PUT
  regardless.
- Not in the Accounting tab cache (CHOSEN 7): an editable sheet always reads live, because a stale
  paint would let someone type over an old copy.

## The grid

Cells render as text with one floating editor (a `textarea`, so line breaks survive) on the active
cell. Rows are memoised, and the model keeps untouched rows' identity, so an edit re-renders one row.
Paste parses Google Sheets' TSV, including quoted cells with line breaks or tabs and doubled
quotes (`clipboard.ts`). It fills right and down from the active cell, adds rows, and **skips a
pasted header row**: at least two non-empty cells, and 60% of them, are this tab's headers. Cells
past the last column (HRIS) are dropped and the count is reported, never wrapped onto the next
row. A single copied cell fills a multi-cell selection. Caps: 2,000 rows, 5,000 characters a cell
(the route refuses more; the client clips and reports). Phone: `table-keep`, an explicit table
`width`, a `relative` scroller (the three traps in [[payroll-wizard-hris-vs-npd]]).

Keys: arrows (Shift extends, Ctrl jumps) · Enter / F2 / double-click edit · typing replaces ·
Enter ↓ · Tab → · Esc cancels · Alt+Enter is a line break · Delete clears · Ctrl+Z / Y ·
Ctrl+A · Ctrl+C / X / V.

## Not connected to anything yet

The HRIS vs NPD Validation step (`payroll-wizard-hris-vs-npd.md`) still takes its own paste and
does not read these tables. Wiring it is a separate decision. If it is ever wired, the dollar
column must be parsed and refused exactly as that step's paste contract says.

## Deploy notes

- **Migration PENDING:** `node --import tsx scripts/apply-npd-sheets-migration.mts --apply` (needs
  `DATABASE_URL`, session pooler; see [[migration-apply-needs-database-url]]). The **dry run passed
  against production 2026-10-01** (46/46 checks; rolled back, nothing committed). Until it is
  applied, the route answers 503 and the page says *NPD is not set up yet*. Re-running `--apply`
  is safe. PostgREST picks the new tables up on its schema reload; a 503 straight after applying
  means the cache has not reloaded yet.
- **Grant PENDING:** Admin → Roles → Accounting → **NPD (New Payroll Dashboard)** → Edit for each
  person who will paste (Aliviah). Admins see it already.
- No env vars, no n8n, no cron.
- Verified 2026-10-01 in a bundled client fixture driven by Playwright with a mocked API (40/40:
  paste with header skip, multi-line cells, edit/undo/redo, copy, delete, insert, 409 → Keep mine,
  failed save → Retry, tab switch flushes, week stepping, view-only, phone width, nav hover). **Not
  clicked through signed in** against the real route.
