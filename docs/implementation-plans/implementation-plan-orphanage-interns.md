# Implementation Plan — Orphanage Interns (profiles · mini wizard · Payroll Wizard Interns view · dispatch)

> **Status: APPROVED 2026-09-02 (Kane: "Start the build!") · BUILT 2026-09-02.** Feature doc:
> `docs/features/orphanage-interns.md`. Task file: `docs/superpowers/plans/2026-09-02-orphanage-interns.md`.
> **The migration is NOT applied yet** — Kane runs `scripts/apply-orphanage-interns-migration.mts --apply`.
> Q2 (50% mechanics) is still open; `shareMode` stays unset and lock-in stays refused until Ellie/Ralph decide.
>
> Originally: the scoping plan for the `blueprint` skill's Phase 2 brief.
> Per `.claude/skills/blueprint/SKILL.md`, **nothing is written to `src/` or `app/` until Kane
> approves the `BLUEPRINT` block in §11**, and the task-by-task execution file
> (`docs/superpowers/plans/2026-09-XX-orphanage-interns.md`) is created only after that approval.
> One business question (§12 Q2, the 50% disbursement mechanics) is owned by Ellie/Ralph and blocks
> the dispatch task specifically — every other task can proceed once the brief is approved.
> Q1 (the PAB predicate) was **answered 2026-09-02**: at least 5 paid hours every week, on Simple's pay
> cycle and PAB period.

| | |
|---|---|
| **Date** | 2026-09-02 |
| **Requested by** | Kane, from the orphanage-dashboard meeting |
| **Owner** | Kane |
| **Governing docs read** | `orphanage-pay-step.md` · `orphanage-pab-coverage.md` · `orphanage-dispute-flow.md` · `third-party-vendors.md` · `payment-dispatch.md` · `payroll-wizard-pab-step.md` · `identity-resolution.md` · `csv-imports.md` · `hubstaff-weekly-auto-sync.md` · `hubstaff-zero-hours-gap.md` · `docs/design/orphanage-dashboard-standards.md` |
| **Memory read** | `orphanage-pay-ot-differential-underpay` · `orphanage-step-delete-all` · `orphanage-pab-auto-coverage` · `hsl-sheet-form-pay-rule` · `hubstaff-ingest-blocklist` · `master-list-sync-race` · `pab-payout-week-gate-and-pill` · `per-cycle-fx-zero-placeholder` · `rate-updated-at-not-evidence` · `postgrest-1000-cap-sweep` · `migration-apply-needs-database-url` · `payroll-wizard-tab-persist` · `blueprint-skill-plan-gate` |

---

## 1. What was asked (requirements restated as rules)

**Compensation**

| Rule | Value | Source |
|---|---|---|
| Hourly rate | ₱200 / hour, editable per intern, must survive future changes | meeting |
| Weekly cap | 5 hours / week maximum paid | meeting |
| Daily cap | 5 hours / day (constraint handling) | meeting |
| Perfect Attendance Bonus | ₱1,000 / month. **Qualifies when every week of the PAB period reaches 5 paid hours.** Same pay cycle (Sun–Sat Hubstaff week) and same PAB period as Simple.biz. | meeting; Kane relaying Ralph, 2026-09-02 |
| Tech Bonus | **None. Interns are never Tech-eligible.** | Kane, 2026-09-02 |
| Orphanage contribution | 50% of total earnings goes to the orphanage — **mechanics OPEN (Q2)** | meeting |

**System — the flow Kane described (2026-09-02)**

1. **Orphanage dashboard → Interns tab.** The Orphanage Manager profiles interns there: `@pathway.ph`
   email (never `@simple.biz`), name, bank info, hourly rate. No standard onboarding paperwork.
2. **The same tab holds a mini Payroll Wizard.** It reads the week's Hubstaff hours for the interns,
   applies caps, rate and intern PAB, and the manager **locks in the values**.
3. **Locked values are sent to the Payroll Wizard** on the Accounting side, where a **Simple | Interns
   toggle** switches between the standard payroll view and the received intern weeks.
4. **Accounting pays them from there** — the Interns view hands the week to Payment Dispatch.
5. Interns are **recognised by `@pathway.ph`** and **segmented out of the standard Payroll Wizard**
   and everything downstream of it.
6. **Interns get their own Hubstaff report**, uploaded into the mini wizard, with **the same columns as
   the Payroll Wizard's weekly report** (Kane, 2026-09-02). Same parser, separate table, separate upload.
7. **Interns have no Employee Dashboard and no sign-in** (Kane, 2026-09-02). Nothing here is built for an
   intern to look at; the Orphanage Manager and Accounting are the only users.
8. **Every personal-data change, bank details included, is made on the Orphanage dashboard** (Kane,
   2026-09-02). Accounting reads intern data; it never edits it. No bank pencil in Mark Paid for intern items.
9. **The mini wizard looks like the Payroll Wizard** (Kane, 2026-09-02): same rendered structure — step
   rail, per-step header cards, the data table, "Lock in values" with a confirm dialog, replay banner —
   in the Orphanage dashboard's accent.

---

## 2. What already exists (the precedents this copies)

Every piece of this feature has a shipped cousin. Inventing a new pattern where one exists is a
defect (`blueprint` §1.2), so each build item names the file it copies.

| New thing | Copies | Why it fits |
|---|---|---|
| Intern profile table + CRUD | `orphanage_worker_payments` (`references/sql/create/create_orphanage_worker_payments.sql`) — "orphanage staff who have NO Hubstaff record and NO employee identity"; `orphanage_vendors` for the bank-column shape (`third-party-vendors.md` §Data model) | Interns are orphanage-side payees with no `global_master_list` identity. That migration's header says: *"Eventual plan: worker management moves to the Orphanage Dashboard and the Payroll Wizard picks it up from there."* This plan is that eventual plan, for interns. |
| Interns tab in `/orphanage` | `ThirdPartyVendorsPanel.tsx` — self-contained CRUD tab with bank fields, `requireFeatureAccess('orphanage', …)` gating, one feature key in `FEATURE_CATALOG.orphanage` | Same dashboard, same palette, same RBAC wiring (`feature-permissions.ts:56`, `view-tabs.ts:74`, `OrphanageApp.tsx:193`). |
| **Manager submits → Accounting decides → dispatch** | `orphanage_budget_requests` → `PATCH /api/orphanage-budget-requests/[id]/decide` → `orphanage_dispatches` (`orphanage-dashboard-standards.md` §2) | Exactly the two-stage hand-off Kane described: the Orphanage Manager locks a week, Accounting accepts it, the dispatch clerk pays it. |
| Segmentation choke point | `HUBSTAFF_INGEST_BLOCKED_EMAILS` in `hubstaff-hours-db.ts:18` — one set, one filter, every reader clean | Domain rule applied at the **read** mapper (`rowsToPayrollRows`, `hubstaff-hours-db.ts:1103`) rather than at ingest, because the mini wizard needs the rows the Payroll Wizard must not see. |
| Week pricing (pure, tested) | `orphanage-pay-pricing.ts` (`priceOrphanageHours`, refusal codes, 2dp legs, "the OT leg is the remainder") | Money math in one pure module shared by preview, lock and Accounting's re-check, so no two screens can disagree (`orphanage-pay-step.md` §The pricing rule). |
| Locked-week record | `orphanage_pay` (`create_orphanage_pay.sql`) — `(source_file, email)` PK, hours + rate + amount, `locked_by/at` | Period identity = Hubstaff `source_file`. **Difference:** no `app_settings` blob carrier at all — see §3. |
| Dispatch of the money | `orphanage_dispatches.dispatch_type = 'worker_payment'` + `listPendingOrphanageItems` (`orphanage-dispatches.ts:69`) + `OrphanageQueue.tsx` sections (`:311-313`, `:543`) | Pending source rows show in Payment Dispatch → Orphanage until an `orphanage_dispatches` row references them; Mark Paid snapshots bank + txn. **Never `payment_dispatches` / paystubs** — that is the Simple rail. |
| PAB month gate | `pab-payout-week.ts` + memory `pab-payout-week-gate-and-pill` | Intern PAB is monthly too: pays only on the week containing the period end. |
| Refuse-until-configured gate | Step 8 FX hard-gated at 0 (`per-cycle-fx-zero-placeholder`) | The 50% split mode must be set before any lock — a silent default would move money nobody decided on. |
| Migration script | `scripts/apply-termination-docs-migration.mts` — dry by default, `--apply`, `--verify` | Kane cannot paste SQL (CLAUDE.md §Data). |
| Accounting toggle + tab persist | `App.tsx:461-488` (`wizardVisited`, `visibilityOf('accounting','payroll-wizard')`), memory `payroll-wizard-tab-persist` | The Interns view is mounted **beside** `<PayrollWizard>` under the same tab; `PayrollWizard.tsx` itself is not edited. |

**Checked and ruled out**

- **Interns on `global_master_list`.** Sheet-synced as a *full replace* (`supabase_global_master_list.sql`
  header; `master-list-sync-race`) — a hand-inserted row dies at the next sync, and it would drag interns
  into People, Overview recon, readiness, zero-hours notifications, MESA and the paystub export.
- **Interns in `employee_hourly_rates` / the Payment Catalog.** Same clobber class (the manual rates CSV
  still writes pay tables — `csv-imports.md` §Rates note) and it would teach `resolve-rate.ts` a
  non-department. Intern rates are dated rows in their own table.
- **Pulling from the Hubstaff API in the wizard.** Removed 2026-07-29; pull is MANUAL
  (`hubstaff-weekly-auto-sync.md`; memory DEPRECATED 08-20). Interns follow the same manual model: the
  Orphanage Manager **uploads the interns' weekly Hubstaff CSV** into the mini wizard.
- **Uploading the intern report into `hubstaff_hours`.** `POST /api/hubstaff-hours` is not a plain
  insert: `replaceHubstaffHoursFromCsvText` **promotes the new batch to `is_current`**, and the route then
  records MESA deposits, fires `payroll.available` and zero-hours notifications, and seeds
  `disbursement_records` (`csv-imports.md` §5, `hubstaff-weekly-auto-sync.md`). An intern file through
  that door would flip Simple's current-week pointer and seed money readers with intern rows. Interns get
  their **own table** (`orphanage_intern_hours`) and their own upload route, reusing only the **parser**
  (`mapHubstaffHoursRow`, `resolveCanonicalColumnsToIso`, the filename date contract).
- **Dashboard / sign-in for interns.** SSO is pinned to `hd: simple.biz` (`auth-options.ts:29`). Out of
  scope; nothing here needs an intern to log in.
- **Interns in the standard PAB engine.** `computePabEligibleEmails` pays ₱5,000 (`dispatch-bonuses.ts:52`).
  Segmentation (§4) keeps interns out of it; intern PAB is its own ₱1,000 rule in its own module.
- **Editing `PayrollWizard.tsx`.** 22,643 lines; the Interns view is a separate component under the same
  Accounting tab. The toggle lives in `App.tsx`, which already owns what that tab mounts.

---

## 3. Architecture in one picture

```
 Simple's weekly Hubstaff CSV ──▶ hubstaff_hours ── rowsToPayrollRows() excludes @pathway.ph ──▶ Payroll Wizard ·
                                                   (safety net: a stray intern row can never be paid here)   current-pay · seeder · …

 Interns' weekly Hubstaff CSV (same columns) ──▶ orphanage_intern_hours (week batch = source_file)
   uploaded in the mini wizard · parser reused · non-@pathway.ph rows REFUSED · no is_current, no MESA, no seeder
        │
        ▼
 orphanage_interns (profile) · orphanage_intern_rates (dated rate rows)      ◀── Interns tab: profile + "Change rate…"
        │
        ▼  priceInternWeek() + internPabVerdict()   (pure, tested — shared by BOTH sides)
 orphanage_intern_pay   status: submitted ──▶ accepted ──▶ (paid, derived from dispatches)
        │              ▲ Orphanage Manager locks    ▲ Accounting accepts in Payroll Wizard → Interns view
        │              └── rejected (note) ─────────┘   (or rejects back with a note)
        ▼  accepted rows appear as pending items ('intern_pay', + 'intern_orphanage_share' when Q2 = split)
 Payment Dispatch → Orphanage tab → Mark Paid → orphanage_dispatches (bank snapshot, txn id)
```

Three hard lines:

1. **Nothing intern-related touches `payment_dispatches`, `paystub_dispatch_queue`, the additions blob,
   `disbursement_records`, MESA, or the paystub email.** Those are the Simple rail.
2. **`orphanage_intern_pay` is the only carrier.** No `app_settings` blob for intern amounts — the
   whole-object blob is where the 2026-08 orphanage clobber lived (`orphanage-pay-step.md` §The 2026-08
   incident). Interns start without one.
3. **Both sides price through the same pure functions.** Accounting's Interns view re-derives every
   submitted row server-side and shows a red mismatch if the stored amount disagrees with its own hours ×
   rate — the `reconcileLockedOrphanageAmount` idea, applied from day one.

---

## 4. Segmentation — `@pathway.ph` never reaches the Simple rail

**Rule:** an email whose domain is `pathway.ph` (case-insensitive after `normEmail`) is an intern.

**Single implementation:** `src/lib/interns/intern-email.ts`

```ts
import { normEmail } from '@/lib/email/norm-email';

export const INTERN_EMAIL_DOMAIN = 'pathway.ph';

export function isInternEmail(email: string | null | undefined): boolean {
  const n = normEmail(email);
  if (!n) return false;
  const at = n.lastIndexOf('@');
  return at > 0 && n.slice(at + 1) === INTERN_EMAIL_DOMAIN;
}
```

**Two doors, one rule each way.** Interns arrive on their own report (§1 item 6), so in the normal
case no intern row is ever in `hubstaff_hours`. The rule is still enforced at both doors because
"normally" is not a guard:

*Simple's door — `src/lib/supabase/hubstaff-hours-db.ts`:*

```ts
export function rowsToPayrollRows(rows: Record<string, unknown>[]): PayrollHubstaffRow[] {
  // Interns (@pathway.ph) are NEVER payroll rows. They arrive on their own report
  // (orphanage_intern_hours); if one lands in hubstaff_hours by mistake it must not
  // be paid by the Simple rail, so the read mapper drops it.
  return rows.map((r) => mapHubstaffHoursRow(r)).filter((r) => !isInternEmail(r.email));
}
```

Plus one route fix: `app/api/hubstaff-hours/route.ts:361` calls `mapHubstaffHoursRow` directly instead
of `rowsToPayrollRows` — switch it or the "all rows" branch leaks. Dropped intern rows are **counted and
reported** in the GET response (`internRowsDropped: n`) so the Payroll Wizard's Step 1 can say "n intern
rows in this file were ignored — upload them in the Interns tab", not silently vanish.

*The interns' door — `src/lib/supabase/orphanage-intern-hours-db.ts`:*

```ts
export function rowsToInternRows(rows: Record<string, unknown>[]): { rows: PayrollHubstaffRow[]; refused: PayrollHubstaffRow[] } {
  // The intern upload REFUSES non-@pathway.ph rows (they are reported back and never stored):
  // a Simple employee in the intern file must not be priced at the intern rate.
  const mapped = rows.map((r) => mapHubstaffHoursRow(r));
  return { rows: mapped.filter((r) => isInternEmail(r.email)), refused: mapped.filter((r) => !isInternEmail(r.email)) };
}
```

**Every consumer of `rowsToPayrollRows` is segmented for free** (measured 2026-09-02): `current-pay.ts`
(Payment Dispatch mirror + standard PAB), `cycle-hours-index.ts`, `payroll-readiness.ts`,
`people/people-roster.ts`, `roster/recently-offboarded.ts`, `supabase/payroll-wizard-notes.ts`,
`anthropic/ceo-tools.ts`, and the `/api/hubstaff-hours` GET that feeds `PayrollWizard.tsx`'s
`hubstaffData` (`:4486`, `:4538`) → `calcResults` (`:7307`). `PAB_BONUS_PHP` and `isTechBonusWeek` never
see an intern.

**Not affected, stated so nobody re-checks:** `recordMesaWeeklyContributions` (opted-in members only),
`notifyPayrollAvailable` (master-list people), `seedMissingDisbursementRecords` (reads via
`rowsToPayrollRows`).

**Proof:** new `hubstaff-hours-db.test.ts` — one `@simple.biz` and one `@pathway.ph` row in; the payroll
array holds exactly the first and the intern array exactly the second. A second test feeds
`buildReconciliationIssues` payroll rows only and asserts no "Hubstaff row not on master" issue names an
intern.

---

## 5. Data model (one migration, one apply script)

**File:** `references/sql/create/create_orphanage_interns.sql` — idempotent, in the worker-payments
file's style (IF NOT EXISTS, `updated_at` trigger, best-effort Realtime).

```sql
-- Interns: orphanage-side payees with NO global_master_list identity and NO
-- employee_hourly_rates row. Identity = their @pathway.ph email.
CREATE TABLE IF NOT EXISTS public.orphanage_interns (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL UNIQUE
                       CHECK (email = lower(email) AND email LIKE '%@pathway.ph'),
  full_name            TEXT NOT NULL,
  personal_email       TEXT,
  phone                TEXT,
  orphanage_id         UUID REFERENCES public.orphanages(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_on           DATE,
  ended_on             DATE,
  -- caps/bonus are per-intern columns (defaults = the meeting's numbers) so a
  -- future change is a data edit, not a deploy
  weekly_cap_hours     NUMERIC(6,2)  NOT NULL DEFAULT 5    CHECK (weekly_cap_hours > 0),
  daily_cap_hours      NUMERIC(6,2)  NOT NULL DEFAULT 5    CHECK (daily_cap_hours > 0),
  pab_bonus_php        NUMERIC(12,2) NOT NULL DEFAULT 1000 CHECK (pab_bonus_php >= 0),
  orphanage_share_pct  NUMERIC(5,2)  NOT NULL DEFAULT 50   CHECK (orphanage_share_pct BETWEEN 0 AND 100),
  -- bank: the same four columns as orphanage_worker_payments / orphanage_dispatches
  bank_name            TEXT NOT NULL DEFAULT '',
  bank_account_name    TEXT NOT NULL DEFAULT '',
  bank_account_number  TEXT NOT NULL DEFAULT '',
  swift_code           TEXT NOT NULL DEFAULT '',
  note                 TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rates are DATED facts about a person (memory: rate-updated-at-not-evidence).
-- Effective rate for a day = newest row with effective_from <= that day.
CREATE TABLE IF NOT EXISTS public.orphanage_intern_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intern_id      UUID NOT NULL REFERENCES public.orphanage_interns(id) ON DELETE CASCADE,
  rate_php       NUMERIC(12,2) NOT NULL CHECK (rate_php > 0),
  effective_from DATE NOT NULL,
  set_by         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intern_id, effective_from)
);

-- The interns' weekly Hubstaff report. SAME COLUMNS as hubstaff_hours (the Payroll Wizard's
-- report) so the shared parser reads it — but a separate table, because the hubstaff_hours
-- upload path promotes is_current and fires MESA / notifications / the disbursement seeder.
-- Append-only per (source_file, row position) like hubstaff_hours; re-uploading a file replaces it.
CREATE TABLE IF NOT EXISTS public.orphanage_intern_hours (
  id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  upload_id   UUID NOT NULL,
  source_file TEXT NOT NULL,
  row_index   INT  NOT NULL,
  row         JSONB NOT NULL,        -- the CSV row verbatim (flexible columns, exactly like hubstaff_hours)
  email       TEXT NOT NULL,         -- normalized, CHECK'd to the intern domain
  CHECK (email LIKE '%@pathway.ph'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_file, row_index)
);
CREATE INDEX IF NOT EXISTS orphanage_intern_hours_file_idx ON public.orphanage_intern_hours (source_file);

CREATE TABLE IF NOT EXISTS public.orphanage_intern_hours_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file  TEXT NOT NULL UNIQUE,
  week_start   DATE NOT NULL,
  week_end     DATE NOT NULL,
  row_count    INT  NOT NULL,
  refused_count INT NOT NULL DEFAULT 0,   -- non-intern rows reported back, never stored
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The locked week. ONE carrier. Period identity = the intern report's source_file, like orphanage_pay.
CREATE TABLE IF NOT EXISTS public.orphanage_intern_pay (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file           TEXT NOT NULL,
  intern_id             UUID NOT NULL REFERENCES public.orphanage_interns(id) ON DELETE RESTRICT,
  intern_email          TEXT NOT NULL,
  week_start            DATE NOT NULL,          -- Sunday, parsed from source_file
  week_end              DATE NOT NULL,          -- Saturday
  hours_raw             NUMERIC(12,4) NOT NULL, -- Hubstaff total before caps
  hours_paid            NUMERIC(12,2) NOT NULL, -- after daily then weekly cap, 2dp
  hours_by_day          JSONB NOT NULL,         -- { "2026-09-06": { raw, paid, rate_php }, ... }
  rate_php              NUMERIC(12,2) NOT NULL, -- rate in force (single-rate weeks); per-day in hours_by_day
  pay_php               NUMERIC(12,2) NOT NULL,
  pab_php               NUMERIC(12,2) NOT NULL DEFAULT 0,
  pab_mode              TEXT NOT NULL CHECK (pab_mode IN ('weekly_hours', 'not_payout_week')),
  pab_month             TEXT,                   -- 'YYYY-MM' when pab_php > 0
  gross_php             NUMERIC(12,2) NOT NULL, -- pay + pab
  orphanage_share_pct   NUMERIC(5,2)  NOT NULL,
  orphanage_share_php   NUMERIC(12,2) NOT NULL,
  intern_share_php      NUMERIC(12,2) NOT NULL, -- gross − orphanage share (remainder → exact sum)
  share_mode            TEXT NOT NULL CHECK (share_mode IN ('system_split', 'intern_remits')),
  -- the two-stage hand-off
  status                TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted', 'accepted', 'rejected')),
  submitted_by          TEXT,                   -- Orphanage Manager who locked in the mini wizard
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by            TEXT,                   -- Accounting user who accepted / rejected
  decided_at            TIMESTAMPTZ,
  decision_note         TEXT,                   -- required on reject
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_file, intern_id)
);

-- Dispatch: two new dispatch types + the source reference, mirroring worker_payment.
ALTER TABLE public.orphanage_dispatches DROP CONSTRAINT IF EXISTS orphanage_dispatches_dispatch_type_check;
ALTER TABLE public.orphanage_dispatches ADD CONSTRAINT orphanage_dispatches_dispatch_type_check
  CHECK (dispatch_type IN ('budget_request','gift_shipping','worker_payment','intern_pay','intern_orphanage_share'));
ALTER TABLE public.orphanage_dispatches ADD COLUMN IF NOT EXISTS intern_pay_id UUID
  REFERENCES public.orphanage_intern_pay(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orphanage_dispatches_intern_pay_uniq
  ON public.orphanage_dispatches (intern_pay_id, dispatch_type) WHERE intern_pay_id IS NOT NULL;

-- For Q2 = system_split: the orphanage's RECEIVING bank. create_orphanages.sql has none today.
ALTER TABLE public.orphanages ADD COLUMN IF NOT EXISTS bank_name           TEXT NOT NULL DEFAULT '';
ALTER TABLE public.orphanages ADD COLUMN IF NOT EXISTS bank_account_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE public.orphanages ADD COLUMN IF NOT EXISTS bank_account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE public.orphanages ADD COLUMN IF NOT EXISTS swift_code          TEXT NOT NULL DEFAULT '';
```

**Apply script:** `scripts/apply-orphanage-interns-migration.mts` — copy
`apply-termination-docs-migration.mts` in shape: no flag = dry run inside a rolled-back transaction,
`--apply` commits, `--verify` proves the tables exist **and** that the `email` CHECK rejects
`x@simple.biz`, the `status` CHECK rejects `'paid'` (paid is derived, never stored here), and the
`share_mode` CHECK rejects `'auto'`. `DATABASE_URL` = session pooler, `@` in the password as `%40`
(`migration-apply-needs-database-url`). **Kane runs `--apply`.**

**Config (one key, no amounts in it):** `app_settings['orphanage.interns.config']` =
`{ "shareMode": "system_split" | "intern_remits" | null }`.
Set by Accounting from the Interns view's Setup panel, audited `orphanage_interns.config_changed`.
**The mini wizard's Lock in refuses while `shareMode` is `null`** (§7). The PAB rule is not
configurable: it is fixed in code (§6) because Ralph decided it.

---

## 6. Pay math — `src/lib/interns/intern-week-pay.ts` (pure, `node:test`, shared by both sides)

```ts
export interface InternDayInput { iso: string; rawSec: number }            // Sun..Sat
export interface InternRateRow  { ratePhp: number; effectiveFrom: string }  // ISO date

export interface InternWeekPriceInput {
  days: InternDayInput[];
  rates: InternRateRow[];           // newest effective_from <= day wins
  dailyCapHours: number;            // 5
  weeklyCapHours: number;           // 5
}

export type InternPriceRefusalCode = 'no_rate_for_week' | 'negative_hours' | 'bad_week_shape';

export interface InternWeekPriceOk {
  ok: true;
  hoursRaw: number;                 // Σ raw, 4dp
  hoursPaid: number;                // after caps, 2dp
  hoursByDay: Record<string, { raw: number; paid: number; ratePhp: number }>;
  ratePhp: number;                  // the rate in force (single-rate weeks)
  payPhp: number;                   // Σ paid_day × rate_day, each leg 2dp, then summed
  cappedOffHours: number;           // hoursRaw − hoursPaid; shown, never paid
}
export interface InternWeekPriceRefusal { ok: false; code: InternPriceRefusalCode; reason: string }

export function priceInternWeek(input: InternWeekPriceInput): InternWeekPriceOk | InternWeekPriceRefusal;

/** gross → shares. Orphanage share = round2(gross × pct/100); the intern share is the
 *  REMAINDER so the two always sum to gross exactly (the orphanage OT-leg rule). */
export function splitInternGross(grossPhp: number, orphanageSharePct: number): { orphanagePhp: number; internPhp: number };
```

| Rule | Test |
|---|---|
| Daily cap first, then weekly cap on the capped sum | 6h Mon + 6h Tue → 5 + 5 → weekly cap → **5.00 paid**, 7.00 capped off |
| Never OT, never a weekend premium, never Tech | 20 raw hours → pay = 5 × rate; the result type has no second leg |
| Rate = newest row effective on/before the day; mid-week change prices per day | ₱200 through Tue, ₱220 from Wed, 1h/day → `2×200 + 3×220 = ₱1,060` |
| No rate effective for any paid day → **refused**, never ₱0 | `code: 'no_rate_for_week'` |
| Shares sum exactly to gross | gross ₱1,000.01 at 50% → 500.01 / 500.00 |
| 2dp hours per day before pricing (sheet convention, `hsl-sheet-form-pay-rule`) | 1.005h → 1.01 → ₱202.00 at ₱200 |

**Intern PAB — `src/lib/interns/intern-pab.ts`**

```ts
export const INTERN_PAB_MIN_WEEKLY_HOURS = 5;   // Ralph, 2026-09-02: "5 hours per week to qualify"

export interface InternPabInput {
  period: { start: string; end: string };      // Simple's PAB period for the month (resolvePabRangeForMonth)
  weeks: Array<{ weekStart: string; weekEnd: string; hoursPaid: number }>; // every Sun–Sat week inside the period
  minWeeklyHours: number;                       // INTERN_PAB_MIN_WEEKLY_HOURS
  bonusPhp: number;                             // the intern's pab_bonus_php (1000)
}

export type InternPabVerdict =
  | { status: 'eligible';   amountPhp: number }
  | { status: 'ineligible'; amountPhp: 0; failedWeekStarts: string[] }
  | { status: 'weeks_missing';   amountPhp: 0 };     // the period has no locked weeks yet — NEVER pays

export function internPabVerdict(input: InternPabInput): InternPabVerdict;
```

- **The rule (Ralph via Kane, 2026-09-02):** eligible when **every** Sun–Sat week inside the PAB
  period has `hoursPaid >= minWeeklyHours − 0.01` (paid = after caps, so the cap and the threshold are
  the same 5 hours: an intern who works the full allowance every week qualifies). One short week loses
  the month, exactly like Simple's one-short-day rule.
- **Same pay cycle and PAB period as Simple.biz.** Weeks are the Hubstaff Sun–Sat batches; the month's
  window comes from the same `pab-period-settings.ts` readers Simple uses (`fetchPabPeriodSettings`,
  `resolvePabRangeForMonth`, overrides included) so the two rails never disagree on what "this month" is.
- A week is counted when its Saturday falls inside the period. Weeks earlier in the period that were
  never locked read as `weeks_missing` for the month → **₱0 with an amber "weeks missing" chip**, never a
  guess; amber = warning only (`wizard-step2-header-cards`).
- Pays on the **payout week only** — the week containing the period end (`isFinalPabWeek`,
  `pab-payout-week-gate-and-pill`). Other weeks store `pab_php = 0, pab_mode = 'not_payout_week'`.
- Tests: 4 full weeks → eligible ₱1,000; one week at 4.99 → ineligible naming that week; 5.00 exactly →
  eligible; a period with a missing locked week → `weeks_missing`; a non-payout week → no PAB line at all.

---

## 7. The mini wizard — Orphanage dashboard → Interns tab → "Pay week" section

**Component:** `src/components/orphanage/interns/InternsWizard.tsx` with one file per step in the same
folder, all pricing through §6. The Interns tab is two panes: **Profiles** (§8) and **Pay week** (this).

**Look and feel — it must read as the Payroll Wizard, smaller.** "Looks like" means what *renders*
matches, not that class names are shared (`same-means-rendered-not-classnames`). Copy these rendered
structures from `PayrollWizard.tsx`, one for one:

| Payroll Wizard element | Mini wizard copy |
|---|---|
| Left step rail: numbered steps, label, one-line description, status badge per step (`steps` array at `PayrollWizard.tsx:1934`) | Same rail with the four steps in §7's table; the PAB step is present but greyed with "payout week only" off the payout week, exactly as the PAB tab appears/disappears in the big wizard (`payroll-wizard-pab-step.md` §The tab only exists on the payout week) |
| Step header cards (Step 2's KPI strip: people · hours · total; teal/neutral, amber only for warnings — `wizard-step2-header-cards`) | Interns with hours · paid hours · pay · PAB · orphanage share · intern share; amber only on refusals / missing profiles / missing weeks |
| The Initial Calculation table: name (master quoted nickname), email mono, per-day cells, totals row, search that filters display but keeps the period total (`orphanage-pay-step.md` §UI) | Same table; Sun–Sat cells show `raw → paid` with capped cells tinted; footer stays the period total while searching |
| "Lock in values" primary button + `LockToggleConfirmDialog` vocabulary (icon-in-title, verb+object confirm, outline Cancel, undismissable in flight) | "Lock in values" → `POST …/pay-weeks`; confirm dialog in the same vocabulary |
| Replay banner on a locked week ("view-only") | Banner on Submitted / Accepted weeks with the status and who/when |
| Upload card (Step 1's Hubstaff CSV card with last-upload status panel — `csv-imports.md` §1) | The intern CSV upload card, same states: idle / uploading / success / error, with the refused-rows list beneath |

Reuse the already-extracted shared pieces rather than re-implementing them: `LockToggleConfirmDialog`,
`PabDecisionConfirmDialog`'s vocabulary, `QueuePagination`, `StatusChip` (Ready = green, Locked = black,
amber = warn only — `hsl-branch-list-and-overlay`), `formatDeptLabel` is not needed (no departments).
Nothing is extracted **out of** `PayrollWizard.tsx` for this; that file is `out:` scope. Palette: the
Payroll Wizard's structure in the Orphanage dashboard's pink/rose accent (`orphanage-dashboard-standards.md`
§3.1 — the accent is what tells a user which dashboard they are in). Verify with a side-by-side screenshot
of the two Step 1s before calling it done.

| Step | Shows | Writes |
|---|---|---|
| **1 · Week** | **Upload the interns' weekly Hubstaff CSV** (same columns as the Payroll Wizard's report; same filename date contract — an undatable name is refused, `csv-imports.md` §4). Below it, a picker of already-uploaded intern batches. Upload result: rows stored · **non-`@pathway.ph` rows refused** (listed by email) · duplicate week → replaces the same `source_file` (idempotent, like the API sync). Readiness: interns with hours · active interns with **no** hours · **`@pathway.ph` rows with no profile** (red blocker, "Add them in Profiles") · config status (share mode set by Accounting?) · this week's status (`—` / Submitted / Accepted / Rejected + note). | `POST /api/orphanage-interns/hours` → `orphanage_intern_hours` + `orphanage_intern_hours_uploads` |
| **2 · Hours & pay** | One row per intern: Sun–Sat cells raw → paid (capped cells tinted), rate in force, pay, capped-off hours. Rows that refuse to price are listed with the reason, never hidden. | nothing |
| **3 · PAB** | Payout week only. Verdict per intern with the failed weeks named; a period with unlocked weeks shows the amber "weeks missing" chip and pays ₱0. | nothing |
| **4 · Review & lock in** | Totals: pay · PAB · gross · orphanage share · intern share. **Lock in** disabled with a stated reason while config is `null`, any row refused, or any `@pathway.ph` row lacks a profile. Confirm via an in-app dialog in the `OrphanageClearConfirmDialog` vocabulary — never `window.confirm`. | `POST /api/orphanage-interns/pay-weeks` → rows `status = 'submitted'` |
| **Submitted / Accepted** | Read-only replay from `orphanage_intern_pay` (never recomputed — `wizard-week-replay-fidelity`). **Withdraw** is allowed only while `submitted`; an `accepted` week is Accounting's to reopen. A **Rejected** week shows Accounting's note and re-enables editing + a fresh Lock in (overwrites the rejected rows). | `DELETE …/pay-weeks?source_file=…&all=1` (submitted only) |

**Upload route:** `POST /api/orphanage-interns/hours` (multipart CSV) — `requireFeatureEdit('orphanage',
'interns')`. Validates the filename dates the week (Sun–Sat, 7 days — the same check
`run-weekly-sync.ts` makes), parses with the shared Hubstaff CSV reader, runs `rowsToInternRows`, stores
the intern rows under `source_file` (replace-in-place per file), records the upload in
`orphanage_intern_hours_uploads`, audits `orphanage_intern_hours.uploaded` with counts, and returns
`{ stored, refused: [{ email, name }] }`. **It never touches `hubstaff_hours`, `is_current`, MESA,
notifications or the seeder.** A file with zero intern rows is refused outright ("this looks like the
Simple report").

**Data pull:** `GET /api/orphanage-interns/pay-weeks/preview?source_file=…` — server reads the intern
batch (`fetchInternHoursBySourceFile`), resolves canonical weekday columns to ISO dates
with `resolveCanonicalColumnsToIso` (`calendar-column-dedupe.ts:872` — the step `current-pay.ts` does,
without which every day reads empty: `payment-dispatch.md` §4.2.1), joins profiles + rate history,
prices with `priceInternWeek`, returns rows + refusals + readiness. Gated
`requireFeatureAccess('orphanage', 'interns', 'view')`.

**Lock route:** `POST /api/orphanage-interns/pay-weeks` — `requireFeatureEdit('orphanage', 'interns')`.
**Recomputes server-side** (client numbers are never trusted), refuses on the same gates as the button,
upserts the week's rows in one batch as `submitted`, and writes one `insertAuditLog`
`orphanage_intern_pay.week_submitted` carrying every row. Refuses (409) if any row for that
`source_file` is already `accepted` — the manager cannot overwrite what Accounting has taken.

---

## 8. Profiles — the other pane of the Interns tab

**Component:** `src/components/orphanage/interns/InternsProfilesPanel.tsx`, copied from
`ThirdPartyVendorsPanel.tsx` (cards + dialogs + Refresh, pink/rose palette per
`orphanage-dashboard-standards.md`).

**Fields:** full name · `@pathway.ph` email (input hard-validates the domain and lower-cases; the server
re-checks; the DB CHECK is the last line) · personal email · phone · orphanage (directory picker) ·
status · started/ended · **rate** (current + "Change rate…" dialog asking for an **effective date**,
appends to `orphanage_intern_rates`, never edits history) · caps and PAB amount (advanced, collapsed,
defaults shown) · bank (four fields; account number **masked to last 4 server-side** on list reads, full
value only on the single-record edit read — `people-export-account-last4-and-updated`).

**API:** `app/api/orphanage-interns/route.ts` (GET, POST), `[id]/route.ts` (PATCH, DELETE),
`[id]/rates/route.ts` (POST a dated rate). Reads `requireFeatureAccess('orphanage','interns','view')`,
writes `requireFeatureEdit('orphanage','interns')`; every mutation audits (`orphanage_intern.saved` /
`.deleted` / `orphanage_intern_rate.added`). **Delete refuses** when any `orphanage_intern_pay` row exists
(FK `RESTRICT`); the UI offers **End internship** instead so paid history stays.

**RBAC wiring (all in one commit):** `FEATURE_CATALOG.orphanage` + `{ key: 'interns', label: 'Interns' }`;
`view-tabs.ts` orphanage list + `'interns'`; `OrphanageApp.tsx:194` union + `'interns'`, a nav button,
and an `{activeTab === 'interns' && …}` branch.

**Empty state says the dependency out loud:** *"Interns appear in the Pay week wizard only after they
have a profile here."*

**This pane is the only writer of intern personal data (Kane, 2026-09-02).** Name, emails, phone,
status, rate history and **bank details** change here and nowhere else. Consequences enforced in code,
not by convention:

- `PATCH /api/orphanage-interns/[id]` and `POST …/rates` are gated on the **orphanage** view's
  `interns` edit permission only. There is no Accounting-gated write to `orphanage_interns`.
- Accounting's Interns view (§9) renders profile and bank fields **read-only**, account number masked to
  last 4, with a "Managed on the Orphanage dashboard" caption instead of an edit control.
- Payment Dispatch's Mark Paid for `intern_pay` items shows the bank **snapshot from the profile** and
  **does not offer the bank pencil** that employee rows get (`mark-paid-bank-override` writes to
  `employee_ids`, which interns do not have). A wrong bank is fixed on the Orphanage dashboard and the
  item re-read, never overridden at pay time.
- Audit rows for every profile mutation name the Orphanage Manager who made it.

---

## 9. Accounting — Payroll Wizard tab → Simple | Interns toggle → Interns view

**Where:** `App.tsx` already decides what the `payroll-wizard` tab mounts (`:461-488`). It gains a
`wizardMode: 'simple' | 'interns'` state (persisted alongside `wizardVisited` —
`payroll-wizard-tab-persist`) and a segmented **Simple | Interns** control in the tab header. `simple`
mounts `<PayrollWizard>` untouched; `interns` mounts `<InternsPayrollView>`
(`src/components/accounting/interns/InternsPayrollView.tsx`). Same feature key (`payroll_wizard`), same
read-only wrapper, same Notes FAB.

**What the Interns view shows:**

- **Inbox:** every `submitted` week (grouped by `source_file`): interns, hours paid, pay, PAB, shares,
  who submitted and when. Each row is **re-priced server-side on read** from its own `hours_by_day` ×
  rate history; a disagreement with the stored amount is a red chip with the delta — the reconciliation
  rule from `orphanage-pay-step.md`, never silently rewritten.
- **Accept week** → `PATCH /api/orphanage-interns/pay-weeks/decide` `{ source_file, decision: 'accepted' }`
  → rows `accepted`, `decided_by/at` stamped, audit `orphanage_intern_pay.week_accepted`. Accepted rows
  are what `listPendingOrphanageItems` turns into Payment Dispatch items (§10).
- **Reject week** (note required) → rows `rejected` with the note; the mini wizard re-opens the week.
  Audit `orphanage_intern_pay.week_rejected`.
- **Reopen** an accepted week → back to `submitted`, **refused while any referencing `orphanage_dispatches`
  row is `paid`** (names the paid rows). Paid money is never re-priced silently
  (`paystub-staged-snapshot-stale`).
- **History:** accepted weeks with paid/pending per intern (joined from `orphanage_dispatches`).
- **Setup (gear):** the `shareMode` radio with a plain-language description of each option and the
  owner of the answer (Ellie/Ralph). Writes the config key, audited. The PAB rule is shown read-only
  ("5 paid hours every week of the PAB period · ₱1,000 · Ralph, 2026-09-02").

Gated `requireFeatureAccess('accounting', 'payroll_wizard', 'view')` for reads and
`requireFeatureEdit('accounting', 'payroll_wizard')` for decide/config/reopen.

---

## 10. Payment Dispatch — where they get paid

`listPendingOrphanageItems` (`orphanage-dispatches.ts:69`) gains a branch: every `orphanage_intern_pay`
row with `status = 'accepted'` and no referencing `orphanage_dispatches` row yields

- one `intern_pay` item — payee = the intern (bank from the profile, snapshotted onto the dispatch row
  at Mark Paid exactly as worker payments do), amount = `intern_share_php` when `share_mode =
  'system_split'`, else `gross_php`;
- one `intern_orphanage_share` item when `share_mode = 'system_split'` — payee = the orphanage
  (bank from `orphanages`), amount = `orphanage_share_php`.

`OrphanageQueue.tsx` gets an **Interns** section beside Budget / Gifts / Workers (violet accent, unused
in that queue today), the `POST /api/orphanage-dispatches` allow-list gets the two types, and the audit
row carries `intern_pay_id`. Mark Paid itself is unchanged except that intern items render the bank
snapshot **read-only** (no edit-in-dialog; personal data changes only on the Orphanage dashboard, §8). `intern_remits` mode shows the orphanage
share on the card as *"₱X owed to the orphanage by the intern"* — recorded, not dispatched.

---

## 11. Build order (each item = one reviewable commit; step-level detail lands in the superpowers plan after approval)

| # | Deliverable | Files | Proof |
|---|---|---|---|
| 1 | Segmentation (both doors) | `src/lib/interns/intern-email.ts` (+test) · `hubstaff-hours-db.ts` `rowsToPayrollRows` drops + counts interns · `app/api/hubstaff-hours/route.ts:361` · `src/lib/supabase/orphanage-intern-hours-db.ts` `rowsToInternRows` refuses non-interns | new tests: one of each domain in → payroll array holds only the Simple row, intern array holds only the intern row, each door reports the one it dropped; `npm test` |
| 2 | Migration + apply script | `references/sql/create/create_orphanage_interns.sql` · `scripts/apply-orphanage-interns-migration.mts` | `--dry` passes; `--verify` proves the three CHECKs reject; **Kane runs `--apply`** |
| 3 | Data layer | `src/lib/supabase/orphanage-interns-db.ts` (profiles + rates) · `orphanage-intern-hours-db.ts` (upload, batches, rows by file) · `orphanage-intern-pay-db.ts` — `selectAllPaged` on every list (`postgrest-1000-cap-sweep`) | mapper unit tests; masking reuses `mask-account.ts` |
| 4 | Pay + PAB + config libs | `src/lib/interns/intern-week-pay.ts` · `intern-pab.ts` · `intern-config.ts` (+tests) | the six pricing rules + the five PAB cases in §6; `weeks_missing` can never return a non-zero amount; `intern-config` parses only `shareMode` |
| 5 | Profiles API + tab | `app/api/orphanage-interns/route.ts` · `[id]/route.ts` · `[id]/rates/route.ts` · `InternsProfilesPanel.tsx` + dialogs · RBAC in `feature-permissions.ts`, `view-tabs.ts`, `OrphanageApp.tsx` | authz test: no view grant → 403; `tsc --noEmit`; screenshot via `run` |
| 6 | Intern hours upload + mini wizard | `app/api/orphanage-interns/hours/route.ts` (POST upload, GET batches) · `pay-weeks/preview/route.ts` · `pay-weeks/route.ts` (POST, DELETE) · `src/components/orphanage/interns/InternsWizard.tsx` + steps | upload of a fixture CSV with one Simple row → stored n−1, refused 1, `hubstaff_hours` row count unchanged, `is_current` unchanged; server recompute equals preview to the centavo; lock refused on each gate; 409 when accepted |
| 7 | Accounting Interns view | `app/api/orphanage-interns/pay-weeks/decide/route.ts` · `config/route.ts` · `src/components/accounting/interns/InternsPayrollView.tsx` · `App.tsx` toggle + persist | accept/reject/reopen transitions; reopen refused when paid; red chip on a hand-altered stored amount |
| 8 | Dispatch | `orphanage-dispatches.ts` types + pending branch · `app/api/orphanage-dispatches/route.ts` allow-list · `OrphanageQueue.tsx` Interns section | item appears after accept, disappears after Mark Paid; two items in `system_split`, one in `intern_remits` |
| 9 | Docs | `docs/features/orphanage-interns.md` · `docs/features/INDEX.md` row (in "PAB, orphanage & time") · memory `orphanage-interns` + `MEMORY.md` line · this file's Status → Approved / Built | same commit as #8 |

Rules of the road: `npm run lint` is `tsc --noEmit`; `npm test` is `node --import tsx --test`. Check for a
live `next dev` before any `next build` (`nextjs-build-vs-dev-shared-dir`). Stage files by explicit path;
**never push** (CLAUDE.md §Git). `.env.local` is production — read-only until Kane runs `--apply`.

---

## 12. Open questions (each says what changes with the answer)

| # | Question | Owner | What changes |
|---|---|---|---|
| ~~Q1~~ | **ANSWERED 2026-09-02 (Ralph via Kane):** 5 paid hours every week qualifies for the ₱1,000; same pay cycle and PAB period as Simple.biz. | — | Fixed in code (§6). No schedule on the profile, no PAB config switch. |
| **Q2** | The 50%: HRIS **splits** into two dispatch items (intern share → intern's bank, orphanage share → orphanage's bank; `system_split`), or the intern is paid 100% and **remits** 50% (`intern_remits`; HRIS records the obligation)? | **Ellie / Ralph** | `system_split` needs the orphanage bank columns filled in the directory and a second pending item; `intern_remits` needs neither. **Lock in is blocked until the mode is set.** |
| **Q3** | Can Accounting **edit** an intern's hours or amount in the Interns view, or only accept / reject back with a note? | Kane | Accept/reject only (recommended — one writer per number, the orphanage side; matches budget requests). Editing would need a second pricing path and an audit story. |
| ~~Q4~~ | **ANSWERED 2026-09-02 (Kane):** interns come on **their own Hubstaff report with the same columns** as the Payroll Wizard's, uploaded in the mini wizard. | — | Own table `orphanage_intern_hours` + own upload route (§5, §7); shared parser only. Never `hubstaff_hours`. |
| **Q5** | Daily cap = Manila calendar day? (The weekly cap is settled: "same pay cycle as Simple.biz" = the Sun–Sat batch week.) | Kane | Assumed yes. Only the day boundary is still an assumption. |
| **Q6** | Any **notification** to the intern (`@pathway.ph`) when paid? | Kane | Out of scope unless yes; then a plain email via the n8n Gmail pipe with a new slug, never the paystub template. |

---

## 13. The BLUEPRINT brief (Phase 2 — waits for Kane)

```
BLUEPRINT  Orphanage Interns — profiles · mini wizard · Payroll Wizard Interns view · dispatch
READ    docs/features/orphanage-pay-step.md §Two carriers (why no blob) · orphanage-pab-coverage.md
        · third-party-vendors.md §API · payment-dispatch.md §3.4.1, §4.2.1 · payroll-wizard-pab-step.md
        · csv-imports.md §Rates note · hubstaff-weekly-auto-sync.md (pull is manual)
        · memory: master-list-sync-race · hubstaff-ingest-blocklist · pab-payout-week-gate-and-pill
        · per-cycle-fx-zero-placeholder · rate-updated-at-not-evidence · postgrest-1000-cap-sweep
        · payroll-wizard-tab-persist
LIKE    orphanage_budget_requests → decide → orphanage_dispatches (manager submits, Accounting decides, clerk pays)
        · orphanage_worker_payments + OrphanageQueue.tsx (orphanage-side payee, no employee identity)
        · ThirdPartyVendorsPanel.tsx (Orphanage-dashboard CRUD tab with bank fields)
        · orphanage-pay-pricing.ts (pure pricing shared by every screen) · orphanage_pay (record keyed on source_file)
        · apply-termination-docs-migration.mts (--dry / --apply / --verify)
SCOPE   in:  isInternEmail · rowsToPayrollRows drops+counts interns (Simple's door) · orphanage_intern_hours +
             _uploads + POST /api/orphanage-interns/hours (the interns' door, refuses non-interns) ·
             orphanage_interns + orphanage_intern_rates + orphanage_intern_pay (submitted/accepted/rejected) ·
             Orphanage dashboard → Interns tab (Profiles + Pay week mini wizard) · Accounting → Payroll Wizard
             tab Simple|Interns toggle → InternsPayrollView (accept/reject/reopen, Setup) · /api/orphanage-interns/* ·
             orphanage_dispatches types intern_pay / intern_orphanage_share · OrphanageQueue Interns section ·
             orphanages bank columns
        out: PayrollWizard.tsx internals · payment_dispatches · paystub_dispatch_queue · paystub email ·
             payroll.wizard.additions.* blob · disbursement_records · MESA · global_master_list ·
             employee_hourly_rates · Payment Catalog · standard PAB/Tech engines · SSO/auth · Employee Dashboard ·
             hubstaff_hours ingest (POST /api/hubstaff-hours, is_current, its side effects)
BUILD   1. src/lib/interns/intern-email.ts                                  pure, tested
        2. src/lib/supabase/hubstaff-hours-db.ts                             rowsToPayrollRows drops + counts interns
        2b. src/lib/supabase/orphanage-intern-hours-db.ts                    rowsToInternRows refuses non-interns; paged reads
        3. references/sql/create/create_orphanage_interns.sql + scripts/apply-orphanage-interns-migration.mts
        4. src/lib/supabase/orphanage-interns-db.ts · orphanage-intern-pay-db.ts      paged reads
        5. src/lib/interns/intern-week-pay.ts · intern-pab.ts · intern-config.ts      pure, tested
        6. app/api/orphanage-interns/route.ts · [id]/route.ts · [id]/rates/route.ts
        7. src/components/orphanage/interns/InternsProfilesPanel.tsx (+dialogs) · RBAC: feature-permissions.ts, view-tabs.ts, OrphanageApp.tsx
        8. app/api/orphanage-interns/pay-weeks/{preview,route,decide,config}
        9. src/components/orphanage/interns/InternsWizard.tsx (+steps)
       10. src/components/accounting/interns/InternsPayrollView.tsx · App.tsx Simple|Interns toggle
       11. src/lib/supabase/orphanage-dispatches.ts · app/api/orphanage-dispatches/route.ts · OrphanageQueue.tsx
DATA    NEW tables orphanage_interns, orphanage_intern_rates, orphanage_intern_hours (+_uploads), orphanage_intern_pay; ALTER orphanage_dispatches
        (2 dispatch types, intern_pay_id, unique (intern_pay_id, dispatch_type)); ALTER orphanages (+4 bank cols).
        Shipped as the --apply-gated script; Kane runs it. NEW app_settings key orphanage.interns.config.
RISK    · @pathway.ph row reaches the Simple rail → one filter in rowsToPayrollRows + test; route :361 fixed
        · Simple employee in the intern file priced at ₱200 → intern upload refuses + reports non-intern rows
        · intern upload flips Simple's is_current / seeds money readers → own table + own route; never POST /api/hubstaff-hours
        · bank edited at pay time → no bank pencil on intern items; snapshot from the profile; edits only on /orphanage
        · mini wizard "looks like" the Payroll Wizard by class names only → side-by-side screenshot of both Step 1s before done
        · money moved on an undecided rule → lock in refuses while shareMode is null (FX-zero pattern)
        · PAB paid on a month with unlocked weeks → 'weeks_missing' verdict is ₱0 with a visible amber chip
        · intern PAB month drifts from Simple's → same pab-period-settings readers, never a second calendar
        · manager and Accounting see different money → one pure pricer; Accounting re-derives on read, red chip on drift
        · overwrite under Accounting's feet → submit is 409 once accepted; reopen refused once paid
        · shares drift from gross → intern share is the remainder; test asserts exact sum
        · >1000 rows someday → selectAllPaged on every list read
        · whole-object blob clobber (the 2026-08 incident) → no blob exists; the record is the carrier
DOCS    docs/features/orphanage-interns.md + INDEX row + memory orphanage-interns; this plan's status flipped
Q1      ANSWERED 2026-09-02 — 5 paid hours every week, Simple's pay cycle + PAB period. Fixed in code.
Q2      50%: system splits to two payees vs intern remits — Ellie/Ralph. Decides the 2nd dispatch item + orphanage bank.
Q3      Accounting edits hours/amounts, or accept/reject only? Recommended: accept/reject only
        (personal data + bank are already Orphanage-dashboard-only by Kane's 2026-09-02 ruling).
Q4      ANSWERED 2026-09-02 — own Hubstaff report, same columns, uploaded in the mini wizard → own table.
Q5      Daily cap = Manila calendar day? Assumed yes (weekly cap week settled by Q1's answer).
Q6      Any pay notification to the intern? Assumed no.
```

---

## TL;DR

- **Interns are a new payee class, not employees.** Own tables (`orphanage_interns`, dated
  `orphanage_intern_rates`, locked `orphanage_intern_pay`); they never touch the master list, the rates sheet,
  `payment_dispatches`, paystubs, MESA, or the Simple PAB/Tech engines. No Tech Bonus, ever.
- **Interns come on their own Hubstaff report, same columns as the Payroll Wizard's**, uploaded in the mini
  wizard into their own table. The shared parser is reused; Simple's upload path (which flips `is_current`
  and fires MESA, notifications and the seeder) is never touched.
- **One domain rule guards both doors:** `isInternEmail` (`@pathway.ph`). Simple's reader drops and counts
  any stray intern row; the intern upload refuses and reports any non-intern row.
- **No Employee Dashboard, no sign-in** for interns. The Orphanage Manager and Accounting are the only users.
- **Orphanage dashboard → Interns tab** has two panes: **Profiles** (`@pathway.ph` email, name, bank, rate with
  an effective date, caps/PAB defaults  5h/week · ₱1,000, no paperwork) and a **Pay week mini wizard**
  (upload the interns' Hubstaff CSV → capped hours × rate → intern PAB on the payout week → **Lock in** = submit).
  **Profiles is the only place intern personal data and bank details ever change.** Accounting reads only;
  Mark Paid has no bank pencil for intern items.
- **The mini wizard looks like the Payroll Wizard, smaller:** same step rail, header cards, table, "Lock in
  values" confirm dialog and replay banner, in the Orphanage pink. Verified by side-by-side screenshot.
- **Accounting → Payroll Wizard tab gets a Simple | Interns toggle.** The Interns view is an inbox of submitted
  weeks, re-priced on read; Accounting **accepts** (or rejects back with a note), and accepted rows appear in
  **Payment Dispatch → Orphanage** where the clerk marks them paid. `PayrollWizard.tsx` is not edited.
- **Intern PAB is settled (Ralph, 2026-09-02):** ₱1,000 when every Sun–Sat week of the PAB period reaches
  5 paid hours, on Simple's pay cycle and PAB period. Fixed in code, paid on the payout week only; a month
  with unlocked weeks shows an amber chip and pays ₱0.
- **Money never moves on an undecided rule.** Lock in is blocked until the 50% split mode (Q2, Ellie/Ralph)
  is set. Submitting over an accepted week is refused; reopening a paid week is refused.
- **Ship order:** segmentation → migration (`--apply` run by Kane) → data layer → pure libs → Profiles tab →
  mini wizard → Accounting view + toggle → dispatch → docs. Each its own commit, no pushes.
- **Next action:** Kane approves or revises the `BLUEPRINT` brief in §13; then the task-level
  `docs/superpowers/plans/` file is written and the build starts at item 1.
