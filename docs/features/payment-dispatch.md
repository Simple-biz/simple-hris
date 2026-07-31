# Payment Dispatch

> **Goal**: A streamlined view that lets the payroll clerk (Lenny) see who's owed pay this cycle, send the money via the right processor, log each confirmation, and pause employee dispute filing while the run is in flight — all in real time across every dashboard.

This document covers the entire Payment Dispatch feature: the UI Lenny uses, the live "payroll being processed" lock employees see, the per-cycle dispatch log, and every supporting migration / API / hook.

> **Related:** non-weekly payouts that bypass this cycle (MESA disbursements + orphanage budget requests) live in the **URGENT** tab — see [urgent-payments.md](./urgent-payments.md).

---

## 1. Origin

Carla's meeting (see `MEETING-WITH-CARLA.MD`) defined the payroll-clerk role and the dispatch flow. Highlights:

- Lenny's job is to **send money**, not calculate it. She sees a streamlined view with **only name, email, and amount** per row, grouped by payment processor.
- After sending, she **manually logs**: arrival date (adjustable), transaction ID, bank used, date sent. No automation — that's the boss's preference.
- Once she clicks **Start processing**, employees should not be able to file disputes. The button gates the dispute UI live across all open employee dashboards.
- Each pay cycle should keep a memory of who was paid (per-cycle log of dispatches).

---

## 2. Where it lives

| Surface | Path | Audience |
|---|---|---|
| Embedded in Accounting view | `/accounting` → **Payment Dispatch** tab | Anyone with accounting access (RBAC gate is TODO) |
| Standalone page | `/payroll-clerk` | Reserved for when Lenny gets her own role + login |

Both views render the same content via **`PayrollDispatch.tsx`** (used inside Accounting) or the dedicated shell **`PayrollClerkApp.tsx`** (used at `/payroll-clerk`). The difference is just the surrounding chrome — the queue, history, and dispatch-lock logic are shared.

The Accounting sidebar entry is registered in `src/components/Sidebar.tsx` (`payment-dispatch` tab id, `Send` icon).

---

## 3. UI structure

### 3.1 Hero

- "Welcome back, **{firstName}** 👋" — `firstName` derived from NextAuth session (`session.user.name` → email local part → "there"), gradient text fill (orange → rose), animated wave emoji on mount.
- "Payment dispatch" title + subtitle.
- **Period pill** (top-right): `Apr 22 – 28, 2026` style label derived from the current Hubstaff upload's date columns. Hover shows source filename. Renders amber "No upload yet" when there's no current cycle.
- **Processing pill**: "Not processing" (zinc) by default. When `lockState.locked` is true: "Processing · disputes paused" with a pulsing rose dot.
- **Start / Stop processing** button (the lock toggle — see §6).

### 3.2 Hero stats

Three animated stat cards (`HeroStat` component, motion spring-counter via `AnimatedNumber`):

| Card | Source |
|---|---|
| **Pending** | `pending.length` (rows still owed) |
| **Sent** | `paid.length` (already-dispatched rows for this cycle) |
| **Volume** | `Σ amountUSD` of pending; sub-label adapts: `"X of Y priced"` while partial, `"all priced"` when complete, `"awaiting pay calc"` when zero |

### 3.3 Processor cards

A row of 8 filter cards (All + Hurupay + Wepay + HiGlobe + Wise + Jeeves + Wires + History). Each card uses `ProcessorCard.tsx` and has its own brand identity:

| Processor | Gradient | Notes |
|---|---|---|
| Hurupay | orange → amber | Most common in production data |
| Wepay | sky → blue | Email only |
| HiGlobe | emerald → teal | Email + account holder name |
| Wise | green → lime | Brand-matched green |
| Jeeves | pink → rose | Phone + wire details |
| Wires | zinc → zinc | Manual wire transfers (catches `x1xxx` suffix codes) |

Active card is highlighted via Framer Motion's **`layoutId`** glow that physically slides between cards on tab switch.

#### 3.3.1 Brand logo support

`ProcessorLogo.tsx` does a HEAD probe on `/processors/{id}.svg`. If the asset exists, it renders the brand SVG inside a white tile. Otherwise it falls back to a gradient monogram tile (or icon, for non-brand cards like All / History).

To add a real brand logo: drop the SVG into `public/processors/` named after the processor id (e.g. `wise.svg`). See `public/processors/README.md`.

### 3.4 The table

Inside `ProcessorQueue.tsx`. **All Pending** view has 6 columns (avatar, person, bank, current pay, hours, action). Per-processor views have 5 (no bank — already filtered).

Sticky column header on desktop (`hidden md:grid`); on mobile each row collapses into a stacked card layout (`md:hidden`).

#### Per-row content

| Column | Content |
|---|---|
| Avatar | Gradient initials circle (deterministic palette per row id) |
| Person | Name (bold), work email (mono), expand chevron |
| Bank Preferred | Pill with processor accent dot + label; `x1xxx` wire suffix surfaces in mono-amber if relevant |
| Current pay | USD on top (`$412.55`), PHP underneath (`₱24,140`), muted |
| Hours | Total hrs on top, OT hours underneath (amber when > 0) |
| Action | "Mark paid" gradient button (emerald → teal, fixed width for column alignment) |

Click the row to expand the processor-specific contact details (Hurupay email, Higlobe email + account name, phone, full address, city, province/state) with copy buttons on each.

#### Search

`SearchBar` with **debounced** input (`useDebouncedValue` hook, 250 ms). Searches name, email, row id, and bank-preferred raw value. Right side shows three bouncing motion-driven dots while typing, then settles to a result count when the debounce completes. Clear button (X) appears when there's a query.

Empty states:
- **Queue clear** — green sparkles tile, when the pending list is empty by itself
- **No matches** — zinc search-X tile + the literal query in a code chip + "Clear search" pill

#### Skeleton

`QueueSkeleton.tsx` mirrors the table structure exactly. Renders during `loading || !hydrated` (hydration flag prevents the one-frame flash where loading flips off but local state hasn't synced from the fetched server data yet). Sliding-gradient shimmer on each placeholder bar, motion-driven 1.6s loop, with row-stagger on entrance.

### 3.5 Mark Paid dialog

Modal organised into two field groups (`MarkPaidDialog.tsx`):

**Send details** (Lenny enters):

- **Transaction ID / details** — paste from processor *(required)*
- **Bank used (sent from)** — e.g. "BPI corporate", "Wise USD" *(required)*
- **Date sent** — date input, defaults to today *(required)*
- **Arrival date** — optional date input

**Recipient banking** (snapshotted to the dispatch row, pre-filled from rates):

- **Preferred bank** — readable bank name (e.g. "Hurupay", "BPI", "UnionBank")
- **Account holder** — name on the recipient's account
- **Account number / wallet ID** — for digital wallets this is usually the email; for wires it's the bank account number
- **SWIFT code** — only shown for the Wires processor

**Outcome:**

- **Status** — pill segmented control: `Paid` (default) · `Not Paid` · `Threshold` · `Problem`. Determines whether the row counts toward the hero "Paid" stat and whether the recipient stays in the pending queue:
  - `Paid` removes them (money moved).
  - `Problem` also removes them — a flagged person is held out of pending and lives in the **Problem** tab until someone clicks **Clear** there (which deletes the marker via `/api/payment-dispatches/undo` and returns them to pending). They stay in the Dispatch Progress denominator while flagged, so the strip can't read "everyone paid" with money still stuck.
  - `Not Paid` and `Threshold` leave the person available for retry in pending.
  - Exception: a **contractor invoice** logged `Problem` stays payable. `POST /api/payment-dispatches` only claims an invoice on `Paid`, and the marker row deliberately carries no `contractor_invoice_id`, so there's nothing to filter that invoice on.
- **Note** — optional free-text textarea for context (e.g. "bank rejected, retrying tomorrow"). Stored in `payment_dispatches.note`.

The confirm button label and color adapt to the chosen status (`Confirm sent` / `Log dispatch` with emerald / amber / rose / zinc background).

The pre-fills follow Carla's per-processor spec:

| Processor | Pre-filled values |
|---|---|
| Hurupay | bank=Hurupay · acct=hurupay_email · holder=name |
| Wepay | bank=Wepay · acct=work email · holder=name |
| HiGlobe | bank=HiGlobe · acct=higlobe_email · holder=higlobe_account_name |
| Wise | bank=Wise · acct=work email · holder=name |
| Jeeves | bank=Jeeves · acct=phone_number · holder=name |
| Wires | bank=raw "Bank Preferred" (e.g. "x1161") · acct=blank · holder=name · SWIFT input shown |

On confirm: POST to `/api/payment-dispatches` with all 4 send fields + 4 recipient banking fields, optimistic remove from queue, refresh on success, rollback on failure.

### 3.6 Sent payments history

`SentPaymentsHistory.tsx` — table of `payment_dispatches` rows for the current cycle. 7 columns (recipient, processor, USD, PHP, bank used, txn id, sent, arrival). On mobile: horizontal scroll (`overflow-x-auto` with `min-w-[760px]`).

### 3.7 Excluded & held tab (cross-cycle arrears)

`ExcludedQueue.tsx` — the **Excluded** processor-rail card. Holds everyone the queue can't (or shouldn't) pay this cycle, so they stay visible instead of silently disappearing. Each row carries one or more `ExclusionReason` chips (`src/components/payroll-clerk/mock-queue.ts`):

| Reason | Chip | Source |
|---|---|---|
| `no_bank` | "No bank preferred" (zinc) | no recognized processor / `Bank Preferred` |
| `no_pay` | "No current pay" (amber) | `computeCurrentPay()` returned no USD amount |
| `no_hours` | "No hours" (rose) | no hours on the Hubstaff row |
| `do_not_pay` | "Excluded in wizard" (violet) | Payroll Wizard's per-row **Exclude** tickbox (staged on `paystub_dispatch_queue.excluded`) |
| `no_rate` | "No rate on file" (sky) | wizard-staged person with no `employee_hourly_rates` row (catalog-paid safety net) |
| `claim_stuck` | "Stuck mid-dispatch" (fuchsia) | contractor invoice claimed by a Mark Paid that never recorded the payment (`dispatch_claimed_at` set, `dispatch_id` null) — investigate before paying out of band |
| `pending_approval` | "Awaiting approval" (teal) | contractor invoice still `pending` — filed but not yet approved by Accounting; becomes a payable queue row once approved in the wizard's Contractors step |

`useDispatchQueue.ts` reads `paystub_dispatch_queue` for the current `source_file`; any row flagged `excluded` is moved out of the pending queue into this tab (keyed by lowercased work email), carrying the last paystub `sent_at` for a "Paystub sent" badge.

**Cross-cycle arrears ledger.** A wizard-excluded person can be held across *multiple* cycles. `useDispatchQueue` overlays `GET /api/paystub-dispatch-queue/arrears` (see [paystub-dispatch.md](./paystub-dispatch.md)) so each row's amount = the **sum** of every unpaid held cycle, with a per-cycle breakdown. People owed from *prior* held cycles who aren't in this cycle's excluded set are still surfaced (so back-owed money never disappears), unless they're payable through the pending queue this cycle.

Header shows an **"Owed ₱X (US$Y)"** pill (sum across the filtered list) + a person/held-cycle count tooltip. A row with `arrears.cycles.length > 1` gets an expandable "**N weeks pending**" disclosure listing each cycle (label + ₱ + a rose "send failed" tag when `lastError` is set).

**Reconcile actions (`onMarkPaid`).** Only a `do_not_pay` row that's *otherwise* dispatchable (`row.payable` present) gets an action button — it opens the same `MarkPaidDialog` as the main queue:

- Single cycle → **"Pay now"**.
- Multiple held cycles → **"Settle ₱X"** — `handleConfirmPaid` in `PayrollDispatch.tsx` loops the unpaid cycles, POSTing `/api/payment-dispatches` once per cycle. It is **failure-tolerant**: each successful POST already moved money + emailed a paystub, so it records per-cycle outcomes (`paidCycles` / `failedCycles` / `sent` / `failedSend` / `notStaged`) and never aborts mid-loop. Failed cycles stay in arrears for a safe retry; the toast summarizes "`paidCycles`/`N` cycles settled". Owed-but-not-payable rows (no bank this cycle) show a muted "Can't pay here" tag instead.

**Filters.** A single-select **reason** rail and a single-select **bank** rail (emerald pills, one per processor present + a "No bank" / `other` pill), plus a 250 ms debounced search over name / email / bank label / raw `Bank Preferred`. Both rails reset pagination (`PAGE_SIZE = 25`).

### 3.8 Wizard dispatch lock — queue gating

The dispatch queue (pending **and** excluded) is gated on a **per-cycle** realtime flag set by the Payroll Wizard: `app_settings` key `payroll.dispatch_lock.<sourceFile>` (`{ locked, lockedAt, lockedBy }`, parsed by `parseLockedFlag` which tolerates legacy bool/blank). This is **distinct** from the global dispute lock in §6 (`payroll.dispatch_locked`, the Start/Stop processing button) — that one only pauses employee disputes; this one decides whether there is any queue data to show.

- `useDispatchQueue.loadAll()` derives `wizardReady` from the flag: **absent (never locked) reads as not-ready**; it is **fail-open only on a fetch error** so a network hiccup never blanks a genuinely-locked run.
- When `!wizardReady`, `loadAll` returns empty `rows`/`excluded`/`paid` and `PayrollDispatch.tsx` renders the `WizardNotReadyState` ("Payroll Wizard isn't ready yet" — prompts accounting to click **Lock in Values & Send to Payment Dispatch** in the wizard).
- `PayrollDispatch.tsx` subscribes via `useWizardDispatchLock(period.sourceFile)`; a lock/unlock flip calls `refresh()` so the queue appears/clears live.
- **Reports / Urgent / Orphanage tabs are NOT gated** — `renderBody()` short-circuits to those before the `!wizardReady` check, so they always render.

**Global Master List filter.** `computeCurrentPay()` returns `masterEmails` (every work/personal/alternate email in `active_employees`; `current-pay.ts:119,795`). `useDispatchQueue` filters both pending and excluded rows to that set (`inMaster`), removing stale / off-boarded / never-mastered rate rows. **Fail-open:** if the master set is missing (degraded payload) it doesn't filter, so the whole queue is never blanked.

### 3.9 USD tab — USD-paid people

People whose **effective Payment Catalog rate is non-PHP** are paid in their own currency, separately from the peso payroll. USD-denominated people (US-based teams, e.g. US Manager Bonus) get a **USD** card + tab; COP-denominated people (Colombian staff) get a **COP** card + tab. Conversion is **USD-anchored** (see [bonus-catalog.md](./bonus-catalog.md)): USD→PHP for PH staff, USD→COP for Colombian staff, USD→USD for US managers.

- **Currency origin.** `current-pay.ts` resolves each employee's effective rate (`empCat ?? sheet ?? deptCat`) and records its currency as `CurrentPayEntry.payCurrency` (`'USD'`/`'COP'` only when an individual/department structure in that currency drives the rate; sheet rates are always PHP). It also derives the native COP payout from the USD anchor — `totalPayCOP = round(totalPayUSD × usd_to_cop_rate)` — alongside `totalPayUSD = totalPayPHP / usd_to_php_rate`. `buildQueueFromRates` copies these onto `QueueRow.payCurrency` (default `'PHP'`) / `amountCOP`.
- **Carve-out, no double-pay.** `PayrollDispatch.tsx` splits `pending` into three **exclusive** buckets by exact `payCurrency`: `usdPending`, `copPending`, `phpPending`. The processor cards, their counts, `totalPending`, and the **All pending** tab all run off `phpPending`, so a non-PHP person appears in **exactly one** place — their currency tab. The COP card only renders when `copPending.length > 0`. All are marked paid through the same `MarkPaidDialog` → `POST /api/payment-dispatches` flow (the record carries `amount_usd` + `amount_php` + `amount_cop`, added by `add_cop_currency.sql`).
- **Display.** The USD/COP tabs reuse `ProcessorQueue` (`processor={null}`) with an `allLabel` override + a `nativeCurrency` prop (`"USD"` / `"COP"`) that drives the headline total; each row's primary figure follows its own `payCurrency` (`formatCOP` for COP). COP is whole-peso (`es-CO`, 0 decimals).
- **Gating.** The USD/COP tabs are queue data, so they sit **after** the `!wizardReady` guard in `renderBody()` (unlike Reports/Urgent/Orphanage).

---

## 4. Data layer

### 4.1 Schema additions

Two migrations (both idempotent, in `references/`):

#### `seed_payroll_dispatch_columns.sql` (migration #11)

Adds 8 quoted columns to `employee_hourly_rates` and seeds them from `references/NEW Payroll Dashboard - All Dept.csv` (1,062 rows after dedup + `#N/A` filter). Required so people show up in the dispatch view.

```sql
ALTER TABLE employee_hourly_rates
  ADD COLUMN IF NOT EXISTS "Bank Preferred"       TEXT,
  ADD COLUMN IF NOT EXISTS "Hurupay Email"        TEXT,
  ADD COLUMN IF NOT EXISTS "HiGlobe Email"        TEXT,
  ADD COLUMN IF NOT EXISTS "HiGlobe Account Name" TEXT,
  ADD COLUMN IF NOT EXISTS "Phone Number"         TEXT,
  ADD COLUMN IF NOT EXISTS "Full Address"         TEXT,
  ADD COLUMN IF NOT EXISTS "City"                 TEXT,
  ADD COLUMN IF NOT EXISTS "Province/State"       TEXT;
```

UPDATEs use `COALESCE(new, existing)` so re-running cannot null out curated values. Distinct values seen in `Bank Preferred`: `Hurupay`, `HiGlobe`, `Wise`, `Jeeves`, plus a few `x1153` / `x1161` (account-suffix codes — handled as wires).

Regenerate via `node scripts/gen-seed-payroll-dispatch.mjs`.

#### `seed_payment_dispatches.sql` (migration #12)

Three things, all idempotent:

1. **`public.payment_dispatches`** — per-cycle pay log

   ```sql
   CREATE TABLE IF NOT EXISTS public.payment_dispatches (
     id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     cycle_id                 UUID REFERENCES public.hubstaff_uploads(id) ON DELETE SET NULL,
     cycle_period_start       DATE,
     cycle_period_end         DATE,
     cycle_source_file        TEXT,
     recipient_email          TEXT NOT NULL,
     recipient_name           TEXT,
     processor                TEXT NOT NULL,
     bank_preferred_raw       TEXT,
     -- Recipient banking snapshot (where money went TO, distinct from bank_used)
     recipient_preferred_bank TEXT,
     recipient_account_number TEXT,
     recipient_account_holder TEXT,
     recipient_swift_code     TEXT,
     -- Outcome of the dispatch attempt + free-text context
     status                   TEXT NOT NULL DEFAULT 'paid'
                              CHECK (status IN ('paid', 'not_paid', 'threshold', 'problem')),
     note                     TEXT,
     amount_usd               NUMERIC(10,2),
     amount_php               NUMERIC(12,2),
     transaction_id           TEXT NOT NULL,
     bank_used                TEXT NOT NULL,
     sent_date                DATE NOT NULL,
     arrival_date             DATE,
     created_by               TEXT,
     created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```

   Indexes: `(cycle_id)`, `lower(recipient_email)`, `(cycle_id, lower(recipient_email))`. Email-normalization trigger attached if `normalize_email_column()` exists (from migration #5).

   The migration also runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` for the four `recipient_*` fields after the `CREATE`, so re-running picks up the schema even if the table existed from an earlier migration run.

2. **Three `app_settings` seed rows** for the lock:
   - `payroll.dispatch_locked` — `'false'` / `'true'`
   - `payroll.dispatch_locked_at` — ISO timestamp when last locked, blank otherwise
   - `payroll.dispatch_locked_by` — operator email when locked, blank otherwise

3. **Realtime publication membership** — adds `app_settings` to `supabase_realtime` so employee dashboards can subscribe to lock changes:

   ```sql
   ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
   ```

   Wrapped in a `DO $$ ... $$` block that checks before adding, so it's safe to re-run.

### 4.2 Pay calculator

`src/lib/payroll/current-pay.ts` exposes `computeCurrentPay()`, which produces the per-employee total Lenny needs to pay this cycle, including PAB and Tech bonuses when they apply:

1. Fetches the **current** Hubstaff upload (`is_current = true`) via `getCurrentHubstaffUploadId()` + `fetchHubstaffRowsOrdered()`.
2. Reads `employee_hourly_rates`.
3. Reads `app_settings.usd_to_php_rate` (falls back to `OFFICIAL_USD_TO_PHP_RATE`).
4. Reads **all** rows from `hubstaff_hours` (every upload, not just the current one) so PAB eligibility can see a full month of daily hours.
5. Reads minimal master columns from `active_employees` — `Name`, `Work Email`, `Personal Email`, `Start Date`, `Department` — for the 30-day Tech-bonus check and HSL identification.
6. Reads `app_settings.pab_period_overrides` so any wizard-saved manual PAB period for the active month is honored.
7. Computes per-employee:
   - `regularHours = max(0, totalHours − otHours)`
   - `otHours` (already on the Hubstaff row, capped at >40h)
   - `regularPayPHP = regularHours × regularRate`
   - `otPayPHP = otHours × otRate`
   - `initialPayPHP = regularPayPHP + otPayPHP`
   - **Bonuses** (see § 4.2.1 below)
   - `totalPayPHP = initialPayPHP + bonusTotalPHP`
   - `totalPayUSD = totalPayPHP / fxRate`
8. Resolves period via two paths:
   - ISO-date columns on `hubstaff.columns`, OR
   - `parseDateRangeFromFilename(row.source_file)` as a fallback when the schema only has canonical weekday columns (`monday`, `tuesday`, …).
9. Returns `{ period, fxRate, byEmail }` where each `byEmail` entry now carries `pabBonusPHP`, `techBonusPHP`, `bonusTotalPHP`, `totalPayPHP`, `totalPayUSD` in addition to the original `initialPay*` fields.

`QueueRow.amountUSD` / `amountPHP` (in `mock-queue.ts`) are wired to the **total** (regular + OT + bonuses) so the dispatch row shows the actual amount Lenny pays. The breakdown fields drive a small "+ ₱5,000 bonus" chip in `ProcessorQueue.tsx`.

#### 4.2.1 Bonus pipeline

Implemented in **`src/lib/payroll/dispatch-bonuses.ts`** as a server-side mirror of the gating logic that lives inside `PayrollWizard.tsx` (the wizard is **not** modified — these helpers re-derive the same rules so the dispatch view's totals match what the wizard would dispatch for the active week).

**Rules captured verbatim from the wizard:**

| Bonus | Amount | Per-week gate | Per-employee gate |
|---|---|---|---|
| **Perfect Attendance Bonus (PAB)** | ₱5,000 | `weekEnd ≥ pabPeriodEnd` (final paycheck of the PAB month) | **Standard rule:** every Mon–Fri in the PAB period ≥ 7 h. **HSL rule:** ≥ 5 of the 7 Mon–Sun days ≥ 7 h effective per week; Sat and Sun count independently; overnight shifts split across midnight combine via **forward** (D + D₊₁ ≥ 7 h → D qualifies) and **backward** (D₋₁ + D ≥ 7 h → D qualifies) checks — both days in a qualifying overnight pair earn a passing-day credit. Approved disputes forgive a day at ≥ 4 h effective hours. |
| **Tech Bonus** | ₱1,850 | `salaryDate ∈ [3rd-week-Monday, 4th-week-Monday)` of its month, where `salaryDate = periodStart + 8d`. Strict 3rd week only — equality, not ≥. Week 1 = the Mon–Sun week containing the 1st of the month, even if partial. | `weekStart ≥ master.start_date + 30d`. Subtle: checked against the period's start date, **not** the salary Tuesday — the wizard's docstring flags this. |
| **No-rates suppression** | — | — | When neither `regular_rate` nor `ot_rate` is set, every PHP-side bonus is forced to 0. Bonuses on no-rate paystubs would produce misleading totals. |

**PAB month resolution** (`pabMonthFromWeekStart`): the PAB period is the calendar month containing the Monday of the dispatch week. For a Sun-Sat Hubstaff filename like `..._2026-04-26_to_2026-05-02.csv`, the Monday is Apr 27 → PAB month = April 2026 → range is Apr 6 – May 1 (or whatever the saved override says).

**Critical schema detail** — `hubstaff_hours` rows store day data under canonical weekday column names (`monday`, `tuesday`, …) on most schemas, with the actual date encoded in the row's `source_file` filename. Before the eligibility merge, every row is passed through `resolveCanonicalColumnsToIso(row, row.source_file)` so the per-employee merged row has ISO-date columns the standard / HSL rules can read. Without this step, every employee's `hoursByDateKey` would come up empty and PAB would silently award zero people.

**What's deliberately NOT mirrored:**

- **Department-specific bonuses** (collections tiers, lead-gen formula). These depend on per-employee toggle state that lives only inside the wizard's React session — they aren't auto-derivable from Hubstaff. The dispatch view will undercount bonuses for employees whose pay includes a dept-specific addition until/unless the wizard persists a snapshot to a table.
- **OT suppression toggles** and **manual hour overrides**. The wizard's per-row UI surfaces those; the dispatch view trusts the raw Hubstaff numbers.

**Helpers exported from `dispatch-bonuses.ts`:**

| Export | Purpose |
|---|---|
| `PAB_BONUS_PHP` / `TECH_BONUS_PHP` | **Fallback** defaults (₱5,000 / ₱1,850). As of 2026-06-17 the live amounts + a per-department allowlist come from the Payment Catalog **System Bonuses** tab (`payment_catalog_system_bonuses`); `computeEmployeeBonus` takes `pabAmountPHP`/`techAmountPHP`/`pabDeptEligible`/`techDeptEligible` and the constants are only the fallback when no rows exist. See `docs/features/bonus-catalog.md` §6. |
| `pabMonthFromWeekStart(weekStart)` | `{ year, month }` — PAB month from any week's start date |
| `getHslAdjustedEnd(pabEnd)` | Extends end to closing Sunday for HSL Mon–Sun weeks |
| `isFinalPabWeek(weekEnd, pabPeriodEnd)` | Boolean — is this the paycheck that closes the PAB month? |
| `isTechBonusWeek(weekStart)` | Boolean — does the salary date (weekStart + 8d) fall in the **3rd full Mon–Sun week** of its month? Week 1 starts on the first Monday ≥ the 1st (partial pre-1st weeks excluded). Per Carla, places tech bonus 2 weeks out from PAB. |
| `hasThirtyDaysFromStart(weekStart, startDate)` | Boolean — 30-day service check, period-Monday-relative |
| `computePabEligibleEmails({ rows, pabRange, hslAdjustedEnd, hslEmails })` | `Set<email>` — runs the standard / HSL eligibility checks across a merged-by-email row set |
| `computeEmployeeBonus({ hasRates, isFinalPabWeek, isPabEligible, isTechBonusWeek, hasThirtyDays })` | `{ pabBonusPHP, techBonusPHP, totalPHP }` — combined gate with no-rates suppression |

**CSV export** — the per-processor "Export CSV" in `ProcessorQueue` includes four bonus-related columns (`Regular + OT (PHP)`, `PAB Bonus (PHP)`, `Tech Bonus (PHP)`, `Bonus Total (PHP)`) so the spreadsheet shows the same breakdown as the on-screen chip.

**On a non-bonus week:** zero visual change — `bonusTotalPHP === 0` for everyone, `amountUSD` equals what it was before, no chips render.

**On the final week of the PAB month:** every PAB-eligible employee shows `+ ₱5,000 bonus` and their total goes up by that amount. Eligibility is recomputed every page load by merging all uploaded Hubstaff rows for the period — if uploads are missing, eligibility correctly fails.

**On the salary-falls-in-3rd-week paycheck:** employees with ≥ 30 days of service and at least one of `regular_rate` / `ot_rate` show `+ ₱1,850 bonus`.

### 4.3 API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/payroll-current-pay` | GET | Returns the `CurrentPayResult` from `computeCurrentPay()` |
| `/api/payment-dispatches` | GET | Lists dispatches, optionally filtered by `?cycle_id=` |
| `/api/payment-dispatches` | POST | Inserts a new dispatch row + writes audit-log entry `payment.dispatched`. When `status='paid'` and the Payroll Wizard staged a paystub for this `(cycle_source_file, recipient_email)`, also fires that **one** person's paystub email via `forwardPaystubDispatch` (best-effort — never fails the payment) and returns `{ paystub: { staged, sent, error } }` so the client can toast sent / failed / not-staged. Gated by `requireFeatureEdit('accounting', 'payment_dispatch')`. See [paystub-dispatch.md](./paystub-dispatch.md). |
| `/api/payroll-dispatch-lock` | GET | Returns `{ locked, lockedAt, lockedBy }` |
| `/api/payroll-dispatch-lock` | POST | Toggles the lock — body: `{ locked: boolean }` — writes audit-log entry `payroll.dispatch.locked` / `payroll.dispatch.unlocked` with snapshotted operator + timestamp |
| `/api/employee-hourly-rates` | GET | Existing route, now also returns the 8 new payment-dispatch fields |

### 4.4 Audit log entries

Both lock toggles and dispatch records write `audit_log` rows. Lock-toggle details snapshot `started_by` + `started_at` so the row is self-contained:

```json
{
  "user_name": "carla@simple.biz",
  "user_role": "payroll_clerk",
  "action": "payroll.dispatch.locked",
  "resource": "app_settings",
  "resource_id": "payroll.dispatch_locked",
  "details": {
    "locked": true,
    "started_by": "carla@simple.biz",
    "started_at": "2026-04-27T12:34:56.789Z"
  }
}
```

Dispatch records:

```json
{
  "user_name": "lenny@simple.biz",
  "user_role": "payroll_clerk",
  "action": "payment.dispatched",
  "resource": "payment_dispatches",
  "resource_id": "<uuid>",
  "details": {
    "recipient_email": "anna.reyes@example.com",
    "processor": "wepay",
    "amount_usd": 412.55,
    "cycle_id": "<uuid>"
  }
}
```

Visible at `/admin` → Audit log.

---

## 5. Hooks

### 5.1 `useDispatchQueue()`

Located at `src/components/payroll-clerk/useDispatchQueue.ts`. Joins three sources:

1. `/api/employee-hourly-rates` — eligibility list + bank-preferred + contact fields
2. `/api/payroll-current-pay` — per-person USD/PHP pay + cycle period
3. `/api/payment-dispatches?cycle_id=<id>` — already-paid for the current cycle

Builds a `QueueRow[]` via `buildQueueFromRates()` from `mock-queue.ts` (filename historical — it's no longer mocks). Filters out anyone whose email already has a dispatch record in the current cycle, so the same person can't be paid twice.

Returns `{ rows, paid, period, fxRate, loading, error, refresh }`. The `refresh()` callback re-pulls everything; called after Mark paid succeeds.

### 5.2 `useDispatchLock()`

Located at `src/hooks/useDispatchLock.ts`. The single source of truth for the live "payroll is being processed" flag.

**Wiring:**

- **REST hydration** on mount: `GET /api/payroll-dispatch-lock` so the UI is correct before Realtime attaches.
- **Realtime subscription**: `postgres_changes` on `app_settings` filtered by `key=eq.payroll.dispatch_locked`. Channel names include a `useId()` suffix so concurrent subscriptions don't collide.
- **30-second backup poll**: belt-and-braces refetch in case Realtime is silently broken (publication missing, RLS blocking anon SELECT). Banner cannot be stuck for more than ~30s.
- **Focus / visibilitychange refetch**: refreshes whenever the tab regains focus.
- **Subscribe-status logging**: emits `[dispatch-lock] Realtime ready` to the console on SUBSCRIBED, or `Realtime CHANNEL_ERROR. Falling back to 30s poll.` on errors. Useful for diagnosing missing-publication issues.

**Returns `{ state, loading, setLocked }`** where `setLocked(boolean)` does optimistic update + POST + rollback on failure.

### 5.3 `useDebouncedValue()`

Generic 250ms debounce hook used by the search bar.

### 5.4 `AnimatedNumber`

Spring-tweened `<motion.span>` for the counters in hero stats and processor cards.

---

## 6. The dispatch lock — end-to-end flow

The mechanism that pauses employee disputes while Lenny is processing. This is the most important plumbing in the feature.

```
┌─────────────────────────┐                         ┌────────────────────────────┐
│  Lenny's Payment        │   1. Click Start ─────► │  POST /api/payroll-        │
│  Dispatch view          │                         │       dispatch-lock         │
│  (PayrollDispatch.tsx)  │                         │  body: { locked: true }    │
└─────────────────────────┘                         └────────────────────────────┘
                                                                  │
                                                                  │ upserts 3 keys
                                                                  ▼
                                         ┌──────────────────────────────────────┐
                                         │  app_settings rows updated:          │
                                         │  - payroll.dispatch_locked  = 'true' │
                                         │  - payroll.dispatch_locked_at = now  │
                                         │  - payroll.dispatch_locked_by = email│
                                         │  + audit_log INSERT                  │
                                         └──────────────────────────────────────┘
                                                                  │
                                          Postgres logical decoding emits UPDATE
                                                                  ▼
                                         ┌──────────────────────────────────────┐
                                         │  Supabase Realtime broadcasts        │
                                         │  postgres_changes event on           │
                                         │  filter: key=eq.payroll.dispatch_    │
                                         │  locked                              │
                                         └──────────────────────────────────────┘
                                                                  │
                                                                  ▼
   ┌─────────────────────────────────────────┐  ┌──────────────────────────────────┐
   │  EmployeeApp.tsx                        │  │  PayrollDispatch.tsx             │
   │  useDispatchLock fires onChange         │  │  useDispatchLock fires onChange  │
   │  → re-fetches lock state                │  │  → re-fetches lock state         │
   │                                         │  │  → ProcessingPill switches red   │
   │  Renders:                               │  │  → Toggle button crossfades      │
   │  • PayrollLockBanner (slides down)      │  └──────────────────────────────────┘
   │  • Sidebar "Paused" pill                │
   │  • One-time toast notification          │
   │                                         │
   │  Passes lockState.locked to:            │
   │  • MyDisputes (disables Submit, banner) │
   └─────────────────────────────────────────┘
```

### 6.1 Lenny's view (Payment Dispatch)

`PayrollDispatch.tsx` renders:

- **`ProcessingToggleButton`** — Start / Stop button. Crossfades icon + label between states using `AnimatePresence mode="popLayout"` (no hard swap). Spring hover lift + tap squish.
- **`ProcessingPill`** — "Not processing" (zinc) or "Processing · disputes paused" (rose, with animated ping dot).
- **`LockToggleConfirmDialog`** — confirmation modal with proper loading state. While the POST is in flight: button shows `Loader2` spinner, label says "Starting…" / "Stopping…", buttons disabled, dialog refuses to close on outside-click or Esc. Closes after success so the exit animation overlaps with the parent state change.
- **`togglingLock` flag** in component state guards against rapid clicks.

### 6.2 Employee view

#### `EmployeeApp.tsx` (shell)

- Mounts the **single** `useDispatchLock` for the employee tree.
- Tracks previous lock state via `useRef` to detect transitions and emit toasts only on change (not on initial mount).
- Renders `PayrollLockBanner` above the main content area.
- Passes `payrollLocked` to `EmployeeSidebar` and `MyDisputes` via prop.

#### `PayrollLockBanner.tsx`

A sticky banner at the top of the shell. Smooth `AnimatePresence` enter/exit (height + opacity + Y slide, easing `[0.16, 1, 0.3, 1]`, 320 ms). Components:

- Pulsing ring around a lock icon (motion `scale 1 → 1.5` with `opacity 0.6 → 0`, infinite loop)
- Title: "Payroll is being processed"
- Sub-line: "Started by Carla · 12 mins ago" (operator name parsed from email; `setInterval` ticks every 60 s for live relative time)
- Bottom-edge shimmer bar (motion `scaleX 0.2 → 1 → 0.2`, infinite, easeInOut, 2.8 s) — ambient activity feel
- Dismiss `X` button — collapses the banner locally for that user. Other notification layers (sidebar pill, inline form banner) still surface the state.

#### `EmployeeSidebar.tsx`

Spring-pop "Paused" pill on the **My Disputes** nav item when locked. Uses motion `initial={ scale: 0.6 }` → `animate={ scale: 1 }` with `type: 'spring', stiffness: 320, damping: 20`.

Plus the existing footer notice that's been in place since the lock landed.

#### `MyDisputes.tsx`

- Receives `payrollLocked` prop from the shell (no longer subscribes to its own `useDispatchLock` — single source of truth).
- Inline rose banner above the form, wrapped in `AnimatePresence` so it smoothly animates out when the lock flips off (height collapse + opacity fade + Y slide).
- Submit button: `disabled={…|| dispatchLocked}`, label changes from "Submit" → "Locked" with a `Lock` icon swap.
- `handleSubmit` short-circuits with a toast if the user somehow bypasses the disabled state.

#### Transition toasts

In `EmployeeApp.tsx`:

```
if (previous != null && previous !== current) {
  if (current) toast.error('Payroll processing started', { … });
  else toast.success('Payroll processing finished', { … });
}
```

Uses Sonner with custom rose / emerald icons. 6 s duration on lock, 5 s on unlock.

### 6.3 KPI Calculator & QC lockout

Since 2026-07-14 the same global lock also takes the score-entry dashboards fully offline — once processing starts, the numbers being paid must not move.

**Client (full takeover, not just disabled buttons):**

- **Manager dashboard → KPI Calculator tab** (`ManagerApp.tsx`, tab `hsl-bonus`): when `useDispatchLock().state.locked`, the tab renders `PayrollProcessingLock` (`src/components/payroll/PayrollProcessingLock.tsx`) instead of the HSL / Departments calculators.
- **QC dashboard** (`QCApp.tsx`): Overview and QC Calculator tabs render the same takeover; only Notifications stays usable.
- Both react live via the existing `useDispatchLock` Realtime + 30 s poll plumbing, so open dashboards flip the moment Start/Stop processing is clicked.
- `HslBonusCalculator`'s older inline `payrollLocked` handling (disabled mark-ready buttons) remains as defense in depth beneath the takeover.

**Server (authoritative):** `rejectWhilePayrollProcessing()` (`src/lib/payroll/processing-guard.ts`) returns **423 Locked** from every KPI/QC mutation while `payroll.dispatch_locked` is `'true'` — same pattern as the bank-details guard. Guarded handlers (GETs stay open; the Payroll Wizard reads them):

| Route | Methods |
|---|---|
| `/api/qc/submissions` | POST |
| `/api/qc/lock` | POST |
| `/api/qc/review` | POST |
| `/api/hsl-bonus/entries` | POST, DELETE |
| `/api/hsl-bonus/period-status` | POST |
| `/api/bonus-catalog-applied` | POST, DELETE |

---

## 6.5 Weekly Disbursement Reports

> Added 2026-04-28. The Reports tab gives Lenny (and accounting) a per-week rollup of every Hubstaff pull — who got paid, who's pending, how much went out, and how the spend split across processors.

### 6.5.1 Why it exists

Once dispatches accumulate across cycles, scrolling the History tab to answer "how much did we send out the week of April 12?" is unworkable. The Reports tab folds every Hubstaff CSV into one card per week with paid / pending / sent counts and totals, plus a click-through detail view.

User direction during the build (chronological, condensed):

- "We need a weekly report on who got paid, how much was pending, how much was sent, how much was paid. Tied to the hubstaff pulls."
- "Format the cycle name as `April 12-18, 2026`."
- "Get the date range from the filename — `simple-biz_daily_report_2026-04-05_to_2026-04-12.csv` already has it. No need to scan the DB."
- "Drop the trailing `Disbursement Report` from the title."
- "6 reports per page only."
- "Add it to the standalone `/payroll-clerk` sidebar too — I'm not using the Accounting embed."
- "Write a SQL query to seed all CSV files into a flat table called `disbursement_records`."
- "Make all of them paid so I can see what the screen looks like with data."
- "Show values broken down per pay processor."
- "Add decimals on the report."

### 6.5.2 Data model — `public.disbursement_records`

A flat table where **one row = one (Hubstaff cycle, employee) pair**. This is the source of truth for the Reports tab — no more re-aggregating across `hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches` on every render.

| Column | Type | Source |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `cycle_period_start` | DATE | Parsed from `source_file` regex `(\d{4}-\d{2}-\d{2})_to_` |
| `cycle_period_end` | DATE | Parsed from `source_file` regex `_to_(\d{4}-\d{2}-\d{2})` |
| `source_file` | TEXT | `hubstaff_hours.source_file` |
| `upload_id` | UUID FK | `hubstaff_hours.upload_id` → `hubstaff_uploads.id` |
| `recipient_email` | TEXT | `hubstaff_hours."Email"` (lower-cased) |
| `recipient_name` | TEXT | `hubstaff_hours."Member"` |
| `total_hours` | NUMERIC(7,2) | Parsed from `"Total worked"` HH:MM:SS into decimal hours |
| `regular_hours` | NUMERIC(7,2) | `LEAST(40, total_hours)` |
| `ot_hours` | NUMERIC(7,2) | `GREATEST(0, total_hours - 40)` |
| `regular_rate_php` | NUMERIC(10,2) | `employee_hourly_rates."Regular Rate"` |
| `ot_rate_php` | NUMERIC(10,2) | `employee_hourly_rates."OT Rate"` |
| `amount_php` | NUMERIC(12,2) | `regular_hours * regular_rate_php + ot_hours * ot_rate_php` |
| `amount_usd` | NUMERIC(10,2) | `amount_php / fx_rate` |
| `fx_rate` | NUMERIC(10,4) | `app_settings.usd_to_php_rate` at seed time |
| `status` | TEXT | `'pending'` default; updated to `'paid' \| 'not_paid' \| 'threshold' \| 'problem'` by trigger |
| `paid_amount_usd` | NUMERIC(10,2) | Mirrored from `payment_dispatches.amount_usd` when status='paid' |
| `paid_at` | DATE | Mirrored from `payment_dispatches.sent_date` when status='paid' |
| `bank_used` | TEXT | Mirrored from `payment_dispatches.bank_used` |
| `transaction_id` | TEXT | Mirrored from `payment_dispatches.transaction_id` |
| `dispatch_id` | UUID FK | `payment_dispatches.id` (latest dispatch for this row) |
| `created_at` | TIMESTAMPTZ | DEFAULT now() |
| `updated_at` | TIMESTAMPTZ | DEFAULT now(); touched by `disbursement_records_set_updated_at` trigger |

**Constraints**
- `UNIQUE(source_file, recipient_email)` — enables idempotent re-seeds via `ON CONFLICT … DO UPDATE`
- CHECK on `status IN ('pending','paid','not_paid','threshold','problem')`

**Indexes**
- `idx_disbursement_records_period` on `(cycle_period_start, cycle_period_end)`
- `idx_disbursement_records_recipient` on `LOWER(recipient_email)`
- `idx_disbursement_records_status` on `status`
- `idx_disbursement_records_source_file` on `source_file`
- `idx_disbursement_records_upload` on `upload_id`

**Triggers**
- `disbursement_records_norm_email` — reuses project-wide `normalize_email_column()` so `recipient_email` is always lower-cased.
- `disbursement_records_set_updated_at` — bumps `updated_at` on every UPDATE (re-seeds, sync trigger writes, etc.).
- `payment_dispatches_sync_disbursement` (on `payment_dispatches`) — write-through: any INSERT or UPDATE on `payment_dispatches` updates the matching `disbursement_records` row's `status / paid_amount_usd / paid_at / bank_used / transaction_id / dispatch_id`. Match key: `(cycle_source_file, LOWER(recipient_email))`.
- `payment_dispatches_unsync_disbursement` (on `payment_dispatches`) — DELETE reverts the disbursement record to `status='pending'`.

### 6.5.3 Migrations (run in order)

| Order | File | What it does |
|---|---|---|
| 1 | `references/seed_disbursement_records.sql` | CREATE TABLE + indexes + email-norm trigger + updated_at trigger; backfills via `INSERT … SELECT` joining `hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches` × `app_settings.usd_to_php_rate`. Idempotent (`ON CONFLICT (source_file, recipient_email) DO UPDATE`). |
| 2 | `references/seed_disbursement_records_sync.sql` | Adds the four sync triggers above; one-time UPDATE backfill from any existing `payment_dispatches`. Idempotent. |

Both are wrapped in `BEGIN/COMMIT` and use `IF NOT EXISTS` / `OR REPLACE`. Run in Supabase SQL Editor. After they execute, re-running the seed any time you ingest a new Hubstaff CSV refreshes the rows in place.

#### Sample rollup queries

```sql
-- Per-cycle summary
SELECT
  cycle_period_start,
  cycle_period_end,
  COUNT(*) AS recipients,
  COUNT(*) FILTER (WHERE status = 'paid')  AS paid_count,
  COUNT(*) FILTER (WHERE status <> 'paid') AS pending_count,
  ROUND(SUM(amount_usd) FILTER (WHERE status = 'paid')::numeric, 2)  AS paid_usd,
  ROUND(SUM(amount_usd) FILTER (WHERE status <> 'paid')::numeric, 2) AS pending_usd
FROM public.disbursement_records
GROUP BY cycle_period_start, cycle_period_end
ORDER BY cycle_period_start DESC;

-- Mass mark-as-paid (used during initial demo population)
UPDATE public.disbursement_records
SET status = 'paid',
    paid_amount_usd = amount_usd,
    paid_at = cycle_period_end,
    bank_used = COALESCE(bank_used, 'BACKFILL'),
    transaction_id = COALESCE(transaction_id, 'BACKFILL-' || LEFT(id::text, 8)),
    updated_at = now()
WHERE status <> 'paid';
```

### 6.5.4 API endpoints

#### `GET /api/payment-dispatches/reports`

Returns one summary per cycle, newest period first.

**Response shape** (`reports[]`):

```ts
{
  cycleId: string;             // hubstaff_uploads.id, or `source:<file>` synthetic id
  periodStart: string | null;  // ISO YYYY-MM-DD
  periodEnd:   string | null;  // ISO YYYY-MM-DD
  sourceFile: string | null;
  uploadedAt: string;          // ISO timestamp from hubstaff_uploads
  uploadedBy: string | null;
  rowCount:   number | null;
  isCurrent:  boolean;         // hubstaff_uploads.is_current
  reportName: string;          // e.g. "April 12-18, 2026"
  totals: {
    paidCount; paidUSD; paidPHP;
    notPaidCount; thresholdCount; problemCount;
    pendingDispatchedUSD;     // sum of amount_usd where status NOT IN ('paid','pending')
    sentCount;                 // any non-pending status
    totalDispatchedUSD;
    outstandingCount;          // status='pending'
    outstandingUSD;
    totalRecipients;
    totalOwedUSD;
  };
  byProcessor: Record<ProcessorId, { count: number; usd: number; php: number }>;
}
```

Implementation: `listDisbursementReports()` in `src/lib/payroll/disbursement-reports.ts`.

#### `GET /api/payment-dispatches/reports/[cycleId]`

Returns a single report's full detail. `cycleId` accepts either a `hubstaff_uploads.id` UUID or the `source:<filename>` synthetic id from the list endpoint.

**Response shape**:

```ts
{
  ...ReportSummary,
  dispatches: PaymentDispatchRow[];   // from payment_dispatches WHERE cycle_source_file=…
  outstanding: Array<{
    email: string;
    amountUSD: number | null;
    amountPHP: number | null;
  }>;                                  // from disbursement_records WHERE status='pending'
  outstandingUSD: number;
}
```

Notes:
- `outstanding` is now populated for **any cycle**, not just current. Previously the old code could only compute it for the active cycle (because it ran `computeCurrentPay()`); the new flow reads pre-computed pay from `disbursement_records` so historical cycles work too.
- `dispatches` still comes from `payment_dispatches` so the table can show processor + banking detail. The flat record table doesn't store processor on each row by design (processor is a property of the employee, not the cycle).

Implementation: `getDisbursementReportDetail()` in `src/lib/payroll/disbursement-reports.ts`.

### 6.5.5 Library — `src/lib/payroll/disbursement-reports.ts`

Single library powering both endpoints. Key functions:

| Function | Role |
|---|---|
| `listDisbursementReports()` | Loads all `disbursement_records` (paged), all `hubstaff_uploads`, and a `Bank Preferred → processor` map from `employee_hourly_rates`. Groups records by `source_file`, tallies totals, derives byProcessor inline. |
| `getDisbursementReportDetail(cycleId)` | Calls `listDisbursementReports()` for the summary, then queries `payment_dispatches` (for dispatch detail) and `disbursement_records WHERE status='pending'` (for outstanding) in parallel. |
| `formatDisbursementReportName(start, end, fallback)` | "April 12-18, 2026" same-month, "April 30 - May 3, 2026" cross-month, "December 30, 2025 - January 5, 2026" cross-year. Returns `fallback` (typically the source filename minus `.csv`) when dates are missing. |
| `tallyRecord(totals, record)` | Internal — increments the right counters based on `record.status`. Pending rows go to `outstandingCount/USD`; paid rows go to paid + sent + total dispatched. |
| `loadProcessorByEmail()` | Builds `Map<email, processorId>` from `employee_hourly_rates."Bank Preferred"` using the canonical `processorIdFromBankPreferred()` matcher (Hurupay/Wepay/HiGlobe/Wise/Jeeves; `xNNNN` → Wires). Used to attribute paid records when the source data was set via direct UPDATE rather than Mark Paid (which would have left a `payment_dispatches` row). |
| `seedMissingDisbursementRecords()` | Generates `disbursement_records` for any `hubstaff_uploads` that have none yet. Computes pay with the **wizard's authoritative calculator** (`computeProratedRowPay` from `current-pay.ts`): Payment Catalog overlay (individual → sheet → department base), per-day `employee_rate_history` prorating, 40h/week cap applied chronologically, HSL weekend premium, FX via `effectiveUsdToPhpRateFromStored`. Pay-week windowed per department (`payWeekFromUploadStart`) so an 8-day Sun→Sun upload counts one 7-day week. Bonuses/MESA are excluded — those arrive via the real `payment_dispatches` sync into `paid_amount_usd`. |

#### Period resolution chain

When `disbursement_records.cycle_period_start/end` are present (the normal case after seeding) they're used directly. The chain order in code is:

1. **`disbursement_records.cycle_period_start/end`** — already DATE-typed, the canonical source.
2. **Filename parser** (`parseDateRangeFromFilename` from `src/lib/hubstaff/calendar-column-dedupe.ts`) — sanity backup if the row is malformed. Regex: `(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})`.

Older code paths also walked dispatch snapshots → `computeCurrentPay()` → ISO-date column scan; those are no longer needed because the seed pre-resolves dates per-row.

#### byProcessor derivation

Every `paid` record looks up the recipient's `Bank Preferred` from `employee_hourly_rates` and buckets the row by processor id. Per-processor `count + usd` is accumulated in the same loop as `tallyRecord`, so there's no extra DB pass. This is what makes the breakdown work even when `payment_dispatches` is empty (e.g. backfilled-paid demo data).

Edge cases:
- Recipients with no rate row → bucketed under `'unknown'` (not displayed by the current UI, which iterates over canonical PROCESSORS).
- Recipients whose `Bank Preferred` doesn't match any known processor (e.g. blank, or a brand-new processor name not in the map) → also `'unknown'`.

### 6.5.6 UI — `src/components/payroll-clerk/DispatchReports.tsx`

Single component handling both list and detail. Top-level state machine:

```
              ┌───── selectedLoading ──────┐
hovered card  ▼                            ▼
─click──► ReportDetailView (loading) ─► ReportDetail
             │
             ▼ error
          Detail error UI ─Back─► ReportListView
```

Switches to detail view via `setSelected*` triplet (`selected`, `selectedLoading`, `selectedError`). Back button clears all three.

**List view** (`PaginatedReportGrid`):
- 6 cards per page (`REPORTS_PER_PAGE = 6`); resets to page 0 on data reload.
- Pagination footer: `Showing X-Y of Z` + Prev/Next + numbered buttons. Active page button uses orange→rose gradient.
- Each card (`ReportCard`) shows period label, uploaded-at timestamp, source filename, mini-stats (Paid / Sent / Pending counts), and a bottom-bar "Total paid out" in USD.
- The current cycle gets an animated orange "Current" pill in the top-right.

**Detail view** (`ReportDetail`):
- Header: report name, period range, uploaded timestamp, source filename, optional "Current cycle" pill.
- 4 hero `DetailStat` cards (Paid / Sent / Pending / Total Paid). Total Paid uses 2-decimal formatting (`minimumFractionDigits: 2, maximumFractionDigits: 2`) — earlier code used `Math.round` which the user asked to fix.
- **Paid by processor** card: 6-up grid of canonical processor tiles. Each shows the paid count (large, left) plus a stacked amount on the right — USD prominent (`text-sm`) over PHP smaller/muted (`text-[10px]`). Empty processors get a muted style; non-empty ones get the orange→rose tint. `byProcessor` carries `{ count, usd, php }`; `php` is summed from each paid record's `amount_php`.
- **Not yet dispatched** card (only renders when outstanding > 0): scrollable email/USD list capped at 50 rows with `+ N more` overflow indicator.
- **Dispatch detail** table: full per-row dispatches sorted with paid first, then by `sent_date` desc. Columns: Recipient, Status, Processor, USD, PHP, Bank used, Txn ID, Sent.

Helper components inside the file:
- `StatusBadge` — pill with icon + color per `'paid' | 'not_paid' | 'threshold' | 'problem'`.
- `MiniStat` — small inline stat (used inside ReportCard).
- `DetailStat` — large hero stat with gradient background (used in ReportDetail header).
- `ReportListSkeleton` — animate-pulse loading skeleton.

### 6.5.7 Where the Reports tab appears

Two surfaces, both pointing at the same `DispatchReports` component:

| Surface | File | How |
|---|---|---|
| **Embedded in Accounting** (`/accounting`) | `src/components/payroll-clerk/PayrollDispatch.tsx` | New `'reports'` tab id, `REPORTS_VISUAL` (violet→fuchsia gradient, ClipboardList icon), card in the in-page processor-filter rail. AnimatePresence key short-circuits to `'reports'` so queue-state flips don't re-mount the report fetch. |
| **Standalone** (`/payroll-clerk`) | `src/components/payroll-clerk/PayrollClerkApp.tsx` + `PayrollClerkSidebar.tsx` | `'reports'` entry in the sidebar's "History" group with a ClipboardList icon. `renderContent()` short-circuits when `activeTab === 'reports'` so it doesn't gate on `cycleReady` or queue load state. |

The `count` prop on `ProcessorCard` is now optional — the Reports nav card hides the badge entirely instead of showing a meaningless "0".

### 6.5.8 Dataflow end-to-end

```
1. Hubstaff CSV upload  ─►  hubstaff_uploads (new row, is_current=true)
                       ─►  hubstaff_hours (rows tagged with upload_id)

2. Run seed_disbursement_records.sql  ─►  disbursement_records
                                          (one row per (week, employee))

3. Lenny clicks Mark Paid  ─►  POST /api/payment-dispatches
                            ─►  INSERT into payment_dispatches
                            ─►  Trigger: payment_dispatches_sync_disbursement
                            ─►  UPDATE disbursement_records SET status='paid', …

4. Reports tab opens  ─►  GET /api/payment-dispatches/reports
                       ─►  listDisbursementReports()
                            ├─ SELECT * FROM disbursement_records  (paged)
                            ├─ listHubstaffUploads()  (for uploadedAt / isCurrent)
                            └─ SELECT email + Bank Preferred FROM employee_hourly_rates
                       ─►  group by source_file, tally byProcessor, format names

5. Click a card  ─►  GET /api/payment-dispatches/reports/[cycleId]
                  ─►  getDisbursementReportDetail(cycleId)
                       ├─ summary from listDisbursementReports()
                       ├─ SELECT * FROM payment_dispatches WHERE cycle_source_file=…
                       └─ SELECT … FROM disbursement_records WHERE status='pending'
```

### 6.5.9 Decisions taken (and why)

- **Filename-based period parsing over column scan.** The Hubstaff export has the dates baked into its name (`simple-biz_daily_report_YYYY-MM-DD_to_YYYY-MM-DD.csv`); parsing is exact and free. The previous code path scanned `hubstaff_hours` columns for ISO-shaped names — fragile because the table uses canonical `monday/tuesday/…` columns in production.
- **Flat `disbursement_records` over per-render aggregation.** The first pass of the Reports endpoint joined `hubstaff_uploads × payment_dispatches` plus `computeCurrentPay()` on every request. With 7 cycles × ~700 employees, this was already slow; with a year of pulls it would be much worse. The flat table makes reports a single grouped scan.
- **byProcessor from `Bank Preferred`, not `payment_dispatches.processor`.** Backfilled / direct-update rows have no `payment_dispatches` row. Sourcing processor from the employee's `Bank Preferred` works in both cases (real Mark Paid flow and direct UPDATE). It's also more accurate when an employee's preferred processor changes between cycles — though that's rare enough that we don't track historical processor on the record.
- **Synthetic `source:<file>` cycle ids.** When `disbursement_records` exists for a cycle but `hubstaff_uploads` doesn't (legacy / weird state), the API still returns a usable `cycleId` so the detail route works. Frontend doesn't care which form it gets.
- **Don't store processor or paid_php on `disbursement_records`.** Two reasons: (1) processor is a property of the employee in `employee_hourly_rates`, not the cycle — duplicating it is denormalization with no win; (2) `paid_php` would just be a derived quantity (`paid_amount_usd × fx_rate` or the snapshot `amount_php`); UI uses `amount_php` for the Total Paid PHP sub-label.
- **Page size 6.** User-requested. The grid is 1 / 2 / 3 columns at sm/lg/xl, so 6 is exactly two rows on the widest layout.

### 6.5.10 Open follow-ups (Reports-specific)

- **Auto-seed on Hubstaff upload.** Right now `seed_disbursement_records.sql` is run manually after each new CSV. Extending `replaceHubstaffHoursFromCsvText` (in `src/lib/supabase/hubstaff-hours-db.ts`) to insert the new cycle's rows after CSV ingestion succeeds would close the loop.
- **Snapshot processor at paid time.** If processor mappings ever change historically, current-month accuracy is fine but year-over-year reports could drift. A future column `paid_processor TEXT` filled by the sync trigger when status='paid' would freeze the attribution.
- **Per-cycle PDF export.** Lenny mentioned wanting to email reports to Carla. A `?format=pdf` mode on the detail endpoint (or a `react-pdf` render of `ReportDetail`) would do it.
- **RBAC on the reports.** Same gap as the rest of Payment Dispatch — anyone with accounting access can see all reports. When the `payroll_clerk` role lands, lock both endpoints to it + admin.

---

## 7. Files

### New components

```
src/components/payroll-clerk/
  PayrollDispatch.tsx           — embedded in /accounting (main view)
  PayrollClerkApp.tsx           — standalone /payroll-clerk shell
  PayrollClerkSidebar.tsx       — sidebar for /payroll-clerk
  ProcessorQueue.tsx            — the table (mobile + desktop layouts)
  ProcessorCard.tsx             — filter cards with shared-layout glow (count prop now optional, hides badge when omitted)
  ProcessorLogo.tsx             — brand-logo loader with fallback
  MarkPaidDialog.tsx            — confirmation modal
  SentPaymentsHistory.tsx       — history table
  DispatchReports.tsx           — weekly disbursement report list + detail view (added 2026-04-28)
  QueueSkeleton.tsx             — loading skeleton (mobile + desktop)
  AnimatedNumber.tsx            — spring counter
  mock-queue.ts                 — types, processor metadata, builders
  useDispatchQueue.ts           — queue + dispatches hook

src/components/employee/
  PayrollLockBanner.tsx         — global locked banner with animations

src/hooks/
  useDispatchLock.ts            — Realtime-subscribed lock state hook
  useDebouncedValue.ts          — generic debounce
```

### New libs

```
src/lib/
  payroll/current-pay.ts                         — server-side pay calculator
  payroll/disbursement-reports.ts                — weekly-report aggregator (added 2026-04-28)
  supabase/payment-dispatches.ts                 — CRUD helpers
  supabase/payroll-dispatch-lock.ts              — get/set helpers
  supabase/browser.ts                            — singleton browser client (Realtime)
```

### New API routes

```
app/api/
  payroll-current-pay/route.ts
  payment-dispatches/route.ts
  payment-dispatches/reports/route.ts            — list weekly reports (added 2026-04-28)
  payment-dispatches/reports/[cycleId]/route.ts  — single-report detail (added 2026-04-28)
  payroll-dispatch-lock/route.ts
```

### New routes

```
app/payroll-clerk/page.tsx     — standalone Lenny page
```

### Migration files

```
references/
  seed_payroll_dispatch_columns.sql              — bank/contact data (1,062 rows)
  seed_payment_dispatches.sql                    — log table + lock setting
  seed_disbursement_records.sql                  — weekly-report flat table + backfill (added 2026-04-28)
  seed_disbursement_records_sync.sql             — payment_dispatches → disbursement_records triggers (added 2026-04-28)
scripts/
  gen-seed-payroll-dispatch.mjs                  — regenerator for the column seed
public/processors/
  README.md                                       — where to drop brand SVGs
```

### Updated files

- `src/lib/supabase/employee-hourly-rates.ts` — extended `EmployeeHourlyRateRow` with the 8 dispatch fields + aliases in the mapper
- `src/components/Sidebar.tsx` — added "Payment Dispatch" nav item
- `src/App.tsx` — added the `payment-dispatch` case
- `src/components/employee/EmployeeApp.tsx` — mounts `useDispatchLock`, banner, transition toasts
- `src/components/employee/EmployeeSidebar.tsx` — "Paused" pill on Disputes nav item
- `src/components/employee/MyDisputes.tsx` — accepts `payrollLocked` prop, animated lock banner

---

## 8. Migrations to run

All files are in `references/`. Run in this order in the Supabase SQL Editor:

1. **`seed_payroll_dispatch_columns.sql`** — required for people to show up in the dispatch view (without the `Bank Preferred` column populated, the queue is empty).
2. **`seed_payment_dispatches.sql`** — required for Mark paid persistence and the Start/Stop processing button.
3. **`seed_disbursement_records.sql`** *(new 2026-04-28)* — required for the Reports tab. Creates `public.disbursement_records` and backfills one row per (week, employee) from existing `hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches` data.
4. **`seed_disbursement_records_sync.sql`** *(new 2026-04-28)* — required so Mark Paid keeps the Reports tab live. Adds the four `payment_dispatches → disbursement_records` triggers and runs a one-time backfill UPDATE for any existing dispatches.
5. **`seed_paystub_dispatch_queue.sql`** *(new — per-employee paystub dispatch)* — required for paystub emails to send. The Payroll Wizard's **Lock in Values & Send to Payment Dispatch** stages each employee's authoritative paystub payload here; `POST /api/payment-dispatches` fires the n8n paystub webhook for that one person when Lenny marks them **Paid**. Also carries the wizard's **Exclude** ("do not pay") flag, which surfaces those people in the **Excluded** tab. See [paystub-dispatch.md](./paystub-dispatch.md).

All five are idempotent — safe to re-run if you're unsure whether they executed cleanly.

For Realtime to fire (vs. the 30-second poll fallback), migration #2's Step 3 must succeed. If it doesn't (e.g. RLS blocks the anon role from selecting `app_settings`), the lock UI still works — just with up-to-30-second latency instead of instant.

---

## 9. RBAC notes

The Payment Dispatch tab is currently **open to anyone with accounting access**. Future work:

- Add a `payroll_clerk` role to `src/lib/rbac/views.ts`
- Restrict the standalone `/payroll-clerk` page to `payroll_clerk` and `admin` only
- Restrict the `payment-dispatch` tab in Accounting to roles that should see it (Lenny + Carla + Fran, presumably)

The lock toggle should also be permission-gated server-side (currently any authenticated user can POST `/api/payroll-dispatch-lock`).

---

## 10. Open follow-ups

- **Cycle-specific lock** — currently the lock is global. If you ever want cycle A locked while cycle B is open, this needs revisiting (probably move the flag onto `hubstaff_uploads` or a sibling table).
- **Department-specific bonuses** — Collections tiers, lead-gen, and other per-dept formula bonuses depend on per-employee toggle state that lives only in the wizard's React session and are not mirrored in `current-pay.ts`. The dispatch view will undercount those until the wizard persists a snapshot to the DB.
- **Wepay tab** — empty in the source CSV (no Wepay employees yet). Tab still exists for when adoption ramps.
- **Unlocked-only Mark paid** — currently Mark paid works regardless of the lock. Consider gating it on `lockState.locked === true` so dispatches can only be logged during a "live" run.
- **Webhook out of `payroll.dispatch.locked`** — for slack-style notifications to managers when payroll starts.
- **Per-row dispatch retry** — if Mark paid POST fails, the row is restored but the dialog is closed. Could keep the dialog open with the entered values pre-filled.
- **`payment_dispatches` audit / undo** — there's no UI to delete a misclicked dispatch. Currently you'd have to delete the row via Supabase manually.
- **Pre-flight summary** — before Lenny clicks Start, show a count of who's about to be billed, total volume, and any people missing bank info.
- **Auto-seed `disbursement_records` on Hubstaff upload** — see §6.5.10. Currently the seed must be re-run manually after each new CSV.
- **Snapshot processor onto disbursement record at paid time** — see §6.5.10. Avoids drift if `Bank Preferred` changes after a row is paid.
- **Per-cycle PDF / email export of weekly reports** — see §6.5.10.

---

## 11. Quick test plan

After both migrations run:

1. Open `/accounting` → Payment Dispatch in tab A.
2. Open `/employee` (signed in as any employee) in tab B.
3. **In tab A:** click **Start processing**, confirm. Within ~1s tab B should:
   - Show a red lock-icon toast
   - Animate the rose `PayrollLockBanner` down from the top
   - Render the "Paused" pill on the My Disputes sidebar item
   - If the user is on the Disputes tab, the inline banner should slide in and the Submit button should become "Locked"
4. **In tab A:** click **Mark paid** on any row, fill the 4 fields, confirm. The row should slide right + fade out, and the History tab should pick it up persistently (survives refresh).
5. **In tab A:** click **Stop processing**, confirm. Within ~1s tab B should:
   - Show a green unlock toast
   - Banner slides up and away
   - Sidebar pill disappears
   - Submit button restores
6. Open DevTools console in tab B — you should see `[dispatch-lock] Realtime ready (…)`. If you see `CHANNEL_ERROR`, Realtime is broken (probably the publication step in `seed_payment_dispatches.sql` didn't run); the 30-second poll keeps things working in degraded mode.
7. Visit `/admin` → Audit log. Each Start/Stop and each Mark paid should have its own entry with full details.

### Reports tab test plan (added 2026-04-28)

After running migrations 3 + 4:

1. Open `/payroll-clerk` → click **Weekly reports** in the sidebar (or `/accounting` → Payment Dispatch → **Reports** card in the in-page rail).
2. You should see one card per Hubstaff CSV in `references/hubstaff_hours/` (currently 7), newest period first, paginated 6 per page. The April 12-18 card shows the orange "Current" pill if `hubstaff_uploads.is_current = true` for that upload.
3. Each card shows mini-stats (Paid / Sent / Pending counts) and a "Total paid out" footer in USD with 2 decimals.
4. Click a card → the detail view loads:
   - Hero stats render with 2-decimal USD (`$106,963.89`, not `$106,964`).
   - **Paid by processor** card shows non-zero counts + USD for processors that have paid records — Hurupay, Wepay, HiGlobe, Wise, Jeeves, Wires.
   - **Not yet dispatched** card appears only when at least one row is `status='pending'` for that cycle.
   - **Dispatch detail** table lists every `payment_dispatches` row for the cycle, paid first.
5. From SQL Editor, INSERT or UPDATE a `payment_dispatches` row → re-load Reports → the matching `disbursement_records` row should now show `status='paid'` (the trigger fired).
6. From SQL Editor, run the mass mark-as-paid UPDATE in §6.5.3 → re-load Reports → every cycle's "Pending" should drop to 0 and "Paid" should match its recipient count.

---

## 12. 2026-07 updates

Additive changes; §3.3 and §3.5 above describe the pre-change behavior and are
superseded on the points below. §12.1–§12.2 are from earlier in the month;
§12.3–§12.6 landed 2026-07-22.

### 12.1 "Bank used (sent from)" is now a dropdown

In [MarkPaidDialog.tsx](src/components/payroll-clerk/MarkPaidDialog.tsx) the **Bank used (sent from)** field became a `<select>` (the `FieldSelect` component) instead of free text, driven by the `BANK_USED_OPTIONS` constant. This replaces the inconsistent free-text spellings that were hard to report on. Options, in the accounting team's canonical order:

```
Chase · Jeeves · Parallax · PayPal · Wise · x1161 · x1153 · x0048 · Remitly · HiGlobe · Hurupay
```

- The select opens on a disabled `Select a bank…` placeholder option (empty `value`), rendered in muted placeholder color via the `placeholderActive` prop while nothing is chosen.
- The confirm button **stays disabled until a bank is picked**: `valid = transactionId.trim().length > 0 && bankUsed.trim().length > 0 && sentDate.length > 0`, and the button is `disabled={!valid || submitting}`. So transaction ID, a chosen bank, and a sent date are all required before a dispatch can be logged.

### 12.2 Wepay retired from the dispatch tabs

Wepay is no longer offered as a pending-queue tab, filter rail, or new-dispatch destination. In [mock-queue.ts](src/components/payroll-clerk/mock-queue.ts):

- `RETIRED_DISPATCH_PROCESSOR_IDS = ['wepay']` lists the retired processors.
- `DISPATCH_PROCESSORS` = `PROCESSORS` minus the retired ids. **Tabs, filter rails, and processor pickers render `DISPATCH_PROCESSORS`.**
- `PROCESSORS` (and the `ProcessorId` type / `'wepay'` member) intentionally stay put, so **label + visual `.find()` lookups still keep using `PROCESSORS`** — historical dispatch records that were sent via Wepay still resolve their label and branding in Reports / Done / Sent-payments history. Wepay is simply hidden as a live destination, not deleted.
- Mirrors `RETIRED_PROCESSOR_IDS` in [employee-payment-processors.ts](src/lib/employee-payment-processors.ts), where `'wepay'` is likewise retired on the employee-facing side.

### 12.3 Routing precedence — Bank Preferred wins (`employee_ids`)

§3.4/§3.7 above treat the legacy `employee_hourly_rates."Bank Preferred"` CSV
free-text column as the sole routing input. It is now the **lowest**-precedence
source. A person is routed to a processor tab by:

```
employee_ids.bank_preferred            (employee-owned "Bank Preferred" — highest)
  ↓ else
employee_ids.preferred_processor       (the Disbursement pick)
  ↓ else
employee_hourly_rates."Bank Preferred" (legacy CSV free-text — §4.1 migration #11)
```

Applied in the routing resolvers `mock-queue.ts`, `pay-schedule.ts`
(`resolveEmployeeProcessor`), and `dispatch-export-csv.ts`
(`buildDispatchExportRows`, where a *recorded* `dispatch.processor` still wins
first). For the CSV column to be authoritative, `preferred_processor` must be
NULL (it outranks the CSV). `x1153`/`x1161` continue to map to `wires`.

This whole feature — the employee **Bank Preferred** dropdown, its **Accounting
approval gate** (changes held in `bank_preferred_change_requests` until approved
in the Issues tab), and the **WIRES lock** (a wires/null/legacy employee can
never be switched to hurupay/higlobe) — has its own doc:
[bank-preferred-routing.md](./bank-preferred-routing.md).

#### 12.3.1 Sub-₱7k wires → Wise (temporary weekly reroute, 2026-07-29)

Owner rule layered ON TOP of the precedence above, after it resolves: a
**wires**-routed person whose pay for the week is **strictly under ₱7,000**
is dispatched **via Wise that week** — wire fees dwarf small transfers. The
first week their pay is ₱7,000 or more they are back in the Wires tab
automatically.

- **Nothing is persisted.** `employee_ids` is never written; the flip is
  recomputed per cycle from the amount actually being sent, inside
  `applySmallWiresWiseReroute` / `SMALL_WIRES_WISE_THRESHOLD_PHP`
  ([mock-queue.ts](src/components/payroll-clerk/mock-queue.ts), unit-tested in
  `small-wires-wise.test.ts`). No interaction with the WIRES lock — that gate
  guards *stored* `bank_preferred` transitions.
- **Applied LAST in [useDispatchQueue.ts](src/components/payroll-clerk/useDispatchQueue.ts)** —
  after the wizard-final overlay, the arrears rollup and the staged safety
  net — because the decision keys on the final amount. An excluded (held)
  person's reroute rides on their `payable` copy, so the Excluded tab's bank
  label and "Pay now" follow the same rule; a multi-cycle arrears settle is
  judged on the **cumulative** balance being sent.
- **Exemptions:** contractor settlements (Wise is not a contractor gateway),
  USD/COP payees (PHP threshold doesn't apply), and null/zero amounts.
- **Receiving side is unchanged.** Wise pays into the same bank account
  (Wise = wire fields); `resolveMarkPaidDefaults` already surfaces the
  person's own bank + SWIFT for a Wise row with wire details. The dialog's
  hero leads with the **PHP** figure (Wise is keyed in pesos).
- **Visible everywhere it matters:** a `smallWiresViaWise` flag on the row
  renders a **"Wires → Wise · under ₱7k"** note in the queue's bank cell and
  a chip in the Mark Paid hero; `bankPreferredRaw` still carries the stored
  wires/x-suffix routing, and Mark Paid records `processor: 'wise'` (the rail
  actually used). An **"Under ₱7k" filter chip** beside the department filter
  (with a live count) instantly narrows the tab to **every PHP payment
  strictly under ₱7,000** — a pure client-side toggle, no fetch — so on the
  Wise tab that's the temp reroutes (still wearing their badge) plus genuine
  small Wise payments. It appears only where such rows exist, resets on tab
  switch, and the CSV export follows it. The Reports CSV export mirrors the flip for rows with **no
  recorded dispatch and not yet paid** only — recorded history is never
  rewritten (`dispatch-export-csv.ts`).
- **Deliberately NOT applied to:** Urgent one-off payments (no "next
  paycheck" to re-evaluate against), the paystub's scheduled-pay-date label
  (`resolveEmployeeProcessor` still reads the stored rail, so a rerouted
  person's stub still projects the wires Thursday), and the Reports
  `byProcessor` paid-history breakdown.
- **Preview who flips this week:**
  `node scripts/verify-small-wires-wise.mjs` (read-only; `--file=` for a past
  week) — mirrors staging + routing precedence and lists names, amounts, and
  who already settled.

### 12.4 Mark Paid — recipient-bank override + own-bank pre-fill

Extends §3.5's "Recipient banking" group (previously *pre-filled/snapshotted,
read-only*):

- A **pencil** on the Recipient divider enters **override mode**; **Save to
  profile** writes the corrected **receiving** details back to `employee_ids` via
  `POST /api/payment-dispatch/bank-override` (accounting-gated; **no**
  dispatch-lock check — the sanctioned mid-processing correction path). It
  **never** touches routing (`bank_preferred`/`preferred_processor`). Column
  mapping is slot-aware in `src/lib/payroll/bank-override-mapping.ts`; the change
  shows in **People → Bank Changes** as `via: mark_paid_override` and notifies the
  employee (`people.banking.overridden`). Full detail:
  [bank-preferred-routing.md § 5](./bank-preferred-routing.md#5-mark-paid-bank-details-override).
- A Wise-routed employee now pre-fills **their own** bank on the modal
  (`src/lib/payroll/mark-paid-defaults.ts`), instead of showing a Wise/processor
  placeholder.
- **Migration PENDING:** `references/sql/alter/2026-07-22_employee_notifications_add_bank_override_type.sql`
  (Supabase SQL editor) — until run, the override notification silently no-ops;
  the override itself works regardless.

### 12.5 Processor card logos — explicit `logoSrc`, white plate, load skeleton

Supersedes §3.3.1. `ProcessorLogo.tsx` no longer HEAD-probes
`/processors/{id}.svg`; it takes an explicit optional **`logoSrc`** and renders
the brand mark on a **wide white plate** (`bg-white`, `object-contain`, **no**
`mix-blend` — these wordmarks are dark-on-transparent and would vanish under
`mix-blend-multiply` in a small square, the original "white box" bug). While the
image loads, an inline **pulse skeleton** shows; a ref-callback checks
`img.complete && naturalWidth > 0` so cached images skip the skeleton (no
permanent shimmer). Missing/`onError` falls back to the gradient monogram/icon
tile. Cards were also widened so the ~3:1 logos are legible. See
[design/ui-standards.md § 6.4](../design/ui-standards.md).

### 12.6 Processor buckets always visible during processing (focus-mode removed)

§3.3's rail list is stale; the live rail is
All · Urgent · Hurupay · HiGlobe · Wise · Jeeves · Wires · USD · Done · Reports ·
Orphanage · Excluded. A short-lived **"focus mode"** used to retract the
processor-bucket rail and compact the KPI hero stats when processing started; it
was **removed entirely** (`PayrollDispatch.tsx`) after it caused a "buckets
disappeared on the deployed site" scare (the real culprit was a stale browser
bundle, not the code). Starting processing now changes nothing about the layout —
buckets and stats stay full-size. The Start-Processing flow instead shows a
themed "Preparing Dispatch…" confirm modal.

### 12.7 100% paid → confetti email to the Accounting team (2026-07-30)

When the Dispatch Progress strip genuinely reaches **100%** — `pending.length
=== 0 && blockedCount === 0 && distinctPaidCount > 0`, same math as the strip —
the screen POSTs `/api/payment-dispatches/cycle-complete` and the server emails
**everyone holding the `accounting` role** a confetti-and-balloons
congratulations for the completed payment cycle, via a new n8n webhook.

- **Trigger (client)** — an effect in `PayrollDispatch.tsx` right after the
  `paidPct` computation. Gated on `hydrated && !loading && wizardReady &&
  !error && !contractorError` so a half-loaded or errored queue can never
  read as "everyone paid". A **past** week (CSV selector) celebrates only if
  this session actually watched its queue finish — opening an old fully-paid
  file stays silent.
- **Once per cycle, ever (server)** — the route INSERTs (never upserts) an
  `app_settings` marker `dispatch.cycle_complete_notified.<source_file>`.
  `key` is unique, so N browsers all seeing 100% at once produce exactly one
  email; undo → re-pay later the same week finds the marker and stays silent.
  The marker is released only if the n8n delivery itself fails, so a transient
  outage can be retried by reopening the screen. Pre-checks (webhook
  configured? any accounting recipients?) run BEFORE the claim so an unwired
  environment doesn't burn the cycle's one shot.
- **Audience (server)** — `employee_roles` where `role='accounting'` and
  `revoked_at IS NULL`; names resolved from `employee_ids` via a targeted
  `.in()` (1000-row-cap safe). Same audience as `/api/ceo/accounting-team`.
- **Payload** — `{ event: 'payment_cycle.completed', cycle: { source_file,
  cycle_id, label, period_start, period_end, completed_at, completed_by },
  stats: { paid_count, total_count, total_paid_usd, total_paid_php },
  recipients: [{ email, name }] }`. `completed_by` = display name of whoever's
  browser reported 100% (best-effort from `employee_ids`, else email local
  part). Audit log action: `payment_cycle.completed`.
- **n8n side** — import
  [payment-cycle-complete-celebration.workflow.json](../../references/n8n/payment-cycle-complete-celebration.workflow.json),
  attach a Gmail OAuth2 credential to **Send Celebration (Gmail)**, activate,
  then paste the production webhook URL into **Admin → Webhooks** under slug
  `payment_cycle_complete` (env fallback
  `N8N_PAYMENT_CYCLE_COMPLETE_WEBHOOK_URL`). The email (subject + body) is
  fixed inside the workflow's **Build Celebration Emails** node — callers only
  choose who gets it. Confetti garland + bobbing balloons are inline-block
  spans + CSS keyframes only (no `position:absolute`), so animation-stripping
  clients still render a tidy static garland. Optional lockdown: set
  `REQUIRED_SECRET` in that node + `N8N_PAYMENT_CYCLE_COMPLETE_SECRET` in the
  HRIS env (sent as `x-webhook-secret`).
- **Files** — `src/lib/payroll/cycle-complete-notify.ts` (audience + POST),
  `app/api/payment-dispatches/cycle-complete/route.ts` (auth + claim + audit),
  trigger effect in `src/components/payroll-clerk/PayrollDispatch.tsx`,
  `payment_cycle_complete` entry in `AdminWebhooks.tsx` `KNOWN_SLUGS`.
  No DDL — the marker rides the existing `app_settings` table.

### 12.8 COP-country payees show/copy native COP (2026-07-30)

Colombian staff have **no COP Pay Structure** — they ride the ordinary PHP rails, so the
COP tab never sees them and their secondary line used to show a peso figure they never
receive. A display-only `countryCurrency` marker (derived from the hire's **submitted**
onboarding `country`, never HR's `invite_country`) makes queue rows and the Mark Paid
dialog show `$COP…` as the small number, with the copy button pasting a **bare integer**
for the bank field. `payCurrency`, routing, amounts and dispatch records are untouched.
Full rule + the trust caveat: [cop-country-payees.md](./cop-country-payees.md).

### 12.9 Triage — why a person isn't in Payment Dispatch

Asked often enough to be worth writing down. In plain terms, someone is missing from the
queue entirely because:

1. Accounting hasn't finished and **locked** that week's payroll yet — the page shows
   nothing for anyone until they do.
2. They had **no recorded hours** that week, so no pay was prepared.
3. They **weren't included** when the week's payroll was finalized (nothing staged).
4. They've **already been paid** — they moved into the paid records.
5. They were flagged with a **payment problem** — they sit in the problem list.
6. They're **no longer on the active employee list** and weren't part of that pay run.
7. You're **viewing a different week** than the one they were paid in.
8. Their record is filed under a **different email or name** than the one searched.
9. **Contractors only:** the invoice isn't approved yet, or was already paid off.
10. The **contractor side failed to load** (the page shows a warning when this happens).

**Missing bank details or a missing pay rate do NOT hide anyone** — those people still
appear, under the **Excluded** tab rather than the pending list. (Catalog-paid people with
no rates row used to be an exception: they showed as "No bank / No rate" and were
unpayable until `buildStagedOnlyPlacement` landed.)
