# Manager → Scheduling — what each person is expected to work, effective-dated

The Scheduling tab is where a manager records the days and hours a teammate is
*expected* to work, as a dated period rather than a flag. It lives at
Manager → Scheduling, between My Team and Transfers, and today it is **UI only** —
there is no route, no table and no migration behind it. It exists so the shape can be
agreed before any schema is committed. Shipped 2026-08-26.

## Key files

| Piece | File |
| --- | --- |
| Shift-window normalizer + tests | `src/lib/manager/shift-window.ts` · `shift-window.test.ts` |
| Schedule-period model + tests | `src/lib/manager/scheduling.ts` · `scheduling.test.ts` |
| Preview fixture (delete when wired) | `src/lib/manager/scheduling-preview.ts` |
| The panel | `src/components/manager/SchedulingPanel.tsx` |
| Tab registration | `src/lib/rbac/view-tabs.ts` · `ManagerSidebar.tsx` · `ManagerApp.tsx` |

## The unit is a PERIOD, never a field on a person

A schedule is not a property of a person; it is a property of a person *during a
stretch of time*. `SchedulePeriod` therefore carries `effectiveFrom` / `effectiveTo`
(inclusive both ends, `null` end = still current), mirroring the proposed
`employee_rest_day_patterns` and `employee_shift_windows` tables field for field.

Storing it flat would mean changing someone's rest days in October silently rewrites
what September's coverage looked like — every historical number moves under you. To
change a schedule you **close the current period and open a new one**; you never edit
a past period's days. `scheduling.test.ts` pins this ("changing a schedule does not
rewrite history").

`findOverlaps` treats two overlapping periods for one person as a **hard error, not a
warning**, and the panel renders it in rose above the table. An overlapping date has
two answers. The proposed unique index on `(lower(work_email), effective_from)` stops
exact duplicates but cannot stop a straddle, so the check lives in code too.

## `isScheduledDay` returns `boolean | null`, and the null is load-bearing

A date no period covers returns **`null`**, not `false`. "We have no schedule on file
for then" and "they were scheduled to rest" are different facts, and only the second
excuses an absence.

This is the same failure class as collapsing "no timesheet record" into "day off" on
the coverage work — the thing that whole workstream exists to end. The return type is
`boolean | null` specifically so a caller cannot forget the third case. **Do not
"simplify" it to a boolean.** A test named for the failure pins it.

## Rest days are checkable. Shift windows are not.

Measured 2026-08-26 against the live database:

- `hubstaff_hours` stores a per-day **total** and no clock times.
- The Hubstaff endpoint this system calls (`activities/daily`, `api-client.ts:65`)
  returns `{date, tracked, overall}` — no clock times.
- `user_presence` holds a single `last_seen_at` with no history.
- The only clock times anywhere are `time_adjustment_requests.requested_segments`,
  which record **missed** time — an exception log, not a record of hours worked.

So once this is wired, "scheduled Tuesday, no hours Tuesday" is answerable, because
both sides exist. **"Started three hours late" is not**, and cannot be until a
time-entry feed is added. Do not build an adherence metric on `shiftWindow` before
that feed exists — the panel says this on screen so nobody promises it upward.

## Shift windows are integer minutes, never text

`ShiftWindow` is `{ startMinute, endMinute }`, minutes from local midnight, and
`shiftWindowKey` is what groups by. The reason is measured: the only shift value in
the system today is `fpu_enrollments.shift_schedule_est`, free text, one row,
`"9 AM TO 5 PM EST"`. The moment someone types `"9:00 AM - 5:00 PM"` for the same
shift, a free-text column has two categories where there is one shift and every
"headcount per shift window" figure splits down the middle.

`parseShiftWindow` is a **rejecting** parser, not a guessing one — same discipline
`payrollWeekFilenameError` applies to Hubstaff batch names:

- Both halves carry AM/PM → 12-hour reading.
- Neither half carries AM/PM → 24-hour reading (`22:00-06:00` is a valid overnight).
- **Exactly one half carries AM/PM → rejected.** `"8-4PM"` has no honest reading, so
  it goes back to a human. Do not add an inference branch to make that pass.
- A zero-length window is rejected — it is the shape a half-filled form produces.

`end < start` means the window crosses midnight; `shiftDurationMinutes` and
`formatShiftWindow` (which appends `(+1d)`) both handle it. `formatShiftWindow` is the
ONE display form, so a shift never appears two ways in the same view.

## "Hours not set" is a state, not a zero

A period may legitimately have days on file and no window — it is common, and the
Attestation team in the preview is deliberately seeded that way. It renders as
**"Hours not set"** in amber and is counted in its own KPI. Defaulting a missing
window to midnight would be the same bug as the one above. In the edit dialog, both
time fields blank is a valid save; exactly one blank is refused.

## Managers see no pay here, and a schedule is not a pay input

`manager-my-team.md` §"Managers do not see rates or pay (anywhere)" applies in full:
nothing on this surface renders a rate, a premium or a peso figure.

Stronger, and the rule most likely to be broken next: **HSL already prices days by the
calendar** — the +₱15/h weekend premium, PAB weekday coverage, orphanage OT all ask
"is it a Saturday?". Once a schedule can answer "was it a scheduled day?", it is
tempting to let those rules read it instead. **Nothing in `scheduling.ts` feeds pay.**
A schedule describes expectation; rates stay keyed on the calendar. Wiring a schedule
into a pay rule converts a descriptive surface into a money path and is its own
decision under the `hardening` rules — not a refactor. See `hsl-weekend-ot-pay.md`
and `orphanage-pab-coverage.md` for what those rules currently key on.

## Seeding is the real cost, not the schema

591 active HSL people, none with a schedule on file. Doing that as 591 forms is how
the feature dies, so the panel leads with **team defaults**: five defaults reach most
of the roster in one pass, and per-person periods exist only where someone differs
from their team. `PREVIEW_TEAM_SIZES` carries the live per-team counts (Intake 187,
Filing 81, SSD Medical Records 56, Case Managers 55, Attestation 51) so the
"Not yet scheduled" KPI shows the real backlog rather than a tidy demo number.

`summarizeScheduling` counts `unscheduled` separately and always — "we scheduled the
team" must never quietly mean "we scheduled 60% of it".

## Expected cover by weekday is the one number a timesheet cannot produce

`scheduledHeadcountByWeekday` reads **forward**: it answers "how thin is Saturday
going to be" before the week, from schedules alone, with no timesheet involved. Every
other coverage figure in this system is retrospective. Weekend columns are tinted and
a zero-cover day renders rose, because thin weekend cover is the question managers
actually bring here.

## Deploy notes

**No migration.** No route, no table, no env var, no n8n import. The tab renders
`scheduling-preview.ts`, and every edit lives in React state — a refresh discards it.
The panel carries a permanent banner saying so.

When the backend is approved, the two tables are specified in the plan
(`employee_rest_day_patterns`, `employee_shift_windows`; both effective-dated). Wiring
them is: add the DDL under `references/sql/create/` with an `--apply` Node script,
add `GET /api/manager/scheduling` gated exactly like
`app/api/manager/department-members/route.ts` (`listDepartmentsForManager` +
`departmentMatchesManagedAssignments`, paged with `selectAllPaged`), then **delete
`scheduling-preview.ts`** and feed the panel from the route. `SchedulingPanel` is
already written against `SchedulePeriod`, so it should not need to change.

Scope note for whoever wires it: a manager granted the bare `HSL` family label vs a
specific `hsl:<sub_team>` is an **open ruling** — `normalizeDeptToKey` collapses every
`hsl:*` into one family key, so family-collapse scoping would let a sub-team manager
see all 591. Settle that before the route ships.
