# Accounting Scoreboard backfill — the board's past, filled from Carla's sheet, and the archive

The Accounting Scoreboard went live on 2026-10-01 with no history. This fill reads Carla's "Accounting Scoreboard"
Google Sheet and writes its past into the board's own tables. That covers the collections log back to 2024-12-30
and the Buckets, Inbox, PM Buckets and Sales Onboarding grids back to January 2025. The one tab no section can
hold, "Totals - History" (team totals, Oct 2021 → Dec 2024), is kept as typed on a read-only page,
`/accounting-scoreboard/archive`. Built and applied 2026-10-01 by session `0cbcdde0`, on Kane's *"lets backfill the
data - and use this Sheet please"* · *"add it into the system for that domain"*. The board itself is
[accounting-scoreboard.md](accounting-scoreboard.md). This doc covers only what the fill wrote and the rules it kept.

## Key files

| Piece | File |
| --- | --- |
| Archive table + weekly collections view | `references/sql/create/2026-10-01_accounting_scoreboard_backfill.sql` |
| Apply / verify the migration (dry by default) | `scripts/apply-accounting-scoreboard-backfill-migration.mts` |
| The fill itself (dry by default, `--apply`, `--undo`) | `scripts/backfill-accounting-scoreboard-from-sheet.mts` |
| Parsers and the alignment rule (pure) | `src/lib/accounting-scoreboard/sheet-import.ts` (+ `.test.ts`) |
| All Time and the record read the weekly view | `src/lib/accounting-scoreboard/server.ts` (`readBoard`, `COLLECTION_WEEKS`) |
| Archive read (server-only, paged) | `src/lib/accounting-scoreboard/archive-server.ts` |
| Archive page (member gate) | `app/accounting-scoreboard/archive/page.tsx` |
| Archive table | `src/components/accounting-scoreboard/ArchivePanel.tsx` |

## What came from where

| Sheet tab | Board table | Written 2026-10-01 | Rule |
|---|---|---|---|
| Collection Count | `accounting_scoreboard_collections` | 9,852 lines, 10,718 points, 91 weeks (2024-12-30 → 2026-09-25) | every line, as typed |
| History, Accounting Buckets | `accounting_scoreboard_entries` (am/pm) | 14,602 cells, 75 of 88 weeks | a week must prove its alignment |
| History, Email Inbox | entries (am/pm) | 14,209 cells, 80 of 88 weeks | same |
| History, PM Buckets | entries (day) | 9,221 cells, 71 of 88 weeks | same |
| History, Customer Sales Onboarding | entries (day) | 3,856 cells, 78 of 88 weeks | same |
| Totals - History | `accounting_scoreboard_archive` | 615 rows | kept as typed, nothing interpreted |
| (names with no board row) | `accounting_scoreboard_rows` | 66 new rows, every one ARCHIVED | exact label, never a near match |

Every row, line, entry and archive row the fill wrote is stamped **`sheet-import`** (`IMPORT_STAMP`), never a
person's email. All of it is INSERTs. The fill never UPDATEs anything.

## A day belongs to the sheet or to the board, never both

- The last day filled is the **Saturday before the week of the first number anyone typed on the board**:
  2026-09-26, because the team's first typed number is on 2026-09-28. A later `--through` is refused.
- On top of that, a collections day that already holds any line (typed or imported, live or deleted) is skipped
  whole. So is a section-day that already holds any entry. That makes a re-run a no-op (measured: 0 of everything),
  and it means a typed number is never mixed with a sheet number on one day.
- **So the current week (Sep 28 – Oct 2) is not filled, and the script cannot fill it.** On 10-01 the sheet held
  111 collections lines for that week and the board held the handful typed at go-live. One of those is
  a near-duplicate (the same account, with different points), so a blended import would count it twice. Whatever this
  week needs gets typed on the board.

## A History week is imported only when it proves its own alignment

The History tab is each week's grid, pasted in by hand. **The paste drifts:** in some weeks a row's numbers sit one
or two columns away from their date header, and the sheet's own weekly figures sometimes come from mis-referenced
formulas (one PM-bucket average covers only Thursday and Friday). Measured on 2026-10-01. So:

- A week is read **only at its header's own columns**: for an AM/PM block, the AM and PM column of each date. For a
  one-number block, the date's two-column pair, with the number in either half. Two numbers in one pair make the
  cell ambiguous, and it is skipped. **Only the week's data columns are read, never its Total.** An earlier draft
  that tried shifted windows "verified" a week by reading the weekly average back as Friday.
- The week is imported when **at least 75% of its informative rows** (`WEEK_VERIFY_SHARE`), out of **at least 5**
  (`WEEK_MIN_INFORMATIVE`), reproduce the figure the sheet pasted beside them. The figures are Σ(AM − PM) for
  Buckets, the PM average for Inbox, the week's sum for Onboarding and the week's average for PM Buckets. A row is
  informative when it has ≥ 2 numbers that are not all equal and a figure beside it. A one-number row must also have
  every day filled. On the real tab every imported week verified at 79–100%. The six weeks that had enough rows
  but fell short verified at 0–71%.
- When a week passes, **every** number of that week is imported, including the rows whose own figure disagreed
  (the sheet's formula bugs). A week is one paste: if most rows sit on their dates, all do. Those rows are listed
  under `disagreeing` in the report.
- A week that fails is skipped whole and reported with its reason, never partly imported and never re-aligned by
  guessing. Also skipped are dates the header lists twice (a week pasted twice, or a typo: both copies are dropped),
  a header whose dates are not one Monday-to-Friday week, and a date without exactly one AM and one PM column.
- A "-", "OFF" or other non-number stays absent (122 cells, all Inbox). A cleared cell is absence, never 0
  ([accounting-scoreboard.md](accounting-scoreboard.md) § Sections and scoring).

## Names: an exact label, or a new archived row

- A sheet name joins a board row when the labels match exactly (trimmed, case and inner spacing ignored), live
  rows first. A log rep with no exact match joins the one live row whose label lists it in a "&" group: the log's
  "Others" belongs to the row "<name> & Others" (verified: that row's History cells equal the log's "Others" points,
  7·3·3·2·3 for Sep 14–18).
- **Anything else gets a new ARCHIVED row** in that section, labelled as the sheet had it. An archived row is
  read-only, shows only in weeks it has numbers in, never makes anyone a member, and keeps a rep's points in the
  team totals ([accounting-scoreboard.md](accounting-scoreboard.md) § The collections log). **Names are never
  merged on similarity.** A sheet "Kev" is not the board's "Kevin", "Joshua" is not "Josh", and "Ryan / Ram" is not
  "Ryan": that would be guessing who someone is. Merging two rows later is a manager's call, and a separate change.
- Who each sheet name is stays in memory `carla-accounting-scoreboard-sheet`, not in this public repo.

## What was not imported, and why

- **Collection Count:** 17 lines that are only a date (pre-dated blanks) and 4 "Holiday" lines worth 0 points. These
  are placeholders, and imported they would count as collected accounts. **2 amounts typed in CAD** are imported
  with no amount: the line and its points stay, and the amount is never converted or read as dollars.
- **History, Collection Rep:** the log is the source. That block's own cells drift, and its totals skip rows.
- **History, Chargebacks** (one open count a day) and **Payroll Accuracy** ("days without a mistake"): no board slot
  holds either. Chargebacks are AM/PM on the board, so putting a level in one slot would invent the other.
- **PM meeting ticks:** History kept none (its MTG columns hold the shifted counts).
- **Sales tab:** the same onboarding numbers as History's block, over a shorter range.
- **Pauses** and **For MAIN ACCT SCORECARD:** not history. One is a pause log and the other a live daily feed.
- **The grids for Sep 21–25:** History stops at Sep 18. That week exists only in the log, so its collections are on
  the board and its Buckets/Inbox/PM/Onboarding cells are "—".

## The archive keeps "Totals - History" as typed

- `accounting_scoreboard_archive` holds one row per sheet row: the tab, the sheet row number, the cells as the sheet
  displayed them (a JSON array of strings), and column A as a date when it is one. **Nothing is interpreted.**
  "34/26", "Holiday", "--" and "FALSE" stay as typed, and the sheet's weekly "Total" lines stay as rows. Nobody has
  said what each column counts, and a parsed number would claim a meaning the sheet never gave. The sheet's own
  slips (8 dates typed twice, some weekend dates, a few out of order) are kept and noted on the page.
- `/accounting-scoreboard/archive` is **gated exactly like the board**: the member check runs in the page server
  component before anything renders (`resolveAccess('member')`). It is server-rendered and has no API route. Being
  under `/accounting-scoreboard` it also exists on `ACCOUNTING_SCOREBOARD_HOST` (`host.ts`), and like the board it is
  not role-gated at the edge (`host.test.ts` pins `requiredRolesFor('/accounting-scoreboard/archive') === null`).
- The table carries `table-keep`, so on a phone it scrolls inside its box with the date column pinned instead of
  collapsing into cards (`src/index.css`). Verified in headless Chrome against the compiled stylesheet at 1360 px
  and in a true 390 px frame, light and dark, rendered from the 615 live rows.
- **Not linked from the board's header yet.** `ScoreboardApp.tsx` was mid-edit by another session (`9fe90c48`), so
  the link is left to that file's next change. Until then the page is reached by its URL.

## All Time and the record read the weekly view, never every line

- The board's All Time column and record week used to page through every live log line on each load and on each 45 s
  refresh. With the history that is ~9,860 lines: measured **3.5 s** of sequential pages. `readBoard` now reads
  `accounting_scoreboard_collection_weeks`, one row per rep row and Sunday week: 566 rows, **0.56 s**, one page.
- `collectionsHistory()` is fed each week's Sunday as the date, which gives the same totals and the same record.
  `scoring.test.ts` pins that, and on the live data the two reads were compared and are identical. `liveSince` is the
  view's earliest `first_date` (2024-12-30). **Do not go back to reading the log for history.** The week view of the
  log (this and last week, every line) is still read in full, because it is short.
- The view is `security_invoker` **and** revoked from anon/authenticated, so it can never read past the log's
  lock-down. Anon gets `42501` on both new objects (checked 2026-10-01).

## What looks like a bug but isn't

- **The record is 189 points (week of Nov 30, 2025), not the sheet's "RECORD: 129".** The sheet's figure is typed
  and stale: 26 weeks in the log beat 129. 129 is the total of five ordinary weeks.
- **A past week lists names that are not on the board today.** These are the archived rows, next to today's live
  rows showing "—". Each section's rows changed over time, and the board shows what each week held.
- **The Dancing Queen preview now shows past weeks too.** It is still display only and writes no pay. Points or
  accounts is still item 315's open ruling.
- **Only a manager can delete an imported collection.** Its `created_by` is `sheet-import`, nobody's email.

## Re-running and undoing

- A re-run is safe and imports nothing twice (§ A day belongs to the sheet or to the board).
- `--undo` removes everything stamped `sheet-import`: lines, entries, archive rows, and the rows the fill created
  once nothing points at them. An imported number someone has since edited is no longer stamped, so it stays,
  along with its row. It is dry by default (`--undo --apply` commits), and it writes its own backup first.
- Every run writes a backup of the current tables and a full report to `docs/audits/backups/` (gitignored: names and
  business names). The report lists every skipped line, week and cell, with its reason.
- The sheet id is not in this repo. Pass it with `--sheet=<id>` (from memory `carla-accounting-scoreboard-sheet`).
  The HRIS service account reads the sheet with `spreadsheets.readonly`.

## Deploy notes

- **Migration: APPLIED 2026-10-01** by session `0cbcdde0`. The dry run passed every check, `--apply` committed,
  `--verify` re-passed, and the anon key is refused (`42501`). Re-check any time with
  `node --import tsx scripts/apply-accounting-scoreboard-backfill-migration.mts --verify`.
- **Backfill: APPLIED 2026-10-01** in one transaction after a clean dry run. All 11 read-back checks passed (counts,
  no typed row touched, weekdays only, points per week equal to the sheet for all 91 weeks, entries per section-day
  equal to the plan for all 1,510 section-days), and a re-run planned 0 rows. Backup and report:
  `docs/audits/backups/accounting-scoreboard-backfill-{backup,report}-2026-10-01T21-38-58-656Z.json`.
- **PENDING (Kane):** the push. Until it ships, the deployed board still pages the whole log for All Time
  (~3.5 s a load). After the push, a signed-in look at a past week and at `/accounting-scoreboard/archive`.
- No env vars, no n8n, no cron. Locally `.env.local` is production, so localhost shows the filled board.
