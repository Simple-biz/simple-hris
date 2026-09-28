# Manager → My Team → Rankings → View (a person's KPI and ranking history)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [ ]` syntax.

**Goal:** every row of the two My Team leaderboards that have a **Tenure** column (Lead Gen /
Callback appointments, and every per-person KPI-bonus department) gets a **View** action after
Tenure. It opens a modal that animates in and out. The modal holds two line charts that share one
week axis: **KPI performance** (the person's count each settled week, against the team's weekly
average) and **Ranking performance** (the person's position each settled week, #1 at the top).

**Spec:** the `BLUEPRINT` brief posted on 2026-09-28, from Kane's *"My Team - Rankings - there
should be an action button after tenure labeled "View" where we can see a histogram via line graph
on KPI Performance and Ranking Performance where it will have data on how people are performing -
this means when we click view it will open up a modal make sure its smooth open and close with the
data inside it"*. It has no `NEEDS` lines.

| # | CHOSEN | Consequence |
|---|---|---|
| 1 | Both leaderboards that have Tenure | one pane (`AppointmentLeaderboardPane`) serves both; AI/API's SP board is untouched |
| 2 | Ranking = position each settled week | KPI depts: that week's bonus pesos, ranked on the SERVER, positions only; Lead Gen: that week's appointments |
| 3 | KPI = that week's count + a grey team-average line | All = unweighted item sum, per-KPI breakdown in the tooltip |
| 4 | Settled weeks only; own window toggle, seeded from the board | a week with no entry breaks the line, never 0 |
| 5 | Order-only KPI (Client VA) | rank strip only, plus the amount-not-count note |
| 6 | Charts always per week | the board's Daily basis does not change them |
| 7 | Ranked among the current roster with an entry that week | ties share a position |
| 8 | Two strips, one x axis, never two y-axes | dataviz rule + CycleTrendChart precedent |

## Global constraints

- **No peso leaves the server.** The per-week order is computed in `deliverable-money-order.ts`
  (server-only) and serialized as positions only. The sentinel test covers the new field.
- **The client never ranks a KPI week.** A rank computed from counts would contradict the board's
  bonus order (`manager-pm-rankings.md` § *The order is the bonus*).
- **Reuse, never copy:** `indexRosterPeople`, `COUNTED_BADGES` + the window rule (lifted out of
  `computeLeaderboard`), `projectMoney`, `PerfDetailModal`'s four dialog fixes, the
  `CycleTrendChart` drawing pattern.
- Out of scope: `RankingsPane` (SP), the Appointments pill, both gates, every write path.
- Stage by explicit path. Commit direct to `main`. **Never push.**

## Task 1 — Pure history module + tests

- [x] `countedWindowWeeks(weeks, window)` in `appointment-averages.ts`; `computeLeaderboard` calls it.
- [x] `src/lib/manager/ranking-history.ts`: `rankWeek` (competition positions over roster people
      with an entry), `buildPersonHistory` (one person's series: value, parts, team average,
      position, ranked).
- [x] `ranking-history.test.ts`: ties share, no entry ≠ 0, two emails in one week sum, leavers
      never ranked, window = newest N counted weeks, drafts left out.

## Task 2 — Server: each settled week's bonus order

- [x] `buildWeekOrder` in `deliverable-money-order.ts`: for every counted week × metric, rank on
      pesos via `rankWeek`, emit positions aligned with `MoneyOrder.people` plus the week's `ranked`.
- [x] `MoneyOrder.weeks` (weekly payload only) + `weekPositionFor` in `deliverable-rankings.ts`.
- [x] Tests: the week order follows pesos, not counts; the sentinel serialization still finds no peso.
- [x] `getDeliverableRankings` attaches it.

## Task 3 — UI

- [x] `RankingHistoryModal.tsx`: `PerfDetailModal`-style shell, stat tiles, window toggle, two
      strips (measured SVG, breaks at gaps, draw-on, crosshair tooltip), week table.
- [x] `AppointmentLeaderboardPane`: `View` column after Tenure (`stopPropagation`), modal state kept
      through the close animation, opt-in `weekRank` prop (default = the count order).
- [x] `DeliverableLeaderboardPane`: passes the server's week order for the chosen KPI.

## Task 4 — Verify + document

- [x] `node --test` (4,853 / 4,855 — the 2 failures are pre-existing, in untouched files); `tsc --noEmit` (clean outside a stale `.next` validator); `next build` SKIPPED — a live `next dev` owns `.next/`. Verified in that dev server instead (fixture page + Playwright, page deleted).
- [x] Measure the payload growth (read-only).
- [x] `docs/features/manager-rankings-history.md`, INDEX row, sibling cross-links, memory + `MEMORY.md`.
- [x] One commit by explicit path. Never push.
