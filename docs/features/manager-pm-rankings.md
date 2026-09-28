# Manager KPI Rankings — every KPI-bonus team ranked by bonus earned, shown as KPI items only

Manager → My Team → **PM Team** (and, since 2026-09-27, **every other department on a per-person
KPI bonus**: Edit, Site Building, Sales Assistant, Discovery, Client VA) → **Rankings**. It ranks the
department's **current roster** by
the **KPI bonus they earned**, averaged per day worked, per week or per month, over **Last 4 weeks ·
Last 3 months · All time**, for **All bonuses** or any single KPI. What is shown is **KPI item counts
only** (reviews, sales, AMPlify, Site Star): the pesos decide the order on the server and never reach
the browser. It is built for the department's own managers. Shipped 2026-09-26/27 (session
`fdd8a4bd`), from Kane's *"My Team - PM Team - Rankings I want you to create a ranking tab similar to
Lead Gen and AI/API Team"* and, mid-build, *"this should be based on their Bonus - now make sure if
their bonuses have changes we still have adaptability and hook the money like the highest money
value without displaying it"*. Widened on 2026-09-27: *"Lets create a rankings tab for OTHER
Departments as long as they were assigned a KPI Bonus this way we can let the Managers see who is
top performing"*. Plan: [2026-09-26-manager-pm-rankings.md](../superpowers/plans/2026-09-26-manager-pm-rankings.md).
The doc keeps its first slug; the surface is no longer PM-only.
It is a sibling of Lead Gen's [appointment leaderboard](./manager-appointment-leaderboard.md), and it
renders **the same pane** and runs **the same `computeLeaderboard`**. Not pushed.

## Key files

| Piece | File |
| --- | --- |
| Counts, the KPI projection, applying the order (client-safe, pure, tested) | `src/lib/manager/deliverable-rankings.ts` · `.test.ts` |
| Pesos → positions; which rows count and which values show (**server-only**, pure, tested) | `src/lib/manager/deliverable-money-order.ts` (`classifyBonuses`, `isCountVariable`, `buildKpiData`) · `.test.ts` |
| "Is this an SP department" (one rule, shared with SP Rankings) | `src/lib/manager/sp-ranking-row.ts` |
| The reads (3 probes, paged applied read, catalog defs + assignments, roster, days) | `src/lib/supabase/deliverable-rankings.ts` · `.test.ts` |
| Route (`?basis=daily` for the second read) | `app/api/manager/deliverable-rankings/route.ts` |
| The gate (shared with Lead Gen's views) | `src/lib/manager/managed-department-gate.ts` · guard test `src/lib/manager/appointment-rankings-route.test.ts` |
| Shared badge + fill-forward, and the badge-input reads | `badgeWeeks` in `src/lib/manager/appointment-rankings.ts` · `readWeekBadgeInputs` in `src/lib/supabase/appointment-rankings.ts` |
| The leaderboard math (shared, unchanged rules) | `computeLeaderboard` in `src/lib/manager/appointment-averages.ts` |
| The pane (wrapper: KPI picker, projection, order) | `src/components/manager/DeliverableLeaderboardPane.tsx` → `AppointmentLeaderboardPane.tsx` |
| The fetches and the view state | `src/components/manager/ManagerApp.tsx` (`deliv`, `delivDaily`, `delivView`) |
| Each settled week's own bonus order, for the row's **View** modal (`order.weeks`) | `buildWeekOrder` in `deliverable-money-order.ts` · `weekRankLookup` in `deliverable-rankings.ts` — [manager-rankings-history.md](./manager-rankings-history.md) |

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
- **The weekly order carries each settled week's OWN order too** (`order.weeks`, 2026-09-28), for the
  row's **View** modal's *Ranking performance* line. It is positions and a per-week "of N" only, and the
  sentinel test asserts the field is in the JSON it scans. The client never ranks a KPI week from
  counts ([manager-rankings-history.md](./manager-rankings-history.md)).

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
- **No department list anywhere.** Which departments have the view follows from their data (the
  next two sections). The 2026-09-26 `PM_KPI_VARS` signature list is **gone**: it gated
  availability to PM's variable names, and the widening made it wrong.
- The read is **the whole department**, never filtered by variable, so tomorrow's bonus is in it.
  Three one-row probes run first, in parallel (any KPI row? an appointment variable? an `SP` +
  `Ranking` row?), so a department with nothing to show, or one served by its own view, costs three
  tiny queries and pages nothing. Lead Gen answers in ~350 ms.

## Which departments get it

A department gets the KPI leaderboard when it has **at least one row that is one person's own KPI**
and **no Rankings view of its own**. Measured read-only 2026-09-27:

| Department | Result | Why |
| --- | --- | --- |
| PM Team | 8 KPIs, 43 ranked | one-variable count bonuses |
| Edit | *Tickets completed*, 52 ranked | `=Tickets_Completed*50` |
| Site Building | Sites Built + Sites Checked, 7 ranked | `*50` / `*250` |
| Sales Assistant | *Units sold*, 10 ranked | `=Units_Sold*150` |
| Discovery | *Units sold*, 3 ranked — **all tied #1** | `=Units_Sold*25`, identical values for all three every week |
| Client VA | **order only**, 72 ranked | `=Appt_Bonus`: the variable IS the pesos |
| Lead Gen · Callback | own view | an appointment variable → the [appointment leaderboard](./manager-appointment-leaderboard.md) |
| AI/API Team | own view | `SP` + `Ranking` rows → `RankingsPane` behind the SP doors |
| HR · QC · Accounting | none | every bonus is a **shared-team split** |
| US Manager Bonus | none | one person's **employee-scoped** bonus |
| HSL (20 sub-teams) | **not built** | scores in `hsl_bonus_entries`, not the Payment Catalog. See *Not built* |

- **A department with its own view is left to it, never stacked with a second pane.** A
  money-ranked AI/API pane behind My Team's gate would widen who reads AI/API's ranking, and the SP
  doors are Kane's ruling ([manager-my-team.md](./manager-my-team.md) § *Rankings*). Lead Gen's
  appointment order already IS its money order (one rate). The test is data (`appointmentsFromVars`,
  `isSpRankingRow`), never a department list.
- **Looks like a bug, isn't: Discovery ties all three people at #1.** Every week they carry the same
  `Units_Sold`, which looks like a team figure entered per person, but the bonus is not flagged
  `shared_team`. The board reports the data. Flagging the assignment shared would remove the board;
  that is the catalog owner's call.

## Only rows that are one person's own KPI count

A row counts only when all three hold. Every other row is left out of **both** the counts and the
order, and a footer counts it.

1. **One variable.** **"Scott Cameron"** (`PM Team - Manager`) is ONE row a week with 15–17 keys of
   the whole team's totals. Counting it would hand the team's work, and its pesos, to one person
   (18 rows on 2026-09-27).
2. **Not a shared-team split** (`bonus_catalog_assignments.shared_team`). HR's
   `New_Hires*1000/HR_Team_Members`, QC's and Accounting's Dancing Queen pay every member the same
   share, so ranking them says nothing about who performed. **The figures are the team's too**
   (measured read-only 2026-09-28): every member's variables are identical in every week (HR 0 of
   20 weeks differ, QC 0 of 23, Accounting 0 of 22). Ranked anyway, the last 4 weeks tie everyone
   at #1 (HR 8, QC 9, Accounting 18), and a longer window orders people only by which weeks they
   were on the team. QC's per-officer `qc_score_assignments` is a seeded-random even deal, not
   performance. Kane asked for HR and QC boards on 2026-09-28; hard-stopped (Open items 247).
3. **Not an employee-scoped bonus.** One person's own bonus (Scott's, Lead Receptionist, Jackie) is
   not the team's KPI.

2 and 3 are decided on **evidence** (`classifyBonuses`). A bonus is left out only when this
department's assignments exist and none is department-scoped and unshared. A bonus with **no**
assignment keeps counting, so a retired bonus keeps its paid history. A failed catalog read fails
the whole call; it is never guessed.

**Seam:** a per-person bonus with two variables (the AI Team Bonus shape) is left out by rule 1.
Ranking it on pesos alone, with no count to show, is a new ruling.

## Shown, or order-only

A KPI's value may be **shown** only when its bonus formula **multiplies the variable by a rate**
(`isCountVariable`: `=Tickets_Completed*50`, `AMP*1250`, `=sum(Site_Star_Ranking*1000)`,
`IF(Appts_Set>=10, Appts_Set*500, …)`). Then the variable is a COUNT and the pesos derive from it.

- **Client VA's formula is `=Appt_Bonus`**: the variable IS the pesos (amount = value on all 95
  non-zero rows measured). Showing it would show pay. The server keeps the value, sends the KPI as
  `shown: false` and each person-week as bare presence (`hidden`), and the board is **order-only**:
  rank, name, weeks scored, tenure. No per-day / week / month figure, total or day count renders
  (`showValues={false}`), and the note says *"entered as an amount, not a count, so this board shows
  who earned the most — never how much"*.
- **Fails closed.** A missing or unreadable formula, a fixed-amount bonus, a `×1`, or ONE
  peso-valued bonus among several scoring the same variable → order-only.
- On **All bonuses** in a department that mixes both, the item sum and breakdown count shown KPIs
  only, and a note names the order-only ones (they still count toward the order).
- The formulas carry the pay **rates**, so they are read and used on the server only; the payload
  carries a boolean.

## One KPI, no picker

A department with **one** KPI gets **no picker** (ui-standards §9.4: a one-option dropdown is
noise). Its board reads in the KPI's own words (`kpiVariableLabel`: *"Tickets completed"*,
*"Units sold"*), because its bonus name is usually just the department's ("Edit", "Discovery").

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

- **Cached per department** (2026-09-27, Kane: *"so when I go to other departments it wont have
  to load the data again"*). Both payloads live in the Manager shell cache under `dept:` keys
  ([manager-dashboard-cache.md](./manager-dashboard-cache.md) § *Per-department views*).
  Returning to a department, switching tabs or reloading paints at once and revalidates in the
  background. The cached payload is counts + positions, so the cache carries no peso either.
- The weekly payload (counts + weekly/monthly order) is fetched when the department is selected.
  It takes **~6.5s cold** for PM Team (measured 2026-09-27; 7,121 applied rows plus the roster) and
  weighs ~140 KB (**169 KB since 2026-09-28**, with the per-week order for View: +24 KB, measured).
- `?basis=daily` returns the Hubstaff days (the shown per-day figures) **and** the per-day order in
  one call, because both need the slow days read. It loads in the background the first time the view
  is opened, the same pattern as Lead Gen's days. A failed daily read disables Daily; Weekly and
  Monthly are unaffected. The view opens on Weekly.
- Basis, window and KPI live in `ManagerApp` (`delivView`). My Team panes unmount on every view
  switch.

## Not built

- **HSL** (20 sub-teams, 591 people). Its KPIs are in `hsl_bonus_entries` (`kpi_data` +
  `calculated_bonus`), not `bonus_catalog_applied`. Its rail keys are `hsl:<sub>`, and card,
  roster and payout are three separate gates there (memory `hsl-data-branch-not-paid-by-wizard`;
  INDEX *HSL KPI Calculator → Payment Catalog migration*). It needs its own read and its own brief.
  Open items 238.

## Deploy notes

**No migration.** No env vars, no n8n, nothing for Kane to run. Reads only: `bonus_catalog_applied`
(with `amount`, server-side), `bonus_catalog_bonuses` (`id, kind, formula`, server-side, never
`amount`), `bonus_catalog_assignments` (`bonus_id, scope, department_key, shared_team`),
`hsl_bonus_period_status`, `app_settings` (`payroll.dispatch_lock.%`), `active_employees`,
`hubstaff_hours` (days, via `getDepartmentDaysWorked`). Committed locally.
**Not pushed; not deployed.**
