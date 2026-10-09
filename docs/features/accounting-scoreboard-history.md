# Accounting Scoreboard History — every week, one bar per week for the Team Score and each Overview card

The **History** tab shows every week the board holds as a bar per week: the Team Score, then one chart per Overview card,
each bar coloured by that week's stop light. Above them sit three highlight cards (Team Score, Most often on track,
Needs attention), and beside them a rail of computed notes (greatest week, toughest week, longest on-track run, biggest
jump, record collections week, this week so far). It sits right after Payroll Problems in the tab row and the phone
menu. Anyone on the board sees it. Built 2026-10-09 (session `38387a37`) on Kane's *"lets add a newtab right after
payroll problems and label it - "History" This tab shows all the weeks and each KPI Card's performance like a histogram
we can see the performance each week if its going high or low. and add like 3 KPI Cards that would highlight important
stuffs. And like notes on the right side … like greatest week … Make sure the animation on that is smooth"*. The board
itself is [accounting-scoreboard.md](accounting-scoreboard.md); the build record is
[the plan](../superpowers/plans/2026-10-09-accounting-scoreboard-history.md).

## Key files

| Piece | File |
| --- | --- |
| Which weeks, every week's cards and Team Score, the highlights and the notes (pure) | `src/lib/accounting-scoreboard/history.ts` (+ `history.test.ts`) |
| One section's light and Team Score card for a week, shared with the Overview | `src/lib/accounting-scoreboard/board.ts` (`weekLight`, `sectionCard`) |
| The window read (server-only) | `src/lib/accounting-scoreboard/server.ts` (`readHistory`, § History) |
| Route | `app/api/accounting-scoreboard/history/route.ts` (`GET ?from=&to=`) |
| Browser cache | `src/lib/accounting-scoreboard/tab-cache.ts` (`acct-sb:history`, `readCachedHistory` / `writeCachedHistory`) |
| The tab | `src/components/accounting-scoreboard/HistoryPanel.tsx`; wired in `ScoreboardApp.tsx` (`historyAt`, `openWeek`) |
| How a card prints its number (shared with the Overview) | `src/components/accounting-scoreboard/shared.tsx` (`cardTitle`, `headlineFormat`, `headlineUnit`) |

## A week is the Overview's own, never recomputed another way

- Each week's card is `sectionHeadline` (its number), `weekLight` (its light) and `sectionCard` (its Team Score card),
  and the week's Team Score is `teamScore` over those cards grouped by the tab each sits on (`tabIdFor`). Those are the
  calls the Overview makes (`summarizeAll` in `ScoreboardApp.tsx`). `weekLight` and `sectionCard` were pulled out of
  `summarizeSection` and `summarizeAll` on 2026-10-09 so both surfaces share one copy. **`history.test.ts` replays two
  weeks (one on pace, one finished) through the Overview's path and through `historyWeeks`, and they must agree.** A
  History number computed any other way is the bug.
- **This week is judged on pace** and drawn as *so far* (a lighter bar); **a past week is judged on its full goal**, the
  same as browsing back to it on the Overview. Verified on production 2026-10-09 (read-only): the week of Sep 27 reads
  **76.5**, the Team Score `accounting-scoreboard.md` § Team Score measured for "last week" on 10-07.
- **The cards are today's Overview list** (`overviewSections`). A section switched off, or hidden from the Overview in
  Setup, has no chart and is out of every week's Team Score, the same rule as the Overview's.
- **Every week is judged against today's goal.** Goals are not versioned: no table holds when a goal changed. So a 2025
  week is judged against a goal Carla set in October 2026 (PM Buckets < 30, Outcomes ≥ 50%). That looks wrong and is the
  rule as built. Fixing it needs a goal-history table (a migration).
- **A week's Team Score counts only the tabs that had numbers that week** (left out, never 0, `team-score.ts`). Early
  2025 weeks hold only the sheet's tabs (Buckets, Inbox, PM Buckets, Sales, Collections), so their scores rest on fewer
  tabs than this month's. The chart's caption says so.
- **Rows are read archived too.** A past week belongs to the rows that held it (the backfill's closer rows are all
  archived). A row with no numbers in a week adds nothing to it.

## Absence is never a bar of 0

- A week with **nothing typed** has no bar, and the table prints "—". A **real 0** (0 problems logged) keeps a 2 px stub,
  so the two never look alike. A week **not read yet** is a quiet grey slot, never a 0.
- **Payroll Timing is not typed.** A cycle that ended before the first close-out (Aug 8) is never judged, so 2025 has no
  Payroll Timing bars. After that, a week the Wizard never closed is judged *missed* (red, 0), exactly as the Overview
  judges it (`accounting-scoreboard.md` § Payroll Timing). That is its own rule, not a blank read as 0.
- Colour is never the only signal: every chart's readout prints the week's word (On track, Close, Behind, Nothing typed,
  Not scored, Not judged), the key under the Team Score chart names each colour, and the table has a screen-reader word
  beside every dot.

## Reading: a quarter at a time, newest first

- **Measured 2026-10-09 (read-only):** 43,502 grid cells back to 2025-01-13 (growing ~500 a week), 10,074 live
  collection lines back to 2024-12-30, 175 rows, 64 payroll events. One read of every cell took **13.8 s to 71 s** from
  Kane's machine, and a 6-wide parallel read **silently dropped a page**. So History never reads every week at once.
- **The route answers one window**: `from` and `to` are Sundays, from ≤ to, **at most 26 weeks**, never past this week,
  never before 2023-12-31 (`parseHistoryWindow`; every refusal names its rule). The panel asks for **13 weeks at a time,
  newest first, one request at a time** (`historyWindows`), down to the first week with any number. Measured: 3–5 s a
  window from Kane's machine, about 25 s for all 7. The newest quarter paints first and older quarters fill in to its left.
- **Every list read is `selectAllPaged`**, and **any failed read fails the whole window** (`readHistory`): a week is never
  drawn from half its numbers. The panel retries a window once when the failure could pass (network, 5xx), then stops
  and names the weeks it could not load with **Try again**. Weeks already shown stay; the rest stay empty, never 0.
  Do not "speed this up" with parallel pages: that is the read that lost a page.
- **Collections reads the window's own log lines** (about 1.5k a quarter), so its math is the Overview's
  (`collectionsWeekStats`). The weekly view `accounting_scoreboard_collection_weeks` would give the same totals today
  (no weekend line exists, and only Mon–Fri can be logged), but it is the All Time read's, kept off every 45 s refresh
  (`accounting-scoreboard.md` § Weeks and days). History is read only when the tab opens.
- **Not part of `readBoard`, not on the live channel, not on the 45 s tick.** Opening the tab paints the browser cache
  (`acct-sb:history`, bound to the viewer like every scoreboard key) and then reads every window again. A teammate's
  number shows on the next open.

## What it points out

All of these read **full weeks only** (never this week, still running) and skip a week with nothing to judge. They
follow the range picked (12 weeks, 26 weeks, 1 year, All; default **All**, Kane's *"all the weeks"*). While older
quarters are still loading, the notes say *so far*.

- **Team Score card:** the last full week with a Team Score, the change from the scored full week before it, and the
  average over the scored full weeks shown.
- **Most often on track:** the card with the most on-track weeks (ties: the higher share, then the Overview's order).
- **Needs attention:** the card behind the longest run that is still going (2 weeks or more; a week with nothing to
  judge is skipped, not a break), else the card behind the most weeks. Neither shows when nothing was behind.
- **Notes:** greatest and toughest week by Team Score (a tie goes to the latest week), the longest run of on-track
  weeks (a week without a score ends it), the biggest one-week rise (a tie goes to the latest), Collections' record week
  (only while its card is on the Overview), and this week so far. Picking a note selects that week in every chart.
- These are computed, never typed. Typed notes per week would need a table and a migration.

## The tab

- **Placed right after the last built-in section's tab** (Payroll Problems when it is on), before any custom section's
  tab (`historyAt`), in the tab row, the phone menu and the slide order. The header's week arrows hide on History: it
  shows every week. **Open week** (and Enter on the Team Score chart) opens the picked week on the Overview.
- **One selected week across every chart.** Hovering any chart moves one band across all of them and every chart's
  readout reads that week; clicking pins it. The Team Score chart is one tab stop: Left/Right, Home/End and
  PageUp/PageDown move the pick, Enter opens it. The card charts are images with a spoken summary, and **Table** lists
  every week and every card without hovering.
- **Motion:** a bar grows from its baseline once, when it first appears (a CSS animation, staggered left to right over
  ~0.4 s), and a changed value eases to its new height. Changing the range redraws the charts and they grow again. The
  band glides between weeks. The highlight cards and notes rise in once. **Under reduced motion all of it is simply
  there.** The bars are memoized apart from the band and readouts, so moving the pointer never re-renders a thousand bars.
- Reference lines (0, the goal, the axis top; 75 and 90 on the Team Score) are hairlines labelled in a gutter right of
  the plot, never over a bar. The axis top's label steps aside when the goal sits within 18% under it.

## Deploy notes

- **No migration.** No env vars. No n8n import. Reads only.
- The route is new: `GET /api/accounting-scoreboard/history`. On the scoreboard host it passes under the existing
  `/api/accounting-scoreboard/*` rule (`host.ts`); nothing to configure.
- **PENDING (Kane):** push. Verified locally: 374/374 scoreboard tests, `tsc` clean, headless Chromium on the real
  `ScoreboardApp` fed the History payload computed from production (aggregates and section ids only, no names) at
  1440 light and dark and 390, reduced motion, a failing window, the table view and the keyboard. Not clicked through
  signed in on the deployed site.
