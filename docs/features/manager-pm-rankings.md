# Manager PM Team Rankings — the team ranked by bonus earned, shown as KPI items only

Manager → My Team → **PM Team** → **Rankings**. It ranks the department's **current roster** by
the **KPI bonus they earned**, averaged per day worked, per week or per month, over **Last 4 weeks ·
Last 3 months · All time**, for **All bonuses** or any single KPI. What is shown is **KPI item counts
only** (reviews, sales, AMPlify, Site Star): the pesos decide the order on the server and never reach
the browser. It is built for the department's own managers. Shipped 2026-09-26/27 (session
`fdd8a4bd`), from Kane's *"My Team - PM Team - Rankings I want you to create a ranking tab similar to
Lead Gen and AI/API Team"* and, mid-build, *"this should be based on their Bonus - now make sure if
their bonuses have changes we still have adaptability and hook the money like the highest money
value without displaying it"*. Plan: [2026-09-26-manager-pm-rankings.md](../superpowers/plans/2026-09-26-manager-pm-rankings.md).
It is a sibling of Lead Gen's [appointment leaderboard](./manager-appointment-leaderboard.md), and it
renders **the same pane** and runs **the same `computeLeaderboard`**. Not pushed.

## Key files

| Piece | File |
| --- | --- |
| Counts, the KPI projection, applying the order (client-safe, pure, tested) | `src/lib/manager/deliverable-rankings.ts` · `.test.ts` |
| Pesos → positions (**server-only**, pure, tested) | `src/lib/manager/deliverable-money-order.ts` · `.test.ts` |
| The reads (probe, paged applied read, roster, days) | `src/lib/supabase/deliverable-rankings.ts` · `.test.ts` |
| Route (`?basis=daily` for the second read) | `app/api/manager/deliverable-rankings/route.ts` |
| The gate (shared with Lead Gen's views) | `src/lib/manager/managed-department-gate.ts` · guard test `src/lib/manager/appointment-rankings-route.test.ts` |
| Shared badge + fill-forward, and the badge-input reads | `badgeWeeks` in `src/lib/manager/appointment-rankings.ts` · `readWeekBadgeInputs` in `src/lib/supabase/appointment-rankings.ts` |
| The leaderboard math (shared, unchanged rules) | `computeLeaderboard` in `src/lib/manager/appointment-averages.ts` |
| The pane (wrapper: KPI picker, projection, order) | `src/components/manager/DeliverableLeaderboardPane.tsx` → `AppointmentLeaderboardPane.tsx` |
| The fetches and the view state | `src/components/manager/ManagerApp.tsx` (`deliv`, `delivDaily`, `delivView`) |

## The order is the bonus; the pesos never leave the server

The order is **bonus pesos credited** (`bonus_catalog_applied.amount`, what the Payroll Wizard paid
from), averaged on the chosen basis. What is **shown** is KPI item counts. Both halves are rules:

- **This is the one My Team read that selects `amount`.** Its projection is pinned by a test:
  `period_start, period_end, employee_email, bonus_name, vars, amount`. Every other My Team read
  keeps `amount` out of its projection. Do not copy this read into one of them.
- **No peso crosses the wire.** Managers never see pay on My Team
  ([manager-my-team.md](./manager-my-team.md):13-17), and a payload ships pay "even with a clean
  render" ([employee-team-directory.md](./employee-team-directory.md):177-179). So the server ranks,
  and the response carries **counts and positions only** (`MoneyOrder`: every email each ranked
  person owns, plus a competition position per window × KPI). `toClientPayload` is the only way
  out and is built field by field. A test serializes it from **sentinel** amounts and fails on any
  of them, or on the word `amount` or `money`. The daily payload is pinned to `days` / `order` /
  `error`.
- **`deliverable-money-order.ts` is server-only.** It is pure so `node:test` can run it, and a
  source scan fails if any file under `src/components` or `app/` (outside `app/api`) imports it.
- **Never show a derived money figure**: no "score", no "% of the leader", no ratio. The ratio of
  two people's pesos IS their relative pay.
- **Looks like a bug, isn't:** the shown averages are **not always in rank order**. A Sale pays
  ₱2,500 and a SmartCustomer ₱500, so fewer, dearer items outrank more, cheaper ones. Measured
  2026-09-27, last 3 months, All bonuses: **22 of 43** people sit in a different place than a
  count order would give. #5 Rivera (4.5 items/wk) is above #6 Superta (5.0/wk). The header says
  *"Ranked by bonus earned · amounts hidden"*. Never "fix" the order to match the numbers.
- On a single KPI with one flat rate the two orders agree. TrustPilot: 0 of 43 moved.

## Adaptable: the KPIs come from the data

Kane: *"if their bonuses have changes we still have adaptability."*

- **Every ONE-variable row in the department is a KPI item.** It is keyed by its variable
  (`TrustPilot`, `Units`, …) and labelled with its **newest** row's bonus name. A bonus added to
  the catalog therefore joins the picker and "All bonuses" with no code change, and a rename reads
  as renamed.
- **A rate change reaches the order through `amount`.** Measured 2026-09-26, every PM bonus has paid
  one flat rate per item so far (TransUnion / TrustPilot / BBB / Facebook / Site Star ₱1,000,
  AMPlify ₱1,250, Sales ₱2,500, SmartCustomer ₱500). Today's order is therefore the rate-weighted
  count, and it will follow any future rate.
- **`PM_KPI_VARS` decides only WHETHER a department has the view**, like Lead Gen's exact
  `Appts_Set`. It never decides what is ranked inside it. Only `pm_team` carries those names
  (0 rows for every other department, measured 2026-09-26). If PM's bonuses were ever all
  re-created under new variable names, add one of the new names to that list.
- The read is **the whole department**, never filtered by variable, so tomorrow's bonus is in it.
  A one-row probe runs first so the other departments a manager opens (Lead Gen's 6,387 rows, and
  so on) cost one tiny query and page nothing.

## Only rows that are one KPI count

A row counts only when its `vars` hold **exactly one key**. **"Scott Cameron"** (`PM Team -
Manager`) is ONE row a week with 15–17 keys of the whole team's totals (`TrustPilot`, `BBB`,
`TransUnion`, … , `SP`). Counting it would hand the team's work, and its pesos, to one person. Rows
like it are left out of **both** the counts and the order, and a footer counts them (**18** rows on
2026-09-27). Scott is on the PM roster and so is simply not ranked.

**Seam:** a future per-person bonus with two variables (the AI Team Bonus shape) would be left out
the same way and counted in that footer. Ranking it on pesos alone, with no count to show, is a new
ruling.

## The leaderboard rules are Lead Gen's, unchanged

`computeLeaderboard` runs on both sides: counts in the browser for what is shown, and pesos on the
server for the order. Both run over the **same rows**, so they agree on the window, who has history
and who is ranked. Everything in
[manager-appointment-leaderboard.md](./manager-appointment-leaderboard.md) § *The three averages* and
§ *Which weeks count* holds here: **settled weeks only** (Finalized, With Accounting, pre-lock No
payroll record), the newest N counted weeks, **≥ 2 scored weeks** to be ranked, per month = per
week × 52/12, ties share a position (on pesos, as the server computed it), and the roster decides
who is ranked (`indexRosterPeople`).

- **No entry ≠ zero, per KPI.** On a single KPI, only person-weeks that HAVE that KPI's row count.
  Site Star exists only from 2026-05-17, and counting the earlier weeks as 0 would drag every Site
  Star average down. On All, a week counts when the person has any KPI row.
- **"All bonuses" shows an UNWEIGHTED item sum** plus a per-KPI breakdown under each name ("Total
  Sales and Referral 4.5 · TransUnion 3"). It is ranked on the summed pesos.
- **Half credits stand.** Units carries 0.5 steps (65 of 207 non-zero rows). Totals print one
  decimal when needed.
- **A row the server could not place goes LAST and is counted** ("N people couldn't be placed in the
  ranking order"). It is never silently ranked by counts. The two rosters come from the same source
  (`active_employees` through `departmentMatchesManagedAssignments`, exactly as
  `/api/manager/department-members`), so this should read 0. It read 0 on 2026-09-27.

## Who may see it: the shared My Team gate

`authorizeManagedDepartment`: the same helper Lead Gen's Appointments and Rankings reads call, and it
mirrors `/api/manager/department-members`. It never consults the SP Rankings doors
(`canViewTeamRankings` / `managerMayReadRankings`). Measured 2026-09-26: **8 live PM Team grants**
(kaner@, aliviah@, carla@, accounting@, hgk2ghobden@, scott@, ainsleyw@, claire@). jakec@ and alyson@
are revoked. The route takes no email parameter; the roster it ranks is resolved on the server from
the department just authorized. The guard test pins **both** reads behind the gate.

## One Rankings pill

PM Team's leaderboard **stacks under the one Rankings pill**, as the appointment leaderboard and
`RankingsPane` do ([manager-my-team.md](./manager-my-team.md) § *Per-department views*). Never a
second pill with the same name. While a newly selected department's appointment or PM read is in
flight, the view holds on a loading state instead of bouncing to People.

**Fixed in the same commit:** PM Team used to show a broken **SP** Rankings pane. Scott's manager row
carries an `SP` key, and `hasSpRankings` fired on any `SP` key, so `/api/team-rankings` listed every
one of PM's ~360 weekly rows (each person about 8 times) at SP 0. That was 12 weeks, visible to the 8
grant holders. `hasSpRankings` now needs **`SP` and `Ranking`** (the AI Team Bonus shape), and
`buildRankingWeeks` ranks only such rows ([employee-team-directory.md](./employee-team-directory.md)
§ *Which departments get a Rankings tab*).

## Loading

- The weekly payload (counts + weekly/monthly order) is fetched when the department is selected.
  It takes **~6.5s cold** for PM Team (measured 2026-09-27; 7,121 applied rows plus the roster) and
  weighs ~140 KB.
- `?basis=daily` returns the Hubstaff days (the shown per-day figures) **and** the per-day order in
  one call, because both need the slow days read. It loads in the background the first time the view
  is opened, the same pattern as Lead Gen's days. A failed daily read disables Daily; Weekly and
  Monthly are unaffected. The view opens on Weekly.
- Basis, window and KPI live in `ManagerApp` (`delivView`). My Team panes unmount on every view
  switch.

## Deploy notes

**No migration.** No env vars, no n8n, nothing for Kane to run. Reads only: `bonus_catalog_applied`
(with `amount`, server-side), `hsl_bonus_period_status`, `app_settings` (`payroll.dispatch_lock.%`),
`active_employees`, `hubstaff_hours` (days, via `getDepartmentDaysWorked`). Committed locally.
**Not pushed; not deployed.**
