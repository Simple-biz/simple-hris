# Accounting — NPD Google Sheet sync (All Dept Payroll CSV + Hogan Payroll Sync)

**Brief:** in-session 2026-10-02. Kane: *"Accounting - NPD - Transfer the button from Payroll Wizard -
Initialize Payroll Data - All Dept Payroll CSV, AND WE WILL add a new button Called - "Hogan Payroll
Sync" so on NPD we can sync them - and it will load the current week similar week that is Payroll
Wizard is on"*. Built under the 2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–8), no NEEDS.

**What was found first:** the wizard's "All Dept Payroll CSV" card reads `GOOGLE_SHEETS_RATES_SHEET_ID`
/ `GOOGLE_SHEETS_RATES_TAB_NAME`, which is **the very spreadsheet NPD replaces** (tab "All Dept", gid 0),
and its route has been switched off since 2026-06-16 (`RATES_SHEET_SYNC_DISABLED`: rates belong to the
Payment Catalog). The same spreadsheet's "Hogan" tab (gid 406220700) is NPD's HSL tab. On 2026-10-02
both tabs held 14 weeks; a week's rows are **not contiguous** (17 and 24 blocks), labels read
`Week 9/20/26 - 9/26/26` with spacing/case variants, and 286 All Dept hour cells display 2 dp while
holding more digits.

## Task 1 — the pure import module

- [x] `src/lib/npd/google-sheet-import.ts`
  - `SHEET_FORMULA_PATTERNS` (moved from the verify script, one source), `GOOGLE_SHEET_TABS`.
  - `parseSheetWeekLabel` → `{ start, end }` ISO from `Week M/D/YY - M/D/YY` (case, spacing, 2/4-digit
    years); null when unreadable.
  - `sheetCellText(formatted, unformatted)` → the display text when NPD's parser reads it as the exact
    value, else the exact number; error explanations stripped; NUL / 5,000-char clip.
  - `buildNpdImport({ sheet, week, formulas, values, formatted })` → rows `{ values, overrides }`,
    `rateText`, summary (other weeks / no week / unreadable week skipped, typed cells, other-rate rows,
    labels), or a refusal (no header row, missing columns, no rows for the week, over 2,000 rows).
- [x] `src/lib/npd/google-sheet-import.test.ts` — labels, cell text, row building, rate choice,
  refusals, and the rebuilt rows evaluating to the sheet's figures.

## Task 2 — verify script uses the shared patterns

- [x] `scripts/verify-npd-formulas-against-sheet.mts` imports `SHEET_FORMULA_PATTERNS`, reads an
  open-ended range (was capped at row 12,000). Re-run: still 0 mismatches.

## Task 3 — server

- [x] `src/lib/google-sheets/fetch-npd-sheet.ts` — three read-only grids (FORMULA, UNFORMATTED_VALUE,
  FORMATTED_VALUE) of one tab, service account, `spreadsheets.readonly`.
- [x] `app/api/accounting/npd/google-sheet/route.ts` — `requireFeatureEdit('accounting','npd')` first;
  wizard week via `resolveCurrentWeek()` (refuse on degraded / no upload / not a Sunday); no `sheet` →
  the week only; else build the import, audit `npd.google_sheet.loaded`, return rows.
- [x] `src/lib/audit/registry.ts` — note the new action in the `npd.` family.

## Task 4 — client

- [x] `useNpdSheet.importSheet(target, payload)` — applies to the target tab×week once loaded (rows +
  rate + column formulas reset, one undo step, saves at once); dropped if the sheet is left first;
  refused when locked, view-only or in conflict.
- [x] `src/components/npd/NpdGoogleSheetSync.tsx` — two buttons (All Dept Payroll CSV · Hogan Payroll
  Sync), the wizard's week, inline confirm when the target week has rows, refusal when locked.
- [x] `NpdDashboard.tsx` — `switchTo` returns success; mounts the sync row (edit grant only).

## Task 5 — wizard

- [x] `PayrollWizard.tsx` step 1 Upload tab: the "All Dept Payroll CSV" card and its handler/state are
  removed; grid is three cards.

## Task 6 — tests, docs, commit

- [x] `npd-wiring.test.ts` — route gate first statement, sync never writes, wizard card gone, NPD
  labels present.
- [x] `docs/features/npd-dashboard.md` § Google Sheet sync + Deploy notes; INDEX row; csv-imports note;
  memory `npd-google-sheet-sync` + MEMORY.md; session log item 320.

## Revisions in the same session

- [x] CHOSEN 9 — *"Separate each sync button please put them in their respective tabs"*: the bar renders only the
  open tab's button; a read whose tab was left is dropped.
- [x] CHOSEN 10 — *"we will use this sheet for HSL"* + link: `HSL_SOURCE` pins spreadsheet `1VPPYSF0…atX4`, gid
  406220700, resolved to its title through the spreadsheet's metadata.
- [x] CHOSEN 11 — *"MAKE SURE when we sync only the current week and add a timestamp"*: `googleSheetSync` on the save
  body; the PUT refuses it for any week but the wizard's (422, before any read); `npd.sheet.synced` after the save;
  `readLastNpdSyncs` feeds "Last synced … by …" on each tab.
