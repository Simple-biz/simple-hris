# Implementation Plan — Employee surface + Lead Gen QC (from the 2026-09-09 Carla/Jackie meeting)

> **Status: AWAITING APPROVAL — nothing is written to `src/` or `app/` yet.**
> Source record: [`docs/meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md`](../meetings/2026-09-09-carla-jackie-employee-surface-and-qc.md).
> Tracked as Open items **19–28** in [`docs/audits/audit-2026-09-10-session-log.md`](../audits/audit-2026-09-10-session-log.md).
>
> Waves 1–6 (§4–§9) are **changes to shipped surfaces** — they go through `hardening`, and each
> is a reviewable commit. §13 carries the **`BLUEPRINT` brief** for the two genuinely new
> surfaces (QC Compare/Override, manager-generated certificates); per
> `.claude/skills/blueprint/SKILL.md` those wait for Kane's approval of the brief before any code.
> §10 lists what is **deliberately not scoped** and exactly what unblocks each item.
>
> **Wave 1 has a hard external deadline: Monday 2026-09-14**, when Jackie and nine QC officers
> test with real data. Everything in Wave 1 is a correctness precondition for that test.

| | |
|---|---|
| **Date** | 2026-09-10 |
| **Requested by** | Kane, from the 2026-09-09 Carla/Jackie meeting |
| **Owner** | Kane |
| **Governing docs read** | `payment-dispatch.md` (§6.3 QC lockout, :444 PAB rule) · `bonus-catalog.md` · `employee-my-hours-calendar.md` · `time-adjustment-requests.md` · `employee-team-directory.md` · `manager-my-team.md` · `employee-dashboard-cache.md` · `employee-id-card.md` · `documents-tab.md` · `bank-preferred-routing.md` · `hubstaff-zero-hours-gap.md` · `notification-alerts.md` · `rbac-feature-permissions.md` · `identity-resolution.md` · `gift-tracker-shipping-export.md` · `pre-release-security-readiness.md` · `docs/reference/business-logic.md` · `docs/notes/problem.md` · `docs/notes/hubstaff-sunday-overlap.md` |
| **Memory read** | `qc-assignment-not-randomized` · `qc-compare-override-paste-format` · `time-adjustment-nudge-approved` · `employee-pab-calendar-exists-drill-in-missing` · `employee-leave-filing-stays-on` · `retro-pab-no-payment-path` · `team-directory-shows-legal-name` · `gift-tracker-no-receipt-state` · `jackie-kpi-ownership-and-va-split` · `pre-post-hearing-2500-vs-3500` · `employee-surface-is-the-remaining-15-percent` · `employee-id-card` · `employee-dashboard-reload-cache` · `dashboard-switch-performance` · `paystub-staged-snapshot-stale` (why there is no skip flag) · `pab-calendar-parity` · `pab-calendars-sun-sat-sweep` · `hubstaff-zero-hours-gap` · `onboarding-middle-name-and-order-check` · `notification-alerts-view-scoped` · `dialog-content-no-height-cap` · `blueprint-skill-plan-gate` · `hardening-skill-and-open-gaps` |

---

## 0. Scope

**In scope** — the meeting's outcomes that are executable today:

| § | Workstream | Kind | Deadline |
|---|---|---|---|
| 4 | QC corrections — ~~Callback out of scope~~ + ~~real randomization~~ **BUILT 2026-09-10**; Alivia's role = Kane's admin click | `hardening` | **Mon 2026-09-14** |
| 5 | ~~Rename the tab to "Time Adjustments" + the auto-playing per-day nudge~~ **BUILT 2026-09-10** | `hardening` | done — show Carla |
| 6 | ~~PAB explainer copy (4 sites) · Details → FAQs · the drill-in~~ **BUILT 2026-09-10** | `hardening` | done |
| 7 | Profile: Overview + ID + Compensation → one pane | `hardening` | — |
| 8 | Reports → "Badges and Certificates" (label only) | `hardening` | — |
| 9 | Team directory: peers stop seeing legal names | `hardening` | — |
| 13 | QC paste → Compare → Override + officer histogram | **`blueprint`** | after Wave 1 |
| 13 | Manager-generated certificates | **`blueprint`** | after §8 |

**Explicitly out of scope, and why** (detail in §10):

- **Pre/Post-Hearing ₱2,500 vs ₱3,500** — a business ruling, not a code task, and **blocking**. This
  plan does not touch `schema.ts:279` or its assertion. See Open item 19.
- **Retro-PAB payment path** — no mechanism exists and no ruling was given. Open item 25.
- **Gift receipt state** — needs a ledger decision (HRIS vs Ellie's sheet) before a migration. Open item 26.
- **Skill Sets caps** — the number Carla gave is incoherent against the current shape; the
  display-density half is scoped in §10.4 because it needs no decision.
- **Employee score / compliance dashboard** — an idea, not a scope. Open item 5 of the meeting record.
- **Leave server-side date floor** — the ruling was "filing stays on", and adding a floor would break
  Sick and Bereavement. §10.5.
- **The two blocking security items** (impersonation backdoor, 4 ungated routes) are Open items 1–2
  and gate the EOM release independently of this plan. Nothing here closes them, and nothing here
  should be read as release readiness.

---

## 1. Requirements restated as rules

Each rule is traceable to the record. Rules marked **⚑** contradict something the room believed.

| # | Rule | Source |
|---|---|---|
| R1 | QC officers are dealt their Lead Gen slice **randomly, and re-dealt every week**. No officer keeps the same members across weeks. | Carla's anti-buddy ruling; Jackie: *"Let's do that."* |
| R2 ⚑ | **Randomization is unbuilt.** The dealer is a deterministic alphabetical round-robin, so officer #1 holds the alphabetically-first slice indefinitely. | `qc-db.ts:304-306`, verified 2026-09-10 |
| R3 | **Only Lead Gen is QCed.** Callback leaves QC scope and stays Jackie's alone. | *"just Lead Gen needs to be QCed"* |
| R4 | Alivia holds no `qc` role. | *"we have to kick Olivia out of the QC thing"* |
| R5 ⚑ | **The hours filter is unbuilt** — QC eligibility is start-date only, with no Hubstaff join, so zero-hours Lead Gen people are dealt to officers today. Whether to exclude them is a **ruling**, not a cleanup. | `qc-db.ts:253-258`; Kane's *"people with hours will be checked"* |
| R6 | An employee who misses a PAB-disqualifying day is **prompted in place** to file a time adjustment — a comic-style bubble on the day itself, opening the existing form. | **The only approved build.** Carla: *"Just do it and then show me when it's done."* |
| R7 ⚑ | **Red is a narrower trigger than the meeting assumed.** Red is `<7h WITH data`; Carla's own failed click was a **zero-hours** day, which renders sky "Processing" or orange "Pending" — never red. R15 chooses red anyway, so the bubble will not fire on the day she clicked. Accepted trade; keep the qualifying set behind one constant so widening is one line. | `EmployeeMyHours.tsx:1770`/`:1773`/`:1780` |
| R8 | **DECIDED 2026-09-10 (Kane), superseding an earlier ruling the same day: the tab IS renamed "Time Adjustments", and the nudge is auto-playing.** The rename ships *with* the bubbles — the label names the tab's purpose, and the bubbles are what make it true. Carla's three-pane sub-nav is still dropped. | Kane, 2026-09-10: *"basically renaming the tab from My Hours to time adjustments + …"* |
| R9 ⚑ | An employee PAB calendar **already ships twice** (Overview + My Hours). Do not build a third. What is missing is the **drill-in** (the stat cell is an inert `<div>`) and a calendar **inside the mobile popup**. | `EmployeeDashboard.tsx:3385-3796` vs `:2870-2903` |
| R10 | The PAB explainer line is rewritten, **"Details" becomes "FAQs"**, and the explicit qualify / not-qualify statements stay. | Carla: *"redo just this line"*; Kane: *"I'll just change Details to FAQs"* |
| R11 | Overview, ID and Compensation become **one pane**. Payment is **not** folded in. | Carla's ask; `employee-dashboard-cache.md:121-126` |
| R12 | The employee "Reports" tab is renamed **Badges and Certificates**. | Carla |
| R13 | A **peer** sees the quoted go-by and the **work** email — never the full legal name, never a personal email. | Carla's safety ruling |
| R14 | Employee **leave filing stays enabled**. No new gate, no server date floor without a ruling. | Carla overruled Kane; he accepted |
| R15 | The bubble says **"Need a time adjustment?"**, appears on a **red** date, shows for **~5 seconds**, and with several red dates a new one appears every 5 seconds pointing at that date, in **random** order. | Kane, 2026-09-10, verbatim spec |

**Standing constraint (from `CLAUDE.md`):** no rule above may be satisfied by loosening a type,
guard, validation, limit or test. Two places in this plan are where that temptation lives — the
₱2,500 assertion (§10.1) and the `canRequestAdjust` predicate (§5). Both are handled by narrowing
or asking, never by widening.

---

## 2. What already exists (the precedents this copies)

Nothing here is greenfield. Every wave has a shipped thing to copy.

- **Single-source department scope.** `QC_DEPT_KEYS = ['lead_gen', 'callback']`
  (`src/lib/qc/constants.ts:10`) is the *only* declaration; `QCApp`'s `DEPT_ORDER`, its `DEPTS`
  list, the submissions fetch and `DeptBonusCalculator`'s department list all derive from it. Its own
  comment records the precedent: **Discovery was removed from QC scope the same way on 2026-06-26.**
  R3 is therefore a one-line change with a documented pattern.
- **Soft role revoke.** `app/api/employee-roles/route.ts` stamps `revoked_at` (`:94`) and un-revokes
  on re-grant (`:173`). R4 is reversible and audited.
- **The paste parser.** The payroll wizard's orphanage-hours step is the UX Kane pointed Jackie at,
  and the parser is the precedent the QC paste copies (§13).
- **The time-adjustment form and route already work.** `POST /api/time-adjustments` accepts any past
  date (`route.ts:94`); the per-day dialog exists. R6 is a **UI affordance only** — no server work.
- **Both PAB calendars.** Overview (`EmployeeDashboard.tsx:3385-3796`, HSL-aware, branches on `isHsl`
  at `:1595-1605`) and the month-navigable one in My Hours.
- **The correct date arithmetic already exists**, and the copy contradicts it:
  `calendar-column-dedupe.ts:175-192` takes the **first Monday on or after the 1st**, and
  `docs/reference/business-logic.md:76-79` already prints `Start = March 2`.
- **Per-caller API shaping.** `canViewTeamRankings()` (`rankings-viewers.ts:26`) gates *above* the
  elevated-role branch in `app/api/team-rankings/route.ts:54` — the precedent for shaping
  `/api/team-roster` per caller in §9 rather than redacting in the browser.
- **A shipped point system**, for whenever the employee score returns:
  `computeReadinessScore` (`src/lib/payroll/readiness-score.ts:107`), weighted with hard blockers
  pinning a dimension.

---

## 3. Sequencing, and why this order

Three forces set the order, in this priority:

1. **A hard external date.** Nine QC officers and Jackie test with real Lead Gen data on **Monday
   2026-09-14**. If Wave 1 has not landed, that test runs with Callback still in scope, Alivia still
   dealt a slice, and the same alphabetical attributions Carla ratified randomization to eliminate —
   and it produces real bonus numbers. Wave 1 is not "first because it is small"; it is first because
   the test is otherwise invalid.
2. **What Carla is waiting to see.** R6 is the meeting's only approved build and she asked to be
   shown it. It follows immediately.
3. **Decision debt.** Waves 6–9 descend by how much is already settled. §9 (privacy) is last of the
   `hardening` waves *not* because it matters least — it is a safety ruling — but because it needs
   the fallback-token decision (Q6) and collides with Jackie's June Full-Name requirement, so
   shipping it wrong is worse than shipping it later.

**Everything in Waves 1–9 is independent of the `blueprint`-gated work in §13.** Wave 1 is a
precondition for the QC Compare build, not a dependency in the other direction.

---

## 4. Wave 1 — QC corrections, before Monday 2026-09-14

> **4.1 and 4.3 BUILT 2026-09-10.** Callback left `QC_DEPT_KEYS` (one line, Discovery precedent,
> history retained-but-invisible). The deal is now seeded-random per `(period_start, department)`
> in a new pure `src/lib/qc/deal.ts` over a shared `src/lib/seeded-shuffle.ts` — 9 tests including
> the regression that the deal is NOT the alphabetical round-robin. Sticky snapshot, diff-only
> writes, even split and regen semantics all unchanged. The surface also got its FIRST feature doc
> (`qc-scoring.md`) + INDEX row + README row.
>
> **4.2 is Kane's admin click** — Admin → Roles & permissions → uncheck `qc` for Alivia. Do it
> BEFORE the first Monday read, so the officer-set change triggers the randomized re-deal.
>
> **BLOCKING RISK found while building:** `scripts/audit-pending-migrations.mts` did **not** probe
> the QC objects at all, so today's "26 APPLIED / 0 NOT APPLIED" said nothing about migrations
> #88/#89 — and without #89 the slot upsert THROWS and the dashboard 500s on first load. Probes for
> all four tables plus `roster_status` / `current_department` are added in the same commit.
> **Run the audit before Monday.**

Three commits. Together they make Monday's test measure what Carla thinks it measures.

### 4.1 Remove Callback from QC scope (R3)

**Change.** `src/lib/qc/constants.ts:10` → `export const QC_DEPT_KEYS = ['lead_gen'] as const;`
Extend the existing docblock the way the Discovery removal did, so the next reader knows Callback
left on 2026-09-09 by Carla's ruling and how to bring it back.

**Why this is the whole change.** Every consumer derives from that constant — `QC_DEPT_ORDER` and
`DEPTS` (`QCApp.tsx:108`, `:466`), the submissions fetch (`QCApp.tsx:251`), the calculator's list
(`DeptBonusCalculator.tsx:1327`), and the three `QC_DEPT_SET` copies (`constants.ts:13`,
`qc-db.ts:27`, `app/api/qc/lock/route.ts:23`) which all read it.

**Invariants.** Historical `qc_score_assignments` / `qc_kpi_submissions` rows for `callback` stay in
the database and become invisible — the deliberate Discovery pattern
(`app/api/qc/assignments/route.ts:52-56`). Do **not** delete them. Jackie keeps scoring Callback in
the Manager KPI Calculator, which is unaffected.

**Done when.** The QC dashboard shows Lead Gen only; a Callback member is no longer dealt to any
officer for a fresh week; Jackie's Callback card in the Manager calculator is unchanged.
**Confirm with Carla first** whether Accounting needs any read path to the retired department's past
QC history (Q1).

### 4.2 Revoke Alivia's `qc` role (R4)

**Change.** Admin → Roles & permissions → "Manager's assistant" group → toggle `qc` off for Alivia,
which issues `DELETE /api/employee-roles?email=…&role=qc` and stamps `revoked_at`. No code change.

**Invariants.** Soft revoke, so it is reversible and audited. Because officer identity comes from
`listActiveQcOfficers()` (`qc-db.ts:139-153`, `.is('revoked_at', null)`), her removal changes the
active officer set — which is exactly what flips `officerSetChanged` and triggers a re-deal
(`qc-db.ts:284`). **Do this before 4.3 lands** so the re-deal that follows is the randomized one,
not one more alphabetical pass.

**Done when.** She is absent from the officer list for the current period, and the remaining nine
officers' counts differ by at most one.

### 4.3 Real weekly randomization (R1, closing R2)

**Change.** In `assignQcSlots` (`src/lib/supabase/qc-db.ts`, the `regen` branch at `:304-306`),
replace the email-sorted `officers[i % officers.length]` deal with a **seeded shuffle**.

**Design — seeded, not `Math.random()`.** Seed on `(period_start, department)`. That buys three
properties the current code does not have and `Math.random()` would not either:

- **Deterministic within a week.** A re-run for the same week produces the same deal, so a re-deal
  triggered by an unrelated officer-set change does not reshuffle everyone.
- **Independent across weeks.** A new `period_start` is a genuinely different permutation, which is
  the actual requirement in R1 — the current code is weekly-*keyed* but not weekly-*re-dealt*.
- **Reproducible in a test.** A `Math.random()` shuffle cannot be pinned; a seeded one can.

Keep the even split exactly as it is — that half of the behaviour is correct and Carla relies on it
(counts differ by at most one; `computeDeptTotals` at `:398-406`).

**Invariants that must not move.**
- **STICKY SNAPSHOT** (`qc-db.ts:213-218`): once a slot row exists for a week it is **never
  deleted**. Randomize inside `regen`; leave the `else` balance-fill branch alone so slots appearing
  mid-week still attach to the least-loaded officer.
- The upsert key stays `(period_start, member_email, department)` (`:388`).
- Departed-but-existing slots keep being re-owned by an active officer so nothing is orphaned.
- **Do not touch eligibility here.** R5 is a separate ruling (Q2).

**Tests** (`node:test`, pure — extract the shuffle so it needs no Supabase):
1. Same `(period_start, dept, officers, slots)` → identical deal twice.
2. Two different `period_start` values over the same roster → the permutation differs (assert on a
   roster large enough that identity is not a plausible shuffle).
3. Counts differ by at most one, for officer counts that do and do not divide the roster evenly.
4. The alphabetical-adjacency property regresses: assert that the first officer's slice is **not**
   the alphabetically-first block. This is the test that would have caught R2.
5. Sticky: a second call with one extra slot re-attributes nothing that already existed.

**Done when.** All five pass, and two consecutive `period_start` values over the live Lead Gen roster
produce visibly different attributions with equal counts.

### 4.4 Wave 1 exit check, before Monday

- QC dashboard: Lead Gen only, nine officers, even counts, non-alphabetical slices.
- `scripts/audit-pending-migrations.mts` covers migrations #88/#89 — [[migration-pending-claims-are-folklore]]
  says run it rather than believing either claim. The 2026-09-10 run reported 26 applied / 0 not
  applied, but confirm those two objects specifically are among what it probes.
- Remember the dispatch interaction: the QC dashboard takes a **full client lockout** while payroll
  is dispatching, and `/api/qc/{submissions,lock,review}` return **423**
  (`payment-dispatch.md` §6.3). If Monday's test overlaps a dispatch, officers will be locked out —
  worth telling Jackie ahead of time rather than debugging it live.

---

## 5. Wave 2 — the per-day time-adjustment nudge (R6, R7)

**The approved shape.** On each day tile in My Hours that cost the employee a PAB day, a
comic-style callout: *"Missing hours? Request a time adjustment"*, opening the existing per-day
dialog for that date.

**This wave is two things: the tab is renamed, and the bubbles auto-play (R8, R15).** The rename
works *because* of the bubbles — on its own the label would stop describing the contents, but with an
auto-playing call to action on every red day the tab now names its **purpose**, and the hours
calendar becomes the instrument rather than the subject.

Carla's three-pane sub-nav stays dropped. Worth keeping in the file for whenever it returns: all
three panes already live in this one 2,361-line component (hours calendar, PAB grid,
`TimeAdjustmentDialog` at `:75`, `/api/time-adjustments` already fetched at `:896-905`, `limit=200`),
and those 200 rows are consumed **only** at `:1052-1054` as a date-keyed map annotating tiles —
**there is no list view.** A Time Adjustments pane would give that history its first list, which is
what Carla was reaching for with *"I wish the history would stay here."*

### 5.0 The rename — six sites, and keep the key

> **BUILT 2026-09-10.** Landed as **seven** sites, not six: the doc-check found that
> `EmployeeApp.tsx:111-112` derives BOTH the browser title and the Admin GML live-status readout
> from `humanizeTabId(activeTab)`, so `hours` still rendered "Hours" after the rename. Closed with
> a one-entry `TAB_LABEL_OVERRIDES` in `src/lib/presence/page-label.ts` — an exception table for
> ids whose display name has diverged from the id, which is narrower than the per-dashboard label
> map that function exists to avoid. The `hours` key/id did not move anywhere.
> `employee-my-hours-calendar.md` and INDEX row 51 were corrected in the same commit.
> `tsc` clean; 2,748/2,750 (the two known pre-existing failures). **The bubbles are still
> unbuilt** — §5.0b is the remaining half of this wave.

**Rename the LABEL, never the key.** `visibility.ts:148` is `{ key: 'hours', label: 'My Hours' }` and
`EmployeeSidebar.tsx:79` is `{ id: 'hours', … }`. The key/id feeds the Pages registry, feature
permissions and the shell's `mountedTabs`, so it stays `hours` — the same rule as a department
rename, which keeps its key and aliases the old name ([[edit-department-dialog]]).

| Site | What |
|---|---|
| `EmployeeSidebar.tsx:79` | `label: 'My Hours'` → `'Time Adjustments'` (keep `id: 'hours'`, keep the `Clock` icon or swap it) |
| `src/lib/pages/visibility.ts:148` | `label` only — **key stays `hours`** |
| `EmployeeMyHours.tsx:1471` | the `<h1>`, and the sub-line at `:1474` still describes merged Hubstaff — reword so the page opens by saying what it is *for* |
| `ManagerTimeAdjustments.tsx:542` | *"files one from their **My Hours** calendar"* — becomes wrong on rename day |
| `src/lib/anthropic/ceo-tools.ts:1188` | *"(My Hours, pay, leave/requests)"* — a Penny tool description; a stale surface name here makes Penny misdirect people |
| ~10 cross-surface comments | `orphanage-pab-coverage.ts:27`, `member-monthly-pay.ts:241`, `pab-period-settings.ts:121`, `calendar-column-dedupe.ts:587`, `api-client.ts:270`, `system-bonus.ts:27`, `PayrollWizard.tsx:10673`, `EmployeeDashboard.tsx:908` — these name the surface to explain a cross-surface invariant, so leaving them stale costs the next reader real time |

No test pins the `'My Hours'` string (unlike `'Pay Stubs'` in Profile), so the rename cannot break the
build — the risk is entirely stale copy, and the table above is the whole of it.

### 5.0b Bubble choreography (R15)

> **BUILT 2026-09-10.** Landed as **three layers**, not one — Kane: *"the point is that if people
> cant see it properly then they wont know where the time adjustment"*. A five-second bubble points
> at one day at a time and is missed by anyone who looks up late, so it ships alongside a persistent
> `!` on every nudgeable day and a permanent count above the grid. Trigger is the pure
> `isNudgeableMissedDay` (10 tests). **No portal needed** — the existing hover card's row-aware flip
> already dodges the card's `overflow-hidden`, and reusing it beat introducing portal machinery.

Exactly as specified: **"Need a time adjustment?"**, on a red date, ~**5s** each, one at a time,
advancing every 5s through the red dates in **random** order, each pointing at its own date.

| Concern | Decision |
|---|---|
| **Which dates** | Red days in the **visible month** — red is the `else` branch at `EmployeeMyHours.tsx:1780` (has data, under 7h). Put the qualifying set behind **one named constant** so widening it later is a one-line change, not a hunt. |
| **Exclusions** | Days that already have a time-adjustment row (pending *or* decided) — a bubble on a day the employee already filed is noise. Also non-HSL weekend tiles: non-scoring, so they cannot cost PAB. |
| **Random, but stable** | Shuffle **once per (visible month, red-day set)** in a `useMemo` — not per render. A bare `Math.random()` in render reshuffles mid-cycle and the sequence jumps. |
| **Loop, don't play once** | With 8 red days, playing once means the last bubble fires 40s in, long after most people have looked away. Cycle continuously so a late glance still catches one. |
| **Pause + dismiss** | Pause while the bubble is hovered or focused, so it can actually be clicked. An × dismisses for the session — store that in **`sessionStorage`, never `localStorage`** (the employee-cache rule: `localStorage` outlives the browser and strands one person's state on a shared machine), and identity-stamp it so an elevated `?email=` preview cannot inherit or leak it. |
| **Reduced motion** | `prefers-reduced-motion` → **no cycling.** Render one static marker on every qualifying day instead. Auto-updating content on a timer is a WCAG 2.2.2 concern, and this file already uses `motion-safe:` / `motion-reduce:` pairs, so this matches house style rather than inventing a rule. |
| **Click** | Opens `TimeAdjustmentDialog` for that date — the same path the tile click uses today. No server change. |
| **Empty state** | Every red day already filed → no bubbles at all. |

**The one real implementation risk: the bubble will be clipped.** The calendar card (`:1489`) and its
`CardContent` (`:1592`) are both `overflow-hidden`, and the card additionally carries
`[@media(max-height:850px)]:max-h-[calc(100dvh-9rem)]`. A tile is ~40–60px, so a bubble anchored over
one — especially in the top row or the right column — gets cut off. **Render it in a portal anchored
to the tile's measured rect** (the repo's popover/tooltip primitives already portal), rather than
absolutely positioning inside the grid or removing `overflow-hidden`, which is load-bearing for the
card's rounded corners and its scroll behaviour.

**One consequence to keep visible:** red is `<7h WITH data`, so a red-only trigger **will not fire on
the zero-hours day Carla actually clicked** — that renders sky "Processing" (`:1770`) or orange
"Pending" (`:1773`). That is the accepted trade for not nudging days whose hours simply have not been
ingested yet (`docs/notes/hubstaff-sunday-overlap.md`). The named constant above is what makes
widening it cheap if she asks.

### 5.1 The trigger — red AND filable

R15 sets the trigger to **red**. Keep one more condition on top of it, because colour and filability
are independent axes in this code:

> **red ∧ `canRequestAdjust(day)` ∧ no existing request ∧ scoring day**

- **Red** — the `else` branch at `EmployeeMyHours.tsx:1780` (has data, under 7h). Kane's choice.
- **`canRequestAdjust(day)`** — the existing predicate, unchanged. This is the load-bearing one:
  **the bubble can never appear where filing is impossible**, because it rides the same predicate
  that enables the click. Note it requires `inMonth` (`:1704`) while the server has no month bound —
  do not relax that to make a bubble reachable; widening a guard for a nudge is exactly what the
  standing constraint forbids.
- **No existing request** for that `(email, date)`, pending *or* decided — a bubble on a day already
  filed is noise, and on an approved day it is wrong.
- **Scoring day** — exclude non-HSL weekend tiles. They are non-scoring / display-only
  (`calendar-column-dedupe.ts:656`) yet fully clickable today, so a bubble there would invite an
  adjustment for a day that cannot cost PAB. This *narrows* the set; it does not touch
  `canRequestAdjust`.

Put that intersection behind **one named constant** (R7): red-only will not fire on the zero-hours
day Carla clicked, and if she asks for it, widening should be a one-line change in one place.

### 5.2 The honest caveat — a blank day is not proof of an absence

`docs/notes/hubstaff-sunday-overlap.md` is **still open at root cause**: a leading Sunday can be
dropped from an 8-day Sun→Sun export and then reads as zero everywhere — calendar, PAB eligibility
and pay. 98 people worked Sunday May 10 and every surface showed nothing.

Two consequences for the copy and the trigger:

- **Word the nudge as a question, never as an assertion.** *"Missing hours?"* survives a
  false positive; *"You missed this day"* does not.
- **Sky "Processing" days are the risky class** — hours may simply not be ingested yet, which is
  precisely why R15's red-only trigger excludes them (Q3, closed 2026-09-10). If the trigger is ever
  widened past red, this is the case that needs a processing-window check first.

### 5.3 Placement

A tile is 52/60px and the card is short-viewport-capped, so a persistent bubble inside the cell will
not fit at every breakpoint. Recommend: the bubble on hover/focus/tap **plus** one summary callout
above the grid when the visible month has any nudgeable day — that is the "big giant button" Carla
said she would accept, and it needs no new date picker because it can scroll to and open the first
nudgeable day.

A date-less standalone button is **deferred**: the dialog is strictly per-day (`adjustDate`, one row
per `(email, day)`), so it would need a new picker for no gain over the callout.

### 5.4 Invariants and boundaries

- **No server change.** `POST /api/time-adjustments` already accepts any past date (`route.ts:94`).
- **Do not "fix" the `inMonth` asymmetry here.** `canRequestAdjust` requires `inMonth` (`:1704`)
  while the server has no month restriction, so filing for the tail of the previous month means
  paging back first. Relaxing `inMonth` is a separate, deliberate decision — and relaxing a guard to
  make a nudge more convenient is precisely what the standing constraint forbids.
- **Do not add an approved-adjustment overlay to `mergedHoursByDateKey` / `isForgiven`** in this
  wave. That changes what My Hours tells people about their PAB eligibility, which is money-adjacent
  and belongs in its own change.
- If the nudge ever chimes or toasts, **every chime mount passes a view** —
  [[notification-alerts-view-scoped]]. A new employee notification type would mean restating a closed
  CHECK with 43 live types, and there is no working scheduler to fire a reminder from
  ([[scheduled-deletion-cron-never-ran]]). Recommend: **in-page only**, no notification.

**Done when.** On a zero-hours weekday inside the current month with no existing request, the bubble
appears and opens the dialog pre-filled with that date; it disappears after filing; it never appears
on a ≥7h day, on a non-HSL weekend tile, or on a day outside the visible month. Then show Carla.

---

## 6. Wave 3 — PAB copy, the FAQs rename, and the drill-in (R9, R10)

> **BUILT 2026-09-10.** Copy branched on `isHsl` at all four sites, `Details` → `FAQs` at four label
> sites, and the PAB stat cell is now a `<button>` that reveals the on-page calendar (`PabStatCell`).
> The surface also got its first `docs/features/INDEX.md` row. **"A calendar in the mobile popup" was
> dropped**: the calendar renders at every breakpoint and the popup is deliberately rules-and-status,
> as its own `DialogDescription` says. `tsc` clean; 2,748/2,750 tests pass (the two known
> pre-existing failures, neither in this file).

### 6.1 Rewrite the explainer (three sites, not one)

The line at `EmployeeDashboard.tsx:3859-3864` is the only occurrence in the repo and is wrong three
ways:

| Defect | Truth |
|---|---|
| *"counting starts on the second Monday"* | The **first Monday on or after the 1st** — `calendar-column-dedupe.ts:175-192` and its docstring |
| *"e.g. March 2026: Mar 9–Apr 3"* | **Mar 2 – Apr 3**. `business-logic.md:76-79` already prints `Start = March 2` |
| Asserts Mon–Fri for everyone | **False for HSL** (≥5-of-7 over whole Sun–Sat weeks). `isHsl` is in scope on the same screen; only the copy ignores it |

**Fix all FOUR sites** (verified 2026-09-10 — the meeting flagged one, and the earlier count of
three was also short):

| Site | Copy | Why it is wrong |
|---|---|---|
| `:3860-3863` | the FAQ line | all three defects above |
| `:2291` | "N **Mon–Fri days** in this PAB month" | reads `pabWeekdayHours` = `pabDailyHours.filter(d => d.weekday)` (`:1739`) — **not model-aware** |
| `:2297` | "Eligible: each **Mon–Fri** in the PAB date range above is logged at 7 hours or more." | Mon–Fri asserted for everyone |
| `:2318` | "…finalized once all **Mon–Fri days** have elapsed." | same |

**The important distinction: the logic is already right — only the description is wrong.**
`isPAEligible` uses `allPabDays` and `pabViolations` filters on `d.scoring` (`:1852-1861`), both of
which are model-aware; the grid has been Sun–Sat since 2026-08-27 and its docstring says non-HSL
weekend cells are chrome. So the screen **computes** the correct verdict for an HSL employee and then
**explains it with the wrong rule** — which is the worst version of this bug, because the number
looks defensible and the sentence beside it does not match it.

For `:2291` the correct source already exists two lines away: **`allPabDays.length`** (the `.scoring`
set) with a label that branches on `isHsl`. Do not "fix" it by re-deriving a second day set.

Carla's `not_eligible` statement (`:2301-2313`, *"No longer Eligible for PAB, Try again next month —
violated on …"*) is the one she praised and it is **factually correct** — `pabViolations` is
model-aware. Keep it; while in there, its prose is worth a light polish (comma splice, inconsistent
capitalisation), which is a copy change and nothing else.

**Recommendation on what it should say:** stop explaining the derivation and print Accounting's saved
window, because Accounting **hand-sets `pab_period_overrides`** (`EmployeeDashboard.tsx:1429-1431`) —
so the derivation is misleading most months even when stated correctly, and the card already shows
the real window (`:2280-2293`). Branch the rule sentence on `isHsl`. Q4 confirms this with Carla,
since she asked to "redo the line", not to remove it.

### 6.2 Details → FAQs

`EmployeeDashboard.tsx:2706` is the only visible label. Also rename, for consistency, the dialog
title *"PAB & bonuses"* (`:3850`) and the two title/aria-label pairs (`:2647`/`:2648`,
`:2701`/`:2702`). The `mobileHelpOpen` state name is internal — rename or leave, no user impact.

### 6.3 The drill-in

Make the PAB stat cell (`:2870-2903`) a real control — `<button>`, or a `<div>` with `role`,
`tabIndex` and a key handler. Desktop: scroll to and focus the inline calendar at `:3385`. Mobile:
the popup **is** the PAB surface, so put a calendar in it or deep-link to the My Hours calendar.

**Invariants.** The Details popup is exactly the `p-0` dialog class
[[dialog-content-no-height-cap]] was written for — it needs `gap-0` plus a dvh cap, and that rule was
discovered when ~895px of content met an ~830px window on this very dashboard. **Do not build a
third calendar** (R9).

**Also note for the copy:** "eligible this day, this day" implies a per-day entitlement PAB does not
have — it is all-or-nothing per month (`business-logic.md:64`). Render per-day *"this day counts /
this day broke it"*, never a per-day award.

---

## 7. Wave 4 — Profile: three chips into one pane (R11)

**Current state.** Overview, ID and Compensation are **already inside the single Profile page** —
three of nine in-page chips (`EmployeeProfile.tsx:151` union, strip at `:507-517`), not tabs and not
routes. The sidebar has one Profile item (`EmployeeSidebar.tsx:78`); the Pages registry one `profile`
key (`visibility.ts:147`). They read as tabs because the strip is a real ARIA tablist with an
animated underline — which is why Carla described them that way.

**Change.** Drop `'id'` and `'compensation'` from the union and from the `tabs` array (`:509-510`);
9 chips → 7. Collapse the three render branches (`:1581`, `:1637`, `:1661`) into one six-section
stack: Personal → Employment → Address (still `hasAnyAddress`-gated) → ID card → Hourly Rates →
Currency. `idCard` (`:1315`) and `handleDownloadId` (`:1339`) are already computed at component
scope and move as-is. Re-word the surviving chip's `label`/`sub` — "Identity, employment, address" no
longer describes a pane carrying a badge and two pay rates.

### 7.1 Caching — the merge must not undo the 2026-09-03 work

**Profile is already cached.** Four datasets since 2026-09-03 — `profileMaster`, `profileRate`,
`profileSkillSet`, `paystubSummary` (`src/lib/employee/tab-cache.ts:338-346`) — and the six identity
calls already run in **one** `Promise.all` wave (`:993-1001`), where they used to be three serial
hops behind one skeleton. So this wave adds no fetches and needs no new cache key.

**All three merging panes already read cached state**, which makes the merge a paint *win*:

| Pane | Backing state | Cached? |
|---|---|---|
| Overview | `master` | **yes** — `profileMaster` (`:654`) |
| ID | `idCard`, a `useMemo` **over `master`** (`:1315`) | **yes, transitively** — it reads the roster row, and its own comment says it deliberately never reads `employee_ids` |
| Compensation | `rate` | **yes** — `profileRate` (`:658`) |

On reload the merged pane therefore paints from `sessionStorage` at once and refreshes in place.

**Five things not to do — in order of how easy they are to do by accident:**

1. **Do not gate the merged pane on `bankInfoLoaded`.** This is the real regression risk. That flag
   today scopes the Payment skeleton to `activeTab === 'payment'` (`:1897`, `:1909`), and
   `/api/employee-ids` is **deliberately never cached** because it carries account numbers. When you
   consolidate three render branches into one it is natural to hoist the readiness flags with them —
   and hoisting that one makes an instantly-cached pane wait on the single uncacheable call in the
   wave. **Payment keeps its own skeleton; the merged pane must never await it.**
2. **Do not widen `loading`.** The whole-page `ProfileSkeleton` seeds from `master === null`, which
   is exactly why a cached identity paints immediately. Extending it to "rate and idCard are ready
   too" reinstates the skeleton the 09-03 work removed.
3. **Do not add a cache key for `idCard`.** It is a derived view model, and the rule is *cache the
   RAW payload and derive with `useMemo`* — a `Set` in a cached shape serialises to `{}` and silently
   disabled the Paystubs button once already. It is also unwired-key territory: every key in
   `EMPLOYEE_CACHE_KEYS` must be wired to a live call site.
4. **Do not add a skip flag.** The merged pane keeps running its fetches unconditionally — **a cached
   value paints, it never decides.** This is enforced, not stylistic: `no-skip-flag`
   (`src/lib/employee/tab-cache.test.ts:323`) greps the module's exports for
   `/fetched|revalidat|skip|ttlHit/i` and **fails the build** if any appear. The reason is money —
   `upsertPaystubDispatchQueue` re-stages onto an already-PAID row with no post-pay detector, so a
   skipped refetch could freeze a superseded pay figure on screen.
5. **Do not lift a cached read above the hydration gate.** Seeding is hydration-safe *only* because
   `renderContent` returns `null` until `employeeEmail` resolves.

Identity stamping is unchanged and still load-bearing: entries are inert until
`bindEmployeeCacheIdentity` runs and binding a different viewer **purges first** — which is what stops
an elevated `?email=` preview of someone else's portal repainting into the viewer's own tab.

**One optional addition.** `usd_to_php_rate` (`GET /api/app-settings`) feeds the Currency section and
is the only uncached input to the merged pane that *could* be cached — a global reference value, no
PII. Honest expectation: **it will not move the needle**, because the wave is parallel and this is
its cheapest call. Wire it with the doc's four-step recipe or skip it deliberately.

### 7.2 If Profile is the slowest surface, the cache is not the lever

Two measured facts say the remaining cost is render weight, not fetch waiting:

- **`EmployeeProfile.tsx` is 2,552 lines**, and the employee shell renders `Array.from(mountedTabs)`
  and merely **hides** inactive tabs — so Profile's whole tree stays mounted beside
  `EmployeeDashboard.tsx`'s 4,157 lines for the rest of the session.
- **The repo contains exactly one `next/dynamic` call.** Tier 1 code-splitting is still open
  ([[dashboard-switch-performance]]), and that memory also records that the perf work was verified by
  `tsc` + tests only — the live feel was never clicked through.

For reference, the reload cost the cache was built for is the **Overview's** ~22 `no-store` fetches;
Profile's is six, in parallel. So the merge helps by deleting two cross-fades and two chips, but
**the real win for this surface is code-splitting the panes** — its own change, and worth measuring
before assuming the merge fixed it.

**One cost the merge does add, stated plainly:** the ID badge currently mounts only when the ID chip
is active; afterwards it is part of the default Profile paint. It is CSS, not canvas (the canvas path
runs only on download), so it should be cheap — but if it is not, the fix is to lazy-render it inside
the merged pane on scroll, **not** to un-merge.

### 7.3 The one real decision this forces

Start Date will appear **twice**, from two different parsers:
`formatStartDate` (`:133-141`, `new Date(s)`) and the card's `formatIdCardDate`
(`src/lib/employee/id-card.ts:89-95`, `parseDateOnlyLocal`). For any viewer west of UTC they differ
by a day, so the merged pane will visibly contradict itself. Q5 decides whether the off-by-one fix is
in scope — it is still open, flagged 2026-09-04 rather than fixed, and correcting it also shifts two
Pay Stubs pay dates and three resignation effective dates by a day for those viewers.

### 7.4 Invariants

- **Payment stays its own chip.** It is the editable payout form, deliberately uncached because it
  carries account numbers (`employee-dashboard-cache.md:121-126`), and it is the bank-preferred
  dropdown's documented home (`bank-preferred-routing.md` §1).
- **Do not move the strings `label: 'Pay Stubs'` or `label: 'Request Documents'`** — a Penny guides
  test source-scans this file for both (`src/lib/penny/employee-guides.test.ts:166-169`) and **fails
  the build** if either moves.
- Keep the ID card in a block that can still reach 372px. Every dimension inside
  `EmployeeIdCard.tsx` is `cqw`, so the frame decides the badge's legible size.
- Feature permissions gate at **tab** granularity (`rbac-feature-permissions.md`), so collapsing
  panes changes what an admin can hide. Confirm nobody gates ID or Compensation today.
- Pay Stubs stays lazy (`:827-828`); the other panes already load in one mount wave, so the merge
  adds no fetches.

---

## 8. Wave 5 — Reports → "Badges and Certificates" (R12)

**Change.** `EmployeeProfile.tsx:514` — `{ id: 'reports', label: 'Reports', sub: 'Commendations' }`
becomes the new label. Keep the internal `id: 'reports'` unless something else demands otherwise;
renaming the id is churn with no user benefit.

The rename removes a real collision: "Reports" already names the retired Pay Cycle Reports
(`documents-tab.md:304`), the wizard's step-9 Reports table, and CEO → Financial Reports.

**Invariants.** The stored `award` document type and its DB CHECK
(`references/sql/migrate/2026-07-18_documents_tab.sql:34`) **survive either way** — existing rows
depend on it, whatever happens to the employee-side picker.

**Q7:** does "Award / Certificate" come off the employee request picker entirely, or stay for a
certificate the worker already holds and wants signed? Carla only said it *"should be put in under
manager"*. The label rename ships regardless; the picker change waits on the answer.

The manager-side generator is a **new build** — §13.

---

## 9. Wave 6 — the team directory stops showing legal names (R13)

**Current state.** The directory's only identity string is the master-list `Name` column passed
through untouched — there is **no nickname extraction in the component at all**. A peer sees the full
surname-first legal name in five places: card headline (`EmployeeTeam.tsx:935`), modal title
(`:1101`), screen-reader description (`:1148`), avatar initials (`:916`, `:1090` — which take the
**surname** initial first), and Rankings rows (`:336`, `:341`, today behind a one-reader allow-list).

Two exposures beyond the rendered name:
- **Personal email by fallback** — card and modal both do `t.workEmail ?? t.personalEmail`
  (`:892`, `:1082`), so a teammate with no work email has their personal address shown to the team.
- **Search matches the hidden fields** (`:680-682`), personal email included — a peer can confirm a
  guessed name or address by typing it. Redaction that leaves search alone is cosmetic.

**Change — server-side, shaped per caller.** Carla's framing is safety, so the legal name should not
reach the peer's browser. Shape the response in `app/api/team-roster/route.ts` using the
`canViewTeamRankings` pattern (gate above the elevated-role branch, `team-rankings/route.ts:54`):
the employee peer view receives `displayName` + `workEmail` only; manager/elevated callers keep the
full row, because **Jackie explicitly asked for Full Name + Work Email** on the manager roster
(2026-06-09) and that route serves both.

Then: fix the `??` personal-email fallback (show "No work email on file" rather than a personal
address), scope search to what is displayed, and re-sort by the displayed short name once the surname
is invisible (`:693`).

**The blocking decision — Q6, the fallback token.** The go-by is *derived* as "the last given token
that is not a bare initial" (`src/lib/name/display-name.ts:36`), so rendering the quoted token alone
would introduce *Jane Marie Santos* to her whole team as **"Marie"** — the exact failure
[[onboarding-middle-name-and-order-check]] records. `fallbackDialerIdentity` falls back to the
**first** name; `parseNameParts` falls back to the implied go-by. Pick one, pin it with a test over
the known-awkward name shapes, and remember `team-roster.ts:120` falls back
`name || workEmail || personalEmail || '(unknown)'` for blank rows.

**Enforcement limit, stated plainly.** Route-access gates **pages, not APIs**
([[pre-release-security-blockers]]), so until Open item 2 closes, a signed-in caller can still hit
`/api/team-roster` directly. Server-side shaping is strictly better than client-side redaction, but
it is not a security boundary while that item is open — and this wave should not be described to
Carla as one.

---

## 10. Blocked or deliberately unscoped — and what unblocks each

### 10.1 Pre/Post-Hearing ₱2,500 vs ₱3,500 — **BLOCKING, no code**

₱2,500 is pinned in `schema.ts:279`, its assertion (`schema.test.ts:307-315`), two docs,
`INDEX.md:23`, the audit log and memory — **all sourced to Carla on 2026-09-08**, one day before she
said *"it was supposed to be 3500"*.

**This plan changes nothing here.** Satisfying the quote means overwriting a pinned pay value **and**
rewriting its assertion, which is the exact move `CLAUDE.md` forbids. It is also genuinely ambiguous:
₱3,500 is the weekly KPI cap (`schema.ts:271`), and the flat is cap-exempt *because* a fixed ₱2,500
under a ₱3,500 cap would eat the rest of the KPI — so a ₱3,500 flat would exactly equal the cap.

**Unblocked by:** one worked example for one named person for the 2026-08-30 final week — what
should their Monthly Bonus line read? Also needed: whose sheet had ₱2,500, and whether the
already-dispatched 08-30 week is reopened, back-paid or left alone. Open item 19.

### 10.2 Retro-PAB payment path

Nothing pays a late-granted PAB. Dispatch gates PAB on `weekEnd >= pabPeriodEnd`
(`payment-dispatch.md:444`); the only ungated route is the Accounting Adjustment column
(`PayrollWizard.tsx:9385`), which prints as an unlabelled *"Adjustment (PHP)"* with no link to the
dispute — while the approval notification already promises *"This day now counts toward your PAB
eligibility"* (`pab-disputes/[id]/route.ts:204`) **unconditionally**.

**Do not invent a path.** Unblocked by Carla answering: which week does it attach to, is it a PAB
line or an Adjustment, and is there a cutoff after which Accounting declines? A grant against a
closed cycle is a write against a closed cycle — [[cycle-reopen-archive-and-suppression]].
Sizing the existing exposure needs a **read-only** probe of `pab_day_disputes`, and `.env.local` is
production ([[subagents-write-to-live-db]]) — Kane's approval first. Open item 25.

**One cheap, safe subset** if Kane wants movement now: condition the notification copy on whether the
payout week has passed. That removes a false promise without inventing a payment path.

### 10.3 Gift tracker receipt state

`employee_gift_shipping_details` has no `shipped_at` / `received_at` / courier column; `status` is
address review only (`employee-gift-shipping.ts:4`, DDL `:26-27`), and "approve" is documented as
*"lock the submitted details… no price, no gift assignment"*. So "who has and hasn't received a gift"
is unanswerable from HRIS and Ellie's catch-up has nowhere to land — **chasing Ellie cannot fix it.**

**Unblocked by a ledger decision:** does HRIS become authoritative for "gifted", or does Ellie's
sheet stay the ledger with HRIS reconciling? `gift-tracker-shipping-export.md:3-6` currently says the
sheet is authoritative, so this rewrites that doc's premise. Then it is a migration + route +
control, and it must stay on the info-only side of the 2026-07-14 line
([[gift-feature-info-only]]). Open item 26.

### 10.4 Skill Sets — the display half ships, the cap does not

Carla's "caps, like 10 on each of these" is incoherent against the current shape: Role/Title is a
single value, **Current projects is already capped at 2** (so 10 would be a *loosening* — forbidden),
and Skills and Strengths are single free-text blobs with no item concept at all. Today the only limit
is 4000 characters per whole field (`app/api/employee-skill-sets/route.ts:13`) with no client cap.

**Shippable now, needs no decision:** her stated complaint was *"less busy"*, which describes the
display. The two modal call sites deliberately widen the chip page from 12 to 60
(`team-ui.tsx:111` vs `EmployeeTeam.tsx:1158`, `ManagerMemberDialog.tsx:298`). Lowering those, with
a "show all" affordance, quietens the surface immediately — and a cap would not, because it cannot
reach the 40-chip rows that already exist.

**Still blocked:** the cap itself needs Q8 (which categories, what is one entry, what character
limit, and what happens to rows already over it). A count over a delimiter-split blob is a data-model
change, not a validation tweak.

### 10.5 Leave — the ruling stands, the gap is documented, no code

Filing **stays enabled** (R14). The forward-dated guarantee Carla's argument rests on exists only in
the browser picker (`EmployeeLeaves.tsx:360`/`:371`); the API POST has no lower bound
(`route.ts:118-131`), the DDL has no CHECK (`leave_requests.sql:8-9`), and `today` is UTC not Manila
so the picker's own minimum is yesterday for eight hours a day.

**Deliberately not fixed here.** Adding a server floor would break **Sick** and **Bereavement**, two
of the five offered types (`EmployeeLeaves.tsx:53-70`), both inherently filed after the fact.
Unblocked by a ruling on which types may be backdated. Separately unruled and likely to generate a
ticket now that filing is blessed: whether an approved leave forgives a PAB day — today it never
does ([[pab-calendar-parity]]), and `employee-guides.ts:126` tells employees so.

### 10.6 Employee score / compliance dashboard

No compliance dashboard exists — not built, not planned in-repo; the only prior version is the
never-built "Manager Scoreboard" from 2026-06-16. Camera violations are not stored at all. Kane's
Penny narrative is not yet achievable: `leave_requests` has no `decided_at` / `decided_by`, and
*"received by Carla at this time"* corresponds to no event in any form. **"SP" is already taken and
already paid** (`bonus_catalog_applied.vars.SP`), so a second point system needs a different name.

**Settled and worth honouring:** both Kane and Carla agreed this is **not a payroll gate**. Nothing
from it may reach `payroll-readiness.md`'s blocker set or the wizard's Setup checklist.

### 10.7 Documentation debt this plan creates work for

**Eight of the surfaces above have no `docs/features/INDEX.md` row** — Profile, Skill Sets,
Badges/Certificates, the employee PAB card, leave filing, the whole QC surface, gift receipt, any
compliance dashboard (Open item 28). Any edit there starts with `READ none`.

The QC surface is the worst case: a 623-line data layer, four API routes, a 1033-line dashboard and a
shared 5360-line calculator, whose entire written record is two clauses in `INDEX.md:24` plus three
sentences in `hsl-kpi-calculator-2026-07.md:573-575` — and the doc that INDEX row names
(`bonus-calculator.md`) is an April PAB/Tech reference with **zero** QC mentions.
**Wave 1 owes the QC surface its first feature doc and INDEX row, in the same commit as 4.3.**

---

## 11. Build order

Each row is one reviewable commit. "Gate" is what must be true before starting.

| # | Commit | § | Gate | Size |
|---|---|---|---|---|
| 1 | `harden(qc): Lead Gen is the only QCed department` | 4.1 | Q1 (retired-history read path) | trivial |
| 2 | *(no commit)* revoke Alivia's `qc` role in Admin | 4.2 | — | click |
| 3 | `harden(qc): deal officer slices by a seeded weekly shuffle` **+ the QC feature doc + INDEX row** | 4.3, 10.7 | commits 1–2 | medium |
| 4 | `feat(employee): the My Hours tab becomes Time Adjustments, and red days ask for one` | 5 | — (Q3 closed: red only) | medium |
| 5 | `fix(employee): the PAB explainer was wrong in three places` | 6.1 | Q4 (copy) | small |
| 6 | `feat(employee): PAB card drills into the calendar; Details becomes FAQs` | 6.2, 6.3 | commit 5 | small |
| 7 | `feat(employee): one Profile pane for identity, ID and compensation` | 7 | Q5 (Start Date) | medium |
| 8 | `feat(employee): Reports becomes Badges and Certificates` | 8 | Q7 for the picker half | trivial |
| 9 | `harden(team): peers see the go-by and the work email, never the legal name` | 9 | Q6 (fallback token) | medium |
| 10 | `feat(employee): quieter Skill Sets` (display density only) | 10.4 | — | small |
| — | **`BLUEPRINT` hard stop** → QC Compare/Override; manager certificates | 13 | Kane approves §13 | large |

Commits 1–3 are the Monday-2026-09-14 set. 4 is next because Carla is waiting on it.
**Never `git add -A`** — stage by explicit path; this checkout is shared
([[multi-session-shared-checkout]]).

---

## 12. Open questions — each says what changes with the answer

| Q | Question | Owner | What changes |
|---|---|---|---|
| Q1 | Does Accounting need a read path to Callback's retired QC history? | Carla | Yes → 4.1 grows a history view. No → one-line change, rows go invisible (the Discovery pattern). |
| Q2 | Should zero-hours Lead Gen people be excluded from QC dealing? | Carla | Exclude → a Hubstaff join in eligibility, against a codebase where **every** comparable predicate fails toward *keeping* the person. Keep → officers keep being dealt ~193/week listed-never-scored people. **Not a cleanup either way.** |
| ~~Q3~~ | ~~Does the nudge appear on sky "Processing" days?~~ | — | **CLOSED 2026-09-10 (Kane): red only.** Avoids nudging a day whose hours are merely not ingested yet (`hubstaff-sunday-overlap`), at the cost of not firing on Carla's zero-hours click (R7). |
| Q4 | Should the PAB FAQ explain the derivation at all, or just print Accounting's saved window? | Carla | Print the window → shorter, always right, and matches the card. Explain → must branch on `isHsl` and stays misleading whenever `pab_period_overrides` is hand-set. |
| Q5 | Is the `formatStartDate` off-by-one fix in scope for the Profile merge? | Kane | In → the merged pane stops contradicting itself, and two Pay Stubs dates + three resignation dates shift a day for west-of-UTC viewers. Out → ship the merge showing two different Start Dates. |
| Q6 | Which token does the directory show when there is no chosen nickname? | Kane | Derived go-by → *Jane Marie Santos* becomes "Marie". First name → safe but not the quoted token Carla asked for. **Blocks Wave 6.** |
| Q7 | Does "Award / Certificate" leave the employee request picker? | Carla | Off → managers are the only source. Stays → an employee can still ask for one they already hold to be signed. The label rename ships either way. |
| Q8 | Skill Sets: which categories, what is one entry, what character limit, and what about rows already over it? | Carla | A count over delimiter-split blobs is a data-model change; a character limit is validation. **A cap of 10 on Current projects would loosen an existing cap of 2 — that one cannot ship.** |
| Q9 | Monday 2026-09-14 vs Jackie's Monday training — is the QC test still Monday? | Jackie | The transcript **cuts off mid-answer** here; she suggested Friday. Wave 1's deadline moves with it. |

---

## 13. The `BLUEPRINT` brief — Phase 2, waits for Kane

Per `.claude/skills/blueprint/SKILL.md` and [[blueprint-skill-plan-gate]], **nothing below is
written until Kane approves this block.** Both items are new surfaces, not edits to shipped ones.

### 13.1 QC paste → Compare → Override + officer histogram

> **BUILT 2026-09-10** (Compare/Override/Undo; the histogram is NOT built — separate brief). Q1 was
> settled by a read-only production probe: the variable is `Appts_Set` on the dept bonus and `Appts`
> on reinelr@'s individual bonus, so it is resolved PER MEMBER. See `qc-scoring.md` §Compare.

**Surface.** Manager → KPI Calculator → Lead Gen. Jackie pastes her weekly sheet, presses
**Compare** to see what disagrees with the officers' entries, then **Override** to replace them; plus
a histogram of which officer is least accurate.

**Contract.** Three columns — **work email, full name, total appointments** — copied from Jackie's
existing weekly payroll email. **Work email is the join key.** Precedent for the paste UX and parser:
the payroll wizard's orphanage-hours step.

**What the brief must settle before code:**

1. **Which formula variable holds the appointment count in `qc_kpi_submissions.vars`.** Nothing in
   the repo declares it — `DEPT_INPUT_CONFIG.lead_gen.employeeFields[0].key = 'leadGenAppts'`
   (`department-bonus.ts:197`) belongs to the **wizard's** modal, while the calculator writes whatever
   the Payment Catalog formula names. **Compare cannot be built until this is pinned by a test.**
2. **What "inaccurate" means.** Any delta, or one that crosses the ₱250/₱500 tier
   (`calcLeadGenBonus`, `department-bonus.ts:71-74`)? A one-appointment miss at the 9/10 boundary is
   worth ₱2,500; the same miss at 3 is worth ₱250. The histogram counts whichever this answers.
3. **Absence is not zero — the single biggest risk.** `saveDeptPeriodApplied` is a **replace-set**
   and the panel paginates at 8 while Jackie's sheet is 280+ rows. An Override built from a partial
   paste that treats absent-as-zero would **silently clear real scores**. Override must write only
   the pasted members, and Compare must show "in paste, no QC row" and "QC scored, absent from paste"
   as distinct states.
4. **Who may see the histogram.** It names individual officers' error rates to a manager who is not
   their manager. `manager-my-team.md` bans compensation from manager surfaces and
   `employee-team-directory.md:73` bans pesos on rankings, but neither covers a cross-department
   performance metric. Carla asked for it; nobody said whether officers see their own number.
5. **Dispatch lockout.** Compare/Override inherits the QC 423 lockout (`payment-dispatch.md` §6.3).
6. **No notifications.** QC is a non-announcing dashboard (`notification-alerts.md:89`).
7. **Identity.** Work-email joins across a roster where 162 people carry duplicate master rows
   ([[duplicate-master-rows-hsl-tiebreak]]) and identity is known-fragmented
   ([[maria-argote-split-identity]]). The brief states which email wins.

**Also:** Kane's ruling that officers do **not** enter daily (*"the higher the frequency… they will
mess it up 100%"*) means the daily sheet stays the system of record and Compare runs **once**, after
the week closes. That is a design constraint, not a limitation to work around.

**Owes on completion:** the QC feature doc, its `INDEX.md` row, and a memory entry — same commit.

### 13.2 Manager-generated certificates

**Surface.** Manager → a team member → generate an award/certificate, which appears in that person's
renamed **Badges and Certificates** pane.

**What the brief must settle:**

1. **What the artifact is.** A third `medal_type` on `employee_medals` (the route hard-codes
   `['commend','flag']` at `app/api/manager/medals/route.ts:66`, the table has no file column, and no
   DDL for it exists anywhere in `references/sql/`), or an `award`-typed `document_requests` row
   surfaced in the pane? *"Looped in with their badges and certificates"* says where it **shows**,
   not where it is **stored**.
2. **A roster scope that does not exist yet.** `POST /api/manager/medals` today accepts **any**
   `employee_email` from the body under the `manager/team` grant with **no own-team check**
   (`route.ts:53-83`). *"one of their people on their team"* requires that check — and note
   `rbac-feature-permissions.md:184` names this route as one the view-only overlay must block, and
   `time-adjustment-requests.md:91` withholds medals from the derived second-approver seat.
3. **Who signs it**, if anyone — the manager (needs a `document_signatures` row and a gate that is
   today `accounting/documents` edit only), the Accounting Head via the existing queue (an approval
   Carla did not ask for), or nobody (a printed signature block).
4. **What it says.** No template, no title/reason field, no facts resolver exists.
5. **Whether the COE's ACTIVE-GML-only, fail-closed gate applies** (`decideCoeActiveGate`,
   `documents-tab.md:127-137`). An award is not an assertion of current engagement, so the reason
   that gate fails closed does not obviously transfer — and a certificate for a leaver's last week
   may be exactly what a manager wants.
6. **Notification.** There is no `badges.*` type; the CHECK covers three `documents.*` types only.
7. Identity: the commendations route resolves emails off a single `.limit(1)` master row, so an award
   made against the losing row of a duplicate pair is invisible to its own recipient.

---

## TL;DR

- **Ten `hardening` commits, two `blueprint`-gated new builds, nine open questions.**
- **Wave 1 (three commits) has a real deadline: Monday 2026-09-14.** Removing Callback from QC scope
  is a **one-line change** to `QC_DEPT_KEYS` with a documented precedent; revoking Alivia's role is a
  click; **randomization has to be written from scratch** — Carla believes it ships, and it does not.
- **Wave 2 is the rename plus the auto-playing nudge.** "My Hours" becomes **"Time Adjustments"**
  (label only — the `hours` key stays), and every red day gets a "Need a time adjustment?" bubble for
  ~5s, cycling one every 5s in random order. Six copy sites to follow, no test pins the old string.
  Red-only is deliberate and **will not fire on the zero-hours day Carla clicked** — keep the
  qualifying set behind one constant. Portal the bubble: the calendar card is `overflow-hidden`.
- **Do not build a third PAB calendar.** Two already ship; wire the inert stat cell up and fix the
  explainer in **all four** places it is wrong — the logic is already HSL-correct, only the prose is not.
- **The Profile merge is cache-safe and needs no new key** — all three panes already read cached
  state, `idCard` included (it is a `useMemo` over the cached roster row). The one real risk is
  hoisting `bankInfoLoaded` into the merged pane's gate, which would make an instantly-cached pane
  wait on the one call that is deliberately never cached. And if Profile still feels slow, the lever
  is **code-splitting** — 2,552 lines, kept mounted, with one `next/dynamic` call in the whole repo.
- **Nothing in this plan touches the ₱2,500.** That needs one worked example from Carla, and the
  pinned value and its test stay as they are until she gives it.
- **Eight of these surfaces have no INDEX row.** Wave 1 pays that down for QC; the rest is tracked as
  Open item 28.
