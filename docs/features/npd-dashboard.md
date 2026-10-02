# NPD — New Payroll Dashboard (Accounting → NPD)

The manual version of the Payroll Wizard: a spreadsheet Accounting fills by pasting from the Google
Sheet it replaces (or by typing, or with the **Google Sheet sync** buttons, § Google Sheet sync), one
sheet per tab per pay week, saved to Supabase. Two tabs,
**All Departments** (30 columns) and **HSL** (32 columns), each with exactly the header row
Accounting supplied. **Nothing is imported from HRIS and nothing here pays anyone.** The calculated
columns use **the Google Sheet's own formulas**, editable per cell or per column (§ Formulas). It sits
in the Accounting rail directly below Payroll Wizard; the label reads **NPD** and wipes to **New
Payroll Dashboard** on hover, like S-Wall's. Built 2026-10-01 from Kane's brief (blueprint, CHOSEN
1–7, no NEEDS); session log item 309. Plan: `docs/superpowers/plans/2026-10-01-npd-dashboard.md`.
**Lock in** added the same day (item 310), **formulas** the same day (item 313). **Google Sheet sync**
(All Dept Payroll CSV · Hogan Payroll Sync) added 2026-10-02 (item 320); plan
`docs/superpowers/plans/2026-10-02-npd-google-sheet-sync.md`.

## Key files

| Piece | File |
| --- | --- |
| Tables + save function | `references/sql/create/2026-10-01_npd_sheets.sql` (applied; never edit it) |
| Apply / verify script (dry by default) | `scripts/apply-npd-sheets-migration.mts` |
| Lock in: columns, save refusal, lock / unlock functions | `references/sql/alter/2026-10-01_npd_sheets_lock.sql` |
| Lock in apply / verify script (dry by default) | `scripts/apply-npd-sheets-lock-migration.mts` |
| The two column lists (= the pasted headers) | `src/lib/npd/columns.ts` |
| Google Sheets clipboard ⇄ grid | `src/lib/npd/clipboard.ts` |
| Row model, paste, weeks, save contract | `src/lib/npd/sheet.ts` |
| Formula engine, the Google Sheet's formulas, the rate | `src/lib/npd/formulas.ts` |
| Formulas: columns, rate, typed-over cells, save v2 | `references/sql/alter/2026-10-01_npd_formulas.sql` |
| Formulas apply / verify script (dry by default) | `scripts/apply-npd-formulas-migration.mts` |
| Engine vs the live Google Sheet (read-only) | `scripts/verify-npd-formulas-against-sheet.mts` |
| Tests (pure + wiring source guards) | `src/lib/npd/clipboard.test.ts` · `sheet.test.ts` · `formulas.test.ts` · `npd-wiring.test.ts` |
| DB layer (service role) | `src/lib/supabase/npd-db.ts` |
| Route | `app/api/accounting/npd/route.ts` |
| Page · grid · client save logic | `src/components/npd/NpdDashboard.tsx` · `NpdSheetGrid.tsx` · `useNpdSheet.ts` |
| Rail label | `src/components/npd/NpdNavLabel.tsx` (wired in `src/components/Sidebar.tsx`) |
| Google Sheet sync: sheet rows → NPD rows (pure) | `src/lib/npd/google-sheet-import.ts` (+ `.test.ts`) |
| Google Sheet sync: the read-only fetch | `src/lib/google-sheets/fetch-npd-sheet.ts` |
| Google Sheet sync: route (wizard week + rows) | `app/api/accounting/npd/google-sheet/route.ts` |
| Google Sheet sync: the button on each tab | `src/components/npd/NpdGoogleSheetSync.tsx` (applied by `useNpdSheet.importSheet`) |
| Sync vs the live Google Sheet, every week, every cell (read-only) | `scripts/verify-npd-google-sheet-sync.mts` |
| Tab registration | `rbac/accounting-tabs.ts` · `rbac/view-tabs.ts` · `rbac/feature-permissions.ts` · `pages/visibility.ts` · `presence/page-label.ts` · `collab/CollabLayer.tsx` · `App.tsx` |

## Every cell is text, exactly as pasted

`₱1,234.56`, `$20.00`, `#N/A`, `Yes`, a two-line note: each **typed or pasted** cell is stored byte for
byte in a `text` column (NULL = empty cell). **Never retype a cell column to `numeric`**, never trim,
never reformat on paste or save. The sheet this replaces mixes currencies, symbols and words in the
same columns, and a typed column would refuse or quietly coerce them, which changes what Accounting
recorded. A **formula cell** holds its formula's figure as text too, in the Google Sheet's display
format (§ Formulas). Anything that needs numbers reads cells **with a tested parser**
(`parseSheetNumber`) and refuses rather than guesses. The right-alignment of figure columns is display
only.

**Formulas: yes. Footer totals: still none.** The first build said *"There are no formulas and no
totals"* (blueprint CHOSEN 3). **Kane overturned the formulas half on 2026-10-01:** *"Copy the formulas
in respective of the Columns please this is to ensure we have the values calculated"* (item 313). The
totals half stands: a footer that sums a column of pay is a new feature and a money ruling, and nobody
has asked for it.

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

## Formulas

Kane, 2026-10-01: *"Copy the formulas in respective of the Columns please this is to ensure we have
the values calculated"*, then *"when we right click on the cell it should show the formula beneath that
cell please and should be editable"*. The formulas were read that day from the NEW Payroll Dashboard
Google Sheet (spreadsheet `1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4`, tabs **All Dept** gid 0 and
**Hogan** gid 406220700), through the HRIS service account with the **read-only** Sheets scope.

**The engine reproduces the sheet exactly.** `scripts/verify-npd-formulas-against-sheet.mts` rebuilds
every row of both tabs (6,808 + 7,136 person-rows, every week since July) as NPD rows and compares each
formula cell with the sheet's own figure. On 2026-10-01: **0 mismatches** in about 97,000 formula
cells, every one identical to the last bit, not just to the cent. Re-run it after touching
`formulas.ts`; it writes nothing.

| Tab | Column (sheet letter) | The Google Sheet's formula |
| --- | --- | --- |
| All Departments | OT Rate (AF) | `=AD*1.5` (Regular Rate × 1.5) |
| | Hours Until OT (AG) | `=IF(AC<40,(40-AC),0)` |
| | Orphan Hours Total Pay (AI) | `=IF(AC>=40,(AH*AF),IF((AH+AC)<=40,AH*AD,(AG*AD)+(AH-AG)*AF))` |
| | Total Hourly Pay (AM) | `=((AC*AD)+(AE*AF)+(AI)+(AJ*AK))` |
| both | Total Pay PHP (AU) | `=AM+AO+AP+AQ+AR+AS+AN`: hourly + bonuses + MESA |
| both | PHP USD Conversion (AV) | `=AU*<that week's rate>` → NPD `={total_pay_php}*RATE` |
| HSL | Hogan WE Rate (AD) | `=AB+15` |
| | Total OT Hours (AE) | `=MAX(0,((AA+AC)-40))` |
| | OT Differential (AF) | `=AB*0.5` |
| | Hours Until OT (AG) | `=MAX(0,IF((AC+AA)<40,(40-(AA+AC)),0))` |
| | Orphan Hours Total Pay (AI) | `=IF((AA+AC)>=40,AH*(AB+AF),IF((AH+AC+AA)<40,AH*AB,(AG*AB)+(AH-AG)*(AB+AF)))` |
| | Total Hourly Pay (AM) | `=((AA*AB)+(AC*AD))+(AE*AF)+AI+(AJ*AK)` |

Rules, each pinned by `formulas.test.ts` and checked against the live sheet:

- **The defaults keep the sheet's exact expression and order.** Sheets and JavaScript both use IEEE
  doubles, so the same expression in the same order gives the same bits. **Never "simplify" a
  default**: that can move a figure by a cent. A test maps each default back to the sheet's letters and
  compares it with the sheet's formula character for character. The one recorded difference: the
  sheet's `+AO` ("Orphan pay") is dropped. NPD has no such column, the sheet never filled it (0 of
  ~13,900 rows), and x + 0 is exactly x.
- **Hours and bonuses are inputs, not formulas.** In the sheet they are XLOOKUPs into an hours tab
  that NPD does not have, so they are pasted like any other cell.
- **MESA is added, as in the sheet.** It is typed negative there (1,372 negative vs 21 positive on
  2026-10-01). Never "correct" it to a subtraction.
- **Sheets semantics:** empty = 0. Text (a space included) is text: arithmetic on it is `#VALUE!`,
  but in a comparison text ranks above every number, so a "Salary" in the hours gives Hours Until OT
  0, exactly as the sheet's Salary rows do. Errors (`#N/A` …) spread. `IF` is lazy. A range inside
  `MAX`/`MIN`/`SUM` skips empty cells and text. A formula that reaches itself is `#REF!`. A row with
  nothing typed in it shows no figures (no column of 0.00s).
- **The PHP→USD rate is per tab per week.** The sheet typed a different constant into each week's
  formula (13 distinct values). NPD's is the **PHP→USD rate** box (dollars per peso, e.g.
  `0.0162575`), stored exactly (`numeric`) on that sheet and **never carried over from another week**
  ([[fx-no-cross-check-npd-divergence]]). With no rate, the USD column is blank, not $0.00. A value
  ≥ 1 is refused (pesos per dollar typed the wrong way round would make every USD figure ~3,800×
  too large), and so is 0. The database has the same check.

**Where a cell's formula comes from**, first that applies: (1) **typed over**, so no formula; (2) the
**cell's own formula**; (3) the **sheet's column formula** (`npd_sheets.column_formulas`; `""` = none
in that column); (4) the **Google Sheet's default** above. Formulas are stored by column key
(`={regular_rate}*1.5`), so inserted rows and reordered columns can't break them. They are shown and
typed in the sheet's notation, column letter + this row (`=H5*1.5`), with a letter row above the
headers. **A formula can only use its own row's cells**: anything else is refused, with the reason.

**Typing works as in the sheet:**
- `=…` typed or pasted into a cell becomes that cell's formula. An unreadable one keeps the editor
  open on Enter and says why.
- A **different figure** typed or pasted into a formula cell is **typed over** it. The cell keeps the
  text verbatim, turns **amber**, and its tooltip gives the formula's figure. Later formulas read the
  typed value, as the sheet's would.
- A pasted figure **equal to the formula's result at 2 decimals** stays a formula. That is what pasting
  the sheet's own computed columns looks like, so a full-row paste flags only real differences.
- **Delete** gives the cell back to its formula.
- Setting the rate folds back any typed USD figure that now matches.

**Right-click a cell** (or Shift+F10 / the menu key) to see its formula **beneath the cell**, with a
live result and what each letter refers to. With an edit grant on an unlocked sheet it is editable:
- **This cell** gives the cell its own formula (corner mark).
- **Whole column** sets the column's formula on this sheet, the sheet's fill-down. It replaces every
  own formula and typed value in that column, and says how many before doing so.
- **Sheet's formula** resets the column to the Google Sheet's.
- **Use the formula again** clears a typed-over cell.

F2 / Enter / double-click on a formula cell edits its formula text. A locked sheet or a view grant
shows the formula read-only. Column changes and the rate are part of an undo step, together with the
rows.

**The server recalculates every formula cell on every save** (`recomputeSheet` in the PUT, before the
removal audit and the save), so what is stored in a formula cell is always what its formula gives. The
browser's figures are never trusted; only cells the row lists as typed over keep the browser's text.
Each row stores `formula_overrides` and `formula_cells`. `npd.sheet.saved` records a changed rate or
changed column formulas (from → to).

Not connected to anything yet: the HRIS vs NPD step still takes its own paste.

## Lock in

Kane, 2026-10-01: *"Lets add a lock in button on this where we can lock in the values on here for
the current week"*. **Lock in** freezes **the tab on screen for the week on screen** (All
Departments and HSL lock separately; one sheet = one lock).

- **The database enforces it, not the page.** `npd_sheets.locked_at` / `locked_by` (both or
  neither, CHECK). While `locked_at` is set, `npd_save_sheet` raises `npd_sheet_locked` for
  **every** save at **any** version, so no path can change a locked cell. The check runs under the
  same row lock `npd_lock_sheet` takes, **before** the version check, so a save and a lock racing
  each other cannot both win. Never move the lock check out of the function or after the version
  check. The route answers **423** before trying, so a refused save writes no audit row.
- **A lock freezes exactly what the editor saw.** The page saves pending edits first, then sends the
  version on screen. `npd_lock_sheet` refuses a stale version (409, the same conflict banner as a
  save), a week with no sheet, and a sheet with no rows. It changes **no cell and no version**.
- **Unlock needs a written reason** (1–500 characters, trimmed). The route writes
  `npd.sheet.unlocked` — the reason, who had locked it, and when — **before** it unlocks, and the
  sheet **stays locked** if that audit cannot be written. The reason is the only record of why
  locked-in values may change again, so it is never optional and never written after the fact. A
  recorded unlock that then failed writes `npd.sheet.unlock_failed`. Locks write `npd.sheet.locked`.
- **Who** is the session email for both, never the body (source-guarded).
- Lock and unlock need the `npd` **edit** grant, the same as saving (no separate approver). View-only
  users see the lock and no Unlock button.
- **Someone locks while you have edits waiting:** the save comes back 423, and the page says who
  locked it and that **your latest edits were NOT saved**. They stay on screen until
  *Show the locked sheet* reloads it. They are never retried and never saved silently after an
  unlock: an unlock reloads the sheet from the server.
- On screen: the **Locked in** pill, a bar naming who and when, a read-only grid ("This sheet is
  locked in. Unlock it to make changes." on a keystroke or paste), disabled row tools, and
  "(locked)" beside that tab in the week menu. Lock in and Unlock are inline two-step actions,
  never `window.confirm`.
- **Before the Lock in migration is applied**, header reads use `select('*')` and treat missing lock
  columns as unlocked. That is true, because nothing can be locked without `npd_lock_sheet`. Saves
  keep working, and Lock in answers 503 *"Lock in is not set up yet"*.
- Locked does not mean "sent" or "paid". Nothing reads the lock yet. The HRIS vs NPD step still takes
  its own paste.

## Google Sheet sync (All Dept Payroll CSV · Hogan Payroll Sync)

Kane, 2026-10-02: *"Accounting - NPD - Transfer the button from Payroll Wizard - Initialize Payroll
Data - All Dept Payroll CSV, AND WE WILL add a new button Called - "Hogan Payroll Sync" so on NPD we
can sync them - and it will load the current week similar week that is Payroll Wizard is on"*, then
*"Separate each sync button please put them in their respective tabs"*, *"we will use this sheet
for HSL - https://docs.google.com/spreadsheets/d/1VPPYSF0HFoLRpXiZB3Bjm-277_tO77-gm1xeUs0atX4/edit?gid=406220700"*
and *"MAKE SURE when we sync only the current week and add a timestamp"*. Built via `blueprint`
(CHOSEN 1–11, no NEEDS), item 320.

- **One button per tab, filling only that tab.** All Departments shows **All Dept Payroll CSV**,
  which reads the Google Sheet's **All Dept** tab (`GOOGLE_SHEETS_RATES_SHEET_ID` /
  `GOOGLE_SHEETS_RATES_TAB_NAME`, the moved button's own config). HSL shows **Hogan Payroll Sync**,
  which reads **the sheet Kane named for HSL, pinned in code** (`HSL_SOURCE` in `fetch-npd-sheet.ts`:
  spreadsheet `1VPPYSF0…atX4`, tab **gid 406220700**, titled "Hogan" on 2026-10-02). It finds that tab
  **by gid**, so a rename or an env change can't point it at another sheet. Never move HSL back onto an
  env var or a tab title. The labels live in `GOOGLE_SHEET_TABS`. If you move to the other tab while the sheet
  is being read, that sync is dropped, so it never pulls you back. The bar shows to the `npd` **edit**
  grant only, and so does the route.
- **It is the wizard's button, moved, with a new job.** The wizard's card read
  `GOOGLE_SHEETS_RATES_SHEET_ID` / `GOOGLE_SHEETS_RATES_TAB_NAME`, which is **this spreadsheet**. Its
  old job, upserting `employee_hourly_rates` through `/api/cron/sync-rates-from-sheet`, has been off
  since 2026-06-16 (`RATES_SHEET_SYNC_DISABLED`; rates belong to the Payment Catalog) and **stays
  off**. Here the button writes NPD's tables and nothing else. Never re-enable the rates sync as part
  of this: that is a money rule (`csv-imports.md` § Rates sync is DISABLED). The card is **gone from
  the wizard** (Initialize Payroll Data now has 3 cards). Admin → CSV Imports keeps its own rates card.
- **ONLY THE CURRENT WEEK, enforced twice.** The sync route takes **no week**; it always uses the
  wizard's, and only rows labelled with that week come back. The `PUT` then **refuses (422) a save
  tagged as a sync (`googleSheetSync`) for any week but the wizard's current one**, before it reads or
  writes anything. An ordinary save of any week is unaffected. Never add a week parameter to the sync.
- **The week is the Payroll Wizard's**: its live (`is_current`) Hubstaff upload's week, through
  `resolveCurrentWeek`, the resolver Payroll Readiness uses. **There is no calendar fallback.** An
  unreadable upload list (503), no upload, or a filename that names no Sunday (409) is refused.
  Syncing into a guessed week would fill the wrong sheet. A past week someone is replaying in their
  own wizard can't be seen by the server, so the sync always uses the live upload. The page switches
  to that week first; it never syncs into the week on screen.
- **A sync REPLACES that tab×week**: rows, the PHP→USD rate, and the column formulas, which reset to
  the Google Sheet's. The page loads the rows (`GET /api/accounting/npd/google-sheet?sheet=…`,
  read-only, audited `npd.google_sheet.loaded`) and saves them through **the normal `PUT`**. So
  everything a paste gets, a sync gets too: the removed rows are audited first, a locked sheet is
  refused (also refused before anything is fetched), and the version is checked. **Never give the
  sync a write path of its own.** Edits on screen are saved before anything replaces them. A week
  that already has rows asks first ("Replace the N saved rows … with the Google Sheet's M?"). A sync
  is one undo step and saves at once. If the target sheet is left or fails to load before the rows
  land, the sync is **dropped, never applied later** (`useNpdSheet.importSheet`).
- **The timestamp ("Last synced Oct 2, 3:14 PM EDT by …") is the server's, written only when the
  synced rows are SAVED.** The sync's save carries `googleSheetSync: { tab, sourceFile }`. Once that
  save lands, the `PUT` writes `npd.sheet.synced` (`synced_at` = the save's time, `synced_by` = the
  session email). The bar on each tab shows the latest one for the wizard's week (read from the audit
  trail by `readLastNpdSyncs`, the wizard's own "Last synced" pattern), or *Not synced yet for …*.
  A read that failed says so, never "not synced". A sync that was cancelled, refused or never saved is
  never shown as synced, and an Undo before the save drops the tag. No migration: the trail is the
  record. The other way is a `synced_at` column on `npd_sheets`, which needs another ALTER.
- **A row belongs to a week by its parsed Week cell** (`Week 9/20/26 - 9/26/26`; case, spacing round
  the dash and 2- or 4-digit years allowed), **never by its position**. A week's rows are scattered
  through the tab (17 and 24 blocks on 2026-10-02). Every row labelled with that week is taken, in
  sheet order. Rows with another week, no week, or an unreadable one are skipped and counted. A
  missing column header refuses the whole load and names the header.
- **NPD ends up equal to the sheet, cell for cell.** A cell holding the sheet's **standard** formula
  (`SHEET_FORMULA_PATTERNS`, shared with the formulas verify script) is left to NPD's formula. Anything
  else in a formula column is **typed over (amber) with the sheet's value**: a typed figure, a one-off
  formula, or **a blank cell with no formula**. That last one is not a bug: left to NPD's formula, a
  blank OT Rate would show Regular Rate × 1.5, which the sheet doesn't have, and the next formula
  would read it.
- **No digit is dropped.** A cell's text is what the sheet shows (`₱11,304.80`) when NPD's parser
  reads that back as exactly the value the sheet holds. Otherwise it is the exact number: an hours
  cell shown `40.25` that holds `40.2533` is stored `40.2533`, because NPD's formulas read the text
  and the sheet's formulas read the number. On 2026-10-02, 286 All Dept hour cells displayed fewer
  digits than they held.
- **The rate is the constant in that week's USD formulas** (`=AU12*0.0160051`), the most common one,
  and the first in the sheet if there is a tie. A row whose formula uses another constant keeps the
  sheet's USD figure as typed, so no figure changes (e.g. 3 such rows in Jul 19–25). A constant NPD
  refuses (≥ 1, or 0) is not used, and every USD figure stays the sheet's, typed.
- **Proof:** `scripts/verify-npd-google-sheet-sync.mts` (read-only) rebuilds **every week of both
  tabs** the way a sync would, lets NPD's engine fill them, and compares every cell with the sheet.
  On 2026-10-02 that was 26 tab-weeks, 14,007 rows and 434,482 cells, with **0 mismatches**. Re-run it
  after touching `google-sheet-import.ts` or `formulas.ts`.

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

- The route gates the **`npd`** accounting feature: `view` to read, and `edit` to save, lock and
  unlock, with the admin bypass inside `requireFeatureAccess`. It is **hidden until granted**: an Accounting user
  with the Payroll Wizard does **not** get NPD automatically (CHOSEN 1). Grant it in Admin → Roles.
- The rows carry per-person pay and bank last-4s. All three tables have RLS on with **zero
  policies**, privileges revoked from `anon`/`authenticated`, and they are not in
  `supabase_realtime`. All three functions (`npd_save_sheet`, `npd_lock_sheet`,
  `npd_unlock_sheet`) have EXECUTE revoked from PUBLIC/anon/authenticated and pin `search_path`. **Never add a policy, a realtime publication or a client-side Supabase read.**
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

- **Base migration APPLIED.** Not applied by this session; found applied by a read-only catalog query
  on 2026-10-01: the three tables exist with RLS on and **0 rows**, and `npd_save_sheet` exists. Its
  dry run had passed 46/46 earlier that day. The create file is the applied record and is **never
  edited**; later changes ship as `references/sql/alter/` files.
- **Lock in migration PENDING:** `node --import tsx scripts/apply-npd-sheets-lock-migration.mts --apply`
  (needs `DATABASE_URL`, session pooler; see [[migration-apply-needs-database-url]]). **Dry run against
  production 2026-10-01: 39/39** (objects, privileges, and a lock that really refuses saves); rolled
  back, and a re-probe confirmed nothing changed. The script refuses to run without the base tables.
  It is safe before or after the code deploys (see § Lock in, the last-but-one bullet).
- **Formulas migration PENDING, AFTER Lock in:** `node --import tsx scripts/apply-npd-formulas-migration.mts --apply`.
  **Dry run against production 2026-10-01: 32/32.** Lock in was not applied yet, so the dry run
  rehearsed Lock in + formulas together and rolled both back. `--apply` refuses to run before Lock in.
  **Order: Lock in `--apply` → formulas `--apply` → push.** The formulas code saves through
  `npd_save_sheet_v2`. Until that exists, a save fails loudly (*NPD formulas are not set up yet*) with
  the edits kept on screen. The original `npd_save_sheet` is kept, so older code still saves.
- **Grant PENDING:** Admin → Roles → Accounting → **NPD (New Payroll Dashboard)** → Edit for each
  person who will paste (Aliviah). Measured 2026-10-01: **0** active `npd` grants. Admins see it
  already.
- **Google Sheet sync (2026-10-02): no migration.** It saves through `npd_save_sheet_v2`, so it needs the
  **formulas migration applied** like any save. Before that, a synced sheet stays on screen with *NPD formulas
  are not set up yet*. Env: `GOOGLE_SHEETS_RATES_SHEET_ID` (+ optional `GOOGLE_SHEETS_RATES_TAB_NAME`, default
  "All Dept") for **All Dept Payroll CSV only**, and the existing `GOOGLE_SHEETS_SERVICE_ACCOUNT_*` for both.
  **Hogan Payroll Sync needs no sheet env**: its spreadsheet and gid are pinned in code. All are set in
  `.env.local`. **Vercel production is PENDING confirmation for `GOOGLE_SHEETS_RATES_SHEET_ID`**: the old wizard
  card never read it in production, because its route returned `disabled` before fetching. Without it, All Dept
  Payroll CSV says *The All Dept Google Sheet is not configured* (503), and nothing changes. That env var is now
  load-bearing for NPD: never remove it as "the rates sync is off".
- Verified 2026-10-02 (sync): 21 pure tests; NPD + wiring 146/146; the live-sheet check above (0 mismatches, re-run
  after HSL moved to its gid); a bundled browser fixture with a mocked API, 36/36. It covered: each tab shows only its own button; an empty week
  loads without asking and saves at version 0 with the sheet's rate; a week with rows asks first, and Cancel changes
  nothing; Replace swaps rows, rate and column formulas; Undo restores all three; a locked week is refused; leaving
  the sheet mid-load or the tab mid-read drops the sync; no rows says so; view-only gets no button; phone width does
  not scroll sideways; each tab's "Last synced … by …" (or *Not synced yet*); the sync's save is tagged and then
  shows the server's time; an Undo's save is not tagged. **Not clicked through signed in**, and the route has not been called against production.
- No n8n, no cron.
- Verified 2026-10-01 in a bundled client fixture driven by Playwright with a mocked API (40/40:
  paste with header skip, multi-line cells, edit/undo/redo, copy, delete, insert, 409 → Keep mine,
  failed save → Retry, tab switch flushes, week stepping, view-only, phone width, nav hover). Lock in
  added 17 more checks (57 in all) (confirm, the locked version sent, read-only grid and row tools, paste refused,
  week-menu marker, reason required, unlock, a save refused by a lock meanwhile). Formulas added 30
  more (87 in all): a pasted figure equal to the formula stays a formula and a different one turns
  amber; the right-click editor opens beneath the cell in the sheet's notation; this cell vs whole
  column (with its confirmation); reset; undo across a column change; the rate refused the wrong way
  round, then applied; `=` typed into a cell; F2 on a formula cell; another row's reference refused;
  locked and view-only read-only. **Not clicked through signed in** against the real route.
