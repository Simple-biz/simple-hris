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
- **The caps are not constants in the pricer.** `priceInternWeek` takes them as inputs
  (`dailyCapHours`, `weeklyCapHours`); the server pricer passes each intern's own
  `orphanage_interns.daily_cap_hours` / `weekly_cap_hours` (`intern-week-server.ts`). They
  default to **5 h a day and 5 h a week** (`INTERN_DEFAULTS` in `intern-types.ts`, and the column
  defaults in the migration) and are editable per intern in the profile dialog.
  **Measured 2026-10-07 (production, read-only):** all 9 profiles hold **5 h/day · 5 h/week · 50%
  to the orphanage**, so in practice the weekly 5 h cap is the one that bites. Capped hours are
  shown, never paid. Whether hours over 5 are payable is **Open item 396 (OPEN MONEY, Ralph then
  Kane)**: no cap value changes until that ruling.
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

### The Review & lock in figure is ONE week, per intern — `intern-lock-summary.ts` (pure, 6 tests)
- On the 2026-10-07 call Alivia read Step 4's bare **"To the interns ₱4,164.00"** as every week so
  far. It is one week's total for every intern (measured: the 2026-09-27 → 10-03 preview, 9 interns).
  So the figure now carries its scope wherever it appears:
  - Step 4's card reads **"To the interns, this week"**, with *"across N interns · one week, not a
    running total"* under it.
  - Step 4's table has a **Capped h** column per intern (hours the caps removed, amber when > 0),
    its last column is **To the intern**, and the footer reads **"Total this week · N interns"**.
  - The confirm dialog's headline reads **"To the interns, this week: ₱… across N interns"**, with one
    line per intern under it: hours paid, hours capped, amount.
- `internLockSummary(rows)` is the one source for those figures: the card, the table footer's
  interns' total and the dialog all read it, so they cannot disagree. It **sums figures the pricer
  already produced and prices nothing**. A refused row is left out, because Lock in writes priced
  rows only (`internPayRowsFromPreview`).
- The dialog is height-capped (`max-h-[calc(100dvh-1.5rem)] sm:max-h-[92dvh]`). Its header,
  totals and footer are pinned, and only the per-intern lines scroll, so **Lock in values** stays
  reachable at any number of interns (`responsive-design.md` § Dialogs). Step 4's table stacks into
  per-intern cards below 640 px; its `min-w-[720px]` applies from `sm:` up only, because a fixed
  minimum width pushed every stacked value off-screen at phone width.
- **The dialog has never opened in production.** It opens only from **Lock in values**, which is
  disabled while any blocker stands, and `shareMode` has never been set (below). So until Q2 is
  answered, Step 4's card is the only place this figure is seen.
- Verified 2026-10-07 in headless Chromium on the real `InternsWizard` and dialog, fed fixture
  weeks (synthetic names, the measured week's totals): 66 scripted checks at 1360 px (light and dark)
  and 390 px (light and dark), plus a 40-intern dialog at 1360×768 and 390×667. They covered the
  card, the table, the headline, every line, the long-name truncation, the dialog inside the
  viewport, Lock in reachable, the lines scrolling, no page-wide horizontal scroll, and no console
  errors. **Not clicked through signed in.**

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
| One week's figure per intern (pure, display) | `src/lib/interns/intern-lock-summary.ts` (+test) |
| Capped-hours measurement (read-only) | `scripts/measure-intern-capped-hours.mts` |
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
pooler (`@` in the password as `%40`). **Applied**: measured present 2026-09-17 (memory
`orphanage-interns`), and the 2026-10-07 measurement script read all six tables. Before it ran, the
Interns tab, the mini wizard and the Interns queue section had nothing to read and said so; nothing
else touches these tables.

## Open

- **Open item 396 — OPEN MONEY, HOLD for Ralph, then Kane (2026-10-07 call).** Are hours over 5
  payable, what does the program's new **monthly** payout change (this system is weekly by design),
  and what is owed or recovered for past weeks? Nothing changes a cap, rate, amount or accepted week
  until then. **Measured 2026-10-07** (`node --import tsx scripts/measure-intern-capped-hours.mts`,
  read-only; totals only on screen, per-intern detail in a gitignored file under
  `docs/audits/backups/`):
  - **No intern week has ever been locked in.** `orphanage_intern_pay` holds 0 rows, and
    `orphanage_dispatches` holds 0 intern rows. The audit trail has no `config_changed` and no
    `week_submitted`. **`shareMode` has never been set.** So the HRIS has paid no intern: whatever
    the interns were paid went outside this rail.
  - 5 reports were uploaded and never locked in. Priced as the preview prices them (PAB ₱0, because no
    week is locked): 34 intern-weeks, 9 interns, **486.03 h raw, 148.29 h paid, 337.74 h removed by
    the caps** (21 intern-weeks over), pay = gross **₱29,658.00**, ₱14,829.00 to the interns and
    ₱14,829.00 to the orphanage, all at ₱200/h. The two August weeks carry most of the capped hours
    (143.59 h and 184.21 h for 4–5 interns, about 40 h each a week). The three September weeks carry
    0.00 h, 0.14 h and 9.80 h. One August row is refused (`no_rate_for_week`).
  - These are hours, not an amount owed. The script prices nothing that is capped.
- **Q2 — the 50% mechanics (Ellie/Ralph).** `shareMode` is unset until they answer; no intern week can
  be locked before then. Both modes are built.
- Steps 2 and 3 of the mini wizard keep a fixed `min-w-[860px]` / `min-w-[640px]` on tables that
  stack below 640 px, so their stacked values sit off-screen at phone width (Step 4's was fixed
  2026-10-07). Step 2 is a per-day grid, so the fix may be `table-keep` rather than stacking. Not done.
- **Daily cap boundary** is the Manila calendar day of the report's weekday columns (assumed).
- The `orphanages` receiving-bank fields are editable in the directory dialog; the directory list
  card does not yet show them.
- Pre-existing, unrelated: `dept-label-render.test.ts` and `manager-time-adjustments-live.test.ts`
  fail on `ManagerApp.tsx` at HEAD (not touched by this work). **2026-10-07: no longer failing**:
  `npm test` passed 6,291 of 6,291.
