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
