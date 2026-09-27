# Manager → My Team → Appointments ranking

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [x]` syntax.

**Goal:** a per-department view on Manager → My Team, beside People, that ranks the department's
current roster by **appointments set**, weekly or monthly, with each person's **tenure**, and
badges every period that is not yet finalized by Accounting.

**Spec:** the `BLUEPRINT` brief (rev 3) posted in session `f73e6c13` on 2026-09-26 (audit log
`docs/audits/audit-2026-09-25-session-log.md` item **229**). Kane's rulings:

| # | Ruling | Consequence |
|---|---|---|
| Q1 | *"The my team tab lets you only see what Departments were assigned to you"* | gate = `/api/manager/department-members`'s scope, **not** `canViewTeamRankings`; a new route, SP Rankings untouched |
| Q2 | Monthly · weekly · daily; then (a) | Weekly + Monthly now. **Daily is not built** — every appointment count in the HRIS is weekly |
| Q3 | Every week, even not sent to Accounting, with a badge | drafts are visible to managers; badge ladder Not scored → Draft → With Accounting → Finalized |
| Q3b | Yes | the top badge is **Finalized by Accounting** (wizard lock); no "Paid" badge. Weeks before the lock record → grey "No payroll record" |
| Q4 | Recommendation | current roster only; leavers counted in one line, never ranked |
| Q5 | Recommendation | tenure = the roster row's Start Date (current stint), "1y 3m" |
| Q6 | Recommendation | data-driven: any department whose rows carry `Appts_Set` / `Appts` (Lead Gen and Callback today) |

**Architecture:** one pure module (`src/lib/manager/appointment-rankings.ts`) that decides every
rule, one server read (`src/lib/supabase/appointment-rankings.ts`) that only fetches, one route,
one pane, and a third department view in `ManagerApp.tsx`. **No migration.**

## Global constraints

- **No pesos.** `amount` is not in the projection (the test pins the string). Nothing on screen is ₱.
- **Exact variable names** `Appts_Set`, then `Appts`. Never `/appt/i` (client_va's `Appt_Bonus`).
- **Weeks join by the PARSED date range**, never the filename (`" 4.csv"`, a second `api_sync` file).
- **A failed status or lock read is "Couldn't check"**, never a guessed badge.
- **The roster decides who is ranked**: the same `membersForRailKey` list the People view shows.
- Out of scope: `/api/team-rankings`, `canViewTeamRankings`, `RankingsPane`, KPI Calculator, QC,
  every write path, wizard, paystubs, dispatch, the employee team tab.
- Stage by explicit path. Commit direct to `main`. **Never push.**

## Task 1 — Pure rules + tests

- [x] `appointmentsFromVars` — `Appts_Set`, else `Appts`, else null (not an appointment row).
- [x] `weekBadge` ladder — finalized (any file for the week `locked:true`) → with_accounting
      (status ready/locked) → draft (rows) → not_scored; pre-lock-record weeks → no_record;
      failed read → unknown.
- [x] `buildAppointmentWeeks` — per-week per-email sums, weeks newest first, the stepper never
      skips a week between the newest scored week and the current week.
- [x] `groupMonths` — month of the owning Monday (`payrollWeekMonthOrdinal`).
- [x] `rankAppointments` — roster join on all four emails, competition ranking (ties share a
      position), leavers counted, tenure from `start_date`.
- [x] `tenureLabel` — "1y 3m" / "3mo" / "12d" / "New" / "—".

## Task 2 — Server read + projection test

- [x] `src/lib/supabase/appointment-rankings.ts` — `bonus_catalog_applied` (paged, no `amount`),
      `hsl_bonus_period_status`, `app_settings` `payroll.dispatch_lock.%`.
- [x] Test: the projection string has no `amount`.

## Task 3 — Route

- [x] `app/api/manager/appointment-rankings/route.ts` — the department-members gate, mirrored.
- [x] Test (source scan): no `canViewTeamRankings`, `departmentMatchesManagedAssignments` used.

## Task 4 — UI

- [x] `src/components/manager/AppointmentRankingsPane.tsx` — Weekly | Monthly, stepper, badge,
      table (sortable by appointments or tenure), leavers line.
- [x] `ManagerApp.tsx` — `'appointments'` dept view, pill when `available`.

## Task 5 — Verify + document

- [x] `npm test` (new files) · `npm run lint` (tsc).
- [x] `docs/features/manager-appointment-rankings.md` · INDEX row · `manager-my-team.md` table ·
      memory · Open item 229 closed · one commit.
