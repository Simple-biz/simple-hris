# QC scoring — officers, the weekly deal, and the first pass

> **This surface had no feature doc until 2026-09-10.** A 623-line data layer
> (`src/lib/supabase/qc-db.ts`), four API routes, a 1,033-line dashboard
> (`src/components/qc/QCApp.tsx`) and a shared 5,360-line calculator, whose entire written
> record was one clause in `docs/features/INDEX.md` row 24 plus an "out of scope,
> deliberately" aside at `hsl-kpi-calculator-2026-07.md:573`. The doc `bonus-calculator.md`
> that row 24 names is an April PAB/Tech reference with **zero** QC mentions.
>
> Written alongside the 2026-09-09 Carla/Jackie meeting's Wave 1 corrections. See
> [`docs/meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md`](../meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md) §3.

## What it is

QC officers do a **first pass** at Lead Gen bonus scoring so the department manager does not
type every number. Officers score in the QC dashboard; their numbers stage in
`qc_kpi_submissions`, and Jackie reviews and finalises in the Manager KPI Calculator.

| Piece | Where |
|---|---|
| Dashboard | `app/qc/page.tsx` → `src/components/qc/QCApp.tsx` (tabs: Overview · QC Calculator · Notifications) |
| Scoring UI | `DeptBonusCalculator` with `variant="qc"` — the SAME component the manager uses, with a different write endpoint |
| Data layer | `src/lib/supabase/qc-db.ts` |
| Routes | `app/api/qc/{assignments,submissions,lock,review}/route.ts` |
| Tables | `qc_score_assignments` · `qc_kpi_submissions` · `qc_officer_locks` · `qc_review_status` |
| Route gate | `src/lib/auth/route-access.ts` — `{ prefix: '/qc', roles: ['qc', 'admin'] }` |
| Officer identity | a **role grant**, not a list: `employee_roles` where `role='qc'` and `revoked_at IS NULL`, ordered by `assigned_at` |

**Migrations #88 then #89** (`references/sql/migrate/2026-06-26_qc_role_and_tables.sql`,
`..._qc_transfer_memory.sql`) are required — until #89 runs the slot upsert throws "column
does not exist" / "no unique constraint", surfaced as a 500. Per
[[migration-pending-claims-are-folklore]], run `scripts/audit-pending-migrations.mts` rather
than believing either claim.

## Which departments are QCed

`QC_DEPT_KEYS` in **`src/lib/qc/constants.ts` is the single declaration.** Everything derives
from it — `QCApp`'s tab order and department cards, the submissions fetch, the manager
calculator's department list, and all three `QC_DEPT_SET` copies.

**Lead Gen only, since 2026-09-10.** Carla: *"just Lead Gen needs to be QCed."*

Removals are additive-safe and reversible, and this is the established pattern:

- **Discovery** left 2026-06-26 — its manager scores it directly.
- **Callback** left 2026-09-10 — Jackie scores it herself; she declined putting Jerome on it
  since he would be the only member.

A department that leaves **keeps every `qc_score_assignments` / `qc_kpi_submissions` row it
already has** and simply stops being listed. Re-adding the key brings its history back into
view. Nothing is deleted, so nothing needs migrating either way.

> **OPEN (Carla):** whether Accounting needs a read path to a retired department's past QC
> history. Today it is retained-but-invisible, which is what the Discovery precedent
> established. A history view would be additive.

## Who the officers are — the QC DEPARTMENT, never an admin grant

Changed 2026-09-14. Kane: *"I dont want the admin provisions to be the source of the QC
Pickers I just want the people under the QC Department to assist the LEADGEN manager in
scoring their KPI's."*

`listActiveQcOfficers` derives the officer list from the **active roster**: everyone whose
department normalizes to `QC_OFFICER_DEPT_KEY` (`'qc'`). It no longer reads
`employee_roles.role='qc'`.

> **`QC_OFFICER_DEPT_KEY` is where the scorers sit. `QC_DEPT_KEYS` is who gets scored.**
> Conflating the two would either enrol Lead Gen people as officers or have officers score
> themselves. They are different constants for that reason.

**Why the grant had to go — it drifts, and it had.** Measured 2026-09-14: the `qc` role held
**10** people, the QC department held **9**. The extra was `jeromer@`, who had transferred to
**Callback Team** and was still being dealt **34 Lead Gen slots that week**. A roster-derived
list cannot drift, because the roster is what defines the department.

The `qc` role rows are **left in place, unused by the deal**. Removing provisions is a
separate, audited decision, and leaving them costs nothing.

> **There is no "QC Manager" role, and `qc` is not one.** `qc` is the OFFICER role (its UI
> label in Admin → Roles & permissions is "Manager's assistant", which is what makes it look
> like a manager grant). Granting it to a manager enrols them as somebody who gets dealt
> people to score. A manager's authority comes from `department_managers`.

### A dealt week is FROZEN

Once a week has slots, its officers are **the officers already on those slots** — not
whoever is in the QC department right now. `freezeOfficers` (`src/lib/qc/officers.ts`).

This is what makes a roster-derived list safe. Under the old grant the officer set only moved
when somebody clicked. Derived from the roster, an ordinary department transfer, an offboard,
or a master-sheet clobber ([[hris-is-dept-source-of-truth]] — the sync still writes Department
from the sheet) changes it, and an officer-set change re-deals the current week. Without the
freeze, routine roster churn would reshuffle every officer's slice underneath people who are
already scoring.

So `regen = existing.length === 0`. **This supersedes the old
`regen = existing.length === 0 || officerSetChanged`** and the line that said revoking
membership "also triggers a re-deal of the current week" — it no longer does, deliberately.
Kane chose this for the Jerome case: he finishes the week he is in and is not dealt the next
one. A new officer likewise joins on the next week's deal, and a slot appearing mid-week is
still balance-filled among the frozen set.

## The period key is a SUNDAY, and the boundary enforces it

Fixed 2026-09-14. `qc_score_assignments.period_start` is a pay-week Sunday. Nothing checked
that, and **`GET /api/qc/assignments` writes** — `ensureQcAssignmentsForPeriod` deals and
upserts a whole week of slots for whatever key it is handed. So a client passing a Monday did
not read the wrong week. **It manufactured one.**

Two clients did. Both seeded a period from the local clock with a Monday-anchored helper and
fetched before the real week resolved: `QCApp.tsx`'s `useState(() => isoWeekStart(new Date()))`,
and the manager calculator's `QcOfficerLog`, which received a raw `weekStart` while every other
write site on that screen was already gated on `weekResolved`. The hazard was written down a
module away the whole time — `use-pay-weeks.ts:48`: *"a KPI row written under a Monday key is
invisible to every reader forever … Sunday in, Sunday out."*

**Measured before the fix** (`scripts/audit-qc-period-key-drift.mts`, read-only):

| | |
|---|---|
| Periods in `qc_score_assignments` | 29 |
| **Non-Sunday (phantom) periods** | **10** — ~3,250 slot rows |
| Phantoms shadowing a real Sunday week | 9 — e.g. `2026-09-07` Mon (404 members) beside `2026-09-06` Sun (397), **385 in both** |
| Phantoms holding scores | **0** |

Three locks now, because one was demonstrably not enough:

1. **`src/lib/qc/period.ts`** — `isQcPeriodStart` (a type predicate, so callers narrow by
   checking rather than asserting) and `qcPeriodStartError`, which names the weekday it
   actually is. Pure, client-safe, unit-tested.
2. **The route refuses a non-Sunday key with 400, *before* the deal call.** Order is
   load-bearing and pinned by a source-scan control: that call writes, so a late check would
   reject the response after the phantom week had already been dealt.
3. **Neither client seeds a period from the clock.** `QCApp` holds `''` until `usePayWeeks`
   resolves a real batch Sunday; `QcOfficerLog` is passed `weekResolved ? weekStart : ''`.

> The ten phantom periods are **left in place** (Kane, 2026-09-14: fix and report, delete
> never). They hold no scores, so they are dead slot rows; the audit script re-reads them and
> **exits 1 if a phantom ever holds a score**, which is the only state needing a decision
> rather than an observation.

`2026-09-14` is an **orphan** phantom: its real Sunday (`2026-09-13`) was never dealt at all.
The week to score on that date is `2026-09-06`, which exists and is frozen.

## The weekly deal — the rule most likely to be violated

**Slots are dealt to officers in a SEEDED-RANDOM order, evenly, and re-dealt each week.**

Carla, 2026-09-09: *"in accounting I would rather have it randomized so that no one has a
buddy on a certain team and they're like, oh I'm going to give them 10 appointments."*
Jackie: *"Great point. Let's do that."*

**That control did not exist until 2026-09-10.** `ensureQcAssignmentsForPeriod` sorted each
department's slots by email and dealt them `i % officers.length`, so officer #1 held the
alphabetically-first slice of Lead Gen **every single week, indefinitely** — precisely the
buddy risk the ruling was meant to close. Kane answered *"it's randomized already"* in the
meeting and the topic closed on it. The *even* half of that claim was true.

The deal now lives in **`src/lib/qc/deal.ts`** (pure, 9 tests) over the shared
`src/lib/seeded-shuffle.ts`.

**Why seeded and not `Math.random()`** — an unseeded shuffle would be worse than the bug:

- The deal is recomputed on **every read** of `/api/qc/assignments`. Unseeded, the same week
  would split differently on every dashboard load — an officer's slice would be
  unreproducible, unauditable, and would appear to change under them mid-scoring.
- The engine **writes only the diff**. An unstable deal turns every read into a full rewrite
  of the week and churns Realtime.
- An unseeded shuffle cannot be tested, so neither the even split nor the not-alphabetical
  property could be pinned — and pinning them is what keeps this fixed.

Seed is `(period_start, department)`: reproducible within a week, independent across weeks,
and uncorrelated between two departments in the same week.

**The regression test is the control.** `deal.test.ts` asserts the deal is *not* the
alphabetical round-robin and that the first officer owns no contiguous alphabetical block. If
that ever passes trivially again, the buddy risk is back.

### What did NOT change, and must not

- **STICKY SNAPSHOT** (`qc-db.ts`): once a slot exists for a week it is **never deleted**. If
  the member transfers or offboards the row is kept and flagged (`roster_status`,
  `current_department`) so their score and bonus for that week still stand. See
  *Transfer memory* below — the flag half was broken from 2026-06-26 until 2026-09-14.
- **Diff-only writes, never deletes** — a no-op read must not churn Realtime.
- **Even split**: counts differ by at most 1 per department. Dealing positions round-robin
  over a permutation preserves this exactly; only the order changes.
- **Regen semantics**: `regen = existing.length === 0 || officerSetChanged`. A fresh week
  deals randomly. An **existing** week is only re-split when the active officer set changes;
  otherwise prior attributions are kept and a new slot is **balance-filled** against the load
  already on the board (`leastLoadedOfficer`), never by reshuffling the week out from under an
  officer mid-scoring.
- A re-deal moves **responsibility, not scores**: `qc_kpi_submissions` conflicts on
  `(period_start, department, employee_email, bonus_id)` — it is not officer-keyed — so moving
  a slot cannot orphan a number already entered.

## Transfer memory — and why nobody's status means "stop scoring"

Fixed 2026-09-14. Kane: *"If an employee was Leadgen on monday and was HSL on tuesday to
friday due to midweek transfers the rules should be that if they have an appointment set for
KPI on monday they should still be able to be scored"*, and separately *"we still need to
score people who quit by the way like offboarded people."*

Three statuses, three distinct facts:

| `roster_status` | Means | `current_department` |
| --- | --- | --- |
| `active` | still in the department this slot scores | the slot's own department |
| `transferred` | still employed, in a different department | **where they are now** |
| `removed` | not on the active roster at all — they left | null |

> **NONE of them gates scoring.** The officer's own slot list (`myRows`,
> `app/api/qc/assignments/route.ts`) filters on officer email and nothing else, and **must
> never gain a status filter** — a source-scan test in `src/lib/qc/officers.test.ts` is the
> control. Status says what the surface SHOWS about a person; it never decides whether they
> can be paid for work they already did. `members` in that route is for email aliasing of
> active people only; transferred and removed people reach the calculator through
> `myByDept`.

**`transferred` was unreachable for its entire life — 0 of 8,537 rows.** The roster feeding
the deal was narrowed to the scored departments *before* the status branch ran, so anyone who
left them had no current department to record and fell through to `removed`. A Lead Gen → HSL
transfer was therefore indistinguishable from quitting, and the data a "Transferred to
&lt;Department&gt;" indicator would need was always null.

The fix reads the **full active roster** once and derives both the scored slots and a
current-department map from it (`currentDeptByEmail`). **The roster READ widened; the KEYS did
not.** Do not ever "fix" a status problem by widening `QC_DEPT_KEYS` — that enrols a
department into QC scoring, which is a scoring decision wearing a bug fix's clothes.

**Forward only** (Kane's call). The 1,032 historical `removed` rows keep their value; only
slots written from this deploy onward can carry `transferred`. Backfilling would re-classify
closed weeks.

### The officer's count matches the officer's list

`summarizeOfficers` counts **every** slot, whatever its status. It used to count only
`active` ones, so an officer holding 34 active plus 2 leavers saw a headline of **34** against
a list of **36**. Once leavers and transfers are explicitly still scored, the count is the
half that was wrong — the list was always right. Same failure mode this doc already warns
about for week keys: give the cards one key and the summary another and both become
untrustworthy.

## The slots are the roster AS OF THE SCORED WEEK

Shipped 2026-09-14. The deal drew its slots from the **live** active roster, whatever week it
was dealing. That is right only while the week being scored is the week you are standing in.
With 50–75 people offboarded a week, anybody who left or moved between a week ending and an
officer opening the dashboard simply vanished from the only roster the deal could see.

Carla, 2026-09-14: *"there's going to be people that were offboarded that are on the usual list
that Jackie sends us, but they're not going to be assigned … and they'd have to be added
externally into the lead gen. And same if they got transferred to HSL."* Asked whether the code
already covered it: *"That's not happening. Every time someone gets transferred, we have to just
add it externally. Same as if they were offboarded."* And the rule itself: *"If they were in
Legion during the time that we're scoring, then they need to be in there so that they don't have
to use the add external member button."*

The rules live in `src/lib/qc/roster-as-of-week.ts` — pure, and unit-tested case by case.

| | |
|---|---|
| **KEEP** | everyone the live roster puts in the department (the old behaviour) |
| **ADD** | offboarded, or moved out on a transfer effective after the week ended |
| **DROP** | a filed transfer INTO the department dated after the week ended — they were not there |

**A midweek move is "there".** Kane: *"within the week if they are still legion at that time
they can still be scored."* Only a move effective strictly after the week's last day counts
either way; a transfer dated inside the week never moves anyone.

### Every rule fires on a POSITIVE record, never on an absence

Transfer data here is known to be incomplete — a move can go unfiled entirely
([[markm-hsl-transfer-never-filed]]) and a sheet sync can clobber a department
([[hris-is-dept-source-of-truth]]). **Nobody is dropped because a record is missing.** They are
dropped only when a filed, applied/approved transfer says they arrived after the week was over.
An absent or unparseable date always means *keep* — pinned by test, because the alternative is
failing to pay somebody for work they did.

### The window is bounded at BOTH ends

A departure counts for a week only while `weekStart <= when <= weekEnd + 14 days`.

The **lower** bound is Carla's rule — *"then after that I am gone"* — someone stamped before the
week began was already gone and was paid out in an earlier run. The **upper** bound exists so a
closed week is not rewritten: the window covers the *churn gap* (week ends → officer opens the
dashboard), not the whole question of who was in the department. Someone who moved out two
months later was obviously there that week — and was also on the live roster when that week was
dealt, so the roster path already had them.

**Measured** (`scripts/verify-qc-roster-as-of-week.mts` — read-only, runs the real function,
never deals):

| Week | Before | After | Added | Dropped |
|---|---|---|---|---|
| `2026-09-06` (live) | 382 | **491** | **+121** — 90 offboarded, 31 transferred out | −12 |
| `2026-06-21` (closed) | 382 | 445 | +64 | −1 |

Those **121** are precisely the people Carla and Jackie were adding by hand, one at a time.
Unbounded, the same rule would have dealt **240** new slots into the closed June week.

The verifier **exits 1 if anyone is dropped without a dated transfer-in record** backing it.

> A read failure is not an empty list. If the offboard or transfer read fails, the deal falls
> back to the live roster — exactly the pre-2026-09-14 behaviour, never a week silently missing
> its leavers.

## The roster carries people who have LEFT, and the deal now drops them

Shipped 2026-09-14, after Kane spotted two long-gone people on the Lead Gen calculator:
*"I shouldn't see him in Lead Gen KPI Calculator because he is long gone."*

**`active_employees` cannot answer "has this person left."** `/api/hr/offboard` stamps a
`global_master_list` row that is **not the one the view serves**, so the served row keeps
`off_boarded_at = null` indefinitely. This was measured and written down for the Payment
Catalog on 2026-08-21 (`catalog-roster-visibility.ts`: *zero* of 1,287 active rows carried a
stamp while **294** of those people were off-boarded per the evidence sources) and the catalog
shipped a guard. **The QC deal never got one.**

Measured 2026-09-14, a month later and essentially unchanged:

| | |
|---|---|
| Active roster the deal reads | 1,373 |
| Carrying a **dated departure record** elsewhere | **284** |
| …in a QC-scored department, dealt slots every week | **188** |
| Hidden once all four guards apply | **158** in Lead Gen (the other 30 are correctly kept) |

`johna@simple.biz` completed the offboarding pipeline on **2026-07-20** — `offboarding_queue`
`completed`, an `offboarded_sheet` row written by the HRIS — and was still dealt a Lead Gen
slot for **2026-09-14**, seven weeks later.

### One implementation, four guards, shared with the Payment Catalog

`hasDepartedBeforeWeek` (`catalog-roster-visibility.ts`) is now the single predicate; the
catalog's own `isOffboardedForPaymentCatalog` is a pure delegation to it, pinned by test. **Do
not write a second one** — two implementations of "has this person left" is how two surfaces
come to disagree about one employee. The guards, unchanged: a canonical **departure reason**
(allowlist, so `duplicate_cleanup` and `temporary_pause` never hide anyone), the record must
**post-date their own Start Date** (re-hires), they must have left **before the scored week**,
and **hours in that week always keep them** — a timesheet row cannot be forged by a stale stamp.

Evidence is matched on **WORK email only**: a personal inbox is shared across duplicate master
identities, so matching on it imports someone else's departure.

### It is applied in TWO places, and the second is not optional

1. **The deal** (`ensureQcAssignmentsForPeriod`) — no new slot is created for someone who had
   already left.
2. **The read** (`app/api/qc/assignments/route.ts`) — because a slot is a **sticky snapshot and
   is never deleted**, the 188 dealt before this guard existed would otherwise render forever.
   Nothing is deleted; the rows stay on the record and stop being shown. The filter runs
   **before** `myRows`, so the officer's list, the manager's log, `deptTotals` and the officer
   summary all derive from the same filtered set.

> **This is not the `roster_status` filter that `officers.test.ts` forbids, and the difference
> is the date.** `roster_status` describes somebody who **worked** the week and then moved or
> left — it must never gate scoring, and it still doesn't. This guard drops only people whose
> departure **pre-dates** the week, who therefore did not work it at all. Anyone who left during
> or after the scored week is untouched. Both rules are pinned by their own control test.

### What it does NOT fix

- **The root cause is untouched and still open**: a completed offboard leaves the served master
  row unstamped. This is the same second lock the Payment Catalog uses, on another surface.
- **A departure the HRIS never recorded at all is invisible to it.** `amielaa@simple.biz` was
  offboarded in the Google Sheet with no queue row, no `offboarded_sheet` row and no stamp — no
  predicate can find evidence that does not exist. That class needs a master-sheet import.
- **19 ghosts sit in `hogan_smith_law`**, which the HSL calculator reaches by a different roster
  path. Not covered.

Fails **OPEN** at every level: an unreadable evidence or timesheet read yields an empty set and
a `degraded` note. Hiding a live person means their KPI bonus is never scored and never paid;
showing a departed one is noise. Verified by `scripts/verify-qc-departed-members.mts`
(read-only, runs the real function, asserts named emails are hidden).

## An absent officer does not block the week — the manager takes over

Kane raised it on 2026-09-14: *"what if a certain person from QC is absent like the whole week?
They have people to score but they can't."* Carla: Jackie should jump in, *"as a manager, she
should just be able to do it."*

**Ruled 2026-09-14: nothing needs building.** Jackie already has every capability, and the code
was checked against the claim rather than assumed:

- **Her roster is the whole department, not a slice.** In manager mode the calculator reads
  `rosterByDept`, never `qcRosterByDept` (`DeptBonusCalculator.tsx`) — the officer split governs
  who is *asked* to score, never who *may be* scored.
- **An unlocked slice cannot block her.** `readOnly` in manager mode depends on the
  department's own status (`d.status !== 'draft'`), not on any `qc_officer_locks` row. An
  officer who never locks — because they were never there — leaves the manager unblocked.
- **She can see who is behind.** The QC first-pass rail shows each officer's slot count and
  lock state, and clicking one filters the table to that officer's people.

> One wrinkle worth knowing before it is reported as a bug: the officer filter narrows the
> manager's table, and that table is built from the **active** roster. A leaver assigned to the
> absent officer is therefore reached through the **Offboarded · last pay** strip rather than
> the filter. Coverage is complete, but by two paths rather than one.

The frozen-week rule is why this matters: an absent officer's slots are **not** redistributed
mid-week (`regen = existing.length === 0`), so "the manager jumps in" is the whole recovery
mechanism, not a fallback to one.

## Eligibility — start date only

The only filter is employment start date: a member whose `start_date` is after the scoring
week is excluded, and **unknown or unparseable start dates are KEPT** ("we can't prove they
hadn't started") — the house fail-toward-keeping pattern.

**There is no Hubstaff join.** Kane's *"people with hours will be checked"* in the meeting is
**unbuilt**, so zero-hours Lead Gen people are dealt to officers today, and Lead Gen carries
~193/week "listed never scored" ([[hubstaff-zero-hours-gap]]).

> **OPEN (Carla):** whether zero-hours people should be excluded. This is a **money ruling,
> not a cleanup** — every comparable predicate in this codebase fails toward keeping the
> person (INDEX row 24 names four such guards), and [[offboarded-bonus-scoring]] notes the
> wizard pays only people with a row in the week's Hubstaff file anyway.

## Interactions worth knowing

- **Dispatch lockout** (`payment-dispatch.md` §6.3): while `payroll.dispatch_locked` is true
  the QC dashboard takes a full client takeover — only Notifications stays usable — and
  `/api/qc/{submissions,lock,review}` return **423**. GETs stay open, so assignment generation
  still runs during a lock.
- **QC does not announce.** Only HR, Accounting and Employee mount the chime
  (`notification-alerts.md`) — load-bearing if anything here is ever meant to notify.
- **Never persist load-seeded state.** The QC first pass would otherwise be written by merely
  OPENING the tab, attributed to whoever opened it ([[kpi-calculator-autosave]]).
- **The `qc` role is the first thing to check when a chip is missing** — a QC officer's fetch
  403'ing once rendered every Colombian in the wrong currency
  ([[settlement-currency-per-person]]).
- **Officer membership is not granted at all any more — it is department membership.** Moving
  somebody into or out of the QC department on the master list is what adds or removes an
  officer, and it takes effect on the **next** week's deal, never the current one (see *A
  dealt week is FROZEN*). The `qc` role in Admin → Roles & permissions, group "Manager's
  assistant", no longer feeds the deal; the rows are retained but inert.
- **The period selector offers the upcoming week** (amber *Upcoming*, never *Past*) —
  `usePayWeeks().upcomingWeek`, the same `upcomingWeekFor` the manager calculator uses, so
  officers can do the first pass before the Hubstaff file exists (Kane Q2, 2026-09-10).
  Scores land under that Sunday's key and the manager sees them the moment the file uploads.
  One week only. Rule and hazards: `hsl-kpi-calculator-2026-07.md` §Scoring the upcoming week.

## Compare / Override / Undo — Jackie's sheet against the officers' first pass

Shipped 2026-09-10 (same-day approval of the revised brief). Manager mode, QC departments,
**draft weeks only** — a locked week is reopened through the existing path first.

**Where it lives (Kane, 2026-09-10, later that day):** the toggle is a chip in the card header,
beside **→ Payout** — *"Compare with your sheet"*. It is **disabled, never hidden**, while the
week is published or the table is still loading; the hint says to reopen the week. While enabled
it wears a running emerald rim (`.compare-ring`, Kane: *"an outline border color running color
green"*) — the rim is never drawn on the disabled chip. The first
cut was a collapsed row above the table and Kane could not find it — a hidden control is an
unfindable one. The body unfolds below the toolbar with a height + opacity animation
(`motion/react`, the file's `EASE`; `useReducedMotion` cuts instead). The body is never
rendered while `readOnly`, so the draft-only rule is unchanged.

**Flow.** Jackie pastes her sheet → **Compare** → a bucketed diff → **Override** → **Undo**.

| Piece | File |
|---|---|
| Parser (pure) | `src/lib/qc/paste.ts` · `paste.test.ts` (10) |
| Diff (pure) | `src/lib/qc/compare.ts` · `compare.test.ts` (11) |
| Panel + Override + Undo | `DeptBonusCalculator.tsx` — `compareMembersFor`, `runCompare`, `applyOverride`, `undoOverride`, and the panel above the officer rail |
| Officer attribution | `DeptAppliedPayload.rows[].scored_by` — the GET always returned it; the client type dropped it until now |

### The results panel is BOUNDED and scrolls

Carla, 2026-09-14: she pasted **18 overrides**, could see **4**, and could not scroll to the
rest. The panel is `flex-none` inside a fixed-height card, so it grew to its natural height and
was clipped by the ancestor's `overflow-hidden` — with no scroll of its own.

What that hid was not only the differences table. The **skipped-lines list sits directly
underneath it**, already open by default, already naming every refused line and why. She could
not reach the one thing on screen that explained what was happening.

The body is now capped at `max-h-[min(70vh,34rem)]` with a sticky table header.
**Never remove the cap without giving the content its own scroll** — the failure is silent, and
it presents as "the system is hiding people from me".

**The cap alone was not enough** (Kane, later the same day: *"does not scroll down properly on
the right side"*). One scroller wrapped both columns, so reaching row 18 dragged the paste box
and the Override button off the top, and the result side — the only column that grows — could
not be scrolled on its own. The body is a capped `grid` with `grid-rows-[minmax(0,1fr)]` at both
levels and **each column scrolls independently at `lg`**; below `lg` they stack under one inner
scroller. The `minmax(0,1fr)` row is load-bearing: an `auto` row sizes to max-content, the columns
stretch to the row rather than the capped container, and overflow is clipped, not scrolled. Inside
the right column the differences table takes the slack (`lg:flex-1 lg:overflow-y-auto`, which is
what lets `sticky top-0` actually stick), and the **skipped-lines and QC-only lists are `shrink-0`
and capped** so a long table can never push the explanation below the fold. Paste box is
`rows={14}`.

### A person QC scored who is not on this week's table is refused as `off_table`

The fifth refusal kind, added 2026-09-14. Before it, a pasted person the manager's table did not
contain got `unmatched` — *"No one in this department matches that work email"* — which reads as
*your paste is wrong*. It was the roster that moved.

**Measured for week `2026-09-06`: 203 of the 374 Lead Gen people QC scored were not on the
manager's table.** 122 were July leavers a `clearOffboarded` sync had resurrected
([[master-sync-never-un-offboards]]); the rest are leavers the as-of-week deal adds to the QC
slice which the manager's roster never carried.

`off_table` fires only when the pasted address matches a **`qc_kpi_submissions` row for this
week** — i.e. QC really did score them — and names the person **and the way to reach them**:

> *Aguilar, John Robert B "Robert" was scored by QC but is not on this week's table — add them
> from the "Offboarded · last pay" chip in the card header, then Compare again.*

**The refusal says what to DO, never why they are off the table.** The first cut asserted a
cause — *"they left before the week being scored, so nothing here can pay them"* — which was true
of the July ghosts and became wrong for **every** case the moment those rows were deleted. What
remains are leavers whose final pay cycle **is** this week: the QC deal adds them, the manager's
roster never carried them, and they **are** owed their score. Pinned by test.

A pasted address **nobody has scored** stays plain `unmatched`. A typo must never be dressed up
as a departure; both cases are pinned by test.

> **Nothing about Override changed.** It still applies only to `mismatch` and `paste_only`
> entries, which by construction are people on the table. A refused line was never silently
> dropped — it was listed, under a panel nobody could scroll.

### QC scores for people who left before the scored week are removed

`scripts/cleanup-qc-scores-for-prior-leavers.mts` — read-only without `--apply`, full SELECT
backup to disk first. It deletes a `qc_kpi_submissions` row only when its person has a **dated
departure record STRICTLY BEFORE the week the row scores**, resolved on **work email**.

Left **during or after** the scored week, no evidence, or an undated record — the row stands.
**`bonus_catalog_applied` is never touched**: that is the money table, this is the first pass.

**Applied 2026-09-14: 151 rows deleted, 0 failures** — 146 in week `2026-09-06`, 5 in
`2026-06-14`; 150 Lead Gen, 1 Discovery; ₱27,000 of staged first-pass values.

| | before | after |
|---|---|---|
| `qc_kpi_submissions` | 400 rows | **249** |
| rows scoring a prior leaver | 151 | **0** |
| lead_gen @`2026-09-06` | 374 rows / ₱151,750 | **228 / ₱124,750** |
| `bonus_catalog_applied` lead_gen | 218 / ₱38,000 | **218 / ₱38,000 — untouched** |

**81 of the remaining 228 belong to people not on the active roster, and that is correct.** They
are leavers whose final pay cycle is this week — the deal adds them, the manager's roster does
not carry them. They reach the table through the **Offboarded · last pay** chip, which is what
the `off_table` refusal now tells the manager to do.

### The paste is TAB-only, and a line without a tab is refused

`marcc@simple.biz ⇥ Cahig, Marc Joseph ⇥ 32`. Column 2 is the surname-first master name — it
**contains a comma** and may carry a quoted nickname. So nothing CSV-shaped may touch it, and the
orphanage paste's comma fallback (`PayrollWizard.tsx:8331`) — which would shred `Cahig, Marc`
into two cells and shift the count — was deliberately **not** copied. Also not copied: the
orphanage parser's silent ₱0 on a misaligned row (`Number('')` is 0 and its pricer has no
zero refusal). Here the count must be a whole non-negative integer or the line is refused with its
line number and reason. Column 2 is **display only**; matching never reads it.

### The variable is resolved PER MEMBER — never assumed

Production (read-only probe, 2026-09-10): the department bonus `bonus_mq9yxlmsyj7avdmc` scores
**`Appts_Set`** (`=IF(Appts_Set>=10, Appts_Set*500, Appts_Set*250)`); **reinelr@ is excluded**
from it and holds `Lead Gen (COP)` `bonus_mtddp1p5rf4hq1rw`, scoring **`Appts`** (`=Appts*14000`).
`compareMembersFor` walks the same `applicableBonuses` the table renders with and picks the
formula variable matching `/appt/i` (or the sole variable). A member with no such bonus is
**refused**, not skipped. `compare.test.ts` pins both live keys as fixtures the way
`team-rankings.test.ts` pins its own.

**The catalog is tables, not a blob.** `bonus_catalog_bonuses` / `bonus_catalog_assignments` via
`bonus-catalog-db.ts`. `BONUS_CATALOG_KEY` has no consumers and no `app_settings` row exists —
`src/lib/bonus-catalog/types.ts`'s header said otherwise until 2026-09-10.

### The join is WORK email → PERSONAL-first canonical, and ambiguity is refused

Applied and QC rows key on `personal_email || work_email`; the paste supplies the work email.
`compareAppointments` bridges through every email the master row owns and matches on the
canonical. A pasted address that resolves to **two** people is refused as ambiguous; two pasted
addresses resolving to the **same** person is a duplicate-person refusal (the parser can only see
duplicate strings). Unmatched rows are listed, never created (Kane, Q5).

### Four buckets; "wrong" is a count delta, in appointments

MATCH · MISMATCH (with `scored_by`) · PASTE_ONLY (no QC row) · QC_ONLY (not in the paste). Kane,
Q4: *"INACCURACY means that the values set by QC is different from the ones set by JACKIE"* — the
officers cannot see her sheet, so any delta is a scoring error. No pesos, no tiers, no FX.

### Override mutates `state` through `setVar` and NEVER assembles `rows[]`

Jackie's numbers win (Kane). Override applies to **MISMATCH and PASTE_ONLY only** — matches are
already right, QC_ONLY has nothing of hers to apply — by calling the existing `setVar` per cell.
That is load-bearing twice over:

- `saveDept` always posts the **full dept-week** and `saveDeptPeriodApplied` deletes every row not
  in the keep-set. Letting the existing autosave run whole is what keeps people **absent from the
  paste** exactly as they were. Absence is not zero.
- `bonus_catalog_applied.employee_email` is stored **verbatim** and is in the conflict target;
  `setVar` writes to the member's existing entry, so a case-variant from the paste can never become
  a second row the wizard sums. And `setVar` clears `seeded` with `dirty`, so the autosave gate
  treats it as a person's entry, not the load.

**Undo** restores **exactly the cells Override changed**, from an in-memory snapshot taken
immediately before — a cell that had no applied entry is removed, not blanked. Edits made elsewhere
since are untouched. It lives until the page is left: that is the "just in case" Kane asked for,
not a history feature (Q2).

**Compare re-fetches `/api/qc/submissions` every time.** The loader's QC seed fires only on a
never-saved week; after the manager's first save the officers' rows are never read again by it.
No new server read was added, so no new paging obligation — but `listQcSubmissions` is unpaged
and a single dept-week stays well under 1,000.

**One audit event**, `qc.compare_override_applied` (family `qc.` by prefix): week, pasted-row
count, and per row `from → to` with `scored_by`. Applied-row saves are otherwise deliberately
unaudited (`audit-log.md` §6, autosave volume); this is one deliberate bulk action during a parallel
test whose point is seeing who was wrong.

**Gate** (Q6): the existing `manager/hsl_bonus` edit + `department_managers` scope. Undo is the
same person, same gate. The 423 dispatch lockout is inherited from the existing route.

### The pasted sheet is SHARED per department-week (2026-09-14)

Kane: *"whatever was pasted in there should be visible to all — similar to Payroll Wizard, Orphanage
step."* Until this the text lived only in the tab that pasted it: Jackie pasted 207 rows and overrode
18 on the evening of 2026-09-14, and nobody else could see what she had compared against.

**Compare is the click that shares** — the orphanage step's "Lock in" moment. The text that was
compared is written to **`app_settings['qc.compare_paste.<dept>.<sunday>']`** as
`{ v, text, pastedBy, pastedAt, rowCount }`, stamped by the server from the **session** (never the
body), with `rowCount` re-derived server-side from the same parser the panel uses. Anyone opening the
panel for that dept-week gets the box **prefilled** and **Compare auto-runs** (`share: false`), so the
differences are shared too, not just the text. An attribution line names who pasted, when, and how
many rows. No migration: the carrier is the same `app_settings` table the orphanage blob uses.

| Piece | File |
|---|---|
| Key, shape, codec, body validation (pure, client-safe) | `src/lib/qc/compare-paste.ts` · `compare-paste.test.ts` (17, incl. 3 source-scan controls) |
| `GET` / `PUT` / `DELETE /api/qc/compare-paste` | `app/api/qc/compare-paste/route.ts` |
| Load on open · save on Compare · Delete all · reset on week change | `DeptBonusCalculator.tsx` — `loadSharedPaste`, `saveSharedPaste`, `clearSharedPaste`, the two effects after `runCompare` |

What holds, and why:

- **The `qc` role is not a reader.** *"The officers cannot see her sheet, so any delta is a scoring
  error"* is the premise the four buckets rest on. The route gates on the manager's `hsl_bonus`
  feature (`view` to read, `edit` to write) **and** a `department_managers` grant on the department
  (admin bypasses the scope, as `/api/qc/review` does). The generic `/api/app-settings` route
  **refuses the family on read as well as write** — it cannot scope by department — and a control
  test pins the predicate at all three entry points (bulk GET, single GET, POST).
- **The key is a QC department × a pay-week Sunday, or it is refused** — `isQcDeptKey` and the
  `qcPeriodStartError` lock from [[qc-period-key-must-be-sunday]]. A Monday key would share a sheet
  under a week no one else will ever open. The panel fetches only once `weekResolved`.
- **One scalar, replaced whole ⇒ last writer wins**, which `casUpdateAppSetting`'s own header
  prescribes for a scalar (CAS is for maps that carry deletions). The attribution says who wrote
  last; the box shows an amber *"differs from the shared sheet"* notice with **Use the shared
  sheet** when local text has drifted; and Compare **skips the write when the text already is the
  shared text**, so re-Comparing produces no churn and no audit row.
- **Nothing parseable ⇒ compared, not shared.** A paste with zero parsed rows still runs Compare
  (the refusals are the point) but the route refuses to store it — there is nothing in it for a
  second manager to see. Blank, oversize (>200,000 chars) and control-character text are refused
  the same way; the text that IS stored is verbatim, tabs and refused lines included, so the next
  viewer sees the same refusals.
- **Delete all is for everyone, confirmed inline, audited FIRST.** A `destructive` **Delete all**
  button sits in the Compare row (Kane, 2026-09-14, later: *"add a delete all button"*) →
  *"Delete the shared sheet for everyone and empty this box?"* (never `window.confirm`; a control
  test pins it). The route writes `qc.compare_paste_cleared` carrying the **full text** before
  deleting and **refuses the delete when that write fails** — another manager typed that sheet, and
  after it is gone `audit_log` is the only place it survives. A successful delete also empties the
  local box and its result, the orphanage step's "fresh start"; with nothing shared yet there is no
  server call and only the box empties. **Disabled, never hidden**, when there is nothing to delete.
  Saves write `qc.compare_paste_saved` with metadata only (row count, chars, whom it replaced) — the
  text is on the row.
- **The panel is per dept AND per week now.** Switching weeks resets the box, the result, the
  shared copy **and the Override Undo snapshot** — Undo writes `state[deptKey]`, which after a week
  switch holds the other week's members. The disclosure (`compareOpen`) is kept; the load effect
  fetches the new week's sheet for any panel still open. This is a tightening of "Undo lives until
  the page is left": a week is a page.
- **Prefill never overwrites.** A box with text in it when the shared sheet arrives is left alone —
  the notice and **Use the shared sheet** cover that case. Only an empty box is filled.
- **A load failure is not "nothing shared".** It is reported on the attribution line, and the next
  open retries; Compare still works and still shares.

**Open:** the body is still never rendered while `readOnly`, so a **published** week's shared sheet
is not viewable from the panel (the row and the audit trail have it). Widening that is a separate
decision — the draft-only rule above is unchanged.

### Not built, deliberately

The officer-accuracy **histogram** (separate brief — it names officers' error rates to a manager
who is not their manager). The "advanced version" where QC reviews appointments from the form and
that count becomes the Lead Gen figure — Kane: *"another topic of discussion that we are going to
get a hold off for now."*

See also: `bonus-catalog.md` · `payment-dispatch.md` §6.3 ·
`hsl-kpi-calculator-2026-07.md` · `hubstaff-zero-hours-gap.md`
