# KPI Calculator insight cards — department spotlight, top earner, sent-to-Accounting trend

Three read-only cards above the department grid on **Manager → KPI Calculator → Departments**
(the "My Departments" landing). From left to right: a **department spotlight** that rotates through
each department and shows its average bonus per week, the **top earner** for the week in the week
picker, and a wider **Sent to Accounting** card with a line chart of the weekly total. They are for
the managers who score these bonuses, and they show only figures those managers already see on the
grid and in Bonus History. Shipped 2026-09-28 (session `c83472b1`, blueprint). Kane: *"one KPI Card
should have a spotlight of each department and their Average bonus per week - and another one that
has a Spotlight of a random Employee that has the biggest bonus. And the last card should be longer
… a line graph on the Total Bonuses that were sent to accounting each week make the animation smooth"*.

## Key files

| Piece | File |
| --- | --- |
| Rules (pure): scope, aggregation, curve, axis | `src/lib/manager/kpi-insights.ts` (+ `kpi-insights.test.ts`) |
| Reads (paged, server-only) | `src/lib/supabase/kpi-insights-db.ts` |
| Route | `app/api/manager/kpi-insights/route.ts` — `GET ?depts=a,b&week=YYYY-MM-DD` |
| Cards + chart | `src/components/manager/KpiInsightCards.tsx` |
| Mount | `DeptBonusCalculator.tsx`, behind the `showInsights` prop. Only `ManagerApp.tsx` passes it |
| Paint cache | `KPI_CACHE_KEYS.insights(surface, week, depts)` in `src/lib/manager/kpi-cache.ts` |
| PROD check (read-only) | `npx tsx scripts/verify-kpi-insights.ts [week]` |

## "Sent to Accounting" is a STATUS, never a save

A dept-week counts as sent only when its `hsl_bonus_period_status` row is **`ready` or `locked`**.
That is the transition that notifies Accounting (`kpi.published`,
`app/api/hsl-bonus/period-status/route.ts:95-100`), the state the Payroll Wizard pays, and the state
`appointment-rankings.ts:151` calls `with_accounting`. Saved rows in a draft dept-week are
**pending**: they show in the tooltip as "saved, still in draft" and never reach the line.

The obvious simplification is to sum every saved row. That turns the chart into a projection, and it
would stop matching what Accounting received. The live week on 2026-09-20 shows the difference:
₱798,250 sent plus ₱3,750 in draft (Site Building) equals the ₱802,000 "Projected" pill in the header.
The header pill is the projection. The chart is the record.

The money column is `bonus_catalog_applied.amount`, the stored PHP the Wizard pays
(`bonus-catalog.md` §3). It is summed in centavos. Native settlement currencies stay inside the
calculator, the same rule the grid's cards follow.

## The trend: a week with no saved row has NO point

- **Window:** the 12 Sunday weeks ending at the newest week in which any scoped department SENT
  (`readLatestSentWeek`). It does not end at the calendar week, or at the newest *saved* week. Either
  would put a ₱0 point on the right edge every Monday (and on every score-ahead draft), and that reads
  as a collapse. The live week joins the chart when its first department is sent.
- **No row saved that week → no mark.** There is no point and no segment, only a 45° hatch between
  the neighbours. The line breaks there (`toRuns`). This is the rule
  `memory/cycle-success-trend-chart.md` set for the Diagnostics chart: the absence of a measurement
  is not ₱0. A week that **has** rows but sent nothing **is** a measurement, and it plots ₱0.
- **Curve = monotone cubic (Steffen), never Catmull-Rom.** It is smooth, and between two weeks it
  stays inside that pair's own range. So it cannot dip below ₱0 or peak above a week that never
  happened. `src/components/ceo/financial-chart.tsx` uses Catmull-Rom and overshoots after a sharp
  drop, so do not "reuse" it here. A test samples the bezier and pins this.
- **Axis is zero-based** (`niceTicks`), because the chart is an area and an area encodes value as
  the distance from ₱0. The Diagnostics chart's floating floor was licensed for a line with no fill.
  `niceTicks` steps first (1/2/2.5/3/4/5×10ⁿ) and then rounds the top. Rounding only the ceiling put
  the live ₱1.2M peak under a ₱2M axis, with 40% of the plot empty.
- **Hollow marker = the NEWEST week while a department has not sent.** Its figure can still rise.
  An older week that one department never sent is a settled record, so it stays solid and the
  tooltip names the gap. The first build hollowed every week with a missing department, and 9 of 12
  points came out hollow.
- **Colour was measured.** The series is `#059669` on light and `#12a574` on dark, and both pass the
  dataviz validator (lightness band, chroma, ≥3:1). `#10b981` fails the dark lightness band. Labels
  use text ink. The only direct labels are the newest week and the peak.

## Motion (Kane: "make the animation smooth")

Entrance: a left-to-right **clip wipe** reveals the line and area together (1.25 s, ease-out cubic).
Each marker springs in at the moment the wipe edge reaches it, using the **inverse** of the wipe
easing rather than a guessed stagger. A refetch that only changes values **morphs `d` in place**.
The wipe replays only when the path's structure changes (a new week, a new gap). That way a Mark
Ready elsewhere does not restart the animation. The crosshair, its dot and the tooltip ride one
**spring**. The tooltip is two elements: the outer one is placed, and the inner one runs the entrance.
On a single element the entrance's `y` overrides the lift, and the tooltip lands on the point it
describes. Figures count up (`AnimatedPeso`).

`prefers-reduced-motion` turns off every one of these, and the spotlight's auto-rotation with them.

## Department spotlight: average ÷ the weeks the department SENT

`avgWeekly = sent total ÷ weeks sent` inside the 12-week window, and `avgPerPerson = sent total ÷
person-weeks paid`. A department that skipped a week is not dragged down by a zero it never
submitted. A ready status over zero rows counts as a week sent at ₱0. The rotation runs in rank order
(highest average first), 5.2 s per department. One animation-frame clock drives both the dwell and
the progress pill, so hovering, focusing or hiding the tab freezes the pill in place. The mini bars
are the department's own 12 weeks. A week it did not send gets a flat stub on the baseline, never a
zero-height bar.

## Top earner: the picked week, saved rows, summed per person

- It follows the **week picker** and reads every **saved** row for that week, drafts included. The
  chip says **Sent** only when every department paying that person has sent. Otherwise it says
  **Projected**. If it were limited to sent rows, the card would be empty on the live week until
  someone submits.
- **One person in two departments = SUM** (`memory/kpi-one-person-two-departments.md`). People are
  keyed on normalized email. A row keyed on a NAME (Arriola, item 244(e)) is keyed as `name:<name>`
  and still ranks.
- **"Random":** a flat common bonus ties whole departments, so the server returns the tied pool
  (capped at 25) and the card draws one. The first draw is a hash of the pool salted once per page
  load. It is random to the reader and stable across re-renders, so the card never swaps person just
  after painting. **Shuffle** draws again, in the click handler.
- Context under the figure: the week's average bonus (with the ×multiple) and the lead over #2, or
  the size of the tie.

## The gate is the grid's own

`GET /api/manager/kpi-insights` resolves role and scope exactly as `/api/manager/department-members`
does. That is the roster the calculator's department list comes from. Manager, admin and elevated
roles only. A caller with `department_managers` rows is scoped to them even when elevated, and only
an elevated caller with no assignments reads every calculator department. The client's `depts`
proves nothing: `scopeInsightDeptKeys` re-matches each key against the session's assignments (built-in
key, or the slug of an in-app label). It refuses namespaced `hsl:*` grants and retired calculator
keys, the same way the grid does. A source-scan test pins that scope comes from the session and never
from a query parameter.

**Do not "simplify" this by reading `/api/bonus-catalog-applied` from the client.** That route's GET
has no gate at all (item 251), and this route must not inherit the gap.

## Reads are paged, per week, in parallel

A single week of `bonus_catalog_applied` already crosses PostgREST's 1,000-row cap (1,071 rows for
2026-09-20). Each week is its own `selectAllPaged`, and all of them run at once: 11,396 rows in
**~2.1 s** against PROD. One failed week fails the whole response. A partial read would draw a dip
nobody paid. The one unpaged read is the `.limit(1)` latest-sent-week probe, and a test pins that
it is the only one. `summarizeApplied` is un-paged and capped today (item 244(f)); do not reuse it.

## Refresh

The card fetches on mount and whenever the week or the department set changes. It fetches **4 s
after** the grid's live figures stop moving (`liveKey` = submitted count + rounded projected total,
because the calculator autosaves on a 1 s debounce), and **immediately** when the page's Refresh
finishes. The cached payload paints first. While a refetch is in flight the previous render is held
at 60% opacity; there is no skeleton flash.

## Deploy notes

**No migration.** No env vars and no n8n. New route `app/api/manager/kpi-insights`. PENDING: push +
deploy (Kane). Verified: 27 unit tests, typecheck clean for these files, and the real rule run against
PROD by `scripts/verify-kpi-insights.ts` (09-20: ₱798,250 sent, 11 of 12 departments, top earner
₱53,750, PM Team). It was rendered and screenshotted in a local harness (light, dark, hover, tie,
gap, narrow) with synthetic names. Kane has viewed it on the dev server (the avatar-ring fix, a
`border-2` instead of a box-shadow the card's `overflow-hidden` clipped, came from that). This session
has **not** clicked through it signed in as a real manager.
