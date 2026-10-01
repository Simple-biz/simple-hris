# Accounting Scoreboard backfill — the board's past from Carla's sheet

**Brief:** in-session 2026-10-01 (session `0cbcdde0`). Kane: *"https://simple-hris.vercel.app/accounting-scoreboard -
lets backfill the data - and use this Sheet please"* (a link to the sheet's "Totals - History" tab), then *"add it
into the system for that domain"*. Built under the 2026-09-26 blueprint rule: CHOSEN 1–6, no NEEDS. Kane's message
is the write approval that item 315's owed (d) waited on. Governing doc: `docs/features/accounting-scoreboard-backfill.md`.

**Stack:** pg (one transaction) for the fill and the migration, the HRIS Sheets service account
(`spreadsheets.readonly`), `node --import tsx --test`.

**CHOSEN as posted:** (1) cut-off through Sat 9/26, and a day belongs to the sheet or the board, never both;
(2) exact label or a new ARCHIVED row, with "Others" joining the one "& Others" row and no merging on similarity;
(3) every write stamped `sheet-import` and undoable; (4) Holiday placeholders skipped, CAD amounts dropped from
their line, PM ticks, chargeback levels and payroll accuracy not imported; (5) "Totals - History" kept as typed at
`/accounting-scoreboard/archive`, not linked from the board yet (`ScoreboardApp.tsx` was mid-edit by session
`9fe90c48`). Added mid-build: (6) the board's All Time/record read moves to a weekly view, because ~10k imported lines
would be 10+ pages on every refresh (measured 3.5 s vs 0.56 s).

## Task 1 — the data layer

- [x] `references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql`: `accounting_scoreboard_archive` (tab,
  sheet row, cells as a JSON array, column-A date, imported stamps; RLS on, 0 policies, revoked) and the
  `accounting_scoreboard_collection_weeks` view (live points per rep row per Sunday week; security_invoker, revoked).
- [x] `scripts/apply-accounting-scoreboard-backfill-migration.mts`: dry / `--apply` / `--verify`, privilege checks,
  a positive control (the view drops a deleted line and keys weeks by Sunday), 5 negative controls.
- [x] Dry run passed every check. `--apply` committed. `--verify` re-passed. Anon refused (42501) on both objects.

## Task 2 — pure parsers + tests

- [x] `src/lib/accounting-scoreboard/sheet-import.ts`: `parseCollectionLog`, `resolveRowLabel`, `parseHistoryBlock`
  (header-only alignment, data columns only, ≥ 75% of ≥ 5 informative rows), `parseArchiveTab`.
- [x] `sheet-import.test.ts`: 19 tests on the measured shapes (summary rows, Holiday, CAD, a week pasted one column
  off, a week pasted a whole day late, a sheet formula bug, a pair holding two numbers, dates listed twice, a weekend
  in a header, unlabelled rows). Fake names only.

## Task 3 — the fill

- [x] `scripts/backfill-accounting-scoreboard-from-sheet.mts`: reads 3 tabs, backs up the five tables, computes the
  cut-off, plans rows/lines/entries/archive, inserts in one transaction, reads back 11 checks, writes a report,
  commits only on `--apply` with every check passing. `--undo` removes only what is stamped.
- [x] Dry run, then `--apply`: 9,852 lines, 41,888 entries, 66 archived rows, 615 archive rows. All 11 checks passed.
  A re-run planned 0.

## Task 4 — server + page

- [x] `server.ts` `readBoard`: history from `COLLECTION_WEEKS`, with `liveSince` from `first_date`.
  `scoring.test.ts` pins that week rows equal line rows. On live data the two reads are identical.
- [x] `archive-server.ts` (paged, server-only), `app/accounting-scoreboard/archive/page.tsx` (member gate, as the board),
  `ArchivePanel.tsx`. `host.test.ts` pins `/accounting-scoreboard/archive` as not role-gated at the edge.
- [x] Rendered from the 615 live rows in headless Chrome against the compiled stylesheet: 1360 px, and a true 390 px
  frame in light and dark. Signed-out request: 307 to `/login?callbackUrl=/accounting-scoreboard/archive`.

## Task 5 — docs

- [x] `docs/features/accounting-scoreboard-backfill.md`, an INDEX row, the board doc's "Not built" line, the
  `components.md` row, an Open items row, and memory `accounting-scoreboard-backfill`.

## Left open

- The current week (Sep 28 – Oct 2) is the board's and was not filled. The sheet held 111 lines for it on 10-01.
- A link to the archive from the board's header.
- The push (until then the deployed board pages the whole log for All Time), and a signed-in look.
