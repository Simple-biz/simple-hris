# FPU groups, session attendance, and the eligible list that opens MESA

When an FPU class's enrollment is closed, HR divides the seated enrollees into groups, appoints a
leader for each, and the leader marks who turned up to each weekly session from their own Employee
dashboard. When the class's end date arrives HR **closes the class**: that publishes the
eligible/ineligible split, enrols the eligible into MESA, and is what starts their ₱100 deduction in
the Payroll Wizard. Shipped 2026-09-17. Sits inside [fpu-enrollment.md](fpu-enrollment.md), which
owns the classes and the enrollment window themselves.

## Key files

| Piece | File |
| --- | --- |
| The division (seeded, balanced) | `src/lib/mesa/fpu-groups.ts` (+ test) |
| Weekly sessions, derived | `src/lib/mesa/fpu-sessions.ts` (+ test) |
| The per-person verdict | `src/lib/mesa/fpu-attendance.ts` (+ test) |
| Server reads, leader resolution | `src/lib/mesa/fpu-groups-server.ts` |
| Preview / confirm / list / leader | `app/api/hr/fpu-classes/groups/{preview,confirm,list,leader}/route.ts` |
| Close the class | `app/api/hr/fpu-classes/class-close/route.ts` |
| Mark attendance | `app/api/fpu-attendance/route.ts` |
| HR surface | `src/components/hr/FpuGroupsPanel.tsx` |
| Employee surface | `src/components/employee/EmployeeFpuGroup.tsx` |
| DDL | `references/sql/create/2026-09-17_fpu_groups_attendance.sql` |
| Migration | `scripts/apply-fpu-groups-migration.mts` · `scripts/Apply FPU Groups migration.cmd` |

## The randomizer runs once per class, ever

HR types how many people per group and gets a preview. **The preview writes nothing**, and the
confirm **re-derives the same division from the seed** rather than accepting membership posted back
to it — otherwise a client could commit a split nobody reviewed, or one built from a population
that moved in between.

The seed is `classId|perGroup|roll`. `perGroup` is in it so that changing 4 to 5 produces a
genuinely different permutation rather than the same running order re-cut; `roll` increments each
time HR asks to shuffle again. The population is **sorted by enrollment id before shuffling** —
`seededShuffle` is deterministic in `(items, seed)` *including the order it was handed*, so an
unsorted read would deal differently on the next call from the same seed.

`Math.random()` is not an option here and is refused in writing by `src/lib/seeded-shuffle.ts:9-17`.

Once confirmed, membership is read from the rows and **the randomizer never runs again for this
class** — both `preview` and `confirm` answer 409 `alreadyDivided`. A re-deal would move people who
already have attendance marked against them. A latecomer is **balance-filled** into the least
loaded group (`leastLoadedGroupNo`); a leaver is stamped `left_on`, never deleted, so the marks they
already have stay truthful.

**The number is a target, not a cap** (Kane, 2026-09-17). 13 people at 4 per group is 4/3/3/3, never
4/4/4/1. One floor overrides the target: **nobody is grouped alone.** Five people at two-per-group
would ceiling to 2/2/1, so the group count is capped at `n/2` and it deals 3/2 instead. A group of
one is only possible when the whole class is one person.

## Sessions are derived, and a class with no end date has none

There is no sessions table. A class's sessions are every 7 days from `class_starts_on` through
`class_ends_on` inclusive, numbered from 1 (`fpuSessions`). The class row already carries both
dates; a stored copy would drift from them the first time HR edits the class, and every other weekly
grid in this app is derived per render.

The accepted cost: `class_ends_on` is nullable — "not announced" is a real state — so **a class with
no end date has no sessions and cannot be divided or attended.** Both group routes answer 409 with
that sentence rather than guessing a count. A span that is not a whole number of weeks simply stops
at the last session that fits: Oct 1 → Nov 8 is the six Thursdays through Nov 5, because nobody
meets in the trailing three days.

Only sessions that have **already happened** can be marked (`isMarkableSession`, Manila today).
Marking a future meeting would record attendance at something that has not occurred, and no later
correction could tell that apart from a real mark.

## A leader is a row-level capability, re-read on every write

This is the first place in the app where an ordinary employee writes a row about a colleague. Every
other employee route is self-scoped through `authorizeEmailAccess`, which 403s any non-elevated
cross-email call.

`POST /api/fpu-attendance` resolves the capability **server-side on every single request**:

- an elevated session (admin / accounting / hr_coordinator) may mark anyone;
- otherwise the caller must **lead the group the target is in**, and the target must not be them.

**A leader never marks their own attendance** (Kane, Q5) — the same rule as "a reviewer cannot
approve their own hours". HR records the leaders. Leadership is read from `fpu_class_groups
.leader_enrollment_id` on each call and never trusted from the client, so replacing a leader revokes
the power on their next request. The leader must be a member of the group they lead; the route
refuses anything else.

Groupmates see **short name and work email only** — directory parity, the standing ruling. A member
sees their own marks; a leader sees the group's, because marking is what they are there for.

## Unmarked is a third state, and it fails closed

`fpu_session_attendance` has a row only when somebody made a deliberate call. `present` is `NOT
NULL` with no default, so a row is always an answer — and **the absence of a row is "unmarked"**,
which is neither present nor absent.

`fpuAttendanceVerdict` reports absent and unmarked **separately** and fails on either (Kane, Q3), so
HR can tell "they did not come" from "the leader never filled it in" and chase the right person. A
class with no sessions at all fails closed rather than passing everyone.

**HR can override, and the override is read, never recomputed over** (Kane, Q6).
`fpu_enrollments.attendance_override` is `pass` or `fail` with an author (both columns move
together), and once set the marks stop deciding — so a later edit by a leader cannot silently undo
the ruling. The record is still reported truthfully; the override changes the verdict, not the
history.

## Closing the class is the completion event

Closing means the class's end date has arrived. `POST /api/hr/fpu-classes/class-close` with
`confirm: false` computes the split and **writes nothing** — HR reads both lists first. With
`confirm: true` it:

1. stamps `mesa_fpu_completed_on` on every rate row of the **eligible only**, dated
   `class_ends_on` (not "today", which could be weeks later) — that date is what MESA membership
   runs from, so the ₱100 starts with the first pay week whose Friday is on or after it;
2. marks eligible enrollments `completed` and ineligible ones **`failed`**;
3. stamps `class_closed_on` / `_by`;
4. returns `toEnroll`, which the client walks through `POST /api/toggle-mesa-member` — still the one
   choke point that opens a MESA account. Anyone already a member, or holding an open account under
   an alias, is returned as `alreadyMembers` and never sent there.

**An ineligible person is never stamped with an FPU date.** That stamp bars every future class
forever and nothing in the app can clear it, and the ruling is that a miss fails *this* class only —
they may enroll in a later batch (Kane, Q2). `failed` is that terminal per-class outcome.

Attendance cannot be marked once the class is closed.

**Nobody's existing MESA balance is ever released by this feature.** An existing member cannot
enroll in a class at all (`fpuVerdict` bars them), so the case is unreachable by construction, and
releasing a balance requires an opt-out request as authorization — see [mesa.md](mesa.md).

**The gate also lives in `POST /api/hr/fpu-enrollments/complete`.** Close class is the intended
path, but that route is what actually stamps the FPU date and hands out a `toEnroll` list, and a
money path must not depend on which button was pressed. It refuses a non-attender into
`missedSessions` and leaves the row `approved`. A class where nothing was ever marked (one that
predates this feature) is left alone rather than failing everyone.

## Deploy notes

- **PENDING — Kane runs:** double-click `scripts/Apply FPU Groups migration.cmd`. It rehearses
  inside a rolled-back transaction, proves every constraint bites, then asks for `APPLY`. This is a
  **different** migration from *Apply FPU Classes*, which is already done and is not re-run.
- Until it lands every route here reports `migrated: false`, the HR panel says which file to
  double-click, and the employee card renders nothing. Nothing 500s.
- Audit actions: `fpu.groups.divided`, `fpu.groups.leader_set` / `_cleared`,
  `fpu.attendance.marked`, `fpu.class.closed`. Registry prefix `fpu.`.
- No env vars, no n8n, no notification type.
