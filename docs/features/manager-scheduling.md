# Manager → Scheduling — what each person is expected to work, effective-dated

The Scheduling tab is where a manager records the days and hours a teammate is
*expected* to work, as a dated period rather than a flag. Shipped 2026-08-26 as a
UI-only preview; **wired to a real table and moved inside the HSL department on
2026-09-14**.

**Where it lives: Manager → My Team → (HSL selected) → Scheduling**, a toggle beside
the department search bar. Kane: *"Scheduling will be inside HSL Department only so
when we click HSL Department we should have a tab inside it."* It is no longer a
top-level sidebar entry.

> **It is still gated on the `scheduling` feature key**, not on `team`. Rendering it
> inside My Team would otherwise have swapped its permission silently — it would have
> stopped being its own hidden-by-default top-level key and inherited `team`, so
> everyone with My Team would have gained it and anyone holding `scheduling` without
> `team` would have lost it. A relocation must not change who may see something, so
> the key stays registered in `view-tabs.ts` and still does the gating.

## Key files

| Piece | File |
| --- | --- |
| Shift-window normalizer + tests | `src/lib/manager/shift-window.ts` · `shift-window.test.ts` |
| Schedule-period model + tests | `src/lib/manager/scheduling.ts` · `scheduling.test.ts` |
| Row ↔ model mapping + the capability predicate | `src/lib/manager/scheduling-rows.ts` · `.test.ts` |
| The table | `references/sql/create/2026-09-14_employee_schedule_periods.sql` |
| Migration runner (`--apply`) | `scripts/apply-employee-schedules-migration.mts` |
| The route | `app/api/manager/scheduling/route.ts` |
| The panel | `src/components/manager/SchedulingPanel.tsx` |
| Tab registration (key only — no sidebar entry) | `src/lib/rbac/view-tabs.ts` · `ManagerApp.tsx` |

## Which departments carry Scheduling — HSL, and only HSL

`departmentHasScheduling` (`scheduling-rows.ts`) is the whole rule: the HSL family
qualifies, nothing else does. The **whole** family — the parent and every `hsl:*`
sub-team — because **the rail is the scoping control**: selecting the HSL parent sets
all 591, selecting a sub-team sets that team.

This is the first per-department surface. When a second department earns one, that
predicate becomes a lookup; one department does not justify a registry, and a
premature one reads worse than the rule it replaces.

> **The family-collapse ruling is SETTLED, by precedent, not by a new decision.**
> This doc previously left open *"whether a manager granted the bare HSL family label
> vs a specific `hsl:<sub_team>` … family-collapse scoping would let a sub-team
> manager see all 591. Settle that before the route ships."* Measured 2026-09-14:
> `departmentMatchesManagedAssignments` already normalises every `hsl:*` onto one
> family key, so such a manager **already sees the whole HSL family on their My Team
> roster**. The route is gated by that same function, so it inherits the behaviour
> rather than inventing it. Nothing new was decided; the open question was already
> answered by the code it was asking about.

## The unit is a PERIOD, never a field on a person

A schedule is not a property of a person; it is a property of a person *during a
stretch of time*. `SchedulePeriod` therefore carries `effectiveFrom` / `effectiveTo`
(inclusive both ends, `null` end = still current), mirroring the proposed
`employee_schedule_periods` table field for field (see *ONE table* in Deploy notes).

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

**MIGRATION PENDING — Kane runs it.**

*Re-verified 2026-09-15: a read-only `select` against production returns `PGRST205` — the
table is still absent, so the route is still answering `migrated: false`.*

```
node --import tsx scripts/apply-employee-schedules-migration.mts          # rehearse (rolls back)
node --import tsx scripts/apply-employee-schedules-migration.mts --apply  # COMMIT
```

The DDL is `references/sql/create/2026-09-14_employee_schedule_periods.sql`. The
script is **dry-run by default** — it applies inside a transaction it always rolls
back, then verifies 26 objects and runs 14 controls (3 positive, 2 trigger, 9
negative) proving each constraint actually rejects what it exists to reject. The
rehearsal was run against production on 2026-09-14 and every check passed; nothing was
committed. Needs `DATABASE_URL` (the **session pooler**, `@` in the password
percent-encoded as `%40`).

**Run order does not matter.** The route answers `migrated: false` when the table is
absent rather than 500ing, and the panel shows a banner naming the script. A surface
that quietly accepted edits it could not store would be the worse failure.

No env var, no n8n import, no cron, no new feature key.

### ONE table, not the two this doc used to name

Earlier revisions referred to *"the proposed `employee_rest_day_patterns` and
`employee_shift_windows` tables"*. **No DDL for them was ever written**, and the
shipped model contradicts the split: `SchedulePeriod` carries one id, one
`effectiveFrom`/`effectiveTo`, and rest days and shift window **together**. Two
independently effective-dated tables would allow a rest-day period of Jan–Mar to
overlap a shift-window period of Feb–Apr, and `SchedulePeriod` has no answer for what
February then is. This doc's own unique index — `(lower(work_email), effective_from)`
— is singular, describing one table. The two-table naming was vestigial.

### What the table enforces, so the UI cannot drift from it

- **both shift minutes or neither** — "hours not set" is a state, and a half-filled
  form is refused (`..._window_both_or_neither`).
- **no zero-length window**, and both minutes inside the day.
- `effective_to >= effective_from`.
- **rest days constrained to 0–6**, sorted and de-duplicated by trigger, so two
  equivalent sets compare equal and a diff-only write does not churn on ordering.
- the work email is lower-cased by trigger, and uniqueness is on `lower(work_email)`.
- **RLS enabled with no policies** — service-role only, reached through the gated
  route, never from the browser.

The reader mirrors each of these rather than trusting them: a row that somehow got
past the CHECK degrades to "hours not set", never to a window starting at midnight.
