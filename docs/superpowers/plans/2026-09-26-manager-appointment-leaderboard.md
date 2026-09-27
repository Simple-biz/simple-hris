# Manager → My Team → Rankings (average appointments set)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [x]` syntax.

**Goal:** the department's **Rankings** view ranks the current roster by **average** appointments
set — per day worked, per week, per month — over a chosen window, so a manager can see the top
performers. **No money values anywhere** (Kane, 2026-09-26).

**Spec:** the `BLUEPRINT` brief posted in session `f73e6c13` on 2026-09-26 (audit item **232**).
Builds on the Appointments view (item 229, `3a0866cc`). Kane's rulings:

| # | Ruling | Consequence |
|---|---|---|
| Q1 | (a) one "Rankings" pill whose content follows the data | SP data → `RankingsPane` (its own gate); appointment data → the leaderboard; both stack if a team ever has both |
| Q2 | (a) daily = ÷ Hubstaff days worked | a new, paged Hubstaff read; a day counts when it has any tracked time |
| Q3 | (a) window picker | Last 4 weeks · Last 3 months · All time, opening on Last 3 months |
| Q4 | recommendation | ranked only with ≥ 2 scored weeks in the window; others listed as "Not enough history yet" |
| Q5 | recommendation | only Finalized / With Accounting (and pre-lock "No payroll record") weeks count; drafts named in a footer |
| Q6 | (a) monthly = avg/week × 52/12 | a hire month or the month in progress cannot shrink it |

## Global constraints

- **No money.** The applied projection stays pinned without `amount`; the Hubstaff projection is
  pinned to `Email` + the seven day columns + `upload_id` — never `Spent total` / `Currency`.
- **Days are deduped, never summed**: max per person-week across files and batches.
- **Weekly files only**: a Hubstaff file counts when its parsed range spans 7–8 days (the 27-day
  `time-activity-report` has 14,094 rows and no emails). Never the junk-filename regex.
- **Emails match case-insensitively** (26 `Alyson@` rows) — rows are read per weekly file and
  filtered in memory, never with an exact `.in()`.
- **The gate is the 229 gate**, lifted into one helper both routes call.
- Out of scope: the Appointments view's behaviour, `/api/team-rankings` + its gate, KPI Calculator,
  QC, wizard, paystubs, every write path.
- Stage by explicit path. Commit direct to `main`. **Never push.**

## Task 1 — Pure rules + tests

- [x] `indexRosterPeople` extracted from `rankAppointments` (unchanged behaviour, tests still green).
- [x] `weeklyHubstaffWeek` (7–8-day parsed range → Sunday) · `daysWorkedInRow` · `buildDaysWorked`.
- [x] `computeLeaderboard` — counted weeks, window, three averages, minimum history, ties on the
      shown precision, top 3.

## Task 2 — Hubstaff read + projection test

- [x] `src/lib/supabase/appointment-days.ts` — uploads list → weekly files → paged per file,
      bounded concurrency → roster-filtered, deduped days.

## Task 3 — Gate helper + route

- [x] `src/lib/manager/managed-department-gate.ts`; the 229 route calls it.
- [x] `app/api/manager/appointment-rankings/days/route.ts` — gate, then the roster resolved server-side.
- [x] Guard test covers the helper and both routes.

## Task 4 — UI

- [x] `src/components/manager/AppointmentLeaderboardPane.tsx`.
- [x] `ManagerApp.tsx` — the Rankings pill follows the data; days fetched only when opened.

## Task 5 — Verify + document

- [x] tests · tsc · a live read-only run.
- [x] `docs/features/manager-appointment-leaderboard.md` · INDEX row · `manager-my-team.md` ·
      `manager-appointment-rankings.md` (gate helper) · reference docs · memory · Open item 232 · one commit.
