# Manager → My Team → PM Team → Rankings (ranked by bonus earned)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [x]` syntax.

**Goal:** PM Team's **Rankings** view ranks the current roster by the **bonus they earned**,
averaged per day worked, per week and per month over a chosen window, for All bonuses or any single
KPI. It **shows KPI item counts only**. It is built like Lead Gen's Rankings leaderboard.

**Spec:** the `BLUEPRINT` brief posted in session `fdd8a4bd` on 2026-09-26, then **re-posted whole**
after Kane's mid-build revision: *"this should be based on their Bonus - now make sure if their
bonuses have changes we still have adaptability and hook the money like the highest money value
without displaying it"*. It has no `NEEDS` lines. The brief's `CHOSEN` lines after the revision:

| # | Choice | Consequence |
|---|---|---|
| 1 | Lead Gen's leaderboard shape | per day / week / month · Last 4 weeks / 3 months / All · podium · tenure · settled weeks only |
| 2 | ORDER = bonus pesos, server-side; SHOWN = KPI item counts | only positions leave the server; the shown averages are not always in rank order |
| 3 | KPIs from the data | every one-variable bonus, keyed by variable and labelled with its newest bonus name; `PM_KPI_VARS` = availability only |
| 4 | non-one-variable rows left out | Scott Cameron's team-total row: out of counts AND order, counted in a footer |
| 5 | data-driven availability | only `pm_team` carries the PM variables (measured) |
| 6 | My Team's gate | `authorizeManagedDepartment`, both reads |
| 7 | SP Rankings tightened | `hasSpRankings` / `buildRankingWeeks` need `SP` **and** `Ranking` |

**Superseded by the revision:** the first brief's "All KPIs = unweighted sum ranked on counts" and
"a fixed list of eight variables". The unweighted sum survives only as the SHOWN "All" figure.

## Global constraints

- **No peso leaves the server.** `amount` is selected by this one read and consumed by
  `deliverable-money-order.ts` (server-only). `toClientPayload` is the only exit. A sentinel
  serialization test guards it.
- **A row counts only when its `vars` hold exactly ONE key.**
- **Reuse, never copy:** `computeLeaderboard`, `indexRosterPeople`, `badgeWeeks`,
  `readWeekBadgeInputs`, `AppointmentLeaderboardPane`, `getDepartmentDaysWorked`.
- Out of scope: KPI Calculator, Payroll Wizard, bonus formulas, every write path, the employee
  team tab UI, `rankings-viewers.ts`, the Appointments view, and Lead Gen's order.
- Stage by explicit path. Commit direct to `main`. **Never push.**

## Task 1 — Shared pieces lifted out (behaviour unchanged)

- [x] `badgeWeeks()` in `src/lib/manager/appointment-rankings.ts`; `buildAppointmentWeeks` calls it.
- [x] `readWeekBadgeInputs()` in `src/lib/supabase/appointment-rankings.ts`.
- [x] `computeLeaderboard` sums an optional per-row `parts` map (absent on appointment rows, and tested).

## Task 2 — Pure modules + tests

- [x] `src/lib/manager/deliverable-rankings.ts` (client-safe): `kpiItemFromVars`,
      `projectDeliverableWeeks`, `applyMoneyOrder`, the payload types.
- [x] `src/lib/manager/deliverable-money-order.ts` (server-only): `buildKpiData`,
      `buildMoneyOrder`, `toClientPayload`. Tests: order by pesos, no peso serialized, no client import.

## Task 3 — Read + route

- [x] `src/lib/supabase/deliverable-rankings.ts`: probe → paged department read → badge inputs →
      roster → order; `?basis=daily` adds the days read. Projection pinned.
- [x] `app/api/manager/deliverable-rankings/route.ts`, with both reads added to the route guard test.

## Task 4 — SP Rankings tightening

- [x] `isSpRankingRow` = `SP` + `Ranking`; used by `hasSpRankings` and `buildRankingWeeks`. Tests.

## Task 5 — UI

- [x] Opt-in props on `AppointmentLeaderboardPane` (`unit`, `controls`, `partLabels`, `notes`,
      `animationKey`, `reorder`, `rankNote`), each defaulting to Lead Gen's behaviour.
- [x] `src/components/manager/DeliverableLeaderboardPane.tsx` (KPI picker, count projection, order).
- [x] `ManagerApp.tsx`: fetch, hold, stack under the one Rankings pill, daily read in the background.

## Task 6 — Verify + document

- [x] Full suite 4,748/4,750 (2 failures predate this work; both fail on HEAD) · tsc clean except the
      stale `.next/types` · a live read-only run (43 ranked, 0 unplaced, no `amount` in the payload).
- [x] Feature doc, INDEX + README rows, sibling docs, reference docs, memory, Open items 237, one commit.

## Widening — every per-person KPI-bonus department (2026-09-27)

Kane: *"Lets create a rankings tab for OTHER Departments as long as they were assigned a KPI Bonus"*.
The brief was posted in session `fdd8a4bd` with no `NEEDS`. Its CHOSEN lines: (1) only one person's own
KPI counts (one variable · not `shared_team` · not employee-scoped, on evidence); (2) a value is shown
only when the formula multiplies the variable by a rate, so Client VA `=Appt_Bonus` is order-only;
(3) departments with their own Rankings view keep it (appointments, SP); (4) HSL is not built here;
(5) no picker with one KPI.

- [x] `sp-ranking-row.ts`: `isSpRankingRow` lifted to a pure module, re-exported by `team-rankings.ts`.
- [x] `classifyBonuses` + `isCountVariable` + served-elsewhere in `buildKpiData`; `PM_KPI_VARS` removed.
- [x] Read: 3 one-row probes, `bonus_id` in the projection, catalog defs + assignments (server-only).
- [x] Client: `shown` / `hidden`, `metricShowsValues`, `kpiVariableLabel`; the pane's `showValues`.
- [x] Cache keys renamed `dept:kpi-rankings:` / `dept:kpi-daily:`.
- [x] Live read-only run over 14 departments; docs, INDEX, memory, Open items 238.
- [ ] HSL — its own brief (Open items 238).
