# Accounting Scoreboard History tab — build record

> Executed in session `38387a37` on 2026-10-09, on Kane's *"lets add a newtab right after payroll problems and label it
> - "History" This tab shows all the weeks and each KPI Card's performance like a histogram … add like 3 KPI Cards that
> would highlight important stuffs. And like notes on the right side … like greatest week or something. Make sure the
> animation on that is smooth"*, through the `blueprint` skill. The governing doc is
> [accounting-scoreboard-history.md](../../features/accounting-scoreboard-history.md).

**Goal:** one tab that shows every week the board holds, as a bar per week for the Team Score and for each Overview
card, with three highlight cards and a rail of computed notes.

**Measured first (read-only, 2026-10-09):** 43,502 grid cells (first 2025-01-13), 10,074 live collection lines
(first 2024-12-30, none on a weekend), 175 rows, 64 payroll events, 10 problem lines. Reading every cell at once took
13.8 s to 71 s from Kane's machine, and a 6-wide parallel read dropped a page. So History reads in windows.

## Tasks

- [x] **1. Shared card rule.** `sectionCard()` in `board.ts`: a section's Team Score card for a week. The Overview's
  `summarizeAll` calls it, so History and the Overview cannot drift.
- [x] **2. Pure module + tests.** `history.ts`: `parseHistoryWindow` (Sunday keys, from ≤ to, ≤ 26 weeks, never past
  this week), `historyWeeks` (per week: every card's value, light, card score, and the Team Score), `historyWindows`
  (13-week windows, newest first), `historyHighlights` and `historyNotes`. `history.test.ts` replays one week through
  the Overview's math and through History and checks they agree.
- [x] **3. Server read.** `readHistory` in `server.ts` (moved from a planned `history-server.ts`: it needs `server.ts`'s private row and section mappers, and a copy would drift): every row (archived too), the window's cells, collection
  lines and problem lines, every payroll event and close, the section switches and custom sections, and the first
  week with any number. Every list read is `selectAllPaged`; any failed read fails the window.
- [x] **4. Route.** `GET /api/accounting-scoreboard/history?from=&to=`, `resolveAccess(null)` like the board GET.
- [x] **5. Browser cache.** `acct-sb:history` in `tab-cache.ts`, bound to the viewer like every scoreboard key.
- [x] **6. UI.** `HistoryPanel.tsx`: range pills, three highlight cards, the Team Score chart, one chart per card,
  the notes rail, a selected week shared by every chart, and "Open this week" on the Overview.
- [x] **7. Tab.** `ScoreboardApp.tsx` (after the last built-in tab, before custom tabs) and the phone menu.
- [x] **8. Verify.** Typecheck, the tests, headless Chromium on a synthetic board at 1440 light and dark and 390.
- [x] **9. Docs.** Feature doc, INDEX row, `accounting-scoreboard.md` key files, memory.

**Verified:** 374/374 scoreboard tests; `tsc` clean; production replay (read-only) of every window: the week of Sep 27
reads 76.5, the Team Score measured on 10-07; headless Chromium on the real `ScoreboardApp` fed that payload (aggregates
only) at 1440 light and dark and 390, reduced motion, a failing window (retried once, then Try again), the table, the
keyboard. Push is Kane's.
