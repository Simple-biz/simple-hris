# KPI Calculator insight cards — department spotlight, top earner, sent-to-Accounting trend (Departments and HSL Branches)

Three read-only cards above the department grid on **Manager → KPI Calculator → Departments**
(the "My Departments" landing). From left to right: a **department spotlight** that rotates through
each department and shows its average bonus per week, the **top earner** for the week in the week
picker, and a wider **Sent to Accounting** card with a line chart of the weekly total. They are for
the managers who score these bonuses, and they show only figures those managers already see on the
grid, any past week through its week picker (`DeptBonusCalculator.tsx` `weekOptions`). Bonus History,
which also listed every dept-week's total, was retired on 2026-09-29. Shipped 2026-09-28 (session `c83472b1`, blueprint). Kane: *"one KPI Card
should have a spotlight of each department and their Average bonus per week - and another one that
has a Spotlight of a random Employee that has the biggest bonus. And the last card should be longer
… a line graph on the Total Bonuses that were sent to accounting each week make the animation smooth"*.

**The HSL Branches calculator got the same three cards on 2026-09-29** (Kane: *"KPI Calculator - HSL
Branch - this should have the KPI Cards similar to other departments please"*). Every rule on this
page holds there. What differs (the gate, the money column, the word "branch") is in
[§ HSL Branches](#hsl-branches-2026-09-29).

## Key files

| Piece | File |
| --- | --- |
| Rules (pure): scope, aggregation, curve, axis | `src/lib/manager/kpi-insights.ts` (+ `kpi-insights.test.ts`) — HSL scope is `scopeHslInsightBranchKeys` |
| Reads (paged, server-only) | `src/lib/supabase/kpi-insights-db.ts` — HSL money is `readHslInsightEntries` |
| Route | `app/api/manager/kpi-insights/route.ts` — `GET ?depts=a,b&week=YYYY-MM-DD` · HSL: `app/api/manager/kpi-insights/hsl/route.ts`, same params |
| Cards + chart | `src/components/manager/KpiInsightCards.tsx` — `calculator` (`'dept'` · `'hsl'`) picks endpoint, cache surface and noun; `colorFor` the row colour |
| Mount | `DeptBonusCalculator.tsx` and `HslBonusCalculator.tsx`, each behind a `showInsights` prop. Only `ManagerApp.tsx` passes it |
| Paint cache | `KPI_CACHE_KEYS.insights(surface, week, depts)` in `src/lib/manager/kpi-cache.ts` (`dept-manager` · `hsl`) |
| PROD check (read-only) | `npx tsx scripts/verify-kpi-insights.ts [--hsl] [week]` |

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
- **"N of M sent" counts the STATUS, including a ready week with no saved rows** (2026-09-29).
  That is a ₱0 submission. It adds nothing to the line and still makes no point, but the
  department HAS sent, exactly as the spotlight average counts it. The first build counted a
  department as sent only when it had rows, so HSL's Healthcare Team Lead (Ready over zero rows in all 8 of its
  weeks) and SSD's off-weeks read *"not scored at all"* on every week they submitted:
  **10 of 13** on 2026-09-20, **12 of 13** after. The Departments figures did not change in the
  current window (measured before and after, byte-identical). The tooltip's *"not scored at all"*
  is now only a department with no rows and no sent status.
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

## HSL Branches *(2026-09-29)*

The same component (`calculator="hsl"`), the same `buildKpiInsights` and the same rules, over the
HSL branch grid. Mounted in the Departments slot: below the payroll-lock banner, above the grid. The
header stays the shared header. Three things differ, and each is deliberate.

- **The money is `hsl_bonus_entries.calculated_bonus`.** It is the figure on every row of the HSL
  grid and in its Total pill, and the stored amount the Wizard's `hslKpiAmounts` pays
  (`hsl-kpi-calculator-2026-07.md` §Dispatch wiring). **One exception is left as it is:** the Wizard
  RECOMPUTES Managers Weekly (`hsl_managers`) from `kpi_data` against the spec dated to the week
  (§Specs are DATED) instead of paying the stored value. The cards show the stored figure, as the
  grid does. The two agree unless a spec version was edited in place, and that is the thing the
  dated-spec rule forbids.
- **The gate is the HSL calculator's own, and narrower** (`scopeHslInsightBranchKeys`). Only an
  explicit `hsl:<key>` grant opens a branch. That mirrors `canAccessHslDept(managed, k, false)`,
  the check `ManagerApp` makes before it shows the HSL calculator at all. There is **no elevated
  arm**: an elevated caller with no HSL grant never sees this calculator, so the route gives them
  nothing either. The Departments route's elevated arm must not be borrowed (a source pin forbids
  `scopeInsightDeptKeys` in the HSL route). A granted key must also be a **live scoring branch**:
  - a code team that is not `noKpi`. Executive Guest Services and Executive Assistants are
    roster-only, have no bonus to average, and have been Ready at ₱0 every week since 2026-08-30;
  - or a data sub-team stored under HSL right now. The sub-team list is read **strictly**, so a
    failed read is a 500. Treating it as "no data branches" would drop a branch's money from the
    total and draw a dip nobody paid;
  - a retired key (`case_manager`, which still holds 50 people's rows) or an unknown key resolves
    nothing, even with its grant still on file (INDEX, HSL sub-departments).

  The client sends its visible branches minus `noKpi`, and the server re-checks every one.
- **The word is "branch"**: *Branch spotlight*, *N of M branches sent*. The shape is shared; the
  label is not (`hsl-kpi-calculator-2026-07.md` § One header). Each branch keeps its own colour
  (`cfg.color`, the colour bar on its grid row); a data branch is slate, like its row.

**Measured on PROD, read-only, 2026-09-29** (`verify-kpi-insights.ts --hsl`, every branch
granted): 13 branches, 12 weeks through 2026-09-20, 6,119 entry rows, 125 status rows, **2.1 s**.
The weekly total runs ₱701k–₱1.14M. The 2026-07-05 week has ₱4,500 sent and ₱199,000 still in draft,
because Filing, Intake and Medical Records have rows under it and no status (Filing's are in audit
item 155's reopen exposure). The top branch is Intake Specialist at ₱308,786 per week sent. On
2026-09-20 the top earner has ₱16,000 (Intake), highest of 288 people. **87 person-weeks since mid-June
were paid on more than one branch**, which is what the SUM rule is for. Every `period_start` in the
window is a Sunday. The monthly branches are keyed on a Sunday week like the rest, and the one
non-Sunday key (`2026-07-01`, SSD and Collections, from before the re-keying) is outside the window.

**How the monthly branches read, and why they were not special-cased.** "Average ÷ weeks sent" is
applied verbatim. SSD Medical Records (monthly) marks off-weeks Ready at ₱0, so its figure,
₱30,171 per week over 7 weeks sent, is the average across those ₱0 weeks. That is a true weekly
average of what it sent. Collections is monthly in config, but in practice it scores and sends every
week (9 of 12). Healthcare Team Lead sent ₱0 in each of the 8 weeks it sent, and ranks last with "₱0.00 / week".

**Known, not fixed:** Healthcare Specialist is a data sub-team with no Bonus Library assignment. It
has never saved a row or a status, so the newest week reads *12 of 13 sent* and stays hollow. That is
true (nothing has been scored there), so nothing hides it. Filtering on `dataBranchHasWork` needs the
calculator's best-effort catalog read, and a failed read would silently drop a scored data branch
from the totals.

## Refresh

The card fetches on mount and whenever the week or the department set changes. It fetches **4 s
after** the grid's live figures stop moving (`liveKey` = submitted count + rounded projected total,
because the calculator autosaves on a 1 s debounce), and **immediately** when the page's Refresh
finishes. The cached payload paints first. While a refetch is in flight the previous render is held
at 60% opacity; there is no skeleton flash.

**First paint.** Before the calculator reveals, its own skeleton (`KpiCalculatorLoading`,
`insights` prop) already holds this row as `KpiInsightCardsSkeleton`. That export shares the grid
constant, the card shell and each card's loading body with the live component, so the grid below
does not drop when the calculator reveals (2026-09-29). Any change to a card's first-load shape goes
in `SpotlightLoading` / `TopEarnerLoading` / `TrendLoading`. Never fork it into the skeleton.

## Deploy notes

**HSL Branches (2026-09-29): no migration, no env vars, no n8n.** New route
`app/api/manager/kpi-insights/hsl`. It reads `department_managers`, `app_settings` (the stored
sub-team map), `hsl_bonus_period_status` and `hsl_bonus_entries`, all server-side. Pushed
(`origin/main` = `3f2f1ea5`, checked 2026-09-29). **PENDING: deploy (Kane).** Verified: 37 unit tests (9 new for the HSL scope and route pins, 1
for the status count), typecheck clean for these files, and the real rule over PROD rows by
`verify-kpi-insights.ts --hsl`. The dev server answered `401` to an anonymous call on the new route.
**Not rendered in a browser and not clicked through signed in as an HSL manager.**

**Departments (2026-09-28): no migration.** No env vars and no n8n. New route `app/api/manager/kpi-insights`. Pushed
(`origin/main` = `0fa0b89d`, reflog 2026-09-29). PENDING: deploy (Kane). Verified: 27 unit tests, typecheck clean for these files, and the real rule run against
PROD by `scripts/verify-kpi-insights.ts` (09-20: ₱798,250 sent, 11 of 12 departments, top earner
₱53,750, PM Team). It was rendered and screenshotted in a local harness (light, dark, hover, tie,
gap, narrow) with synthetic names. Kane has viewed it on the dev server (the avatar-ring fix, a
`border-2` instead of a box-shadow the card's `overflow-hidden` clipped, came from that). This session
has **not** clicked through it signed in as a real manager.
