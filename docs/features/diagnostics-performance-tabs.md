# Diagnostics performance tabs — payroll cycle success rate and the HR hiring funnel

Admin → Diagnostics gained a tab strip on **2026-09-04**. The existing service map became
one of three tabs; the two new ones each answer a "how are we doing" question with a
percentage: **Payroll Cycles** (Accounting — of the people a closed pay week owed money to,
how many were paid) and **HR Pipeline** (HR — of the people HR listed for a hiring week, how
many reached the Global Master List). Admin-only, inheriting the Diagnostics gate.

The two are **separate surfaces on purpose** (Kane, 2026-09-04: *"add KPI Cards as well,
separate HR from accounting"*). They measure different populations over different
denominators, and one blended company-performance number would be wrong in both directions.
Each tab owns its KPI cards, its accent (Accounting orange, HR teal) and its own caveats.

Ship commit: see `git log` for `feat(diagnostics)` on 2026-09-04.

## Key files

| Piece | File |
| --- | --- |
| Tab strip + mount-once shell | [`src/components/SystemDiagnostics.tsx`](../../src/components/SystemDiagnostics.tsx) (default export; the map is now `ServiceMapView`) |
| Payroll rules (pure) | [`src/lib/admin/cycle-performance.ts`](../../src/lib/admin/cycle-performance.ts) · `.test.ts` |
| HR rules (pure) | [`src/lib/admin/hr-pipeline-performance.ts`](../../src/lib/admin/hr-pipeline-performance.ts) · `.test.ts` |
| Payroll route | [`app/api/admin/diagnostics/cycle-performance/route.ts`](../../app/api/admin/diagnostics/cycle-performance/route.ts) |
| HR route | [`app/api/admin/diagnostics/hr-pipeline/route.ts`](../../app/api/admin/diagnostics/hr-pipeline/route.ts) |
| Payroll tab | [`src/components/admin/PayrollCyclePerformance.tsx`](../../src/components/admin/PayrollCyclePerformance.tsx) |
| HR tab | [`src/components/admin/HrPipelinePerformance.tsx`](../../src/components/admin/HrPipelinePerformance.tsx) |
| Shared chrome (KPI card, rate bar, loading modal, detail modal, share bar) | [`src/components/admin/performance-ui.tsx`](../../src/components/admin/performance-ui.tsx) |
| Per-processor unpaid aggregation (the PII boundary) | [`src/lib/payroll/cycle-closeout.ts`](../../src/lib/payroll/cycle-closeout.ts) → `aggregateUnpaidByProcessor`, applied in `cycle-closeout-store.ts` → `toCycleCloseoutSummary` |
| Processor labels (Kolan, x1153) | [`src/lib/payment-catalog/pay-processors-db.ts`](../../src/lib/payment-catalog/pay-processors-db.ts) → `readPayProcessorRegistry`, wrapped in the payroll route |
| Modal scope rules (pure) | [`src/lib/admin/cycle-performance.ts`](../../src/lib/admin/cycle-performance.ts) → `resolveMonthScope` (month vs one week, with the fallback) · `summariseProcessorRows` (the shared footer) |
| Trend chart rules (pure) | [`src/lib/admin/cycle-performance.ts`](../../src/lib/admin/cycle-performance.ts) → `selectTrendCycles` (the window + the four states) · `trendRateBand` (the non-zero axis) |
| Trend chart UI | [`src/components/admin/performance-ui.tsx`](../../src/components/admin/performance-ui.tsx) → `CycleTrendChart` |
| Read-only prod checks | `scripts/probe-closeout-by-processor.mjs` · `scripts/verify-cycle-processor-breakdown.ts` · `scripts/verify-cycle-trend.ts` |
| Listed-per-week reader | [`src/lib/supabase/hr-new-hire-checklist.ts`](../../src/lib/supabase/hr-new-hire-checklist.ts) → `listChecklistWeekCounts` |
| Cycle inventory (which cycles EXIST) | [`src/lib/payroll/cycle-inventory.ts`](../../src/lib/payroll/cycle-inventory.ts) |

## The accents are not free choices

**Accounting is orange, HR is teal**, and neither may be "brightened" without re-reading two
existing rules:

- **Amber means WARNING, only** (`wizard-step2-header-cards`, `hsl-branch-list-and-overlay`).
  It cannot also be an identity colour. The `warn` KPI tone, the unpaid count and the
  never-staged count are the *only* amber on these tabs — that is what makes amber legible.
  Accounting therefore takes **orange**, which the Diagnostics header already uses.
- **Green is a verdict** here (Ready = green on the shared StatusChip). A rate bar encodes
  **magnitude, not judgement**, so a bar filling green would quietly congratulate a 40% week.
  HR takes **teal**, which the wizard's header cards already establish as the neutral-KPI
  colour ("COP teal NOT amber").

No verdict colour is used for an identity or a magnitude anywhere on these tabs.

## The payroll rate has exactly one source, and the alternatives are poison

A cycle's rate is `paid / (paid + unpaid)` read from its **close-out record**
(`app_settings` key `dispatch.cycle_closeout.<source_file>`). That record is the only artifact
carrying a **payable denominator** — see [cycle-closeout.md](./cycle-closeout.md).

Two tables look like they could answer this and **must never be used for it**. Both were
measured against live production data on 2026-09-04:

| Table | Why it lies |
| --- | --- |
| `disbursement_records` | Cycles `2026-06-21`, `06-28`, `07-05` are **100% `pending`** across 2,916 rows for weeks that were paid. Every cycle from `2026-03-01` to `2026-05-17` carries `status='paid'` with `paid_at` **NULL**. `2026-08-02` and `2026-08-23` have **no rows at all**. A rate over this table reports three fully-paid weeks as **0%**. |
| `payment_dispatches` | Its denominator is "rows staged into dispatch", so it structurally cannot see a payable person who was never dispatched. It sits at 97–99% by construction and would flatter every week. |

`disbursement_records` appears on the screen only as the **Outstanding** column — the
`records_outstanding` cross-check the record already stores. It counts people Accounting
**excluded**, so it is normally *larger* than Unpaid. It is labelled audit, it has no
percentage anywhere near it, and a failed read is rendered `unknown`, never `0`.

## Every cycle is listed; only a closed one can have a rate

Superseding the original "weeks before the first close-out are absent from the tab"
(2026-09-04, same day — Kane: *"can we add the unclosed? even though they aren't closed lets
just label unclosed"* / *"and still add the data in there"*). What did **not** change is the
load-bearing part: there is still exactly one rate, and it still comes only from close-outs.

Undeclared cycles are read from `payment_dispatches` + `disbursement_records` by
`listObservedCycles` and listed with their real paid figures and:

| Field | Value | Why |
| --- | --- | --- |
| `unpaid` | **null**, not 0 | 0 is a *claim* that nobody was owed. Only a close-out knows. |
| `payable` | **null**, not 0 | No denominator exists, which is precisely why there is no rate. |
| `rate` | **null** | Not 0%, not 100%. |
| `paid` | a number, **or null** | Null when the cycle has no dispatch rows at all — see below. |

They **never enter a denominator**, month or all-time. A cycle whose payable count is
unknowable cannot make a percentage more accurate; it can only make one up. Their payments
are reported separately as `totals.paidOnUnclosed`.

This is the `orientation-week-stats.ts` `measurable:false` rule applied to payroll (Kane,
2026-08-26: *"only produce data when it has been passed... if it hasn't been marked then just
put a note on it"*).

### Three statuses, and why `pre_closeout` is separate

`closed` · `unclosed` · `pre_closeout`. The last two lack a rate for the same mechanical
reason, but a cycle that ended **before the first close-out was ever filed** could not have
been closed — the feature did not exist. Live, that is **22 of 27 cycles**. Labelling them
"unclosed" would read as 22 Accounting failures, so they are greyed and neutrally worded,
never flagged amber. The boundary is the earliest **closed** `period_end`, inclusive.

A **reopened** cycle correctly returns to `unclosed`: reopening archives the record under a
different prefix and frees the live key, so the week genuinely has no declaration again.

### `paid: null` means unknown, and this one was nearly a lie

`payment_dispatches` only reaches back to **2026-05-24**; the ledger holds cycles from
**2026-03-01**. The first build reported `paid: 0` for every earlier cycle — announcing that
~700 people went unpaid in each of a dozen weeks that in fact paid everyone. That is the same
lie the rate rules exist to prevent, relocated into a different cell. A cycle with **no
dispatch rows at all** now reports `null`, rendered `—`. A cycle *with* dispatch rows that
genuinely paid nobody still reports `0`.

### A cycle is a PERIOD, not a file

`listObservedCycles` groups dispatch and ledger rows by `(period_start, period_end)`, falling
back to the source file only when a row has no period. Measured 2026-09-04: **Jul 26 – Aug 1
holds rows under two different source files** (a re-upload renames the CSV), and grouping by
file listed that one pay week twice — 1,019 paid and 1. Grouping by period also lets
`tallyPaidDispatches` see all of a week's rows at once, so a person paid under both file names
is counted once, which per-file tallies summed afterwards never could.

Because a close-out keys on a *file*, an observed cycle carries **every** file its rows were
found under (`sourceFiles`), and the builder suppresses it if **any** of them is declared —
or if its period matches a closed cycle's. One pay week is one row.

### A month that is not fully closed says so

`MonthPerformanceRow` carries `closedCycles` / `unclosedCycles` / `preCloseoutCycles` and
`fullyDeclared`. When `fullyDeclared` is false the card prints the coverage line. **A 98%
headline over one closed week of four is not a 98% month**, and a reader who cannot see the
gap will assume it is. Do not remove that line without removing the rate beside it.

## "Payable" excludes the Excluded tab, so ~98% is the correct-looking answer

Inherited from the record. Unpaid = `pending` + `problem` + `threshold`. People with no bank,
no rate, a wizard exclusion or a USD track were set aside deliberately; counting them as
unpaid would turn an intentional hold into an apparent failure. The live August 2026 figure
is **98.47%** (3,088 of 3,136 across three cycles) — if a future reader expects a dramatic
number, this section is why there isn't one.

**`unpaid.truncated` is added to the unpaid count.** The `MAX_STORED_UNPAID` cap drops rows
from the stored *list*, not from the debt. A rate over the stored list alone would *improve*
as a week got worse.

## Month rates are pooled, never averaged

`Σpaid / Σpayable` across the month, on both tabs. A 40-person week and a 1,050-person week
are not equal votes on how the month went. The month bucket is the calendar month of
**`period_end`** — the month the work happened, not `closed_at` (Aug 2–8 was closed Aug 14).

## The trend chart starts where HRIS started PAYING, not where close-outs started

Added **2026-09-11** (Kane: *"a histogram ... where we can see weekly each cycle how successful
it is per pay cycle as we progress"*, then *"Only the cycles where we actually started using
HRIS even though we havent closed it ... the other weeks can be marked as NO HRIS Yet"*).
`CycleTrendChart` sits above the month cards: a line/area point per pay cycle, oldest on the
left.

It reads nothing new — `selectTrendCycles()` derives the whole series from the `cycles` array
the tab already polls. No route change, no migration.

### The window is a different boundary from `pre_closeout`, and they must not merge

| Boundary | Question it answers | Live |
| --- | --- | --- |
| `hrisStart` (this chart) | *were we paying through HRIS yet?* — earliest `periodEnd` with a non-null `paid` | **2026-05-31** (the week of May 24–31) |
| `pre_closeout` (the table) | *did close-outs exist yet?* — earliest CLOSED `periodEnd` | 2026-08-08 |

Eleven weeks apart, and conflating them would file a dozen weeks under the wrong story. Weeks
before `hrisStart` collapse into **one** "No HRIS yet" block — 12 weeks to 2026-05-24, live —
not twelve empty slots, which would double the chart's width and squeeze the weeks that carry
data. Those weeks were paid; just not through here, so the wording stays neutral, matching the
rule that pre-feature weeks are never flagged as failures.

### Four states, because three would hide the most important thing on the chart

`closed` (a rate — the only state that draws a mark on the rate line) · `no_denominator` (HRIS paid
people, nothing recorded who was owed) · `not_run` (`paid == null` — the week exists and no
dispatch row does) · the collapsed pre-HRIS block.

**`not_run` is not a variant of `no_denominator`.** Live it is 2026-06-21 → 2026-07-11, four
consecutive weeks where payroll happened somewhere other than HRIS, bracketed by three good
weeks (~800/wk) and a restart that paid **330 and left 723 pending**. Measured 2026-09-11; it
is the only collapse-and-recovery in the record and no other screen shows it. Merge the two
states and it disappears.

It must also never be confused with a week that ran and paid nobody — that week carries
`paid: 0`, a measured fact, where `not_run` carries `paid: null`, the absence of one.

### A week with no rate gets NO MARK — never a zero

A zero-height bar reads as 0%, and so does a line dipping to the floor. This tab has already
been bitten by that exact lie once (the first build's `paid: 0` announced ~700 people unpaid in
a dozen fully-paid weeks). An unmeasured week renders a **45° hatched band and nothing else**:
no point, no segment, no marker. `selectTrendCycles` additionally strips `rate` off every
non-`closed` point, so no renderer can draw one by accident even if it tries. Both are pinned by
tests.

This rule is form-independent and outlived the switch from columns to a line. Whatever the
chart is next, it holds.

### Two strips, never two axes

- **Rate** — only a closed cycle has one, so 3 of 15 live weeks are drawn. Its axis is the
  labelled non-zero band below.
- **People paid**, its own strip with its own axis **from zero**, because it is the series that
  actually carries the progress story: 803 · 811 · 848 · *(stop)* · 330 · 1,007 · 1,019 ·
  1,051 · 1,014 · 1,023 · 1,051 · 1,056.

Two plots sharing an x, **never two scales on one plot**. Still-owed rides in the tooltip.

### The line BREAKS; it never interpolates

Superseding "Columns, not a line" (2026-09-11, same day — Kane: *"Not a bargraph please a line
graph kinda Histogram"*). The original rule banned the **form** because of a **behaviour**:
a single path through every point would draw straight across the four weeks payroll ran
outside HRIS, asserting a number for each of them that nobody ever recorded. Banning the shape
was the blunt way to stop that. The invariant is the behaviour:

> **No segment is ever drawn into, out of, or across a week with no measurement.**

`toRuns()` splits the series into runs of *consecutive* measured weeks and draws each run as
its own path. A gap gets no point, no segment and no marker — only the hatched band underneath,
which says a week is there and a number is not. A run of one renders as a lone marker rather
than being silently dropped.

Two related rules ride with it:

- **Straight segments, never a spline.** `src/components/ceo/financial-chart.tsx` smooths with
  Catmull-Rom, which is right for its contiguous series and wrong here: a curve overshoots
  between two weeks and implies values no week had. Copy that file's dependency-free approach
  — the app ships **no charting library** — never its interpolation.
- **A hatched band is not a zero.** `not_run` (`paid == null`) and a measured zero are
  different facts, and the old "a week with no rate draws no column" rule survives verbatim in
  the new form: no point, no segment, no marker.

### The rate axis is NOT zero-based, and that licence is spent here

Superseding "Rate, always 0–100%" (2026-09-11, Kane chose the labelled band). The original rule
was written for **bars**, where it is absolute: a bar encodes its value as *length from zero*,
so a truncated bar axis is a straight lie about the mark. A line encodes value as *position
against labelled ticks*, which is why the zoom is defensible — and it is necessary, because
pinned to 0–100% the live rates (98.18 / 98.83 / 98.18) are a hairline against the ceiling and
the chart shows nothing at all.

`trendRateBand()` owns it, and it cannot zoom arbitrarily tight:

| Rule | Why |
| --- | --- |
| the ceiling is **always 100%** | the only meaningful reference on the axis; a band floating free of it would let a bad month look like a good one rescaled |
| the floor is `min(95%, worst rate rounded down to a whole 5%)` | a good stretch gets a 5-point window; a 40% week gives a 40–100 band |
| the window **never narrows below 5 points** | caps the exaggeration of a small spread |
| a bad week **expands** the band | the chart can never hide a collapse by rescaling |

The axis carries **visible tick labels at both ends** and the caption says in words that it
does not start at zero. **If this chart ever returns to bars, `trendRateBand` goes with it** —
the licence belongs to the line form, not to the data.

### The colour is measured

The validator, run 2026-09-11: the tab's existing bar orange `#f97316` is **2.73:1** on the
light chart surface, under the 3:1 floor. The chart therefore uses **orange-600 on light,
orange-500 on dark** — its own step per surface, not one value flipped. The no-data grey is
deliberately below the chroma floor because it marks an *absence* rather than a series, so its
real encoding is the hatch; separation from the orange passes regardless (ΔE 16.0 deutan, 19.4
normal). Required contrast relief is present: selective direct labels plus the per-cycle table
directly below.

Labels are **selective** — every measured week while there are ≤ 6, then only the best, worst
and newest. A number over every point is noise. They wear **text ink, never the series
colour**: the marker beside them already carries the identity. They are also the validator's
required contrast relief, which is **not dismissable** — removing them does not remove the
obligation, it just leaves the per-cycle table carrying it alone.

The state legend is **not decorative**: line vs break vs hatch is an identity encoding, and
identity is never carried by appearance alone.

Verified against production by `scripts/verify-cycle-trend.ts` (read-only): 15 points,
`hrisStart` 2026-05-31, 12 collapsed weeks, a rate on the 3 closed points and nowhere else.

## A month card opens a per-processor breakdown, and its counts are a different unit

Added **2026-09-11** (Kane: *"Monthly Cards should have an Open button ... how much was paid
for each Pay Processor ... the main point is for us to know how successful Payroll Wizard HRIS
is"*). Every month card carries an **Open** button raising `PerfDetailModal`: one row per pay
processor with money paid, payments, and the unpaid people split into Pending / Problem /
Threshold, plus a week-by-week section and the legend.

It reads **nothing new**. Both halves were already inside the close-out record — the paid split
is the record's own frozen `byProcessor`, and the unpaid split is aggregated from
`unpaid.payees` at the store boundary. No migration, no new route, no new table.

### The count column is PAYMENTS; the card's headline is PEOPLE

This is the trap the whole design is shaped around, and it was measured, not guessed.
`byProcessor` is built by walking the paid dispatch rows and incrementing **per row**
(`cycle-closeout.ts` § `buildCycleCloseoutRecord`), while the card's `paid` is
`tallyPaidDispatches`'s **distinct payee** count. Live August 2026:

| | |
| --- | --- |
| `Σ byProcessor.count` | **3,112** — equals `paid.dispatchCount` |
| `paid.payeeCount` (the card) | **3,088** |
| `Σ byProcessor.usd` / `.php` | **exactly** `paid.paidUSD` / `paid.paidPHP` |

So the field is named `paidPayments`, never `paid`, and **no per-processor rate is drawn
anywhere**. Dividing paid-*payments* by (paid-payments + unpaid-*people*) would invent a
denominator out of two units and would have read 97.73% for Kolan — within a point of the
truth, which is exactly what makes it dangerous instead of obviously wrong. It is the same
error that makes `payment_dispatches` poison as a rate source, relocated into a modal.

The 24-row gap is **shown, not smoothed**: each one is a second paid row for someone who
already had one that week. On a screen about how accurate the system is, that is a finding.

**The money is the trustworthy half**, and a unit test pins it. If `Σ processors.usd` ever
stops matching the frozen `paid.paidUSD`, the record was written by an older builder — surface
it, do not "correct" either side.

### Nothing records whose fault a Problem was

Kane's question is *"was it the processor or was it us?"*. The record stores a `reason`
(`pending` / `problem` / `threshold`) and a `processor`, and **no cause, no note, no owner**.
So the modal shows the evidence — which rail carried which reasons — and prints **no verdict
column** (Kane, 2026-09-11, Q1(a)). A `problem` is counted as **ours until something says
otherwise** (Q2: *"we cant detect it so we just leave it as HRIS Problem for now"*).

The three reasons are never summed into one "unpaid", because they do not mean the same thing:
**threshold** is a deliberate hold under the payout minimum, **pending** was never dispatched,
**problem** is money that got stuck. Threshold therefore never takes the amber warning colour —
amber there would read as 34 failures for something Accounting chose on purpose.

Making this attributable for real needs a **cause captured at Problem-time in Payment
Dispatch**. That is a separate brief; it moves the dispatch screen.

### The department split does not exist here

There is no department on a close-out's unpaid payee — the row carries name, email, payeeType,
reason, amounts and processor, full stop. An HSL-vs-other split would mean joining those emails
against the roster, and Kane ruled it out for now (Q2). Do not add it without re-reading
§ "Aggregates only" first.

### Closed cycles only, and the button says so when it cannot open

An unclosed cycle has no frozen processor split, so `processors` is `[]` and `paidPayments` is
`null` — **not** an empty table of zeros, for the same reason `payable` is null there. A month
with nothing closed gets a **disabled Open button carrying the reason** (Kane, Q3(b)), never a
hidden one: hiding it makes the absence look like a layout difference rather than a fact about
the month. Today that is every month except August 2026.

### The week filter narrows EVERY total, and both scopes foot with one function

Added **2026-09-11** (Kane: *"each month when we open the month and see the modal we should be
able to split them in weeks or have a filter for weekly"*). A month holding more than one
closed week shows a chip row — **All N weeks** plus one chip per week — and the whole modal
re-scopes: stat tiles, table, footer, and the payments-vs-people note.

`resolveMonthScope()` picks the rows and `summariseProcessorRows()` foots them, **for both
scopes**. That is not tidiness: computing the tiles from the month and the table from the week
is exactly how a filtered view ends up showing one week's table under the whole month's
headline, and the two would be within a few percent of each other — wrong in the way nobody
notices.

Narrowing to a week **does not create a denominator the month lacked**. There is still no
per-processor rate at any scope; the paid column still counts dispatch rows and the unpaid
columns still count people. The footer relabels itself *Week total* / *Month total* so the
number is never ambiguous about what it foots.

The per-week overview list is shown **only while the whole month is in scope**. Once a week is
selected the table above IS that week, and repeating it underneath invites reading one of the
two as a different fact. Its rows are buttons — clicking one selects that week.

### Two rules the modal inherits

- **It never fetches.** It opens over data the tab already polled, which is why it can open
  instantly and animate. It holds the month **key**, not the month object, so the 120s poll
  refreshes an open modal in place instead of pinning it to a stale snapshot. A detail view
  that needs its own read needs its own loading treatment — do not add a spinner in here.
- **The selected week is a `sourceFile` KEY too, for the same reason** — and a key that no
  longer matches any week **falls back to the whole month**, never to an empty table.
  Reopening a cycle archives its close-out and frees the live key, so a week genuinely can
  vanish under an open modal; zeros there would read as *"this week paid nobody"*, which is
  the lie this whole tab exists to prevent. `resolveMonthScope` reports the fallback and the
  modal clears the dangling chip. Opening a different month always resets to All weeks —
  carrying a week key across months would apply one month's key to another's data.
- **`ShareBar` is deliberately not `RateBar`.** A rate bar means a measured success fraction;
  this one means a share of a total. Reusing it would teach a reader that a full orange bar
  means "everyone got paid" and then show them a full bar that only means "this rail moved all
  the money".

Processor **labels** come from the Pay Processors registry (`hurupay` → Kolan, `wires` →
x1153); the id is never renamed to match. `readPayProcessorRegistry` **throws** on a failed
read, so the route wraps it and every label falls back to its raw id — a screen of correct,
reconciled money must not 500 because nobody could look up the word "Kolan".

Verified against production 2026-09-11 by `scripts/verify-cycle-processor-breakdown.ts`
(read-only): money reconciles to the cent, payments and unpaid people both sum to the month
row, and no email appears anywhere in the output.

## The HR rate is over STAGED, never over LISTED

The funnel is listed → staged → submitted → attended → promoted, and the **headline is
`promoted / staged`** (Kane, 2026-09-04). Three inherited rules carry it:

1. **The week is `hr_new_hire_checklist.period_start`, joined on personal email**, resolved by
   the shared `pickChecklistWeek`. A pending row has no link back to the checklist and its
   `start_date` is null on essentially every live row, so `start_date ?? created_at` filed
   **46% of hires one week early** — see [manager-orientation-attendance.md](./manager-orientation-attendance.md).
   Both routes call the same resolver, so this tab, HR's Orientation tab and the Manager tally
   cannot disagree about which week a hire belongs to.
2. **Listed ≠ staged, and every rate is over staged.** Live: 1,479 listed, 1,049 staged. A
   listed hire with no `hr_pending_employees` row can never carry a promoted stamp, so a rate
   over `listed` could never reach 100% and would read as a pipeline failure when it is an
   intake gap. The gap is the **Never staged** KPI card instead — 430 people, the largest
   single loss in the funnel and the number this tab exists to make visible.
3. **A week with nothing staged is unmeasurable, not 0%.** Every checklist week before
   2026-06-07 looks like this, and so does a freshly-listed current week.

**Attendance is the STAMP (`orientation_attended_at`), never `status`.** Production carries
rows where the two disagree in both directions. A promoted hire is never also counted as a
no-show, even when both stamps are set.

Staged hires matching no checklist row keep their **own row at the bottom of the table**
("Not on HR's checklist"), are counted in the totals, and never join a month rollup — their
week would have to be derived from `created_at`, which is the known-wrong key.

## The HR numbers are live and decay; the payroll numbers are frozen

This is the sharpest difference between the two tabs and the reason they poll but never claim
to be a record:

- **Payroll cycles are frozen declarations.** A closed cycle's numbers are what the clerk
  approved at close time and do not move afterwards, even if money goes out later.
- **HR pipeline is a live read, and old weeks drift down.** Offboarding removes
  `hr_pending_employees` rows (`scheduled_deletion_at`), so a past week's `staged` count
  shrinks over time and its rate moves. Both tabs stamp `generatedAt` as "Read HH:MM:SS"; the
  HR tab additionally says this in words. Do not add caching that hides the read time.

**A failed read is never an empty state.** Both routes return the error and `null` data rather
than an empty series, and both tabs keep the previous numbers on screen and show a loud banner
— "zero closed cycles" and "we could not read the closed cycles" render identically on a
percentage screen, and one of them is a lie. On the HR route, a failure of **either** checklist
read returns 500 with no numbers: the only fallback week key is the 46%-wrong one, so there is
deliberately no degraded mode.

## Aggregates only — this route family never returns PII

Inherited from [system-diagnostics.md](./system-diagnostics.md) § Security. Counts, rates and
dates only; no names, no emails, no rates of pay.

- The payroll route reads `listCycleCloseouts()`, which already projects away `unpaid.payees`
  (`CycleCloseoutSummary`). Nothing re-introduces them.
- The HR route reads whole hire rows via `listOrientationHistory()` — **including names,
  personal emails and pay rates** — and projects each one down to seven fields before anything
  counts them. `listChecklistWeekCounts()` is count-only by construction, deliberately unlike
  its sibling `listChecklistWeeksByEmail()`, which must return emails to do the week join.

If you add a column to either tab, check it against this section first.

## Every read is paged

`selectAllPaged`, no `.range()`. Live sizes: `hr_new_hire_checklist` 1,479 · `hr_pending_employees`
1,049 · the `dispatch.cycle_closeout.%` scan grows one row per week forever. PostgREST caps at
1,000 rows **with no error**, so an un-paged read here would silently under-count the oldest
weeks and quietly flatter both funnels.

## The tab strip: mount once, then hide

A tab is mounted the first time it is opened and then **stays mounted**, hidden with Tailwind
`hidden`. Never unmount them:

- Unmounting throws away fetched data and React Flow's entire canvas, so every switch back
  re-fetches, re-skeletons and re-lays-out — the repaint the Manager shell suffers from
  (see `manager-dashboard-shell-cache`).
- Deferring the *first* mount until the tab is opened is what stops the page firing three
  requests on arrival.
- `hidden` (display:none), not `opacity-0` — a transparent pane still takes layout and still
  animates.

Smoothness rules that must survive an edit, all in `performance-ui.tsx`:

- **The first read raises a modal progress bar**, not a layout skeleton (Kane, 2026-09-04:
  *"instead of skeletons lets add a modal progress bar"*). See § below.
- **It is first-load only**, derived from `!everLoaded && !data`. A background poll never
  blanks or covers a screen that was already correct.
- **Every number is `tabular-nums`.** Proportional digits change width as they change value,
  so a polling counter visibly shivers.
- **Bars animate `transform` / `width` inside a fixed-height track**, starting from 0 on the
  next animation frame (a value set in the same paint as insertion has nothing to transition
  from).
- **`motion-reduce:` on everything animated.**

## The loading modal never reaches 100% on prediction

`PerfLoadingModal` reuses `src/lib/payroll/step-load-prediction.ts` — the Payroll Wizard's
step-rail predictor — rather than deriving its own maths. `payroll-wizard-step-load.md` § 6 and
its memory note both forbid inlining that module back into a component, and the reason applies
here with more force, not less:

> A full bar on a payroll screen is a claim that the figures behind it are safe to read.

So `predictedProgress` ramps to **90%** across the duration this browser remembers, then eases
asymptotically toward **99%** if the read overruns — movement without a false finish. **Only the
data landing fills it.** The observed duration is folded into a localStorage EMA
(`hris.diagnosticsPerf.loadMs.v1`, keyed per tab) so the second visit predicts better than the
first.

Four behaviours that look incidental and are not:

- **A failed read never completes the bar** and never trains the estimate. The modal leaves
  immediately and the error banner takes the screen. Filling to 100% and *then* revealing an
  error is the same false "done" the ceiling exists to prevent — and a read that died after
  300 ms is not evidence that this tab loads in 300 ms.
- **The fill is written to `style.transform` from a rAF loop, never React state.** A `setState`
  per frame re-renders the whole tab while its own fetch saturates the main thread, which is
  exactly when the bar must stay smooth. Nothing sets `transform` or `transition` through the
  style prop; React would re-assert it on render and fight the loop.
- **Only the landing transitions**, and it is attached one frame *before* the fill is painted.
  Declaring the transition and changing the value in the same paint makes the bar jump to full
  instead of travelling there.
- **The modal is dismissable.** A modal that cannot be closed is a trap. Closing it does not
  cancel the read; the numbers arrive underneath either way.

Under `prefers-reduced-motion` there is no rAF loop at all: the bar holds one honest static
position, which still reads as working and still cannot claim to be finished.

The dialog carries `gap-0` and a `max-h` because the shared popup is a `grid gap-4` with **no
height cap at all** — see `docs/design/responsive-design.md` § "Dialogs and modals".

Both tabs poll every **120 s**, deliberately slower than the service map's 30 s: the map is a
health feed where a mid-session outage must surface on its own, while these are records and a
funnel that move once a week.

## Deploy notes

**No migration.** No DDL, no new table, no column, no n8n import, no env var, nothing for Kane
to run. Every number is derived from tables and `app_settings` keys that already exist.

One additive data-access export was added to an existing module —
`listChecklistWeekCounts()` in `src/lib/supabase/hr-new-hire-checklist.ts`. It touches no
existing function.

**2026-09-11, the per-processor breakdown: also no migration.** Both halves already existed in
the close-out records — `byProcessor` has been written on every record since the close-out
shipped, and the unpaid split is derived from `unpaid.payees`, which was already stored. No
DDL, no new route, no n8n import, no env var.

Two additive changes to existing modules, neither touching an existing function's behaviour:
`aggregateUnpaidByProcessor()` in `cycle-closeout.ts`, and one new field
(`unpaid.byProcessor`) on `CycleCloseoutSummary`, populated by `toCycleCloseoutSummary`.
The payroll route additionally reads the Pay Processors registry for labels, best-effort.

**Not clicked through in a browser** — typecheck clean, 86 unit tests green, and the route
returns its 401 gate under the live dev server. The arithmetic *was* verified against
production by `scripts/verify-cycle-processor-breakdown.ts`.

**2026-09-11, the trend chart: also no migration.** `selectTrendCycles()` is a pure addition
to `cycle-performance.ts` and `CycleTrendChart` a pure addition to `performance-ui.tsx`; both
derive from the `cycles` array the tab already polls. No route change, no new read, no DDL.
Verified against production by `scripts/verify-cycle-trend.ts`; **not clicked through in a
browser** — typecheck clean, `/admin` compiles and redirects to login.

The chart became a **line/area** on the same day (Kane: *"Not a bargraph please a line graph
kinda Histogram"*), which rewrote two rules rather than adding any — see § "The line BREAKS"
and § "The rate axis is NOT zero-based". Still no migration, no route change, no new read.
103 unit tests green.
