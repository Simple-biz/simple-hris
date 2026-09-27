# Manager Rankings leaderboard — top agents by average appointments set per day, week and month

Manager → My Team → **Lead Gen** (and any department that scores appointments) → **Rankings**. It
ranks the department's **current roster** by **average** appointments set: **per day worked**,
**per week**, or **per month**, over **Last 4 weeks · Last 3 months · All time**. The top three get
a podium, and every ranked person's tenure is shown. **No money values anywhere** (Kane,
2026-09-26). Built for the department's own managers. Shipped 2026-09-26 (session `f73e6c13`, audit
item 232); rulings are in [the plan](../superpowers/plans/2026-09-26-manager-appointment-leaderboard.md).
Sibling of the per-week totals view, [manager-appointment-rankings.md](./manager-appointment-rankings.md),
whose count, gate, roster match and tenure it reuses **unchanged**. Not pushed.

## Key files

| Piece | File |
| --- | --- |
| Every rule (pure, tested) | `src/lib/manager/appointment-averages.ts` · `.test.ts` |
| Roster → people (shared with Appointments) | `indexRosterPeople` in `src/lib/manager/appointment-rankings.ts` |
| Hubstaff days read (projection pinned) | `src/lib/supabase/appointment-days.ts` · `.test.ts` |
| The shared gate | `src/lib/manager/managed-department-gate.ts` · guard test `src/lib/manager/appointment-rankings-route.test.ts` |
| Days route | `app/api/manager/appointment-rankings/days/route.ts` |
| Weeks route (the Appointments view's) | `app/api/manager/appointment-rankings/route.ts` |
| The pane | `src/components/manager/AppointmentLeaderboardPane.tsx` |
| The pill, the days fetch, the view state | `src/components/manager/ManagerApp.tsx` (`leaderView`, `rankingsViewAvailable`) |

## Two callers of the pane and the math

Since 2026-09-26, `computeLeaderboard` and `AppointmentLeaderboardPane` also serve the **KPI**
Rankings of PM Team and (2026-09-27) every other per-person KPI-bonus department ([manager-pm-rankings.md](./manager-pm-rankings.md)). That view is ranked by bonus earned and
shows KPI items. It reuses them rather than copying them, so this doc's rules (settled weeks, window,
minimum history, the three averages, ties) hold on both. The additions are all opt-in, and each
defaults to this view's behaviour:

- `computeLeaderboard` sums an optional per-row `parts` map into `LeaderboardRow.parts`. Appointment
  rows never carry one, so a Lead Gen row has no `parts` field (a test pins it).
- The pane takes `unit` (default *appointments*, so every sentence here reads as before), `controls`,
  `partLabels`, `notes`, `animationKey`, `rankNote`, `reorder` and `showValues` (false = order-only: no figure anywhere; for a KPI whose variable is the pesos). **`reorder` is how PM Team applies
  a server-computed order without pesos in the browser.** This view passes none of them.
- The badge + fill-forward (`badgeWeeks`) and the badge-input reads (`readWeekBadgeInputs`) were
  lifted out of `buildAppointmentWeeks` / `getAppointmentRankings` unchanged, so PM Team's weeks badge
  by the same rule.

Never let a PM Team change alter this view's defaults. Lead Gen's order is still the shown average.

**Search** (2026-09-27) is built into the pane for both callers: names + WORK emails
(`rankings-search.ts`), never a personal email. It filters and never re-ranks, and it hides the podium
while a query is active ([manager-my-team.md](./manager-my-team.md) § *Rankings*).

## One "Rankings" pill; its content follows the data

Kane, Q1 → (a). My Team already had a **Rankings** pill for SP-scored teams (AI/API Team). There is
still **one** pill. SP weeks render `RankingsPane` behind **its own** gate (the one-name list, or an
exact-label grant; [manager-my-team.md](./manager-my-team.md) § *Rankings*). Appointment weeks
render this leaderboard behind **My Team's** gate. If a department ever carried both kinds of data,
the two would **stack** under the one pill. **Never add a second pill with the same name, and never
move either pane behind the other's gate.**

`rankingsViewAvailable` holds the view while a newly selected department's appointment read is in
flight. That is deliberate: without it the view bounces to People and back.

## Who may see it: the shared My Team gate

`authorizeManagedDepartment` is the 229 gate, lifted out of the Appointments route so both reads
call **one** function. It mirrors `/api/manager/department-members`: `department_managers` rows scope
even an elevated caller, and only an elevated caller with no assignments reads any department. It
never consults `canViewTeamRankings` / `managerMayReadRankings`. A source-scan test pins the helper's
order and that **both** routes read only after every refusal has returned. The days route takes
**no email parameter**; the roster whose days come back is resolved server-side from the department
just authorized.

## No money values

Kane, 2026-09-26: *"No money values should be displayed here."* The view shows counts and averages
of counts only. Two reads feed it, and both projections are pinned by tests:

- `bonus_catalog_applied`: `period_start, period_end, employee_email, vars`, never `amount` (the
  Appointments view's read, reused).
- `hubstaff_hours`: `Email, sunday, monday, tuesday, wednesday, thursday, friday, saturday`. The table
  also holds **`Spent total`** and **`Currency`**, which must never be selected. What leaves the
  server is an email, a week and a **count of days**, with no hours.

## The three averages

| Basis | Formula | Why |
|---|---|---|
| **Per day** | appointments ÷ **Hubstaff days worked** (a day counts with any tracked time) | Kane, Q2 → (a). Absorbs holidays: most of the 09-06 week was 4-day (Labor Day) |
| **Per week** | appointments ÷ **weeks the person has an entry for** (a saved 0 counts) | — |
| **Per month** | per week × **52 ÷ 12** | Kane, Q6 → (a). A hire month or the month in progress cannot shrink it |

- **A week with appointments but no Hubstaff days is left out of the DAILY figure only**, never
  divided by zero. It still counts for weekly and monthly, and the cell carries a `*` with the reason.
  Measured over four recent weeks, 0–4 agents a week were in this state.
- **Ties share a position on the value as SHOWN** (2 decimals daily, 1 weekly/monthly), then order by
  total. Two people both displayed as "5.0" are both #1.
- Daily needs the days to decide the **order**, so it shows a loading state until they arrive. It is
  never computed half-way. A **failed** days read disables Daily (the toggle shows Weekly) and says
  so; weekly and monthly are unaffected. The view **opens on Weekly**. The days read takes ~6s the
  first time per department (measured), and it loads in the background while Weekly renders.

## Which weeks count, and the window

- **Only settled weeks are averaged** (Kane, Q5): Finalized, With Accounting, and pre-lock "No
  payroll record" weeks (paid before the lock existed). **Drafts and "Couldn't check" weeks are left
  out and named in a footer.** A half-scored draft would drag every average down. This is the
  opposite of the Appointments view, which shows drafts with a badge. Both are rulings; **do not
  "align" them**.
- **The window is the newest N COUNTED weeks**: Last 4 weeks = 4, Last 3 months = 13, All time =
  every counted week. "Last 4 weeks" therefore always holds four settled weeks, even while the latest
  week is still a draft. The header prints the exact dates covered.
- **Minimum history** (Kane, Q4): fewer than **2** scored weeks in the window → "Not enough history
  yet", listed under the table and never ranked. On Daily, someone with no Hubstaff days in those
  weeks is also listed, not ranked.

## Days worked: deduped, weekly files only, case-insensitive

- **Max per person-week, never a sum** (INDEX *Hubstaff ingest*: readers dedupe). An api_sync +
  daily_report pair, a re-ingest, and the Monday-anchored `backfill-may10_2026-05-04_to_2026-05-10`
  (which lands on the 05-03 week) all describe the same days.
- **Weekly files only, by PARSED range.** A file counts when its name spans 7–8 days, so drifted names
  (`… 4.csv`, `…_2026-04-25 .csv`) are fine. That drops the 27-day
  `time-activity-report_2026-04-05_to_2026-05-02`: 14,094 rows, **none with an email**. Never use the
  junk-filename regex, which hides paid weeks.
- **Emails match case-insensitively.** 26 rows are `Alyson@`. That is why each weekly file is read
  whole (~1,100 rows) and filtered in memory; an exact `.in('Email', …)` would miss them (a test
  forbids it). Hubstaff keys on the **work** email, so a person's days are found through every email
  their roster rows carry.
- **Any failed file fails the whole read.** A partial read would under-count days and **inflate**
  daily averages.

## The roster decides who is ranked

The roster match, leavers counted rather than listed, duplicate-row merging and tenure = the latest
Start Date all come from `indexRosterPeople`. It is the **same** function the Appointments view
uses, so the two views cannot match a row to different people. **Looks alarming, isn't:** Lead Gen's
"no longer on the roster" line reads in the hundreds (455 emails over four weeks, measured
2026-09-26). That is churn, not a join failure: 361 had left, 93 were active in another department,
and **0** were active Lead Gen agents the match missed.

## Deploy notes

**No migration.** No env vars (the Hubstaff table honours `NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE`
like every other reader), no n8n, nothing for Kane to run. Reads only. Committed locally. **Not
pushed; not deployed.**
