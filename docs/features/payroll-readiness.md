# Payroll Wizard — "Readiness" dashboard

One answer to one question for Accounting: *are we Payroll Ready for the week
we're about to run?* The Readiness tab lives in the Payroll Wizard's floating
Notes FAB (the "Payroll Notes" modal, whose panes are **Adjustments and Notes /
Readiness / Rates** — see [payroll-wizard-notes.md](../features/payroll-wizard-notes.md)).
It unions four independent signal families for the payroll week in view, grades
them into a blocker-weighted 0–100 score, and lets the accountant fix rate/bank
gaps and submit KPIs inline without leaving the wizard.

Built Jul 23–25, 2026. The 2026-07-25 score recalibration made
missing-bank-on-this-week's-payroll a **hard blocker** (the "192 missing bank
but 94/100" fix).

## Key files

| Piece | File |
| --- | --- |
| Server aggregator (`getPayrollReadiness`) | `src/lib/payroll/payroll-readiness.ts` |
| Pure scorer (no I/O, unit-tested) | `src/lib/payroll/readiness-score.ts` (+ `readiness-score.test.ts`) |
| API | `app/api/payroll-wizard/readiness/route.ts` — `GET /api/payroll-wizard/readiness[?source_file=…]` |
| Readiness pane + inline fixers | `src/components/accounting/PayrollWizardNotesFab.tsx` (`PayrollReadinessGlance`, `SetRateDialog`, `SetBankDialog`, `KpiCalculatorDialog`) |
| 100% celebration — trigger rule (pure, unit-tested) | `src/lib/payroll/readiness-celebration.ts` (+ `readiness-celebration.test.ts`) |
| 100% celebration — canvas confetti | `components/ui/confetti-burst.tsx` (`ConfettiBurst`) |
| Change-source tagging (audit) | `src/lib/payroll/readiness-audit.ts` (`READINESS_SOURCE = 'payroll_wizard_readiness'`) |
| Rate-fix write path | `app/api/payment-catalog/pay-structures/route.ts` |
| Bank-fix write path | `app/api/update-employee-ids/route.ts` |
| KPI mark-ready/lock audit | `app/api/hsl-bonus/period-status/route.ts` |
| CLI verifier (runs the REAL fn) | `scripts/verify-readiness.mts` + `scripts/server-only-stub.ts` + `tsconfig.readiness-verify.json` |
| Bank-dimension reconciliation audit | `scripts/audit-readiness-bank-score.mjs` (local-only diagnostic) |

No migration — everything reads existing tables.

## Week resolution

- The snapshot describes exactly the week the accountant is looking at. The
  wizard broadcasts its current Hubstaff upload (`WIZARD_CYCLE` event, retried
  on modal open); the pane forwards it as `?source_file=`. Omitted → the live
  `is_current` upload; no upload at all → today's calendar Monday (so the tab
  still renders pre-upload).
- The week key is the upload filename's date-range **START, verbatim** (a
  Sunday, e.g. `..._2026-07-12_to_2026-07-18.csv`) — deliberately NOT
  Monday-anchored, because that pulled the Sunday back a full week and made
  every dept read "Pending" against an empty `hsl_bonus_period_status` period.
  This is the same key the wizard and the manager KPI calculators write.
- The tab also has its **own week selector** (same upload list as the wizard's
  period dropdown). Default = follow the wizard; picking any non-current week
  latches the tab to it; picking "Current" resets to following. Out-of-order
  fetches are discarded via a monotonic request token.

## The four dimensions

1. **KPI Submissions** — per department: has the manager marked the week
   ready/locked (`hsl_bonus_period_status` ⨝ `hsl_bonus_entries` /
   `bonus_catalog_applied`)? The list covers **every master-list department**:
   built-in manager-KPI depts, every HSL sub-dept (monthly ones read `Not due`
   off the month's final payroll week), in-app registry depts ("In-app" chip,
   informational), and derived rows for any roster Department label not
   otherwise enumerated (e.g. "Orphan Ministry") — so a dept with nothing owed
   reads Ready instead of silently missing. HSL-ish labels are skipped (HSL is
   represented by its sub-dept rows).
2. **No Pay Rate** — this week's Hubstaff workers with no resolvable rate
   (individual Payment Catalog → sheet → dept base, via `resolvePeopleRate`
   over every master-roster alias). USEE/US Employees are excluded (paid
   off-channel), and so is anyone holding an active `contractor` dashboard
   role (Admin → Roles & Permissions; 2026-07-27): contractors are paid
   per-invoice via the wizard's Contractor Invoices step, never by hourly
   rate, so they leave the list AND the worker denominator
   (`loadContractorEmails`, matched on every master-roster alias with the
   Hubstaff email as fallback). The exclusion is rate-check-only — a
   contractor also on the employee roster keeps their normal Bank Info
   treatment. Best-effort read: a role-table failure re-lists contractors
   (over-flags, never hides an employee), so it doesn't join `degraded`.
3. **Bank Info** — active on-channel employees whose `employee_ids` row isn't
   payable (`isPayoutComplete`, judged WITH the legacy rates-sheet fallbacks).
   Each row carries `onPayroll`: true when any of the person's aliases has
   hours in the week's Hubstaff file — a **hard blocker** (they will reach
   Payment Dispatch and simply not get paid). Blockers sort first.
   **Off-boarded people age off once their final pay is out** (2026-07-27): HR
   keeps a leaver on the master sheet (⇒ the active roster) through their last
   pay, so the roster alone would list them for weeks. The check unions every
   off-board record (stamped duplicate `global_master_list` rows, the
   `offboarded_sheet` snapshot, completed `offboarding_queue` requests — see
   `loadOffboardDatesByEmail`), guards it against the person's own start date
   (a re-hire / recycled email never matches its predecessor's off-board), and
   drops anyone who left BEFORE the pay week in view and has no hours in its
   file — from the list AND the eligible denominator. Someone who left
   during/after the week (or with hours in its file) stays until the run that
   pays them is behind us, labeled "Left · final pay" in the UI.
4. **Exceptions** — HR onboarding-pipeline people expected NOT to be paid this
   week: `onboarding`, `awaiting_orientation`, `no_show`, `started_this_week`
   (first pay period hasn't closed). **Excluded from the score entirely** —
   their identities (all email aliases + a name fallback) are also subtracted
   from the rate/bank lists AND denominators, so an expected non-payment never
   costs points anywhere.

Departments switched off in the wizard's step-1 Configuration tab
([payroll-wizard-configuration-tab.md](../features/payroll-wizard-configuration-tab.md))
stay **listed** with an explicit red "Excluded" status ("off in wizard
Configuration") but leave every dimension — numerators and denominators — so
the score describes only the departments actually being paid. The exclusion is
keyed per Hubstaff source file, so a new week snaps everything back. Pausing
Hogan Smith Law pauses every HSL sub-dept with it.

### Auto-Ready (`no_bonus`)

A general/in-app/derived dept with NO Payment Catalog bonus its manager could
apply this week (dept- or employee-scoped assignment; monthly cadence only
counted on the final week — see [bonus-catalog.md](../features/bonus-catalog.md))
has nothing to submit — the catalog-driven calculator literally renders "No
bonuses assigned" — so an untouched dept auto-reads **Ready** ("no bonus set")
instead of pending forever. An explicit ready/locked, or any applied rows this
week, always wins over the shortcut; a catalog read failure never auto-Readies.

## The score (`readiness-score.ts`)

Pure function, framework-free, reused on both sides of the wire. Weights:
**rate 50 / KPI 25 / bank 25** (`SCORE_WEIGHTS`); exceptions excluded. Each
component reports `points` (the headline `value` is exactly their sum), `open`,
`blockerOpen`, and a display `percent`.

- **Floor rule**: any open item floors its dimension (`Math.floor`) — "1
  missing of 500" reads 49/50 and 99%, never rounds back to full. 100/`ready`
  only when truly clear. Percent is 100 only at `open === 0`, else capped at 99.
- **Hard blockers** pin their dimension and force grade `blocked`:
  - any missing rate pins rate to **10/50** (a blocker alone caps the total at
    10+25+25 = 60);
  - any missing-bank person **on this week's payroll** pins bank to **5/25**
    (caps the total at 50+25+5 = 80).
- Grades: `blocked` (any blocker) / `ready` (nothing open) / `almost` (≥ 85) /
  `at_risk`. A nothing-to-measure week reads 100/ready.

This is the 2026-07-25 recalibration: before the on-payroll split, 225 missing
of 1091 (156 of them on the week's payroll) still scored 94/100 "almost".
`readiness-score.test.ts` locks that exact case to 80/`blocked`, plus the
sum-reconciliation, floor, clamp (payroll-overlap > missing list), and percent
invariants.

### Pay-this-week scoping (2026-07-26)

The score counts **only what's needed to pay the week in view**. The composer
feeds the scorer's bank dimension the on-payroll slice — numerator
`missingBankOnPayroll` over the new `bankOnPayrollCount` denominator (eligible
roster people with hours in the week's Hubstaff file, matched on any alias).
Missing bank on the wider roster ("data debt") stays **visible in the Bank
Info list** but moves neither the score nor the grade — same treatment as
excluded departments, onboarding exceptions, and USEE. Rates were already
payroll-scoped (this week's Hubstaff workers) and KPI drops `na`/`excluded`
from its denominator. Consequence: a week with only roster-hygiene bank gaps
can now grade `ready`; the hero flips green with a "N roster bank items to
review (not paid this week)" note instead of holding amber. The scorer itself
is unchanged (still generic numbers-in → score-out); only its inputs and the
payload (`bankOnPayrollCount`) changed.

### Score details modal (2026-07-26)

The score dial (and a mobile score chip next to the hero headline) is a
button — clicking it opens `ScoreDetailsDialog`, a client-side breakdown of
the payload the tab already has (no extra fetch): per-dimension cards (points
earned / max, progress bar, who was counted, what's open, and the pinning
rule that produced the number), a "never counted against the score" list
(excluded depts, exceptions, off-payroll bank gaps, USEE — with this week's
live counts), the four grade bands with the current one highlighted, and the
`degraded[]` warnings when the load was partial.

### `degraded[]` — no green on broken reads

Every data source the composer could not read this load is reported
human-readably: Hubstaff hours (kills the rate check AND the payday-blocker
signal), `employee_ids`, the legacy rates sheet, onboarding records, the
pay-week Configuration setting, the department registry, the roster. A broken
read reshapes the numbers **to look better**, so it is never swallowed: the UI
shows an amber "Partial data this load" alert, and the composer caps the grade
— `ready` becomes `at_risk` while anything is degraded.

## The pane (inside `PayrollWizardNotesFab.tsx`)

Hero banner (green/amber/rose verdict + SVG score dial), four stat tiles (each
with its dimension's percent + progress bar), then a tab strip — **KPI
Submissions / No Pay Rate / Bank Info / Exceptions** — with live count badges
(rate = rose blocker tone, exceptions = neutral sky). Each list has a search
box; the three people lists paginate at 10/page. Kept live via `useLiveRefresh`
on 7 tables (period status, entries, applied bonuses, rates, pay structures,
`employee_ids`, `hr_pending_employees`) plus a 30s poll. Read access = the
accounting `payroll_wizard` view grant (same as the notes board); the inline
actions additionally require the edit grant (`canEdit`), and the write APIs
enforce their own grants.

### 100% confetti celebration (2026-07-27)

When the week's score reaches a **full 100/Ready while the tab is open** — the
accountant just watched the last blocker clear (their own inline fix landing, a
manager marking ready over the live refresh, the 30s poll) — a ~3s canvas
confetti burst erupts from the hero banner. `ConfettiBurst`
(`components/ui/confetti-burst.tsx`) draws on ONE full-viewport canvas
(pointer-events-none, `aria-hidden`) portaled at `z-[60]`: above the notes
dialog (z-50), deliberately below dropdowns/popovers (`z-[140]`). Colors stay
on-palette (readiness greens + brand amber/orange + one sky accent).

The trigger rule is pure and unit-tested (`readiness-celebration.ts`,
mirroring the `readiness-score.ts` split): only a live not-ready → 100/Ready
transition of the **same week** fires. Opening onto an already-clean week,
switching weeks onto one, and repeat ready payloads all stay quiet; a degraded
"100" can't fire (the composer already caps its grade off `ready`); a score
that dips and clears again is a real re-transition and celebrates again.
Reduced motion skips the confetti entirely — the hero's green flip is the
celebration.

- **KPI rows** — name + completeness bar (scored/expected) + status pill.
  Clicking a row (edit grant, non-`custom` source) opens that dept's **KPI
  Calculator in a modal** — the SAME component the manager uses. General depts
  get `DeptBonusCalculator` elevated with the clicked dept's panel auto-opened;
  HSL rows get `HslBonusCalculator` scoped to ONLY the clicked sub-dept (a
  single `hsl:<key>` grant, `isElevated={false}` — no "All Departments" view;
  server-side writes still authorize on the elevated session). Readiness
  reloads on close.
- **No Pay Rate → "Set rate"** — files an EMPLOYEE-scoped Payment Catalog pay
  structure via `POST /api/payment-catalog/pay-structures` (top of the rate
  chain, effective immediately; also syncs rate history / the rates sheet and
  notifies the employee). Department defaults from the row's label; any HSL
  sub-department label files under the one Hogan Smith Law dept (the dialog
  says so).
- **Bank Info → "Set bank"** — writes payout details to the person's
  `employee_ids` row via `POST /api/update-employee-ids` (the same route the
  employee portal saves through, so history/audit/notifications all fire).
  When the row already resolves an effective processor, the processor is
  FIXED and only its missing details are collected — routing changes stay in
  their approval flows and the WIRES lock stays intact. Only with no processor
  at all does the picker open (a `SmoothSelect` over
  `EMPLOYEE_SELECTABLE_PROCESSOR_OPTIONS`, which un-retires **Wise**; Wise is
  deliberately not a wallet here — it collects the same wire fields as Wires,
  since `isPayoutComplete` judges it on bank details), writing the
  Disbursement channel (`preferred_processor`), never `bank_preferred`.
  Filters: a searchable **department dropdown** (including a "No department"
  bucket) and a **"Paying this week (N)"** toggle chip that narrows to the
  hard blockers (hidden — and auto-released — when none qualify). Blocker rows
  carry a rose "Paying this week" badge next to the amber
  "`<processor>` · incomplete / No processor" pill.
- **Exceptions** — read-only list with kind pills and a detail sub-label
  (e.g. "Started 2026-07-21 — first pay period not closed").

## Audit trail (`readiness-audit.ts`)

All three write paths the tab drives accept an optional `source` string,
validated against a whitelist (`CHANGE_SOURCES`) so a typo can't poison the
trail; unknown values fall back to each surface's own origin. Readiness fixes
send `READINESS_SOURCE` (`payroll_wizard_readiness`, label "Payroll Wizard
(Readiness)"):

- **Set bank** → `insertAuditLog` + `insertBankUpdateHistory` with
  `via: source`, attributed to the verified session actor (the accountant),
  not the employee — the People-tab "Bank changes" source label agrees.
- **Set rate** → the pay-structures route writes the Rate History note
  `Set from Payroll Wizard (Readiness) by <actor>` (a normal catalog save
  writes the literal `Set via Payment Catalog`, which the Payment Catalog's
  Rate History panel hides — so a Readiness fix reads back there as a visible
  "changed from Payroll Wizard" attribution). USD structures are intentionally
  not pushed to the PHP-denominated history/sheet.
- **Mark Ready / Lock / reopen** from the embedded calculators
  (`submissionSource={READINESS_SOURCE}`) → audited in the period-status route
  as `payroll.kpi.marked_ready` / `.locked` / `.reopened` with
  `source_label`; score-saves are deliberately not audited (volume).

## Verification harness

`scripts/verify-readiness.mts` runs the **real** `getPayrollReadiness()` — the
exact production function behind the API — from the CLI against the live DB
(read-only), printing the KPI due/submitted split, custom/derived rows,
degraded notes, counts, the score breakdown, and the first on-payroll bank
blockers. Because `payroll-readiness.ts` imports the `server-only` marker
(which Next shims but plain Node can't resolve), it runs with
`tsconfig.readiness-verify.json`, whose `paths` maps `server-only` to the empty
`scripts/server-only-stub.ts`:

```powershell
$env:TSX_TSCONFIG_PATH="tsconfig.readiness-verify.json"; node --import tsx scripts/verify-readiness.mts [source_file]
```

`scripts/audit-readiness-bank-score.mjs` is a local-only diagnostic that
re-derives the Bank Info dimension (denominator, per-processor missing
reasons, alias-expanded on-payroll blockers, score arithmetic) straight from
the raw tables, for reconciling the dashboard against the data.

## Deploy / pending notes

- **No migration** and no new tables — safe to deploy standalone.
- `audit-readiness-bank-score.mjs` is marked "not meant to be committed"
  in-file but ships in `scripts/` as a diagnostic; it needs
  `SUPABASE_SERVICE_ROLE_KEY` locally.
- Related docs: [payroll-wizard-notes.md](../features/payroll-wizard-notes.md)
  (the FAB the tab lives in),
  [payroll-wizard-configuration-tab.md](../features/payroll-wizard-configuration-tab.md)
  (the Excluded status' source of truth),
  [bonus-catalog.md](../features/bonus-catalog.md) (the catalog the auto-Ready
  rule and the Set-rate fixer write against).
