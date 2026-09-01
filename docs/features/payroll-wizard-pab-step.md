# Payroll Wizard — Step 6 "PAB"

A review step between **Contractors (5)** and **Validation (7)** listing everyone who lost the
Perfect Attendance Bonus for the active PAB period, how many days cost them it, a button onto
the existing PAB Calendar, a **Forgive month** action that restores the bonus, and an
**Ignore** action that declines it (writes the month's PAB exclusion). It exists because a
month's ₱5,000 could be lost to one or two short days that were a shifting schedule rather
than absence, and nothing in the wizard ever showed that list.

Since **2026-09-01** the step is the payroll's **last call** on PAB and its tab exists on the
rail **only during the payout week** — see [the tab only exists on the payout
week](#the-tab-only-exists-on-the-payout-week).

Shipped **2026-08-28**; Ignore + payout-week gate **2026-09-01**. Source:
`src/lib/payroll/pab-ineligibility.ts`, `src/lib/payroll/pab-payout-week.ts`,
`app/api/payroll-wizard/pab-forgive-month/route.ts`,
`src/components/payroll/PabIneligibleTable.tsx`, `src/components/PayrollWizard.tsx` (step 6).

## Key files

| Piece | File |
| --- | --- |
| Failed-day detail — pure, tested | `src/lib/payroll/pab-ineligibility.ts` |
| The identity alarm | `src/lib/payroll/pab-ineligibility.test.ts` |
| Payout-week tab gate — pure, tested | `src/lib/payroll/pab-payout-week.ts` (+ `.test.ts`) |
| Forgive-the-month batch write | `app/api/payroll-wizard/pab-forgive-month/route.ts` |
| Ignore-the-month write (exclusion) | `app/api/pab-exclusions/route.ts` — pre-existing, see `pab-exclusions.md` |
| The table | `src/components/payroll/PabIneligibleTable.tsx` |
| The Done tab (receipts) | `src/components/payroll/PabDoneTable.tsx` |
| Row builder + step body | `src/components/PayrollWizard.tsx` (`pabIneligibleRows`, `case 6`) |
| The verdict this step explains | `src/lib/payroll/dispatch-bonuses.ts` (`computePabEligibleEmails`) |

## Forgiveness writes DISPUTES, never a month-level grant

The obvious design is the mirror of `pab_period_exclusions` — that blob zeroes a person's PAB
for a month, so a grant blob would restore it. **It was scoped and deliberately rejected.**

An approved `pab_day_disputes` row is the only PAB input that every verdict in the product
already reads: the dispatch rail (`current-pay.ts`), the employee/manager rail
(`member-monthly-pay.ts`), both wizard breakdowns, `EmployeeDashboard`, `EmployeeMyHours`,
`EmployeePabCalendar` and `Overview`. A new blob would need a read added to each of them, and
the existing month-level store is the proof of what happens when that is not done: **nothing
under `src/components/employee/` mentions `pab_period_exclusions` at all** (`grep -rn
"exclusion" src/components/employee/` → zero hits), so a person zeroed by an accountant is
still told on their own dashboard that they are eligible. An invisible GRANT is worse than an
invisible exclusion, because it is a benefit the employee was told they received.

**"Whole month, not per-day" is a statement about the button, not about the store.** The batch
writes one approved dispute per failed day. Do not "simplify" this into a single row.

Per-day forgiveness is unchanged and still lives in two places: the PAB Calendar modal's
`handleForgiveDay`, and the step-4 Additions **Attendance Issues** panel (which lists people
who FILED an issue, scoped to the active department — a different list from this one, which is
everyone who FAILED, filed or not, across every department).

## `override_hours: 7` — the value that reaches the employee

Both forgive paths write a flat `7`. Server-side that is indistinguishable from the `null`
(or `5`) the modal used to write: `applyPabAdjustments` bumps any forgiven day with ≥4h
effective to a full 7h regardless, so **no pay changes**.

What changes is the employee's own screen. `EmployeeDashboard` applies `override_hours` as a
plain SET and skips `null` entirely, and 5h sits below the 7h bar — so before this change a
forgiven person kept a failing day, `pabViolations` kept counting it, and the dashboard read
**"No longer Eligible for PAB, Try again next month — violated on <the exact days that were
just forgiven>"** while dispatch paid them the bonus. `EmployeeMyHours` applied the ≥4h→7h bump
and said the opposite, on the same person, at the same time.

Writing 7 makes the dashboard agree with the money **without touching the dashboard**. The
visible trade: a forgiven cell reads `7:00` with a "Forgiven" chip instead of real tracked
hours. That is the opposite of the choice `orphanage-pab-coverage.md` made, and the difference
is real — orphanage coverage is an *additive top-up* that never needs a SET, so it can afford
to keep honest hours.

`EmployeeDashboard` still does not call `applyPabAdjustments` and still ignores a `null`
override. That divergence is **out of scope by ruling** (Kane, 2026-08-28: "a separate thing
that would inherit") and is now inert for anything this step writes — but an older dispute row
carrying `null` or `5` still shows the old contradiction.

## Ignore writes the month's PAB EXCLUSION — the existing store, the audited route

**Kane's ask, 2026-09-01:** the step is where everyone gets their *last* shot at PAB — worthy
people are forgiven, and everyone else is explicitly **Ignored**: "their PAB eligibility is
ignored for the month and that PAB period."

Ignore writes a `pab_period_exclusions` entry for `(person, month)` through
**`/api/pab-exclusions`** — the same route the System Bonus modal's exclusion toggle calls.
Never a raw `app_settings` write and never a new store:

- The route owns the **audit row** (`pab_exclusion.added`) and the **best-effort employee
  notification** (`pab.excluded`). `pab-exclusions.md` documents the 107 author-less entries
  that are the cost of skipping it.
- The exclusion list is already read by every pay path (`current-pay.ts`, both wizard
  breakdowns via `perfectAttendanceEligible`), so no verdict needs a new read.
- The known blind spot — `src/components/employee/` reads no exclusions, so an excluded person's
  own dashboard does not say so — is **inert for this cohort**: everyone on this step is already
  `ineligible`, so their dashboard already reads ineligible. The gap remains real for excluding
  an *eligible* person from the modal (unchanged here).

Money effect, stated plainly: an ignored person earns **₱0 PAB for the period even if a later
time adjustment would have rescued a failed day**, until the exclusion is lifted (System Bonus →
PAB settings). That is the decision the button records.

**A decided row LEAVES the list** (Kane 2026-09-01 PM — supersedes the same-morning "row stays
with an Excluded chip" design). Forgive flips the verdict, Ignore trips the excluded skip in
`pabIneligible`; either way the row exits with a slide-out animation (`AnimatePresence` +
`motion.tr`, exit-only — page flips play no entrances) so the click has a visible receipt. This
is NOT the all-clear-that-hides-people failure, because removal follows an **explicit decision**
and the count survives: the KPI strip's disclosure line names how many ineligible people are
ignored (managed in System Bonus → PAB settings, where the exclusion is lifted). The table's
Excluded chip / disabled-Forgive / "Excluded from PAB" filter guards are kept but normally
unreachable — defensive, like the `no-hours` band, in case the population rule is ever relaxed.
Row removal also stopped resetting the pager: only filter/search changes reset to page 1, and
`safePage` clamps when the page count shrinks.

The write is keyed to the **step's evaluated month** (`pabMonthRange`) — deliberately not
`editMonthKey`, which follows the System Bonus modal's month picker and can point at a
different month. Forgive and Ignore are opposite verdicts on the same month, so one in-flight
write freezes both buttons on the row.

## Step 1 Configuration's "Pay this week" also empties this list

A department toggled OFF in Step 1 → Configuration is filtered out of every downstream step
(`effectiveCalcResults` — its people take no pay this run), so they take no PAB decision here
either (Kane 2026-09-01): `pabIneligible` skips anyone whose dept key is in `pausedDeptKeys`,
using the **same dept-key resolution as that filter** (`employeeDepts[email] ??
employeeDepts[lowercased]`). Counted and disclosed on the strip's line as "in departments not
paid this week", never silently dropped. Display-only — pausing a department already keeps its
people out of dispatch; this makes the review list agree with the run.

## The Done tab — receipts for both decisions

The step carries a `Needs review | Done` strip (Kane 2026-09-01 PM, same ask as the realtime
below). **Done is an action log, not an attendance ranking**: everyone acted on this PAB
period, folded from the TWO existing stores and nothing new — forgiven = approved
`pab_day_disputes` days (`approvedDisputeDates`, already period-fetched; all three forgive
paths write the same rows so month-batch, calendar-modal and Attendance-Issues forgiveness all
land here), ignored = the month's `pab_period_exclusions` entries. **No population gates** —
an off-roster person someone excluded still shows, unlike the review list. A person can carry
BOTH chips (days forgiven, then ignored); the exclusion is what pays (₱0). Filters: decision
(All / Forgiven / Ignored — the filter Kane asked for), department, search; same
never-strand/never-hide rules as the review tab. Its empty state is honest by nature: an empty
receipts list claims only that nobody has acted yet, so it carries no all-clear hazard.

Switching tabs is animated as state, not decoration (product motion register): the active pill
**slides** between tabs (shared `layoutId`, the step rail's own idiom) and the panes crossfade
directionally — each pane enters from and exits toward its own tab's side (review left, done
right), exit 120ms / enter 180ms on ease-out-quint, transform + opacity only,
`mode="wait"` so the two tables never overlap. Every motion on this step (pill, pane swap, row
exits, the rail tab's entrance and ping) collapses to instant under `prefers-reduced-motion`.

## Realtime — several accountants work this step at once

Decisions converge every open wizard live (Kane 2026-09-01: "multiple persons are working on
this PAB section"). One Supabase channel, `payroll-wizard-pab-decisions`, **Broadcast, never
`postgres_changes`** — anon + RLS means row events never reach the browser
(`payment-dispatch.md` rule). Senders fire AFTER their write succeeds, fire-and-forget:

| Action | Event payload |
| --- | --- |
| Forgive month (step 6) | `days_forgiven` + the re-read day list |
| Forgive day (calendar modal) | `days_forgiven` + the dispute id |
| Revoke day (calendar modal) | `day_revoked` |
| Ignore (step 6) / exclusion toggle (System Bonus modal) | `exclusion_changed` |

Receivers patch the SAME local maps the actor patches (`approvedDisputeDates` /
`approvedDisputeIds`) so the row leaves B's review list exactly as it left A's;
`exclusion_changed` triggers `pabPeriodSettings.refresh()` instead, because the exclusions
blob is month-keyed globally and the route owns the write. Dispute patches are **guarded by
`monthKey`** — `approvedDisputeDates` is period-scoped, and seeding stray months would pollute
every consumer keyed off it; a viewer on another month refetches on month switch anyway.
Best-effort by design: a missed message costs freshness until the next fetch, never
correctness — the stores stay the source of truth. The channel subscribes for the wizard's
whole life (the wizard stays mounted across app tabs), so events are not missed while the
operator sits on another step.

**OPEN — `/api/pab-exclusions` is read-patch-write with no CAS.** Two accountants ignoring two
different people at the same moment can lose one entry silently (the same last-write-wins
shape `payroll.wizard.exclusions` still has; MV solved it with `casUpdateAppSetting`).
Multi-operator use makes this window live now. Flagged 2026-09-01; the fix belongs in the
route, not the wizard.

## HSL failures display as WHOLE WEEKS

HSL PAB is won week-by-week, so an HSL row's chips show the full Sun–Sat week each failure
sits in — "Aug 2 – Aug 8" … "Aug 23 – Aug 29", the period's own boundary days appearing as the
start/end of their weeks (Kane 2026-09-01) — with the short days and shortfalls in the chip's
hover title. `groupFailedDaysByHslWeek` (`pab-ineligibility.ts`, tested) groups
`computePabIneligibility`'s verbatim output on the same `hslWeekStartIso` anchor the quota walk
uses; **severity stays the day count** and the engine identity is untouched. Non-HSL rows keep
per-day chips — their bonus is won day-by-day. Legacy Mon→Sun months group on Monday weeks
automatically, since the model rides the same required `hslSunSat` flag as everything else.

## The tab only exists on the payout week

**Kane's ask, 2026-09-01.** The PAB tab appears on the step rail only when the **selected file
week is the payout week** — the week whose dispatch carries the bonus — and it mount-animates
(spring entrance + persistent emerald pulse) every page load during that week, so the payout
week announces itself.

The gate is `isPabPayoutWeekForRange` (`src/lib/payroll/pab-payout-week.ts`, tested), which is
nothing but the two shared pieces the money path uses: `pabMonthFromWeekStart` (a Sunday
file-start's owning Monday is the NEXT day) and `isFinalPabWeek` (containment — the week
CONTAINS the period end, never `weekEnd >= periodEnd`), over the same period-end resolution as
the wizard's dispatch memo (valid legacy manual range → month override → code default).

- **Keyed on the SELECTED FILE WEEK, never the wall clock.** The 2026-08 period ended Sat
  Aug 29; during the operational week Aug 30 – Sep 5 the wizard is processing the
  `2026-08-23_to_2026-08-29` file — that file contains the period end, so the tab shows all
  week, which is what "the payout week" means in arrears. Wall-clock gating would also break
  replay: replaying a past payout week **still shows the tab** (read-only via the existing
  `isReplay`), because a replay shows the week as it was paid.
- **Ids stay contiguous 1–9.** The step is filtered out of the rail's *render*; `nextStep` /
  `prevStep` step over id 6 when hidden, and an operator standing on 6 when the gate flips
  (week switched, override moved) is snapped back to 5. The progress bar, both real gates
  (red-flag confirm 7, FX-zero 8) and all eight number sites are untouched.
- **False until the PAB settings have loaded once** (`pabSettingsEverLoaded`) — judging off
  unfetched default ranges could flash the tab onto the wrong week. Gated on
  ever-loaded, not `loading`, because `refresh()` flips `loading` true on every save and would
  blink the tab out mid-action.
- **The emerald pulse is emerald on purpose** — the bonus pays this week; amber stays the
  wizard's warning colour.
- **Standing landmine, inherited:** a month nobody overrides falls back to `getPabMonthRange`'s
  Mon→Fri default (September 2026 = Mon Sep 7 → Fri Oct 2), which moves the payout week and
  therefore when the tab appears. The gate follows the money either way — a documented test
  case pins it. Accounting sets the override monthly (`pab-calendars-sun-sat-sweep`).
- Forgiveness outside the payout week still exists where it always did: the PAB Calendar
  modal (reachable from People/Overview) and the step-4 Attendance Issues panel.

## Severity explains a verdict; it never reaches one

`pabIneligibleRows` takes membership from **`effectivePabStatus`** — the same verdict the
Additions pill, the staged toggle and the dispatch row read. `computePabIneligibility` only
names the days. A review surface that re-decides who failed is a second implementation of a
money rule, and this codebase already carries eight independent PAB verdicts.

`in_progress` people are deliberately absent: mid-period they have failed nothing yet, and
listing them would invite forgiving days that may still be worked.

**The identity test is the alarm.** `pab-ineligibility.test.ts` asserts that the set of people
with `severity === 0` is exactly `computePabEligibleEmails(...)` for the same inputs, across
three period shapes × six attendance patterns × both cohorts. If it fails, PAB money has moved
— the same role `pab-calendar-sun-sat-display.test.ts` plays for the Sun–Sat grid.

## HSL counts weeks, not days — and that is why the column is useful

Non-HSL PAB is won day-by-day (every Mon–Fri ≥7h). HSL PAB is won week-by-week (≥5 qualifying
days of each 7). So for HSL three carve-outs apply, lifted verbatim from the shipped calendar
modal: **weekends never count as failed**, an **overnight-qualifying day never counts** (the
shift crossed midnight; the hours are real), and a day inside a **week that reconciled** never
counts.

Consequence that looks like a bug: an HSL person short on four days can show severity 0. They
made quota every week. That is also what makes "1 or 2" meaningful — under this definition a
low count is a genuine near-miss rather than an artefact of a shifting schedule.

## The evaluated window is WIDER than the PAB period

`computePabIneligibility` scores a missing day as zero hours, exactly as the engine does. So
**under-supplying days does not error — it manufactures failures.** HSL weeks anchor back to
the Sunday on/before the period start, so when a period opens mid-week (2026-07 began Mon
Jul 6) that Sunday is outside the period and still scored. Use `hslCoverageStart(...)` →
`periodEnd` to size the window, never `[periodStart, periodEnd]`.

The identity test caught exactly this on its first run, and a named regression test pins it.
**Do not "fix" a boundary failure by padding zeros — widen the window.**

**OPEN:** the wizard's own `allDaysColumnGroups` filters from `pabMonthRange.start` and is NOT
wide enough, so for an HSL person in a period that opens mid-week the wizard's breakdown can
under-count the opening week relative to the engine. Widening it would change
`perfectAttendanceEligible` — a money-adjacent verdict — so it was left alone. The step drops
any row that resolves to severity 0 rather than showing a Forgive button with nothing to
forgive.

## People are named, never emailed — and the name has three sources

The Employee column shows the **master quoted nickname** and nothing else. The email is the
join key every write is addressed to; it is never rendered, and it is not in the search
haystack either.

Resolution order, and why it needs three tiers:

1. `masterIndex` (`master.name`) — the same field `calcResults` uses, so the nickname on this
   step is identical to the one on every other wizard surface. `byWorkEmail` already indexes
   both alternate work emails, so an aliased Hubstaff row still resolves.
2. `calcResults` — this week's file.
3. The Hubstaff row's own `Member` name.

Tier 3 is not belt-and-braces. **Measured 2026-08-28 against live data:** the PAB month spans
2,086 emails with hours, but `/api/employees` serves `active_employees`, which resolves only
**1,200** of them — the month includes people who have since left the active roster. The full
`global_master_list` would reach 1,831. Every Hubstaff row carries a `Member` name, so tier 3
closes the remaining 886 with a real name.

Resolving off `calcResults` alone — the first version — missed nearly everyone, because
`effectivePabStatus` spans the whole PAB month while `calcResults` holds only the current
week's file. The fallback was the raw email, so the column rendered addresses.

If all three miss, the row still renders, as an explicit *"Unknown — not on the master list"*
with the address in a `title` tooltip only. **Do not drop the row** — that is the all-clear
that hides someone, and **do not fall back to the email** as a display name.

The **Employee ID** (`master.employee_id`, `YYMM-NNNN`) sits under the name — the slot the
email used to occupy, because an internal identifier is safe to show where a personal address
is not. It is also searchable. It comes only from the ACTIVE roster, so it is `—` for the same
people whose name falls through to the Hubstaff `Member` tier: measured 2026-08-28, 1,328 of
1,329 roster rows carry an id and all 1,200 hubstaff emails that resolve to a roster row have
one — the other 886 have no roster row at all. **Never synthesise an id to fill that dash.**

## The population: ACTIVE on the Global Master List, WITH hours

**Kane's rule, 2026-08-28.** PAB covers people who are active on the Global Master List and who
actually have hours in the period. Nothing else belongs on this step.

Both exclusions are applied in one place — `pabIneligibleRows` — against one shared set,
`pabScoredEmails`, which the KPI strip also counts from, so the list and the cards can never
describe different populations.

Measured 2026-08-28, over the 2,086 emails the month's merge carries:

| | Count |
| --- | --- |
| Excluded — not active on the Global Master List | 886 |
| Excluded — no hours in the period | 194 |
| **Listed** — active, with hours, and failed a day | **476** |
| …of which 1–2 day cases | **176** |

Before the rule the list was 1,203 rows, 874 of them off-roster. The 1–2-day cohort the step
exists for was buried under leavers who had not worked since May.

**Neither exclusion is silent.** The KPI strip carries a line naming both counts, so a list that
suddenly shrinks is always explained. Losing that line would turn a scoping rule back into the
all-clear-that-hides-people.

## "No hours recorded" is not a severity — it is missing evidence

A person with **no tracked time on any scoring day** did not miss every day; they were never
scored. `pabSeverityBand(severity, hasHours)` bands them `no-hours`: **amber** chip and amber
`—` in the severity cell (Kane 2026-09-01 — amber, not greyed out: missing evidence is a
warning to check, not furniture; the original zinc read as ignorable). Amber stays legal here
because it is the wizard's warning colour and this is genuinely a warning — never an OK state
(step-2 header cards ruling). No day chips, Forgive **disabled** ("there is no missed day to
forgive"), and they sort BELOW everyone with real hours.

**Why this matters, from the live failure that caused it.** Aaron Taguas resigned 2026-06-02,
has no August Hubstaff data at all, and scored **severity 15** — the top of the August list,
above every genuine 1–2-day case the step exists to surface. Measured 2026-08-28: **871 of the
2,086** emails the month's merge carries are in that state. Ranking them as the worst
attendance in the company buried the real cohort and offered a Forgive button for a bonus the
person cannot earn.

Since the population rule above now excludes them from the list outright, the `no-hours` band is
a **defensive guard rather than a state you will normally see** — it exists so that relaxing the
population rule can never silently re-rank a never-scored person as the worst attender. Keep it.

## The KPI strip is MASTER-LIST scoped, and it reports THREE buckets

The step's header is a four-card strip, not prose (Kane 2026-08-28). Every figure counts only
people who resolve to a master-list row through `masterIndex` (work, both alternate work, or
personal email).

**Why scoped.** `effectivePabStatus` spans every Hubstaff email across every uploaded week of
the period — ~2,086 in 2026-08 — and **886 of them (42%) have no roster row at all**. Counting
those would make "Eligible / Ineligible" describe a population nobody manages.

**Three cards, and the arithmetic is the point: Eligible + Ineligible = Evaluated, exactly.**

`effectivePabStatus` is tri-state, but a card literally labelled "Eligible" reading **0** is
worse than useless — mid-period nobody is finalised, so the raw `eligible` bucket is 0 *by
construction* and reads as a bug. The Eligible card therefore folds in the still-running
verdicts (nobody has failed yet), renames itself **"Eligible so far"** while the period runs,
and states its own provisionality in the hint. Once the period ends it becomes plain
"Eligible".

**This card is where eligible people live.** The table below is an EXCEPTIONS list — passing
people are deliberately absent from it — so their count has nowhere else to appear. Do not
"simplify" the strip by dropping it back to the raw `eligible` bucket; that is the 0-that-looks-
broken again. Measured 2026-08-28: **530 eligible so far · 476 ineligible · 1,006 evaluated.**

**The off-roster remainder is disclosed, never dropped** — an amber line under the strip names
how many had hours but are not on the master list, following the `mesa.md` idiom. They still
appear in the table below and can still be forgiven; they are simply not counted above.

**Two guards, same failure class the table already carries.** While `!pabMergeLoaded` the strip
shows a counting state, never four zeros — a KPI card reading "0 Ineligible" during the
wizard's slowest fetch is the all-clear-that-hides-people bug wearing more authority than the
sentence it replaced. And when `masterRosterUnavailable`, every GML-scoped number is 0 by
construction, so the strip says the roster failed instead of showing the zeros.

**The `step6-pab-review` tutorial anchor moved onto the strip's wrapper, verbatim.** Deleting
the node would orphan `guide.ts`'s step-6 target, and nothing tests that link — step 7's
`step7-validation-table` is already dead exactly that way (the DOM says `step6-validation-table`).

## Filters narrow the view; they never remove anyone

Department and status filters sit beside the search box, following the rule
`dispatch-log-department-filter.md` set for the Payment Dispatch log views:

- **A filter never hides a row.** A person whose department cannot be resolved lives under an
  explicit **"No department"** bucket rather than dropping out of every view.
- **A selection that leaves the data resets itself.** If the last row of a department is
  forgiven, the filter falls back to "All departments" instead of stranding the table on an
  empty view with no way back. Same for the status filter.
- **Options are built from the UNFILTERED rows**, so they cannot shift under the pointer while
  another filter is in use.
- **The raw key is the option VALUE; `catalogDeptNameFrom` produces the label.** The slug must
  never reach a human, and the raw value must never be shown just because it is the key.
  `employeeDepts` holds normalized KEYS (`lead_gen`, `hogan_smith_law`), not master labels, so
  `formatDeptLabel` alone is not enough — it only rewrites the HSL family and passes every
  other key through unchanged, which is how the filter first shipped showing `lead_gen`.
  Resolution is **Payment Catalog registry → built-in `DEPARTMENTS` → humanized slug**, and
  namespaced sub-keys resolve as "Parent — Sub" rather than being humanized whole
  (`medical_billing:intake_team` would otherwise read "Medical billing:intake Team").
  Verified against live data: all 39 department values and the normalized key space both
  resolve with zero slug-looking labels.
- The count line always states the filtered total against the true total, and says filters
  narrow the view only. The "N ineligible" headline chip is always the UNFILTERED count.

Status options are the severity bands (**Review** 1–2 days, **Repeated** 3+) plus **Excluded
from PAB**, and each appears only when some row is actually in it.

## OPEN — HSL cannot appear on this step until the period's last day

**Measured 2026-08-28.** The department filter shows no HSL entry, and that is not a filter
bug. `pabStatusByEmail`'s HSL branch is:

```
if (isHsl) { map.set(email, periodEnded ? (eligible ? 'eligible' : 'ineligible') : 'in_progress'); }
```

So every HSL person is `in_progress` until the PAB period ENDS, and this step lists only
`ineligible`. With the 2026-08 window closing Sat Aug 29, all **587** HSL-family people on the
active roster were `in_progress` on Aug 28. The frozen snapshot for the 08-16 week agrees:
564 in_progress, 21 ineligible, 0 eligible — and even those 21 are lifted back to
`in_progress` by `effectivePabStatus`'s upgrade-never-downgrade rule.

**Why this matters more than it looks.** The step exists for the cohort the ask named — "1 or 2
days, probably HSL with shifting schedules". That cohort is precisely the one that cannot be
reviewed until the day the period closes, which is the day it is too late to act calmly.

**Why non-HSL differs.** A non-HSL person locks `ineligible` on their first PAST failed
weekday: the verdict cannot be salvaged by future days, so it is safe to state early. The same
argument holds for HSL at the WEEK level — once a week has closed with fewer than 5 of its 7
days qualifying, that week can never be recovered and the month is already lost. So HSL COULD
be locked mid-period on closed weeks only.

**Not changed here, deliberately.** `pabStatusByEmail` drives the Additions pill, the
auto-applied `perfect_attendance` toggle and therefore the staged dispatch amount. Making HSL
lock mid-period would move a money-adjacent verdict for 587 people, which is a decision to take
explicitly, not a side effect of a review screen. Raised with Kane 2026-08-28; pending.

Second landmine in the same branch, for whoever takes it on: after the period ends the HSL
verdict reads `perfectAttendanceEligible`, which returns an EMPTY SET when
`pabMonthColumnCoverageComplete` is false. On 2026-08-28 only 15 of the 20 expected Mon–Fri
column groups were uploaded, so a period that ended while coverage was short would mark every
HSL person `ineligible` at once. Any fix must handle incomplete coverage as "cannot judge yet",
never as "everybody failed".

## The PAB Calendar modal is two columns, not a tower

The modal (`PayrollWizard.tsx`, the `pabCalendarModalEmail` block) is `max-w-6xl` and lays the
calendar LEFT with the verdict, failed days and forgiven days in a right rail.

Stacked — how it shipped — a 15-day failure list put every Forgive button below the fold, so
acting on the list meant scrolling past the thing you were acting on. Side by side the modal's
height is `max(calendar, verdict)` rather than their sum.

Rules for anyone touching it:

- The rail carries its own scroll (`lg:max-h-[74vh] lg:overflow-y-auto`) and the failed-days
  list caps at `max-h-[46vh]`, so neither can drive the modal's height.
- It collapses to ONE column below `lg` — a two-column grid at laptop width squeezes the
  calendar into unreadability.
- The verdict card keeps `mt-3` for the stacked case and drops it (`lg:mt-0`) as the rail's
  first child.
- The header names the person through the same chain as the step-6 list (master → calc row →
  Hubstaff `Member`), falling back to an explicit unknown. It used to render the raw email.

## An empty list has three causes and they are NOT interchangeable

The first version of this step rendered "Nobody is ineligible for August 2026 — every
evaluated person cleared the attendance rule" whenever the row array was empty. That is the
worst failure this surface can have: **the all-clear that hides the exact people the step
exists to surface.** It shipped that way and was caught immediately against live data, where
the same period actually has ~1,557 ineligible people.

The table now separates:

| State | Condition | What it says |
| --- | --- | --- |
| Loading | `!pabMergeLoaded` | "Loading attendance for \<month\>" — the all-weeks merge is the slowest fetch in the wizard (one request per archived upload) |
| Not evaluated | merge done, `effectivePabStatus.size === 0` | amber — "could not be evaluated… this is **not** an all-clear" |
| Genuinely clear | merge done, verdicts exist, none ineligible | emerald, and it names the evaluated headcount |

**Never collapse these back into one branch.** An empty array is not evidence that nobody
failed; it is evidence that nobody failed *or* that nothing was measured, and only
`pabMergeLoaded` plus a non-zero verdict count can tell them apart.

## `col` is a label; `iso` is the date

Breakdown entries carry both. `col` is `pickPreferredHubstaffColumn(group)`, which returns
the canonical `monday`…`sunday` name for any week whose upload had no day-prefixed header —
and `parseColDate` cannot read those. Anything that needs the DATE must use the resolved
`iso` the breakdown now exposes, never re-parse `col`. Today's live columns happen to be
plain ISO dates, so re-parsing `col` works by luck; it stops working the moment a canonical
week is merged in.

## The batch is all-or-nothing, and re-reads before it reports

A half-forgiven month is worse than none: the operator sees success, the employee stays
ineligible, and nobody knows which days are missing. So the route attempts every day, then
**re-reads the table** and reports the days that are actually forgiven — never "forgave N
days", which is a claim about writes rather than about eligibility. Any shortfall is a 500
carrying the per-day outcome.

It is idempotent (the table is unique on `(work_email, dispute_date)`; an already-forgiven day
is a no-op) and it **refuses to touch a denied row** — reversing an explicit denial belongs in
the Issues queue where the note and the original decider are visible.

Audit: one **`pab_dispute.month_forgiven`** row for the decision, on top of the per-day
`pab_dispute.approved` rows `decideDispute` writes. The per-day rows are what the pay path
reads; the summary row is what makes "granted the whole month of August" legible as a single
act instead of something an auditor reassembles from twenty fragments. `pab-exclusions.md`
documents the cost of skipping this: 107 person-month entries with no recoverable author.

## Renumbering: the rail is 9 steps and the ids must stay contiguous

`1` Initialize · `2` Initial Calculation · `3` Orphanage · `4` Additions (+HSL tab) ·
`5` Contractors · **`6` PAB** · `7` Validation · `8` Dispatch · `9` Reports.

Step 6's tab is conditionally **rendered** (payout week only, above) but its id is
unconditional — hiding is a render filter plus nav skip, never a renumbering.

The progress bar is `currentStep / steps.length` and completion is `currentStep >=
steps.length`, so an id gap reads past 100% and marks Reports complete at Dispatch. Step
numbers live in **eight** places that move together:

1. the `steps` array, the `currentStep` comparisons, the `isStepDataLoading` cases, the
   `renderStepContent` cases and the `data-tutorial-target` attrs — all `PayrollWizard.tsx`
2. `tutorial/guide.ts` — target keys, `stepId`, `resolveStepTargets`, `deriveStepStatus`, and
   the `n >= 1 && n <= 9` localStorage bound
3. `tutorial/guide.test.ts` — the contiguity assertion
4. `tutorial/TutorialGuide.tsx` — now derives from `TUTORIAL_STEPS.length` rather than a
   hardcoded number, which had already drifted once
5. `wizard-setup-steps.ts` — the operator-facing `stepNo` strings
6. `AdminWebhooks.tsx`, `validation-breakdown.ts`, `payroll-wizard/audit/route.ts` — prose
   naming a step number
7. this doc and the reference docs
8. the two REAL gates, which must be re-asserted by number after any move: the red-flag
   confirm (now **7**) and the per-cycle FX-zero hard block (now **8**)

Closing check: `grep -rn "Step [1-9]" src app docs`.

## Deploy notes

**No migration.** No new table, no new `app_settings` key, no DDL.

No new notification type — the batch rides `dispute.approved`, already in
`employee_notifications_type_check`. This was deliberate: a new type is dead until a DDL
restating the whole list runs, and it dies *silently* because delivery is best-effort
(`pab.excluded` was dead for 17 days that way).

The `pab_dispute.month_forgiven` audit action is a new string. `NewAuditLog.action` is typed
`AuditAction | string`, so it compiles with no type feedback and needs registering in
`AuditLogPanel` to render with a label rather than raw.
