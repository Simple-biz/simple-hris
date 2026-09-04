# Diagnostics performance tabs — payroll cycle success rate and the HR hiring funnel

Admin → Diagnostics gained a tab strip on **2026-09-04**. The existing service map became
one of three tabs; the two new ones each answer a "how are we doing" question with a
percentage: **Payroll Cycles** (Accounting — of the people a closed pay week owed money to,
how many were paid) and **HR Pipeline** (HR — of the people HR listed for a hiring week, how
many reached the Global Master List). Admin-only, inheriting the Diagnostics gate.

The two are **separate surfaces on purpose** (Kane, 2026-09-04: *"add KPI Cards as well,
separate HR from accounting"*). They measure different populations over different
denominators, and one blended company-performance number would be wrong in both directions.
Each tab owns its KPI cards, its accent (Accounting amber, HR indigo) and its own caveats.

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

## The series starts when close-outs started, and nothing before it is inferred

Kane, 2026-09-04: *"only when we started."* The first close-out was filed 2026-08-10. Weeks
paid before that are **absent from the tab**, not zero — there is no back-fill, no estimate,
and no second series from another table. The coverage footnote names the earliest
`period_end` on screen so the absence is visible; an absence nobody mentions reads as "we
paid nobody".

**A cycle that was never closed has no rate at all.** This is the
`orientation-week-stats.ts` `measurable:false` rule applied to payroll (Kane, 2026-08-26:
*"only produce data when it has been passed... if it hasn't been marked then just put a note
on it"*). It is not 0% and it is not 100%.

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

- **The skeleton mirrors the real grid box-for-box.** A skeleton whose layout differs from the
  content's makes the page jump when data lands.
- **The skeleton is first-load only**, derived from `!everLoaded && !data`. A background poll
  never blanks a screen that was already correct.
- **Every number is `tabular-nums`.** Proportional digits change width as they change value,
  so a polling counter visibly shivers.
- **Bars animate `width` inside a fixed-height track**, starting from 0 on the next animation
  frame (a width set in the same paint as insertion has nothing to transition from).
- **`motion-reduce:` on everything animated.**

Both tabs poll every **120 s**, deliberately slower than the service map's 30 s: the map is a
health feed where a mid-session outage must surface on its own, while these are records and a
funnel that move once a week.

## Deploy notes

**No migration.** No DDL, no new table, no column, no n8n import, no env var, nothing for Kane
to run. Every number is derived from tables and `app_settings` keys that already exist.

One additive data-access export was added to an existing module —
`listChecklistWeekCounts()` in `src/lib/supabase/hr-new-hire-checklist.ts`. It touches no
existing function.
