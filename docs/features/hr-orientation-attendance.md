# HR orientation attendance — the week's hires against the week's attendance

HR → **New Hire Checklist → Orientation** answers one question about the week the
checklist selector is already on: *of the people we listed, how many actually turned up
for orientation?* It is the HR-side counterpart to the manager tally
([manager-orientation-attendance.md](./manager-orientation-attendance.md)) — same two
tables, same model, same published rate — narrowed to one week and widened with the number
only HR can see: how many listed hires never reached a manager at all.

It is the **second inner tab** on the New Hire Checklist, beside Checklist. That is
deliberate: an inner tab inherits the `hr`/`new_hire_checklist` feature permission, while a
new top-level HR tab is a new feature key, and a missing grant is **hidden by default**
([rbac-feature-permissions.md](./rbac-feature-permissions.md)) — nobody but an admin would
see it until it was granted person by person. Same call as the manager Orientation tab.

Shipped 2026-08-26. Kane's ask: *"under New Hire Checklist there should be a tab in there
that we can see the number of people that were hired and the number of people that actually
attended orientation"*, scoped *"only … according to the Week Selector from the original New
Hire Checklist"*, with *"proper caching … if data was already loaded it won't have to load
again"*.

## Key files

| Piece | File |
| --- | --- |
| The tab | [HrOrientationAttendancePanel.tsx](src/components/hr/HrOrientationAttendancePanel.tsx) |
| The host tab + inner tab bar | [HrNewHireChecklist.tsx](src/components/hr/HrNewHireChecklist.tsx) |
| The week model (pure, tested) | [orientation-week-stats.ts](src/lib/hr/orientation-week-stats.ts) |
| Its test | [orientation-week-stats.test.ts](src/lib/hr/orientation-week-stats.test.ts) |
| The cached read | [useHrOrientationAttendance.ts](src/hooks/useHrOrientationAttendance.ts) |
| The route | [route.ts](app/api/hr/orientation-attendance/route.ts) |
| The shared bucketing model | [orientation-weekly.ts](src/lib/manager/orientation-weekly.ts) |
| The cache store | [tab-cache.ts](src/lib/hr/tab-cache.ts) |

## "Listed" and "staged" are different numbers, and only one of them is a denominator

Two counts describe the same week and they never match:

- **Listed** — `hr_new_hire_checklist` rows for the week. HR typed these.
- **Staged** (labelled *With managers* in the UI) — hires that reached
  `hr_pending_employees`, where a manager can mark them attended.

Measured across every live week on 2026-08-26:

| Week | Listed | Staged | Attended | Never staged |
| --- | --- | --- | --- | --- |
| 2026-08-23 | 79 | 70 | 66 | 7 |
| 2026-08-16 | 60 | 56 | 50 | 5 |
| 2026-08-02 | 102 | 89 | 83 | 11 |

> **The rate runs over STAGED, never over listed.** A listed hire with no
> `hr_pending_employees` row cannot carry an `orientation_attended_at` stamp — no manager
> has anything to mark — so putting them in the denominator caps the week below 100%
> forever and reports an intake problem as an attendance problem. They are counted in their
> own **Listed but never handed to a manager** section instead, where HR can act on them.

`listedStagedElsewhere` is the third bucket and exists so the second one stays honest: a
re-listed hire is staged, just filed under the week `pickChecklistWeek` resolved them to
(the later week wins). They are neither "here" nor "missing", and 2 to 8 hires a week land
there.

## The rate is the manager tally's rate, imported

`rate` is `attendanceRate(week)` from the shared model — the same function, not a
reimplementation, so `attended / total` is computed exactly once in the codebase. HR and a
manager looking at the same week see the same percentage, verified week by week against
production.

That carries the manager tally's ruling with it: **an unmarked hire counts against the
week**, because "did not attend" means "was not marked attended". The panel does not soften
this, it **annotates** it — a week containing unmarked hires renders a note saying how many
and that the rate can only rise once managers mark them. Changing the denominator here
instead would make the two surfaces disagree, which is the one failure this feature must
not have.

## A week with nothing marked is unmeasurable, not 0%

Kane, 2026-08-26: *"only produce data when it has been passed to the managers and the
managers have marked it; if it hasn't been marked then just put a note on it."*

`measurable` is false when the week staged nobody, and `rate` is then `null` and the panel
renders a note in place of numbers. This is not an edge case:

- **Every week before 2026-06-07** has checklist rows and zero staged hires (2026-05-03:
  52 listed, 0 staged). Manager marking did not exist yet; those weeks are permanently
  unmeasurable.
- **A freshly listed current week** looks identical (2026-08-30, measured on ship day: 31
  listed, 0 staged) and becomes measurable on its own as onboarding lands.

> Rendering 0% for either would report a total attendance failure where there is simply no
> data. The two cases share one state and one note, distinguished only by wording.

## The week comes from the selector, and there is only one selector

The panel takes `period` from the host tab's existing week control and has **no week
control of its own**. The same `period` drives the grid, so the two inner tabs cannot be
looking at different weeks, and the header's selector keeps working on both.

`listedRows` is likewise the grid's **own row state**, mapped down to four fields — not a
second read of the same table. So the Orientation tab's "Hires listed" and the header's
"N hires this week" are the same number by construction, and adding a hire updates both
with no refetch.

The week key itself is HR's `period_start` joined on `personal_email`, resolved by the
shared model. Never the hire's own dates — that grouping was wrong for 46% of the roster
(see the manager doc).

## One fetch serves every week

The payload is week-independent: all hires, all checklist weeks, bucketed client-side. So:

- The tab fetches **once per page session** and caches under
  `HR_TAB_CACHE_KEYS.orientationAttendance`.
- **Switching weeks costs no query** — the selector re-derives from memory.
- Leaving the tab and coming back **paints instantly** instead of re-flashing a skeleton
  (HR tabs fully unmount on switch — [tab-cache.ts](src/lib/hr/tab-cache.ts)).

Freshness is the panel's **Refresh** button, which writes back through the same cache key,
so a refresh warms the next visit rather than leaving a stale copy behind it. The cache is
in-memory and deliberately **not** persisted: a page reload pulls fresh data.

> The one number that is *always* live is **Listed**, because it reads the grid's rows
> rather than the cached payload. A cached attendance payload can therefore be a few minutes
> behind while the hire count is current — that asymmetry is intentional, not drift.

## Failure refuses to render, and never degrades

A failed read clears state, shows the error with a **Retry**, and renders no numbers. There
is no fallback to the hire's own dates: that is the 46%-wrong week key the feature exists to
replace, and a wrong week presented as right is worse than an empty tab (same rule as the
manager panel and the Overview CSV in
[accounting-total-payout.md](./accounting-total-payout.md)).

The route surfaces a checklist read error as a 500 with empty rows for the same reason — a
hire list without its week map cannot be bucketed, only guessed at.

## No money, and no writes

The route strips `regular_rate` / `ot_rate` **unconditionally** — not conditioned on the
caller's rate visibility, because this surface renders no money at all and nothing
downstream should have to be trusted about that. `requireFeatureAccess("hr",
"new_hire_checklist", "view")` is enough to read it: attendance is *marked* on the manager
surface, and this tab only reads.

Both reads use `selectAllPaged`. `hr_new_hire_checklist` is at **1,351 rows** and
`hr_pending_employees` at **976**; PostgREST truncates at 1,000 with no error even when an
explicit `.range()` is given, which would silently file hundreds of hires onto the wrong
week.

## The manager panel's motion

Shipped in the same commit: Manager → My Team → Orientation now eases its week expand /
collapse, staggers its KPI tiles and week cards in, and **refreshes in place** — the hook
now separates first-load `loading` from `refreshing`, so Refresh spins the icon instead of
swapping the whole panel for a spinner card and back.

`useOrientationHistory` gaining `refreshing` changes nothing for its other consumer
([NewlyHiredPanel.tsx](src/components/manager/NewlyHiredPanel.tsx)), which never read
`loading`. **The motion is decoration only**: animated wrappers render their children
unconditionally, `AnimatePresence` guards only a section that was already conditional, and
`useReducedMotion` collapses every animation to a plain opacity step. No count, gate, or
error branch depends on it.

## Deploy notes

**No migration.** No DDL, no new table or column, no webhook, no n8n import, no cron, no
env var. Both reads are read-only against `hr_pending_employees` and
`hr_new_hire_checklist`.

Verified against production on 2026-08-26 by running the shipped
`buildHrOrientationWeekStats` over the live tables for all **18** checklist weeks: 956 of
976 staged hires attributed to an HR week (the other 20 match no checklist row and stay in
the shared model's off-checklist buckets), 920 attended, and every invariant held —
`listedStagedHere + listedStagedElsewhere + notStaged = listed`, `attended + notAttended =
staged`, `noShow + awaiting = notAttended`, the department breakdown summing to both totals,
the rate matching `attendanceRate` for every week, and **no unmeasurable week producing a
rate** (5 weeks, all pre-June or current).

## Related

- [manager-orientation-attendance.md](./manager-orientation-attendance.md) — the tally this
  shares its model and its rate with, and where attendance is actually marked.
- [new-hire-checklist.md](./new-hire-checklist.md) — the host tab, the week, and the
  Lead-Gen-only orientation invite.
- [rbac-feature-permissions.md](./rbac-feature-permissions.md) — why this is an inner tab.
