# Payroll Wizard — Initial Calculation & Final Pay

How the Payroll Wizard turns Hubstaff hours into each employee's final pay, and the
accounting-editable adjustments layered on top. Covers the **Initial Calculation** (step 2)
and the **Additions** step (step 4) — both its shared department table and its **HSL** tab.

Source: [`src/components/PayrollWizard.tsx`](../../src/components/PayrollWizard.tsx).
Last substantive update: **2026-08-28**.

> **Replaying a past week is a different contract.** Everything below describes
> the live cycle. What the header's pay-period selector is allowed to show for a
> closed week — which values are read verbatim from that week's saved state, which
> fall back to live computation, and the one thing (bonus **amounts**) that still
> resolves from today's catalog — is owned by
> [payroll-wizard-week-replay.md](./payroll-wizard-week-replay.md).

---

## 2026-08-28 — HSL and Additions are ONE step, and HSL is a TAB of it

Kane: *"HSL and Additions should be merged, however for HSL it should be in another tab,
not merged with the other departments."* Both halves are load-bearing.

**One step.** The old step 4 (HSL) and step 5 (Additions) are now a single step 4,
"Additions". Its render lives in one `case 4:`; the HSL workspace was lifted out
verbatim into `renderHslWorkspace()` and is called from inside it. No figure, column,
total, handler or stored value changed in the move — `bonusOverrides`,
`orphanageAmounts` and the `payroll.wizard.additions.<sourceFile>` blob were **already
shared** by both tables, which is what made the merge a render change rather than a
money change.

**HSL is its OWN TAB inside the step — not an entry on the Departments rail**
(Kane, revised the same day). The step carries a **section tab strip** of its own,
`Departments | HSL`, sitting above the workspace and below the step header:

- **Departments** — the vertical department rail plus the shared additions table.
- **HSL** — the Hogan surface, replacing the workspace entirely: its own sub-department
  rail, monthly-bonus cards and Total Pay table. (The header banner and the weekly
  period cards were removed 2026-08-28 — see `components.md` §Step 4.)

Selecting HSL does not change *which department the table shows*; it changes *which table
there is*. That is why it is a section rather than a rail entry, and it is also what keeps
HSL out of the shared department table: `hogan_smith_law` is excluded from the rail's map,
and the rail can no longer select it at all. HSL has to stay separate on the merits too —
it prices **Mon–Sun** weeks with a **+₱15/h weekend premium** and takes its bonuses from
HSL KPI periods, so its rows do not fit the other departments' columns.

The section is **separate state** (`additionsSection`), never a magic
`'hogan_smith_law'` value on `activeDeptTab`: the department rail owns `activeDeptTab` and
snaps it away from paused departments, and that snap must not be able to bounce the
operator out of a section it knows nothing about. The **active** section is *derived*
(`activeAdditionsSection`) rather than stored, so a stored `hsl` cannot outlive the tab
that offered it. **Paused in the Configuration tab ⇒ the HSL tab leaves the strip**, like
any other excluded department
([payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md)) — its rows
are already filtered out of `effectiveCalcResults`, so the surface would be an empty
bucket. Each tab carries its own payable-headcount badge; pending time-adjustment counts
stay on the department rail, where the review panel that answers them lives.

**Every later step shifted down by one, and that was forced.** The rail's progress bar is
`currentStep / steps.length` and completion is `currentStep >= steps.length`, so leaving
a hole in the ids would read past 100% and mark Reports complete while standing on
Dispatch. The shipped rail is now:

| # | Step | Was |
|---|---|---|
| 1 | Initialize Payroll Data | 1 |
| 2 | Initial Calculation | 2 |
| 3 | Orphanage | 3 |
| 4 | **Additions** (department table + HSL tab) | 4 (HSL) + 5 (Additions) |
| 5 | Contractors | 6 |
| 6 | **PAB** (review + Forgive month) | — new 2026-08-28 |
| 7 | Validation | 7 |
| 8 | Dispatch | 8 |
| 9 | Reports | 9 |

**The two real gates moved with their numbers** and are unchanged in substance: the
red-flag confirm on Continue is now step **7**, and the per-cycle FX-zero hard block is
now step **7**. Nothing was loosened to make the renumbering fit — every step reference
in the code, the readiness checklist's `stepNo` strings, the tutorial guide and these
docs was corrected in the same commit.

**The switch is animated, and the animation is part of the contract.** The strip
carries ONE underline that glides between the tabs on a shared `layoutId`; the
workspace does a directional crossfade + 20px slide (`mode="wait"`, so two pay
tables never cross-dissolve into each other), wrapped in `overflow-x-clip` — never
`-hidden`, which would make it a scroll container and break the tables' sticky
headers. Every duration is gated behind `useReducedMotion()`. The department panel
inside the Departments section lost its `blur(2px)` legs in the same pass: filtering
a several-hundred-row pay table on every tab change was the one thing here that
dropped frames. Pattern and constants: `docs/design/ui-standards.md` §11.1.

**The step's load line waits on BOTH sections.** `isStepDataLoading(4)` now counts the
all-weeks PAB merge **and** the HSL KPI amounts / HSL bonus entries, and the HSL fetch
stays gated on **step** entry — never on `activeAdditionsSection === 'hsl'`. Gating it
on the section would let the line go green while nothing had ever been fetched for HSL,
which is the one thing that line is not allowed to do
([payroll-wizard-step-load.md](./payroll-wizard-step-load.md)).

**One behaviour deliberately NOT added:** the HSL section still shows no time-adjustment
review panel. HSL adjustments were never reviewed on the old HSL step either, and
surfacing them here would be a new approval surface, not a merge.

## 2026-08-18 — the per-cycle FX rate has no source of truth (**OPEN**)

Found reconciling three paystubs against NPD's sheet. **Nobody's pay math was wrong —
the pesos agreed to the centavo on all three. The USD divisor didn't.**

| | HRIS ₱ (verified) | ÷ 61.52 (HRIS FX) | ÷ ≈60.93 (NPD's implied FX) |
|---|---|---|---|
| `arvsn@` | 12,652.73 | **$205.67** ✓ HRIS | $207.66 (NPD showed 207.73) |
| `lorar@` | 17,009.68 | **$276.49** ✓ HRIS | **$279.17** ✓ NPD |
| `ellainnec@` | 5,102.13 | **$82.93** ✓ HRIS | **$83.74** ✓ NPD |

Same peso total, two divisors — that is the entire discrepancy. HRIS's Aug 9–15 leg was
**61.52** (`payroll.wizard.fx.…2026-08-09_to_2026-08-15.csv`, set 2026-08-17 14:55 UTC);
the prior three weeks — 61.68 / 61.00 / 60.91 — matched NPD to four decimals. **Which of
61.52 / 60.93 is the correct market rate is an Accounting call, not something either
system can be shown wrong about**, and it is not evidence of a defect on either side.

**What the wizard actually guarantees about that number: only that it isn't zero.**

- It is a **free-typed value**. The save path
  ([`PayrollWizard.tsx:2950`](../../src/components/PayrollWizard.tsx#L2950)) writes the
  typed number straight into `payroll.wizard.fx.<sourceFile>` **and** the global
  `usd_to_php_rate`. There is no range check, no plausibility band, no comparison against
  the previous cycle, the NPD sheet's `AW` cell, or any market feed — and **no alarm on a
  week-over-week move** (this one was +1.00%). Every earlier week matched because a human
  copied the sheet, not because anything enforced it.
- The only gate is the **Dispatch-step zero gate** (step 8 since the PAB step landed 2026-08-28;
  memory `per-cycle-fx-zero-placeholder`):
  zero is a real state that hard-blocks publish. A *wrong but non-zero* rate is
  indistinguishable from a right one and publishes normally.
- **The no-rate fallback is ₱1.00 = $1.** `OFFICIAL_USD_TO_PHP_RATE` is
  `100_000 / 10⁵` = **1** ([`usd-php.ts:8`](../../src/lib/fx/usd-php.ts#L8)), and
  `effectiveUsdToPhpRateFromStored` returns it whenever the stored value is missing,
  blank, unparseable or ≤ 0. So a lost or corrupted FX key does not fail loudly — every
  USD figure downstream comes out **≈61× too large**. That zero gate catches a typed
  zero, not this path.
- The tutorial guide reads the *previous* cycle's record for advisory copy only and must
  never prefill this cycle's input — see
  [payroll-wizard-tutorial-mode.md](./payroll-wizard-tutorial-mode.md). That stays true:
  the answer to "no source of truth" is a **cross-check**, never a carried-forward value.

Closing this class means one of: validating the typed rate against the sheet cell HRIS is
replacing, or a stored band + confirm-on-outlier, plus making the missing-key case an
error rather than `1`. None of it is built.

*One residual from the same reconciliation, unrelated to FX:* at 60.93 two of the three
land exactly and `arvsn@` is $0.07 short (₱4.25 ≈ 0.016 h at ₱265) — NPD's `M-F Total
Hours` reading ≈40.52 h where HRIS has 40.51 h, i.e. a sub-minute Hubstaff re-sync
difference between the two pulls, not a calculation gap on either side.

## 2026-08-17 — step-2 header layout

Presentation only. No handler, guard, hydration path, or stored value changed.
The per-cycle FX contract (memory `per-cycle-fx-zero-placeholder`, spec
[`2026-08-03-per-cycle-fx-zero-placeholder-design.md`](../superpowers/specs/2026-08-03-per-cycle-fx-zero-placeholder-design.md))
still governs the numbers: cards hydrate **raw** from
`payroll.wizard.fx.<sourceFile>`, zero is a real state, all four save paths
(PHP/COP × Enter/Apply) write through, and replay stays read-only.

- **The two FX rate strips are now cards**, matching the Initialize Payroll Data
  sync-card anatomy on step 1 (icon tile, eyebrow, title, body, footer control).
  Each tile carries the **currency pair's two flags** (US+PH, US+CO, PH+CO) via
  `CurrencyFlagPair` in [`components/ui/flag.tsx`](../../components/ui/flag.tsx).
  These are **inline SVG, never emoji** — Windows ships no glyph for
  regional-indicator pairs, so `🇺🇸` renders there as the letters "US". The tile
  background is neutral (`bg-white dark:bg-zinc-900`) so the ring separating the
  two overlapping circles matches the surface behind them; if you re-tint a tile,
  pass a matching `ringClassName`.
  A third **read-only** card shows the derived `PHP ↔ COP` cross-rate that used to
  be buried in the COP strip's footnote. USD stays the anchor: that pair is
  computed, never set.
- **USD → COP moved from amber to teal.** Amber is this step's *warning* colour
  (missing rates, and the "Not set for this cycle" state that renders **inside**
  these cards). A normal control must not wear it, or the warning disappears into
  its own container. Do not move it back.
- **Three things collapsed into icon affordances** beside the step title, each a
  hover/click/keyboard popover (`StepInfoButton`, built on Base UI Popover via
  [`components/ui/popover.tsx`](../../components/ui/popover.tsx)):
  the **calculation formula** (plus the departments-shown note and the official
  PHP default), the **active Hubstaff upload**, and the **missing-rate list**
  (amber, badged with the count, only rendered when the count is non-zero).
- **The missing-rate list is unchanged in substance** — same
  `regularRate == null` filter, same three columns, same copy. It is behind an
  icon rather than a full-width `<details>`. The count is visible on the trigger,
  so the blocker is never silent.

## 2026-07-29 updates

- **HSL rows now show in the Initial Calculation table (step 2).** Previously
  `hogan_smith_law` rows were filtered out of the step-2 table (a banner pointed
  to the HSL tab instead), even though their `initialPay` was computed in the
  same pass. The table now lists **every department**; the banner clarifies that
  HSL **KPI bonuses** are still added on the HSL tab. Display-only — no
  money-path change (the HSL tab always read the same rows).
- **Step-2 department filter.** A `Dept:` dropdown next to the table search
  narrows the table to one department (options are the departments present in
  the current run's rows, with counts; people whose email maps to no wizard
  dept fall under **Unassigned**). Each row also shows its department under the
  member name, and the search box matches department names too.

## 2026-07-25 updates

- **Every master-list department is visible.** The wizard previously folded or
  dropped whole departments: `SMM Freelancer` was normalized into the built-in
  `smm` ("Social Media") tab, `hsl:*`-keyed people scattered, and master-list
  departments with no built-in mapping had no tab at all. Now `smm_freelancer`
  is split into its own tab, `hsl:*` members roll into the **HSL** tab
  (**pay-affecting** — ~35 people who previously fell through), unknown
  departments get **derived-slug tabs** (e.g. USEE), and members with no
  Hubstaff hours appear on a **read-only roster card** so a department is never
  silently empty. (`src/lib/payroll/normalize-dept-key.ts` + the wizard rail.)
- **Step-1 Configuration tab.** Per-department **Pay this week** (week-scoped
  exclusion) and **Overtime** switches — see
  [payroll-wizard-configuration-tab.md](./payroll-wizard-configuration-tab.md).
- **Catalog-created departments get paid.** Departments minted in the Payment
  Catalog's Department tab appear in the wizard/Additions like any other — see
  [payment-catalog-departments.md](./payment-catalog-departments.md).
- **Time Adjustments are week-gated.** The Additions "Time Adjustments" fold-in
  only shows requests belonging to the wizard's **current pay week**; other
  weeks' requests no longer bleed into every run.
- **HSL table UX.** Pinned always-visible horizontal + vertical scrollbars,
  Additions-matching text size, and the **KPI Bonus column hidden by default**
  behind a Show/Hide dropdown in the toolbar.
- **Orphanage PAB auto-coverage (temporary).** Orphanage-step hours can
  auto-forgive short PAB weekdays — see
  [orphanage-pab-coverage.md](./orphanage-pab-coverage.md).

## 2026-07 updates

Three changes landed 2026-07 — a proration-parity fix, a PAB-pill display change, and
last-synced timestamps on the Initialize step.

Key files:

- [`src/lib/payroll/rate-history-resolve.ts`](../../src/lib/payroll/rate-history-resolve.ts) — client-safe rate-as-of-date + history index.
- [`app/api/payroll/rate-history-bulk/route.ts`](../../app/api/payroll/rate-history-bulk/route.ts) — rate-visible bulk `employee_rate_history` feed.
- [`app/api/accounting/sync-status/route.ts`](../../app/api/accounting/sync-status/route.ts) — last Google-sync timestamp per source.
- [`src/lib/supabase/audit-log.ts`](../../src/lib/supabase/audit-log.ts) — `fetchLastSyncTimestamps` (reads the audit trail).

### Mid-week rate proration (Step 2 ↔ Payment Dispatch parity)

Step 2's Initial-Pay calc now prorates a **mid-week rate change** per day so the wizard
matches Payment Dispatch byte-for-byte. When a dated rate change falls **inside** the pay week,
`proratePayForMidPeriodChange` (`PayrollWizard.tsx:457`) walks the pay days chronologically —
old rate before the effective date, new rate on/after — mirroring the server's
`computeProratedRowPay` in [`current-pay.ts`](../../src/lib/payroll/current-pay.ts): a **40h
chronological regular cap** (`REG_WEEK_CAP_SEC`), the **HSL +₱15/day** weekend premium on
Sat/Sun hours, and **raw accumulate then round once** (per-day PHP summed into a float,
`Math.round(..*100)/100` applied only at the end).

- **Data feed:** rate history comes from the client-safe
  [`rate-history-resolve.ts`](../../src/lib/payroll/rate-history-resolve.ts) module
  (`buildRateHistoryByEmail` / `resolveRateAsOfDate`, the pure half of `rate-history.ts`) hydrated
  from `GET /api/payroll/rate-history-bulk` — every `employee_rate_history` row (email, reg/ot,
  `effective_from`), newest-first, gated to **rate-visible roles** (admin / accounting / ceo).
- **Keyed on the Hubstaff email only.** History is looked up on the same `em` key Payment Dispatch
  uses, so the two engines can never resolve a different history row (`PayrollWizard.tsx:3922`).
  A flat **INDIVIDUAL** catalog rate is skipped (that rate is flat all period).
- **Unchanged employees stay byte-identical.** When the week has no in-window change and the
  constant history rate equals the fallback cache/catalog rate, the function returns `null` and
  the caller keeps its existing single-rate result (`PayrollWizard.tsx:536`).
- **Step-2 badge.** A mid-week change surfaces an amber `old→new eff YYYY-MM-DD` pill under the
  Rate column (`row.rateChange`, `PayrollWizard.tsx:7412`).

### PAB pill — provisional "Eligible" (display only)

On the **Additions** tab the PAB pill now shows a green **✓ Eligible** with the Payment-Catalog
PAB amount as soon as **no weekday has failed yet** (previously a neutral ⏳ "In Progress").
The tri-state pill (`PayrollWizard.tsx:9316`) collapses the raw `in_progress` status to `eligible`
for display: `status = rawStatus === 'in_progress' ? 'eligible' : rawStatus`. This is
**display-only** — actual payout is still gated by the `perfect_attendance` toggle plus dept
eligibility (`isPabDeptEligible`), and only a genuinely failed weekday locks the pill to
✗ Ineligible. The HSL tab (step 4 since the 2026-08-28 merge) is unchanged.

### Last-synced timestamps on Initialize

The **Initialize Payroll Data** step now renders a "Last synced …" line under each Google-sync
card — **Roster** (`master`), **Rates** (`rates`), and **Hogan** (`hsl`). The wizard fetches
`GET /api/accounting/sync-status` on mount into `lastSyncAt` (`PayrollWizard.tsx:969`, rendered via
`renderLastSynced`), which calls `fetchLastSyncTimestamps` — the latest `created_at` of the
`csv.master.sync` / `csv.rates.sync` / `csv.hsl.sync` audit actions. Because it reads the audit
trail each sync route already writes, **cron-triggered syncs count the same as manual button
syncs**; no separate persistence. Missing timestamps are non-fatal (the line just stays hidden).

---

## 1. The final-pay formula

For every employee the wizard computes:

```
Final = Initial Pay
        + PAB bonus            (Perfect Attendance, ₱5,000, final PAB week only)
        + Tech bonus           (₱1,850, 3rd-paycheck week, 30-day tenure)
        + KPI / dept bonuses   (manager KPI Calculator submission → "KPI Sub." column;
                                 SSD "KPI Bonus" toggle; US-manager toggles)
        − MESA deduction       (₱100/paycheck for enrolled members)
        + MESA disbursement    (approved payout being released this run, if any)
        + Adj.                 (accounting signed adjustment — see §2)
        + Orphanage            (accounting positive add — see §3)
```

`Initial Pay = regularPay + otPay`, where `regularHrs = min(totalHrs, 40)` and `otHrs = rest`,
priced at the employee's PHP `Regular Rate` / `OT Rate`. HSL employees also get a **+₱15/h
weekend premium** for Saturday/Sunday hours (baked into Initial Pay).

The same formula is used in three places and they must agree:
- the **Additions** table row Final (step 4, the shared department table — non-HSL),
- the **HSL** table Total Pay (step 4's HSL tab),
- the **dispatch payload** (`dispatchData`) `pay_php.final`, which is what actually gets paid.

> **Per-department performance bonuses moved to the KPI Calculator (2026-06-10).** The old violet
> in-wizard calculators (Tix ×₱50, Sites, Lead-Gen appts, Units, Sales, HR pool, Accounting weekly
> collections, QC) were removed from the Additions tab. `bonusTotals` no longer calls
> `calculateDepartmentBonus`; for formula departments the dept bonus now comes **only** from the
> manager's KPI Calculator submission (`resolvedManagerBonus` → "KPI Sub." column). So a department
> bonus requires a manager KPI submission — there is no auto-computed fallback in the wizard.

---

## 2. Adj. column — signed delta, not a replacement

The **Adj.** column (Additions) / **Adjustment** column (HSL) is backed by
`bonusOverrides: Record<email, number>`.

**Semantics (corrected 2026-06-10):** the typed value is a **signed delta added on top** of the
auto-computed bonus subtotal — it does **not** replace it. Positive increases pay, negative
deducts. So the auto PAB/Tech/KPI/dept amounts always remain in Final.

- Additions: `bonusTotal = autoBonus + adj`, `getEffectiveBonus(email) = bonusTotals[email] + bonusOverrides[email]`.
- HSL: `effectiveBonus = kpiBonus + adj`.
- Dispatch: `adj` is folded into `pay_php.other_bonuses` so `bonuses_total = pab + tech + other`.

> Before the fix it was a full **replacement** of the bonus subtotal, so setting an adjustment
> wiped KPI/PAB/Tech from Final. `bonusOverrides` is only ever written by the Adj inputs, so the
> meaning change is contained to this feature.

Persistence: saved in the Additions draft (`app_settings` key
`payroll.wizard.additions.<sourceFile>`) and reloaded by `loadAdditionsProgress`.

---

## 3. Orphanage column — positive add, own paystub line

Added **2026-06-10**. A manual per-employee orphanage pay amount, **distinct** from the
auto-computed orphanage-visit wages shown in the Orphanage step (id 3).

- State: `orphanageAmounts: Record<email, number>`; updater `updateOrphanageAmount(email, value|null)`
  (audited as `wizard.addition_edited` / field `orphanage_pay_php`).
- **Positive only** (input rejects negatives), added on top of Final / Total Pay.
- Present in **both** the Additions table (between Adj. and Final) and the HSL table (between
  Adjustment and Total Pay, with its own footer total).
- Dispatch: new field `pay_php.orphanage_pay` on `DispatchEmployee`, included in `final`.
- Persisted in the Additions draft alongside `bonusOverrides`.

> **n8n template note:** the dispatch route (`app/api/dispatch-paystubs/route.ts`) forwards the
> whole payload to n8n, which renders the actual paystub. The "Orphanage" paystub line must be
> added to the **n8n paystub template** to display `pay_php.orphanage_pay`; the value is already
> in the data.

---

## 3a. Shared-email KPI bonuses — attribution by name snapshot *(2026-07-30, `5cd515c`)*

**The bug.** `bonus_catalog_applied` rows are keyed by the email the manager KPI Calculator's
roster shows for a member (**personal-first**). The wizard paid by **summing rows per email** —
which silently merges **two people** whenever one address sits on more than one master row.
Live incident: Rhocel Bencito's master row carried John Marc Corpuz's gmail, so **both**
paystubs staged her ₱2,500 `pm_team` KPI **plus** his ₱8,666.67 HR split as one **₱11,167**
sum. The KPI Calculator itself showed the correct ₱2,500.

**The rule now** — [`src/lib/payroll/manager-bonus-attribution.ts`](../../src/lib/payroll/manager-bonus-attribution.ts):

- Stored keys are **left exactly as they are**. The KPI Calculator, QC, and all history data
  are untouched — no re-keying, no migration. Disambiguation happens at **resolution time**.
- `buildSharedEmailOwners(master)` finds emails claimed by **2+ master rows whose names
  tokenize differently** (`normalizeNameTokens`) — i.e. genuinely different humans. **Duplicate
  rows for the same human** ("Lee, Seungyong" vs "Seungyong, Lee") tokenize identically and are
  deliberately **not** flagged, because for one human the per-email sum is correct.
- Only for a flagged email: each claimant is paid **only the rows snapshotted under their own
  `employee_name`** (the calculator stamps one on every applied row).
- Rows naming **neither** claimant are paid to **nobody** and surfaced — never guessed at.
- **Unshared emails (99.9% of people) resolve byte-for-byte identically to before** — the
  loader's per-email sums are used untouched, so the regression surface is zero.
- The **Additions step shows an amber banner** naming the shared email, the per-person split,
  and telling Accounting to fix the master list — so this class of data error can never again
  land silently on a paystub.

**Verify against live data:** `npx tsx scripts/verify-kpi-shared-email-split.mts` runs the real
production module. On the incident cycle the merged 11,167 splits to **Bencito 2,500 (pm_team) /
Corpuz 8,667 (hr)** — exactly the calculator's numbers — and that email was the **only** genuine
collision across all 1,307 master rows. Rerun it any week.

> **Two follow-ups this does NOT fix:** the master list is still factually wrong (Rhocel's
> Personal Email is John's gmail — the banner nags until corrected), and rows already staged
> **before** the fix still hold the merged figure. Reload the wizard tabs and **re-lock** the
> cycle to restage.

---

## 4. Pay week & hours sourcing

Hours come from `payDaysByEmail` → `payHoursByEmail` (40h/week regular cap applied
chronologically), **not** the Hubstaff "Total worked" aggregate (which spans the whole uploaded
file, including an overlap day).

### Department pay weeks
- **HSL (Hogan):** Monday → Sunday.
- **All other departments:** **Sunday → Saturday**.

`payWeekFromUploadStart(uploadStart, isHsl)` returns the 7-day window; the window is anchored on
the current `calcSourceFile`'s start date.

### Canonical columns → true dates, then window
`hubstaff_hours` stores `monday`…`sunday` columns (+ `Total worked`), not per-date columns.
`payDaysByEmail` resolves them to **true ISO dates from the file range**
(`resolveCanonicalColumnsToIso`) and then clamps to the pay week — so a Mon→Sun or 8-day Sun→Sun
upload's **trailing Sunday is excluded** from a non-HSL Sun→Sat week instead of being relabeled
as the leading Sunday. (Same fix applied in `current-pay.ts`.)

### Cross-upload merge (boundary Sunday)
`payDaysByEmail` reads the **merged rows across all uploads** (`hubstaffRowsForPab`, each upload
resolved to true dates via its own filename), then windows. This recovers a pay week's leading
Sunday from the **adjacent upload** where that date is the trailing day.

See [hubstaff-sunday-overlap.md](../notes/hubstaff-sunday-overlap.md) for the underlying
last-wins collapse and the validated `ruthg@simple.biz` example (May 31–Jun 6 = ₱11,222.90).

---

## 5. Final-pay snapshot → Employee Dashboard + Payment Dispatch

Other surfaces don't know the wizard's accounting layer (KPI/dept, Adj., Orphanage, MESA
disbursement), so the wizard **publishes a per-employee snapshot** they read.

- `publishFinalPaySnapshot()` writes `app_settings` key `payroll.wizard.final_pay.<sourceFile>` =
  `{ source_file, fx_rate, finals: { [email]: WizardFinalPayEntry } }`, built from
  `dispatchData.rows`, keyed by **both** work and personal email (lowercased). The
  Regular/OT split + hours are included (not just `final`) so the dashboard's Regular + Overtime
  tiles reconcile exactly with the take-home.
- **The entry is fully itemized** (`WizardFinalPayEntry` in
  [`paystub-recovery.ts`](../../src/lib/payroll/paystub-recovery.ts), which extends the
  client-safe `WizardSnapshotEntry`): `perfectAttendanceBonus`, `techBonus`,
  `otherBonuses`, `adjustment`, `orphanagePay`, `mesaDeduction`, `mesaDisbursement`,
  `regularRate`, `otRate`, `adjustmentNote`, the HSL `weekend*` carve-out, the
  `proration` block and the `hoganSheet` legs. Consumers read these **verbatim** —
  re-deriving them from hours diverges on manual toggles and post-hoc config drift.
- **Published LIVE** — a 1.5s-debounced effect on `dispatchData` writes it as accounting edits, plus
  immediate writes on **Lock in additions** and **Confirm & Dispatch**.
- **Dashboard** ([EmployeeDashboard.tsx](../../src/components/employee/EmployeeDashboard.tsx)) —
  `fetchPayrollFinal` refetches on mount, window focus, and a 30s interval. When the viewer's
  email/alias is present, the hero take-home **and** the Regular/OT/Initial stats come from the
  snapshot (note: "Includes payroll-confirmed bonuses & adjustments"). **Fallback:** client-side
  auto-estimate (`INIT + PAB + Tech − MESA`) when no snapshot / All-time view.
- **Payment Dispatch** ([useDispatchQueue.ts](../../src/components/payroll-clerk/useDispatchQueue.ts)) —
  `loadAll` overlays each queue row's amount **and its whole itemization** from the wizard. Without
  this it shows `/api/payroll-current-pay`, which recomputes net pay WITHOUT the accounting layer.

  > **This snapshot is NOT the only carrier, and it does not always win (2026-08-11).**
  > `paystub_dispatch_queue` froze the same figures at lock time, and the precedence
  > between them is one shared rule —
  > [`wizard-dispatch-values.ts`](../../src/lib/payroll/wizard-dispatch-values.ts),
  > used by both the queue and the paystub freshness merge. The snapshot wins only
  > when it is **newer than `locked_at`**, itemized, catalog-consistent, matched on
  > the **work email**, and the row is not wizard-`excluded`; otherwise the LOCKED
  > values do. Full table + consequences:
  > [payment-dispatch.md §4.2.2](./payment-dispatch.md#422-which-figures-the-queue-actually-shows).
  >
  > Two things follow for this publisher. **A re-lock demotes an older snapshot** —
  > which is what makes "unlock and re-lock" authoritative over Payment Dispatch.
  > And because this publish is a `void`-fired 1.5s debounce that **returns early**
  > behind its own gates (`additionsHydratedFor`, both KPI markers, a per-cycle FX of
  > 0), a re-lock whose publish is held no longer strands the queue on pre-relock
  > figures — it falls back to the values that were just staged.

Reg + OT = the wizard's Initial; take-home = `final`. When the employee has no bonus/MESA/Orphanage/
Adj, Reg + OT equals take-home exactly; otherwise take-home is higher by those (separate lines).

## 6. MESA membership

The per-paycheck ₱100 MESA deduction is driven by `mesa_member` (boolean) on
`employee_hourly_rates` — read via `ratesByEmail`. There are multiple rate rows per employee
(one per upload); the flag must be consistent across them.

**Remove someone from MESA (clears the deduction on the next calc):**

```sql
update employee_hourly_rates
set mesa_member = false,
    updated_at  = now()
where lower("Work Email") in ('someone@simple.biz')
  and mesa_member is distinct from false;
```

This only flips the payroll flag; it does **not** write an opt-out record in the `mesa_requests`
table (the opt-in/opt-out/disbursement workflow). Handle that separately if needed.

## 7. Contractors step — Actions column gating

Step 5 (`Contractors`, id 6 before the 2026-08-28 merge) lists pending contractor
invoices to review before dispatch. Each row's
**Actions** column renders state-dependent buttons; the on-click handler is `updateInvoiceStatus`
(`PayrollWizard.tsx:9852`), which PATCHes `/api/contractor/invoices/{id}` with the new status.

The opposite button is **hidden once a decision is made** so a decided row only offers an undo:

| `inv.status` | Buttons shown |
| --- | --- |
| `pending` | **Approve** + **Reject** (both gated on `inv.status === 'pending'`) |
| `approved` | **Reset** only (Reject no longer lingers) |
| `rejected` | **Reset** only (Approve no longer lingers) |

**Reset** is gated on `inv.status !== 'pending'` and calls `updateInvoiceStatus(inv.id, 'pending')`,
returning the row to pending and restoring both Approve and Reject. No backend
approve/reject/reset logic changed — this is purely a render-time gate on the same three buttons.
