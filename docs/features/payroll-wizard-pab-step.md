# Payroll Wizard — Step 6 "PAB"

A review step between **Contractors (5)** and **Validation (7)** listing everyone who lost the
Perfect Attendance Bonus for the active PAB period, how many days cost them it, a button onto
the existing PAB Calendar, and a **Forgive month** action that restores the bonus. It exists
because a month's ₱5,000 could be lost to one or two short days that were a shifting schedule
rather than absence, and nothing in the wizard ever showed that list.

Shipped **2026-08-28**. Source: `src/lib/payroll/pab-ineligibility.ts`,
`app/api/payroll-wizard/pab-forgive-month/route.ts`,
`src/components/payroll/PabIneligibleTable.tsx`, `src/components/PayrollWizard.tsx` (step 6).

## Key files

| Piece | File |
| --- | --- |
| Failed-day detail — pure, tested | `src/lib/payroll/pab-ineligibility.ts` |
| The identity alarm | `src/lib/payroll/pab-ineligibility.test.ts` |
| Forgive-the-month batch write | `app/api/payroll-wizard/pab-forgive-month/route.ts` |
| The table | `src/components/payroll/PabIneligibleTable.tsx` |
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

## The KPI strip is MASTER-LIST scoped, and it reports THREE buckets

The step's header is a four-card strip, not prose (Kane 2026-08-28). Every figure counts only
people who resolve to a master-list row through `masterIndex` (work, both alternate work, or
personal email).

**Why scoped.** `effectivePabStatus` spans every Hubstaff email across every uploaded week of
the period — ~2,086 in 2026-08 — and **886 of them (42%) have no roster row at all**. Counting
those would make "Eligible / Ineligible" describe a population nobody manages.

**Why three verdict cards, not two.** `effectivePabStatus` is tri-state. An Eligible/Ineligible
pair silently loses everyone mid-period — including *every* HSL person, who is parked
`in_progress` until the period closes. **Eligible + Ineligible + In progress must equal
Evaluated**, or the strip lies by omission. Measured 2026-08-28: 0 / 329 / 871 over 1,200
evaluated — and Eligible is 0 *by construction* until the period ends, which is why that card
carries the reason on its face rather than a bare zero.

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
