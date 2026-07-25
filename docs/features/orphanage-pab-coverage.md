# Orphanage → PAB Auto-Coverage (TEMPORARY rule)

> **Status: TEMPORARY** (owner: "this will change soon"). Added 2026-07-25; auto mode
> (no excuse record needed) confirmed by the owner the same day. To remove the rule,
> start at `src/lib/payroll/orphanage-pab-coverage.ts` — every consumer funnels
> through it (see [Where the rule lives](#where-the-rule-lives)).

## The business rule

Employees who attend a company orphanage visit lose tracked Hubstaff time that day —
which would normally cost them the monthly **Perfect Attendance Bonus (PAB, ₱5,000)**,
since PAB requires **every Mon–Fri in the PAB period to reach 7 h** (one un-forgiven
short day kills the whole month).

The Payroll Wizard's **Orphanage step** (step 3) records each attendee's **orphanage
hours** for the pay week (paste tool → `orphanage_pay` table → paid at their rate, own
paystub line). Those recorded hours now also **automatically forgive** the attendee's
short workdays:

```
tracked seconds + orphanage hours × 3600  ≥  7 h   ⇒   the weekday counts as a full PAB day
```

- **AUTO** — the locked orphanage hours alone forgive. No `orphanage_visit` dispute /
  excuse record is required (in practice none exist).
- **Additive-only** — the rule can only rescue a failing day; it never fails a passing
  one, and it never changes **pay** (only PAB eligibility). The pre-existing approved-
  dispute forgiveness (≥ 4 h floor) keeps working independently.
- **Weekdays only** — the standard PAB rule only checks Mon–Fri, and covering weekends
  would hand HSL's 5-of-7 weekly quota free passing days.

## The coverage window (why "week before")

Orphanage attendance results only arrive **the week after the visit**, so accounting
pastes the hours into the **following week's** payroll run. The hours row is keyed by
that file's week (`orphanage_pay.source_file`, e.g. `..._2026-07-12_to_2026-07-18.csv`),
one row per `(source_file, employee_email)`, weekly total — **no per-day split**.

Therefore each hours row covers **its file week PLUS the week before it**:

```
                 ┌────────── visit week ─────────┐┌────────── file week ──────────┐
                 Mon .. Fri(visit, short day) .. SunMon .. Fri .. Sun
coverage window: └──────────────────────── file-week start − 7d … file-week end ──┘
```

Real example (July 2026): the **Fri Jul 10** visit's hours were all locked into the
`2026-07-12_to_2026-07-18` file. Karl Jhunz tracked 5:49 on Jul 10 (−1 h 10 m) and has
12 h in that file → 5.83 h + 12 h ≥ 7 h → Jul 10 is forgiven and his PAB survives.

When consecutive weeks' windows overlap a date, the **largest** single row's hours are
used for that day (per-day max — never a sum of rows).

Known accepted looseness (temporary rule): one weekly lump can top up **several** short
days in its window independently (e.g. 6 h covering both a 3 h and a 6 h day) — there is
no per-day allocation, because the visits carry no per-day record.

## Where the rule lives

**Single source of truth:** `src/lib/payroll/orphanage-pab-coverage.ts`
(unit tests: `orphanage-pab-coverage.test.ts`)

| Function | Role |
|---|---|
| `orphanageCoversDay(workedSec, orphHours)` | The predicate: `worked + hours×3600 ≥ 7h` |
| `buildOrphanageHoursIndex(rows)` | `orphanage_pay` rows → email → weeks (+ window) |
| `orphanageHoursForDate(idx, email, iso)` | Hours whose window contains a date (max) |
| `orphanageHoursByCoveredDate(idx, email)` | AUTO enumeration: every window **weekday** → hours |
| `buildOrphanageCoverageMap(rows)` | Whole-fleet `email → (iso → hours)` for the server engine |

**Consumers — all six PAB eligibility surfaces apply the identical predicate:**

| Surface | File / entry point | How it applies |
|---|---|---|
| Server engine | `src/lib/payroll/dispatch-bonuses.ts` → `applyPabAdjustments` (4th param), `computePabEligibleEmails` (`orphanageHoursByEmailIso`) | Bumps covered days to 7 h in the eligibility copy of the hours map (raw worked = base) |
| Payment Dispatch | `src/lib/payroll/current-pay.ts` | Fetches all `orphanage_pay` rows (final PAB week only) → `buildOrphanageCoverageMap` → engine |
| Employee PAB amount | `src/lib/payroll/member-monthly-pay.ts` | Per-employee, alias-bridged rows collapsed to one identity → `orphanageHoursByCoveredDate` → engine |
| Payroll Wizard | `src/components/PayrollWizard.tsx` → `effectiveOverridesForPab` | Overlay copy of dispute overrides; covered days get override `7`; feeds `perfectAttendanceEligible` + both weekday-breakdown memos. Index refreshes on Orphanage lock-in/remove. |
| Employee My Hours | `src/components/employee/EmployeeMyHours.tsx` → `orphanageCoveredKeys` | Calendar keeps **real tracked hours**; covered days render the "Forgiven" chip + "Forgiven by Accounting — orphanage hours" tooltip/hover; `isPAEligible` counts them as passing |
| Employee Dashboard | `src/components/employee/EmployeeDashboard.tsx` → `orphanageCoveredKeys` | Same honest-hours + forgiven treatment; "Orphanage – Visits" panel lists each week's hours + any day the hours could NOT rescue |
| (Admin mirror) | `src/components/employee/EmployeePabCalendar.tsx` | Same top-up (7 h bump) for the People-tab / Overview calendar |

**Data / endpoints:**

- `orphanage_pay` table (`references/sql/create/create_orphanage_pay.sql`) — no new
  migration; the rule is calc-time only.
- `GET /api/orphanage-pay?all=1` — every locked row across all weeks, reduced to
  `(source_file, employee_email, hours)`. **Accounting-gated** (`payroll_wizard` view).
  Powers the wizard. On failure the wizard logs
  `[orphanage-pab] … coverage inactive this session` and the rule simply doesn't apply.
- `GET /api/employee/orphanage-hours` — **session-scoped** (caller's own rows only,
  master-list alias-bridged). Powers the employee surfaces.
- `listAllOrphanagePayHours()` (`src/lib/supabase/orphanage-pay-db.ts`) — paginated with
  a stable `ORDER BY` (composite PK) so >1000-row reads can't silently drop coverage.

## Interaction with the frozen PAB snapshot

The wizard freezes `pabStatusSnapshot` into the week's additions blob so verdicts don't
change on refresh. Because orphanage hours arrive **one run after** the visit, a frozen
`ineligible` can predate the coverage that rescues it. `effectivePabStatus` therefore
lets the **live verdict UPGRADE a frozen `ineligible`** (never downgrade a frozen
eligible/in_progress). Expect a rescued employee to show **⏳ In Progress** while the
PAB month is still running — the green ✓/₱ appears on the payout week if the rest of
the month stays clean.

## Guard rails kept from review

- **Orphanage-style disputes always store `override_hours = null`** (enforced in
  `decideDispute` / `editDisputeDecision`) so every surface computes the top-up from the
  same raw-worked base.
- The rule never feeds pay: the wizard overlay feeds only the PAB memos; the server
  engine bumps only the eligibility hours copy; employee calendars keep real hours.

## Worked verification (2026-07-25, July data)

Live-data run of the shipped code: **26 employees'** short days fully covered (incl.
Karl Jhunz), **5 not covered** because their hours can't lift near-zero days to 7 h
(Jopie E., Ian D.T. Jul 7, Ericson T., Jesica R., Lawrence D.) — those need a normal
forgiveness decision via the wizard's PAB calendar if warranted.

## Removal checklist (when the rule is retired)

1. Delete `src/lib/payroll/orphanage-pab-coverage.ts` (+ its test) and fix the imports:
   the six consumer sites above, `?all=1` branch of `app/api/orphanage-pay/route.ts`,
   `app/api/employee/orphanage-hours/route.ts`, `listAllOrphanagePayHours`.
2. Grep for `orphanage-pab-coverage` / `orphanageCoveredKeys` / `orphanageHoursIndex` /
   `orphanageHoursByEmailIso` — every hit is part of this rule.
3. Keep: the Orphanage **pay** step itself, `orphanage_pay`, the ≥4h dispute-floor
   forgiveness, and the `override_hours = null` guard (independently correct).
