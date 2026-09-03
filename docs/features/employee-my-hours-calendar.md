# Employee dashboard — My Hours calendar

Kane, 2026-09-03: *"Employee - My Hours - Calendar UI lets upgrade this please that it
will look like Small KPI Cards from MESA under accounting make the calendar dates a bit
bigger"* → *"a bit smaller"* → *"Flatten this please put this at the right side of the
Week Selector"* → *"Lets not make the calendar gradient"*.

Shipped across five commits of live iteration: `c8e5f658` · `4265bdfd` · `b1c0dcf3` ·
`fb26990b` · `6f4ac980`. This doc covers the calendar grid and its per-day tiles; the
PAB verdict maths it renders is governed by `payroll-wizard-pab-step.md` and
`pab-exclusions.md`.

Key file: `src/components/employee/EmployeeMyHours.tsx` (~2,360 lines — grid, tiles,
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
