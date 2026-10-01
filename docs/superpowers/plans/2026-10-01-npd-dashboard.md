# Accounting — NPD (New Payroll Dashboard)

**Brief:** in-session 2026-10-01. Kane: *"Accounting - Lets create a new section just right below
Payroll Wizard - and lets label it - "NPD" and similar to S-WALL when you hover over it - it will
extend to - "New Payroll Dashboard" Where - inside it will be the Manual Version of Payroll Wizard -
where there are two tabs inside it one for All Departments and One for HSL only … this is like a
google sheet where Aliviah can paste in the data manually none of these data will be automatically
imported from HRIS … we will publish this in Supabase make sure to write a migration"*. Built under
the 2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–7), no NEEDS.

**Stack:** Next.js app router, Supabase service role behind a feature-gated route, one plpgsql RPC
for the atomic save, `node --import tsx --test`.

## Task 1 — the data layer

- [ ] `references/sql/create/2026-10-01_npd_sheets.sql`
  - `npd_sheets` — one row per (sheet, pay-week Sunday): `version` (CAS), `row_count`,
    `created_by/at`, `updated_by/at`. `unique (sheet, week_start)`, `unique (id, sheet)` for the
    composite FK. Sheet ∈ `all_departments | hsl`; week_start must be a Sunday.
  - `npd_all_departments_rows` (30 text cells) and `npd_hsl_rows` (32 text cells) — exactly the
    two pasted header rows. `sheet` column pinned by CHECK and composite FK `(sheet_id, sheet)` so
    an HSL row can never hang off an All Departments sheet. `unique (sheet_id, row_no)`.
  - `npd_save_sheet(p_sheet, p_week_start, p_expected_version, p_saved_by, p_rows)` — creates the
    header if absent, locks it, raises `npd_version_conflict:<v>` on a stale version, replaces the
    rows, bumps the version. `search_path = ''`, EXECUTE revoked from PUBLIC/anon/authenticated.
  - RLS on, zero policies, table privileges revoked from anon/authenticated, not in realtime.
- [ ] `scripts/apply-npd-sheets-migration.mts` — dry by default (rolled-back transaction),
  `--apply`, `--verify`; object checks + positive and negative controls (stale version, non-Sunday,
  unknown sheet, blank saved_by, cross-sheet row, duplicate row_no, anon has no EXECUTE/SELECT).

## Task 2 — the pure modules

- [ ] `src/lib/npd/columns.ts` — `NPD_SHEETS`, per-sheet column registry (key = DB column, header
  with the sheet's line breaks, width, align). Two header typos corrected on screen.
- [ ] `src/lib/npd/clipboard.ts` — `parseClipboardGrid` (Google Sheets TSV, quoted cells with
  newlines/tabs/doubled quotes, CRLF, trailing newline) and `serializeClipboardGrid`.
- [ ] `src/lib/npd/sheet.ts` — row model (`{id, values[]}`), `applyPaste`, `clearRange`,
  `insertRows`, `deleteRows`, `ensureSpareRows`, `trimTrailingBlankRows`, header-row detection,
  week helpers (`isSundayIso`, `defaultNpdWeek`, `shiftWeek`, `weekLabel`), and the server-side
  `validateSaveBody` + `removedRows` diff + DB record mapping.
- [ ] `*.test.ts` for all three, plus source guards on the route (edit gate on PUT, `saved_by`
  from the session, removal audit before the RPC) and the registries (tab id ↔ catalog key).

## Task 3 — route + audit

- [ ] `src/lib/supabase/npd-db.ts` — `readNpdSheet` (selectAllPaged, `order(row_no)`),
  `listNpdWeeks`, `saveNpdSheet` (RPC; conflict and missing-table mapped).
- [ ] `app/api/accounting/npd/route.ts` — GET (`npd` view): one sheet, or `?list=weeks`.
  PUT (`npd` edit): validate → early 409 on a stale version → audit removed rows FIRST (refuse on
  audit failure) → RPC → `npd.sheet.saved`. Missing tables → 503 "not set up yet".
- [ ] `src/lib/audit/registry.ts` — family `npd.`.

## Task 4 — registries + UI

- [ ] `accounting-tabs.ts`, `view-tabs.ts`, `feature-permissions.ts`, `pages/visibility.ts`,
  `presence/page-label.ts` (`npd` → "NPD"), `collab/CollabLayer.tsx` labels.
- [ ] `src/components/npd/NpdNavLabel.tsx` — SWall's clip-path wipe, `group-hover`.
- [ ] `src/components/npd/useNpdSheet.ts` — load, local rows, undo/redo, debounced autosave,
  flush-before-switch, conflict state, `beforeunload` while dirty.
- [ ] `src/components/npd/NpdSheetGrid.tsx` — table-keep grid, sticky head + first columns,
  selection, single floating editor, paste/copy/clear, keyboard map.
- [ ] `src/components/npd/NpdDashboard.tsx` — tabs, week stepper + weeks-with-data menu, status,
  toolbar, conflict banner.
- [ ] `Sidebar.tsx` (item after Payroll Wizard), `App.tsx` (case `npd`).

## Task 5 — verify + document

- [ ] `npm test` for the new files, `tsc --noEmit`, a rendered screenshot of the grid + nav label.
- [ ] `docs/features/npd-dashboard.md`, INDEX row, memory `npd-new-payroll-dashboard` + MEMORY.md,
  session-log Open items row (migration + grant PENDING). One commit, explicit paths, no push.
