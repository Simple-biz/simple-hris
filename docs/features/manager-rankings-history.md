# Manager Rankings → View — one person's KPI and ranking performance, week by week

Manager → My Team → any department whose **Rankings** board has a **Tenure** column (Lead Gen and
Callback's appointment leaderboard; PM Team, Edit, Site Building, Sales Assistant, Discovery and
Client VA's KPI leaderboard) → **Actions → View**. It opens a modal holding two line charts that
share one week axis. **KPI performance** plots the person's count each settled week against the
team's weekly average. **Ranking performance** plots their position each week, with #1 at the top.
Stat tiles and a week-by-week table sit with them. It is built for the department's own managers.
Shipped 2026-09-28 from Kane's *"My Team - Rankings - there should be an action button after tenure
labeled "View" where we can see a histogram via line graph on KPI Performance and Ranking
Performance … make sure its smooth open and close with the data inside it"*. Plan:
[2026-09-28-manager-rankings-history.md](../superpowers/plans/2026-09-28-manager-rankings-history.md).
It sits on top of [manager-appointment-leaderboard.md](./manager-appointment-leaderboard.md) and
[manager-pm-rankings.md](./manager-pm-rankings.md), and every rule in those docs holds here. Not pushed.

## Key files

| Piece | File |
| --- | --- |
| Every rule: the person's series, per-week ranks, ties, team average (pure, client-safe, tested) | `src/lib/manager/ranking-history.ts` · `.test.ts` |
| The window rule, lifted out of `computeLeaderboard` so both use one | `countedWindowWeeks` in `src/lib/manager/appointment-averages.ts` |
| Each settled week's bonus order, positions only (**server-only**) | `buildWeekOrder` in `src/lib/manager/deliverable-money-order.ts` · `.test.ts` |
| The payload field and the client lookup | `MoneyOrder.weeks` · `WeekPositions` · `weekRankLookup` in `src/lib/manager/deliverable-rankings.ts` |
| The modal (shell, tiles, notes, table) | `src/components/manager/RankingHistoryModal.tsx` |
| The two strips | `src/components/manager/RankingHistoryChart.tsx` |
| The View column and the modal's state | `src/components/manager/AppointmentLeaderboardPane.tsx` (`openHistory`, `weekRankFor`) |
| The KPI board's server order, handed to the modal | `src/components/manager/DeliverableLeaderboardPane.tsx` |
| The toggle and date helpers both share | `src/components/manager/leaderboard-ui.tsx` |

## A KPI board's weekly rank is the server's bonus order, never the counts

The KPI boards are ordered by **bonus pesos**, and no peso leaves the server
([manager-pm-rankings.md](./manager-pm-rankings.md) § *The order is the bonus*). A week's rank on
those boards is therefore decided on the server too:

- `buildMoneyOrder` (weekly basis only) now also returns `weeks`: for every settled week and every
  metric (All + each KPI), each ranked person's competition position on that week's pesos, plus how
  many roster people had an entry (the "of N"). **Positions only.** The existing sentinel
  serialization test now asserts the field is in the payload it scans, so it covers it.
- The client reads it through `weekRankLookup` and passes it to the modal as
  `rankBy: { kind: 'server' }`. **`ranking-history.ts` never ranks a KPI week from counts.** Doing
  so would contradict the board: fewer, dearer items outrank more, cheaper ones.
- **Looks like a bug, isn't:** the rank line and the count line can disagree in the same week. In the
  fixture check, a person with 4.5 items was #4 of 9 in a week where lower counts ranked above them.
  The header sentence says *"Each week is ranked by the bonus earned that week; the amounts are never
  shown."* Never re-rank to the counts.
- **Lead Gen / Callback rank on the counts** (`rankBy: { kind: 'values' }`, the default), because
  their appointments ARE their order (one rate). The pane's default must stay the counts, and only the
  KPI wrapper passes `weekRankFor`.
- **A payload cached before 2026-09-28 has no `weeks`.** The shell cache paints it
  ([manager-dashboard-cache.md](./manager-dashboard-cache.md) § *The rule*), so the lookup is null,
  the modal says *"Loading each week's bonus order…"*, and the rank tiles and cells read "…" until
  the always-on revalidation lands. It never falls back to ranking counts.
- Measured 2026-09-28 (read-only): the weekly payload grew **PM Team 145 → 169 KB** (21 weeks, 43
  people), **Edit 83 → 91 KB**, **Client VA 101 → 111 KB**. The read itself is unchanged.

## The weeks, the people and the averages are the board's

- **One window rule.** `countedWindowWeeks` is the function `computeLeaderboard` now calls, so the
  modal covers exactly the weeks the board would. That means settled weeks only (Finalized, With
  Accounting, pre-lock No payroll record), the newest N, with drafts and "couldn't check" weeks
  named in a footnote and never plotted. A test pins that the modal's **average per week and weeks
  scored equal the board's** row for the same window, for every person and every window.
- **The roster decides who is ranked**, through the same `indexRosterPeople`. A leaver's rows are
  in no week's rank and no team average, a person scored under two emails in one week is summed,
  and ties share a position (1, 2, 2, 4). Pesos are compared at cents, so a float sum never splits
  a real tie. The "of N" is that week's own count and varies week to week.
- **No entry ≠ 0.** A week without the person's row is `null`, and both lines break there with no
  point and no bridging segment. A saved 0 IS an entry and is ranked (last). This is the
  leaderboard's per-KPI rule ([manager-pm-rankings.md](./manager-pm-rankings.md)
  § *The leaderboard rules*).
- **The team average** is the mean over roster people with an entry that week, of the same value
  the person's line shows. On "All bonuses" that is the unweighted item sum of shown KPIs, as on the
  board.

## What the modal shows, and what it never does

- **Always per week.** The board's Daily / Weekly / Monthly basis does not change the charts: a week
  is the unit both reads share, and a per-day rank would need the slow days read for the order too.
  The header names the board position the row was opened from (*"#3 on the board (weekly average,
  last 3 months)"*).
- **Its own window toggle**, seeded from the board's window on every open. Changing it never moves
  the board. Switching it redraws the lines.
- **Order-only KPIs** (Client VA, `=Appt_Bonus`: the variable IS the pesos) get **no KPI strip, no
  value tile and no value column**. They show only the rank strip, "Weeks scored", the best and
  latest rank, and the amount-not-count sentence.
- **Never a money figure.** The same rule as both boards: no amounts, no ratios, no "% of leader".
  The modal's values are counts, and its ranks are positions.
- **It never fetches.** Everything comes from data the board already holds, so it opens straight
  onto its content.

## Smooth open and close

- The dialog primitive animates both ways (320 ms in, 180 ms out, `docs/design/ui-standards.md`
  § 10). **The pane keeps the row after close**: `historyOpen` flips and `historyRow` stays, so the
  exit animation plays on the person's data, not an emptied popup (checked mid-close on 2026-09-28).
  Clearing the row on close is the regression to avoid.
- The lines draw on after the dialog has scaled in (a `stroke-dashoffset` reveal, 160 ms late).
  Markers and labels fade in after them. Reduced motion shows the finished chart at once.
- The shell carries the four dialog fixes (`docs/design/responsive-design.md` § *Dialogs and
  modals*): `gap-0`, `max-h-[calc(100dvh-1.5rem)] sm:max-h-[92dvh]`, a `shrink-0` header and a
  `min-h-0 flex-1 overflow-y-auto` body, re-declared at `sm:max-w-3xl`.

## The View button

- It sits in an **Actions** column after Tenure, styled as the roster's own View button (outline,
  blue, `h-7`) with a line-chart icon, because this View opens performance, not the profile.
- **The row itself still opens the member profile** (`onOpenMember`). The button calls
  `stopPropagation`, so one click never opens both. The podium cards are unchanged.

## The chart rules

Drawn the way `CycleTrendChart` is (`src/components/admin/performance-ui.tsx`), kept local for
the same reason:

- **Two strips on one x axis, never two y-axes.** A count and a position share no scale.
- **Straight segments that break at a gap**, never a spline and never interpolated.
- **Lines only.** An area wash under the person's line buried the grey average and was removed:
  with two series, the dataviz rule is lines only.
- **Colours were validated with the dataviz palette validator on 2026-09-28**, not picked by eye.
  The person's line is blue-600 `#2563eb` on light and blue-500 `#3b82f6` on dark. Both pass the
  lightness band, contrast and CVD checks, and blue-400 failed the dark band. The team average is
  zinc-500 `#71717a`, **deliberately under the chroma floor**: it is the grey context line behind
  the one series that matters. Legend keys, tooltip rows and the table carry the names, so colour
  is never the only cue.
- **Selective direct labels**: the newest and the best point on each strip, never every point. A
  label that would leave the strip goes below its point.
- **The table is the chart's twin**: every value is readable without hovering. It is `table-keep`,
  so the phone rule does not restack it.
- **Hover and keyboard**: one full-height hit column per week, a crosshair, and one tooltip for
  every series at that week. The plot is focusable, the arrow keys, Home and End step through weeks,
  and an `aria-live` line reads each one.
- **On a phone the history is wider than the screen**, so the scroller opens at the newest week.

## Not here

- **AI/API Team's SP board** (`RankingsPane`) has no Tenure column. It is paged per week and sits
  behind its own two-door gate ([manager-my-team.md](./manager-my-team.md) § *Rankings*), so it has
  no View. Adding one would read `/api/team-rankings`, never this module.
- **The Appointments pill** (per-week totals, [manager-appointment-rankings.md](./manager-appointment-rankings.md)).
- **HSL** has no KPI leaderboard yet (Open items 238), so it has no View either.

## Deploy notes

**No migration.** No env vars, no n8n, nothing for Kane to run. No read changed. The KPI weekly
payload carries one new positions-only field (`order.weeks`). Committed locally. **Not pushed; not
deployed.**
