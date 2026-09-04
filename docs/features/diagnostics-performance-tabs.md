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
| Shared chrome (KPI card, rate bar, skeleton) | [`src/components/admin/performance-ui.tsx`](../../src/components/admin/performance-ui.tsx) |
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
