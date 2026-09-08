# Orphanage interns — profiles · mini wizard · Payroll Wizard Interns view · dispatch

> Built 2026-09-02 from `docs/implementation-plans/implementation-plan-orphanage-interns.md`
> (the scoping plan, with every decision Kane took that day). This file is the rules. Someone
> editing this in six weeks should be able to read only this file and not break it.

## What an intern is, in this system

An orphanage intern is a **payee class of their own**, not an employee:

| | Simple employee | Orphanage intern |
|---|---|---|
| Identity | `global_master_list` work email | `@pathway.ph` email on `orphanage_interns` |
| Name | parts on the onboarding tables, composed `Name` on the master list | parts on `orphanage_interns` (`first_name` / `middle_name` / `last_name` / `name_extension`), composed `full_name` — same `composeFullName`, middle never composed |
| Hours | `hubstaff_hours` (Simple's weekly report) | `orphanage_intern_hours` (their own weekly report, same columns) |
| Rate | Payment Catalog / `employee_hourly_rates` | `orphanage_intern_rates` — dated rows |
| Pay rule | Payroll Wizard (40h cap, OT, HSL forms…) | `priceInternWeek`: daily cap → weekly cap → rate in force per day; **no OT, no weekend premium** |
| Bonuses | PAB ₱5,000 (7h Mon–Fri), Tech Bonus | **PAB ₱1,000 only** (5 paid hours every week); **never Tech** |
| Who edits personal data / bank | People tab, onboarding, bank requests | **Orphanage dashboard → Interns → Profiles, only** |
| Sign-in / dashboard | Employee Dashboard | **None** |
| Paid through | `payment_dispatches` + paystub | `orphanage_dispatches` (Payment Dispatch → Orphanage tab) |

Kane 2026-09-02: interns are profiled on the Orphanage dashboard with an `@pathway.ph` email
(never `@simple.biz`), have their own PAB but no Tech Bonus, have no Employee Dashboard, and
**every personal-data change including bank details happens on the Orphanage dashboard**.
Ralph (via Kane): **5 hours a week qualifies for the ₱1,000 PAB, same pay cycle as Simple.biz.**

## The flow

```
Orphanage Manager                                     Accounting                          Dispatch clerk
─────────────────                                     ──────────                          ──────────────
Interns → Profiles      add @pathway.ph intern, rate + effective date, bank
Interns → Pay week      upload the interns' Hubstaff CSV  →  capped hours × rate  →  PAB (payout week)
                        Lock in values ──────────────────▶ Payroll Wizard → Interns (Simple | Interns toggle)
                                                            Accept ───────────────────▶ Payment Dispatch → Orphanage
                                                            Reject (note) ◀── fix & lock in again              Mark paid → orphanage_dispatches
```

`orphanage_intern_pay.status`: `submitted` → `accepted` | `rejected`. **`paid` is never stored** —
it is derived from `orphanage_dispatches` rows referencing `intern_pay_id`.

## Rules (each one has a reason and a test or a guard)

### Segmentation — `@pathway.ph` never reaches the Simple rail
- `isInternEmail` (`src/lib/interns/intern-email.ts`) is the ONE implementation of the domain rule.
- Simple's door: `rowsToPayrollRows` (`hubstaff-hours-db.ts`) drops interns; every payroll reader
  goes through it (Payroll Wizard, `current-pay.ts`, readiness, seeder, roster). `/api/hubstaff-hours`
  discloses the count as `internRowsDropped`. Test: `intern-hours-rows.test.ts`.
- The interns' door: `parseInternHoursCsv` **refuses** non-`@pathway.ph` rows and reports them; they
  are never stored. A file with zero intern rows is refused outright ("this looks like the Simple report").
- The intern upload **never touches `hubstaff_hours`, `is_current`, MESA, notifications or the
  disbursement seeder**. That is why `orphanage_intern_hours` exists as a separate table even though
  its columns are the same.

### Name — parts are the source of truth, like Simple's onboarding
- `orphanage_interns` stores `first_name` (required), `middle_name`, `last_name` (required),
  `name_extension`; `full_name` is COMPOSED on every write by the same `composeFullName`
  Simple's onboarding uses (first + last + extension). Kane 2026-09-02: "split the full name,
  similar to simple biz".
- **The middle name is never composed in** — same rule and same reason as
  `onboarding-name-parts.md`: the go-by rule takes the last given token, so folding it in would
  change what payroll prints. It is stored and shown on the profile only.
- A PATCH carrying any part recomposes `full_name` from the MERGED parts server-side
  (`updateIntern`), so a client that sends only the field it edited cannot desync the name.
  DB CHECK `orphanage_interns_name_parts_present` refuses blank first/last.

### Pricing — `src/lib/interns/intern-week-pay.ts` (pure, 15 tests)
- `paid_day = min(round2(raw_day), dailyCap)`; the weekly cap is consumed chronologically.
- Rate = newest `effective_from <= day`; a mid-week change prices per day. Never edit a rate row —
  append (`orphanage_intern_rates`, unique per intern+date).
- A paid day with no rate in force **refuses the week** (`no_rate_for_week`). Never ₱0.
- 2dp hours per day before pricing; `round2` carries an EPSILON nudge (1.005 → 1.01).
- Shares: orphanage = `round2(gross × pct)`, intern = **remainder**; DB CHECK `shares_sum` enforces it.
- The server (`intern-week-server.ts`) is the only path that turns a stored report into money; the
  client sends a file name, never figures. Accounting's inbox re-derives every row on read
  (`reconcileInternPayRow`) and shows a red chip on drift — **never rewrites**.

### PAB — `src/lib/interns/intern-pab.ts` (pure, 9 tests)
- Eligible ⇔ every Sun–Sat week whose Saturday is inside the month's PAB period has `hoursPaid ≥ 5`.
  Fixed in code; not configurable.
- The period and the payout week resolve **exactly as `current-pay.ts` does for Simple**: owning month
  from `pabMonthFromWeekStart(Monday)`, window from `pab_period_overrides` else `getPabMonthRange`,
  payout week = the week that **contains** the period end (`isFinalPabWeek`).
- A Saturday in the period with no locked week → `weeks_missing`, ₱0, amber chip. Never a guess.
- Non-payout weeks store `pab_php = 0, pab_mode = 'not_payout_week'`.

### The hand-off — `orphanage_intern_pay` is the ONLY carrier
- No `app_settings` blob for intern amounts. The whole-object blob is where the 2026-08 orphanage
  clobber lived (`orphanage-pay-step.md`); interns start without one.
- Lock in is **refused** while: `shareMode` is unset (Q2 — Ellie/Ralph — a default would move money
  nobody decided on), any `@pathway.ph` row has no profile, any row could not be priced, or the week
  is already `accepted` (409).
- The manager can **withdraw** a `submitted` week (`DELETE …/pay-weeks?source_file=…&all=1`, explicit
  flag); an `accepted` week is Accounting's to **reopen**, and reopen is **refused while any dispatch
  row is paid**.
- Accounting **accepts or rejects (note required)**. It never edits an intern's hours, rate, bank or
  personal data — that is the Orphanage dashboard's.

### Dispatch
- Accepted rows → `listPendingOrphanageItems` yields `intern_pay` (intern share, or gross under
  `intern_remits`) and, under `system_split`, `intern_orphanage_share` (bank from the orphanage
  directory's new receiving-bank columns). One dispatch per (row, type) — unique index.
- Mark Paid shows the bank **read-only** for intern items (no pencil, unlike worker payments).

### Config — `app_settings['orphanage.interns.config']`
`{ "shareMode": "system_split" | "intern_remits" | null }`, set in Payroll Wizard → Interns → Setup,
audited `orphanage_interns.config_changed`. Readable by the Orphanage dashboard so the mini wizard can
say why Lock in is refused.

## Key files

| Piece | File |
|---|---|
| Domain rule | `src/lib/interns/intern-email.ts` (+test) |
| Two-rail split (pure) | `src/lib/interns/intern-hours-rows.ts` (+test) · `hubstaff-hours-db.ts` `rowsToPayrollRows` / `splitHubstaffRows` |
| Intern CSV parse (pure) | `src/lib/interns/intern-hours-csv.ts` (+test) |
| Pricing + split + reconcile (pure) | `src/lib/interns/intern-week-pay.ts` (+test) |
| PAB (pure) | `src/lib/interns/intern-pab.ts` (+test) |
| Config (pure) | `src/lib/interns/intern-config.ts` (+test) |
| Types (client-safe) | `src/lib/interns/intern-types.ts` |
| Server pricer | `src/lib/interns/intern-week-server.ts` |
| DB | `src/lib/supabase/orphanage-interns-db.ts` · `orphanage-intern-hours-db.ts` · `orphanage-intern-pay-db.ts` |
| Profiles API | `app/api/orphanage-interns/route.ts` · `[id]/route.ts` · `[id]/rates/route.ts` |
| Hours + weeks API | `app/api/orphanage-interns/hours/route.ts` · `pay-weeks/{route,preview,decide,config,inbox}/route.ts` |
| Orphanage dashboard | `src/components/orphanage/interns/InternsTab.tsx` · `InternsProfilesPanel.tsx` · `InternDialog.tsx` · `InternRateDialog.tsx` · `InternsWizard.tsx` · `InternLockConfirmDialog.tsx` |
| Accounting | `src/components/accounting/interns/InternsPayrollView.tsx` · `App.tsx` (Simple \| Interns toggle) |
| Dispatch | `orphanage-dispatches.ts` (`listPendingInternItems`) · `OrphanageQueue.tsx` Interns section · `OrphanageMarkPaidDialog.tsx` `bankLocked` |
| RBAC | `FEATURE_CATALOG.orphanage` `interns` · `view-tabs.ts` · `OrphanageApp.tsx` |
| Migration | `references/sql/migrate/2026-09-02_orphanage_interns.sql` · `scripts/apply-orphanage-interns-migration.mts` |

## Migration

`node --import tsx scripts/apply-orphanage-interns-migration.mts` rehearses in a rolled-back
transaction (default); `--apply` commits; `--verify` re-checks. 5 tables, 16 named CHECK/UNIQUE
constraints, 6 indexes, RLS enabled with no policies, `orphanage_dispatches` gains two types +
`intern_pay_id`, `orphanages` gains four receiving-bank columns. Needs `DATABASE_URL` = the session
pooler (`@` in the password as `%40`). **Until it runs**, the Interns tab, the mini wizard and the
Interns queue section have nothing to read and say so; nothing else touches these tables.

## Open

- **Q2 — the 50% mechanics (Ellie/Ralph).** `shareMode` is unset until they answer; no intern week can
  be locked before then. Both modes are built.
- **Daily cap boundary** is the Manila calendar day of the report's weekday columns (assumed).
- The `orphanages` receiving-bank fields are editable in the directory dialog; the directory list
  card does not yet show them.
- Pre-existing, unrelated: `dept-label-render.test.ts` and `manager-time-adjustments-live.test.ts`
  fail on `ManagerApp.tsx` at HEAD (not touched by this work).
