# Employee dashboard — Time Adjustments calendar (tab id `hours`)

> **Renamed 2026-09-10 (Kane): the tab label is "Time Adjustments", not "My Hours".** The tab is
> named for its purpose — the day that cost you PAB is where you file. **The `id`/`key` stays
> `hours`**: it is the persisted key in `pages.visibility` and the employee app's render switch
> (`src/lib/pages/visibility.ts:26-28`), so moving it would orphan every saved admin visibility
> flip. The component and this doc's filename are unchanged for the same reason, which is why
> comments across the codebase still say "My Hours" as shorthand for `EmployeeMyHours.tsx`.
> Renamed alongside it: the sidebar entry, the Pages-registry label, this page's H1 and sub-line,
> the manager empty-state copy that names the employee's filing path
> (`ManagerTimeAdjustments.tsx:542`), Penny's portal description (`ceo-tools.ts:1188`), and a
> `TAB_LABEL_OVERRIDES` entry in `src/lib/presence/page-label.ts` — without that last one the
> employee's own browser tab and the Admin GML live-status column would still read "Hours".

Kane, 2026-09-03: *"Employee - My Hours - Calendar UI lets upgrade this please that it
will look like Small KPI Cards from MESA under accounting make the calendar dates a bit
bigger"* → *"a bit smaller"* → *"Flatten this please put this at the right side of the
Week Selector"* → *"Lets not make the calendar gradient"*.

Shipped across five commits of live iteration: `c8e5f658` · `4265bdfd` · `b1c0dcf3` ·
`fb26990b` · `6f4ac980`. This doc covers the calendar grid and its per-day tiles; the
PAB verdict maths it renders is governed by `payroll-wizard-pab-step.md` and
`pab-exclusions.md`.

Key file: `src/components/employee/EmployeeMyHours.tsx` (name unchanged by the rename) (~2,360 lines — grid, tiles,
month/PAB header, skeleton and the eligibility walk all live here).

## The rule most likely to be violated

**The grid reads Sun–Sat. The non-HSL scoring set is still Mon–Fri. Weekends are
display only.**

Since the 2026-08-27 week-model cutover the calendar renders whole Sun–Sat weeks
(`buildCalendarMonthWeeksIncludingWeekends`), but the non-HSL verdict still walks
**every Mon–Fri in the PAB period** and nothing else. Widening the walk to match what
the grid draws would silently change who earns PAB.

HSL is the opposite and must stay that way: it is **≥5-of-7 over whole weeks**, not
"every weekday passes". Walking Mon–Fri there (what this did until 2026-08-27) both
ignored the weekend credit that rescues a short weekday and used the pre-cutover anchor,
so My Hours could contradict the wizard and dispatch **in either direction**.

Forgiveness (US holiday · approved dispute · TEMP orphanage coverage) bumps a forgiven
**weekday** to a full 7 h. **Weekend cells keep raw hours** — under HSL they earn credit
on their own merit, and gifting them 7 h would hand out the 5-of-7 quota.

## The missed-day nudge

Shipped 2026-09-10 with the tab rename. Kane's spec: *"any day that they missed the pay that
disqualifies them — any red … a small chat bubble will open up on that date saying 'Need a time
adjustment?' and it will pop up for like 5 seconds; if they have multiple then every 5 seconds
another will pop up pointing to that date and it should be random."*

**Three layers, because one was not enough.** Kane, on the second pass: *"the point is that if
people cant see it properly then they wont know where the time adjustment"*. A bubble that shows for
five seconds and then moves on is only ever pointing at ONE day, and it is missed entirely by
someone who looks up a second late — the same discoverability failure in a new costume. So:

1. **A persistent `!` marker on every nudgeable day.** In flow, in the label row's right-hand slot —
   the one Holiday / Forgiven / the today-dot use, each of which is mutually exclusive with red, so
   it cannot collide and, being in flow, cannot clip on an edge row or column.
2. **The rotating bubble** — `NUDGE_INTERVAL_MS` (5s), one at a time, **looping**. Playing the list
   once would put the last bubble 40s in on an eight-day month.
3. **A permanent count above the grid** — "N days this month came in under 7 hours" — which survives
   dismissing the bubbles and does not depend on catching one.

**The trigger is `isNudgeableMissedDay` in `src/lib/employee/missed-day-nudge.ts`** — one pure
definition shared by the cycle memo and the tile, so the bubble and the colour cannot disagree. Its
first six terms mirror the tone chain's final `else`; **change one and you must change the other**,
and `missed-day-nudge.test.ts` walks the branches as the tripwire.

- **Red-only is narrower than the feature, on purpose.** `time-adjustment-requests.md` says a request
  is "requestable before Hubstaff upload" and works on "days with zero or missing Hubstaff data" —
  the forgot-the-tracker case. Those render sky "Processing" or orange "Pending", never red, so the
  nudge does not appear on them. What it buys: a no-data day is often a day the SYSTEM has not read,
  and the leading Sunday of every 8-day Sun→Sun export is still dropped outright
  (`docs/notes/hubstaff-sunday-overlap.md`, root cause OPEN). Requiring real hours closes that whole
  false-positive class by construction. Widening it is a one-line change in the predicate.
- **`canRequestAdjust` is load-bearing, not belt-and-braces.** A future day carrying partial data
  falls through the tone chain to red, and that term is the only thing excluding it.
- **Random, but seeded.** `orderNudgeDays` is a Fisher–Yates shuffle over a `mulberry32` seeded on
  the joined ISO list. `Math.random()` would reshuffle on every recompute and the cycle would jump
  mid-sequence; a seeded deal is also the only kind that can be tested.
- **Reduced motion gets one static bubble**, no rotation — timed auto-updating content is a WCAG
  2.2.2 concern.
- **Paused while a bubble is hovered or focused**; a 5-second target is otherwise hard to click. The
  bubble also hides while its own tile is hovered, so the richer hover card takes over instead of
  stacking on it.
- **No portal.** The bubble reuses the hover card's `absolute` + row-aware flip
  (`wi === 0 ? 'top-full' : 'bottom-full'`), which is how that card already stays inside the
  calendar card's `overflow-hidden`.
- **Dismissal is per viewer, per tab** — `sessionStorage`, never `localStorage`, with the email in
  the key so an elevated `?email=` preview cannot inherit it. Dismissing stops the bubbles; the
  markers and the count stay.
- **Nothing notifies.** In-page only, so `notification-alerts-view-scoped` does not apply.

## The tiles

They borrow the **Accounting → MESA stat-card idiom**: `rounded-xl`, a flat tone fill, a
1px border, no gradient. Height is `h-[3.25rem]` (`sm:h-[3.75rem]`).

- **Flat tone fills, never gradients** (`fb26990b`). The page keeps its soft background
  wash; the tiles do not.
- **A weekend tile is `bg-orange-50/50` with `text-orange-950`** (`6f4ac980`) — warm ink
  drawn from its own ground, never neutral zinc on a coloured fill. This is the same
  gray-on-color rule the Manager Overview greeting follows.
- **A not-yet-real miss shows "Processing" in sky, not orange.** Hours that have not been
  ingested yet are not a failure, and orange would tell an employee they missed a day the
  system simply has not read.
- **Tailwind variants must be literal.** The tone classes are written out per branch
  (`border-blue-200 bg-blue-50 text-blue-900`, …) rather than interpolated as
  `border-{t}-200` — an interpolated class is not in the build output and renders
  unstyled. Same trap as `manager-time-adjustments-workspace`.
- Empty leading/trailing cells are dashed zinc with an em-dash, not blank space.

**The skeleton mirrors the loaded grid 1:1** — same columns, gaps, tile height and radius
— so the swap to real tiles does not reflow. Changing tile geometry means changing both.

## The header

The weekday row is `sticky top-0 z-10` with an opaque backdrop, so it survives the
grid's internal scroll.

**The month range and PAB period sit flattened on one line to the right of the week
selector** (`b1c0dcf3`), not stacked beneath it — the pill's left edge levels with the
first day tile below it. That alignment is deliberate; restacking it costs a tile row on
short viewports, which the card already guards with
`[@media(max-height:850px)]:max-h-[calc(100dvh-9rem)]`.

## Known state

- The five commits are UI only — no verdict, threshold or period boundary moved.
- None of them touched a doc at the time; this file is the retrospective record.

See also: `payroll-wizard-pab-step.md` · `pab-exclusions.md` ·
`orphanage-pab-coverage.md` · `employee-dashboard-cache.md`.
