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
  `current_department`) so their score and bonus for that week still stand.
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
- Officer membership is granted/revoked in **Admin → Roles & permissions**, group "Manager's
  assistant". Revoking is a **soft** revoke (`revoked_at`), so it is reversible and audited —
  and because the officer set changed, it also triggers a re-deal of the current week.

## Still to build

**Paste → Compare → Override + the officer-accuracy histogram** — agreed in the 2026-09-09
meeting, `blueprint`-gated, not started. Contract: three columns (work email, full name, total
appointments) from Jackie's weekly payroll email, joined on **work email**. See
[[qc-compare-override-paste-format]] for the four things the brief must settle first — chiefly
that **absence is not zero** (`saveDeptPeriodApplied` is a replace-set, and an Override built
from a partial paste would silently clear real scores).

See also: `bonus-catalog.md` · `payment-dispatch.md` §6.3 ·
`hsl-kpi-calculator-2026-07.md` · `hubstaff-zero-hours-gap.md`
