# Bonus Catalog

An Accounting tab (renamed **Payment Catalog**) covering two concerns:

1. **Bonuses** -- author reusable custom bonuses (a flat amount or an
   Excel-style formula, in **PHP, USD, or COP**) and assign them department-wide
   ("common") or to a specific employee. As of the 2026-06 rework it is
   **database-backed** (moved off `app_settings`) so a teammate's edits show up
   live, and it ships with a real spreadsheet formula engine. A USD/COP bonus is
   converted to PHP at the live FX rate when it is **applied** (see §3), so the
   payout layer (`bonus_catalog_applied` + the Payroll Wizard) stays PHP.
2. **Pay Structures** -- the authoritative starting Regular/OT hourly rate for a
   department or an individual, in PHP, USD, or COP (see
   [§5 Pay Structures (authoritative rates)](#5-pay-structures-authoritative-rates)).

> **Currencies are USD-anchored.** USD is the conversion anchor: two rates live
> in `app_settings` -- `usd_to_php_rate` (PHP per $1) and `usd_to_cop_rate` (COP
> per $1) -- both editable in one panel in the Payroll Wizard "Initial
> Calculation" step. PHP↔COP is *derived* through USD (`php_per_cop =
> usd_to_php_rate / usd_to_cop_rate`), never stored. The generalized FX module is
> `src/lib/fx/currency-fx.ts` (`phpPerUnit`, `nativeAmountFromPhp`, `buildFxRates`).
> Internal pay math stays PHP-pivot; COP-paid people are settled natively in COP
> via a dedicated Payment Dispatch tab (`payment_dispatches.amount_cop`).

> As of 2026-06-16 the Pay Structures are **authoritative for hourly rates** and
> are wired into all pay math via a compute-time overlay
> (`src/lib/payroll/resolve-rate.ts`). Bonuses defined here still drive the
> non-HSL KPI Calculator -> `bonus_catalog_applied`, not the Wizard directly.

Code: `src/components/accounting/BonusCatalog.tsx`,
`src/lib/bonus-catalog/{types,formula}.ts`,
`src/lib/supabase/bonus-catalog-db.ts`, `app/api/bonus-catalog/route.ts`.
Pay Structures: `src/lib/payment-catalog/pay-structure.ts`,
`src/lib/payroll/resolve-rate.ts`,
`app/api/payment-catalog/pay-structures/route.ts`.
Migration: `references/create_bonus_catalog.sql`.

---

## 1. Data model

Two tables (see `references/create_bonus_catalog.sql`):

**`bonus_catalog_bonuses`** -- the bonus definitions:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `name` | text | |
| `description` | text? | |
| `kind` | text | `'flat'` \| `'formula'` |
| `amount` | numeric(14,2)? | amount (in `currency`) when `kind='flat'` |
| `formula` | text? | Excel-style expression when `kind='formula'` |
| `currency` | text | `'PHP'` (default) \| `'USD'` \| `'COP'`; USD/COP is converted to PHP at the live FX rate when the bonus is **applied** (see §3). Added by `add_bonus_catalog_currency.sql`; COP allowed by `add_cop_currency.sql`. |
| `cadence` | text | `'weekly'` (default) \| `'monthly'`. Weekly pays every payroll week it is applied; monthly pays **once**, on the month's final payroll week (see §7). Legacy rows ⇒ `'weekly'`. Added by `add_bonus_catalog_cadence.sql` (migration #103); `bonus_catalog_applied` snapshots the same column at apply time. |
| `created_by` / `created_at` | | immutable (preserved by `bonus_catalog_touch` trigger) |
| `updated_by` / `updated_at` | | |

**`bonus_catalog_assignments`** -- who each bonus applies to:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `bonus_id` | text FK -> bonuses, `ON DELETE CASCADE` | |
| `scope` | text | `'department'` \| `'employee'` |
| `department_key` | text | canonical dept key; set for both scopes |
| `employee_email` | text? | required when `scope='employee'` (lower-cased by trigger) |
| `employee_name` | text? | display name captured at assignment time |
| `created_by` / `created_at` | | |

The migration backfills the legacy `app_settings.bonus.catalog` JSON blob into
these tables once (idempotent, `created_by='migrated'`). Both tables are added to
the `supabase_realtime` publication; `BonusCatalog.tsx` subscribes to
`postgres_changes` on both and refetches on any event, so teammates' edits appear
live.

---

## 2. Formula engine (`src/lib/bonus-catalog/formula.ts`)

Excel-style expressions; a leading `=` is optional. **No cell references** (no
`A1`/`B2`) -- all identifiers are *named variables* (e.g. `tickets`, `base_rate`).

- **Operators:** `+ - * / ^` (exponent, right-assoc) and comparisons
  `= <> >= <= > <` (which yield `1`/`0`).
- **Functions:** `IF(cond,a,b)`, `MIN/MAX/SUM` (variadic), `ROUND(x,[d])`,
  `ROUNDUP`, `ROUNDDOWN`, `FLOOR(x,[step])`, `CEILING`, `AND/OR/NOT`, `ABS(x)`,
  `MOD(a,b)`. Constants `TRUE`->1, `FALSE`->0.
- **Semantics:** numeric-everywhere (Excel coercion); nonzero is truthy.
  **Division by zero -> 0** and non-finite/undefined vars -> 0, so payroll math
  never produces `Infinity`/`NaN`. The evaluator walks the AST directly -- no
  `eval()` / `Function()`.

Helpers: `validateFormula()` parses + extracts the variable list;
`compileToTypeScript()` emits an equivalent runnable TS function (shown in the
editor for devs to copy).

Example: `IF(tickets >= 10, 500, 250) * tickets` -> variables `[tickets]`; with
`tickets=15` -> `7500`.

---

## 3. UI (`BonusCatalog.tsx`)

- **Create / edit a bonus:** toggle between **Flat amount** and **Formula**
  (animated transition), plus a **PHP / USD / COP** currency toggle (same control
  as Pay Structures, driven by `PAY_CURRENCIES`) and a **Weekly / Monthly**
  cadence toggle (monthly shows the hint "Paid once a month, on the last payroll
  week of the month" — see §7). The amount input + all amount
  displays render in the chosen currency; a sky badge flags non-PHP (USD/COP)
  bonuses and an amber `CadenceBadge` flags **monthly** bonuses
  in the cards, detail modal, and assignment rows. Flat shows an amount input; Formula shows a monospace editor
  with live validation and a generated-TypeScript preview.
- **Inline tester:** for formula bonuses with variables, an `InlineTester` lets
  you type sample variable values and see the computed result (in the bonus's
  currency) in real time.
- **The manager view shows each bonus in its own currency; conversion to PHP
  happens only at save time.** The **KPI Calculator** (`DeptBonusCalculator.tsx`)
  DISPLAYS a non-PHP bonus in its native currency (`computeNative()` — no FX) so a
  US-denominated bonus reads `$X` and a Colombian one reads `COP$X`, and totals
  are kept split by currency (`Money` is a `Record<PayCurrency, number>`;
  `fmtTotals` → e.g. `₱1,200.00 · $50.00 · COP$8,000`; a single-currency
  department shows pure native). The **payout layer stays PHP**: when the manager
  saves, `saveDept()` writes the FX-converted PHP value
  (`computeAmount()` × `phpPerUnit(currency, fx)`) into
  `bonus_catalog_applied.amount`, and **that stored PHP value is what the Payroll
  Wizard "KPI Sub." sum, Bonus History, and Employee KPI Results read + pay** — it
  never re-converts. A sky tag on non-PHP columns carries a tooltip explaining the
  displayed native amount is paid in PHP at the live rate.
  > **Known limitation (display only):** the grid is a *live* projection — the
  > displayed native amount recomputes every render (it doesn't read back the
  > stored PHP `amount`), and the PHP value `saveDept` writes uses
  > `usd_to_php_rate` at save time. So if the rate changes after a USD bonus week
  > was saved, the stored/paid PHP can differ from a fresh conversion of the shown
  > dollars. This mirrors the live-recompute behavior PHP formula bonuses already
  > have; **payouts are unaffected** because the Wizard reads the stored PHP
  > snapshot. To make a saved non-live week reconcile exactly, snapshot the rate
  > on the applied row.
- **Currency-forced departments.** Some departments are paid in a fixed non-PHP
  currency regardless of each bonus's own catalog currency (e.g. US-based teams
  paid in dollars). `DeptBonusCalculator.tsx` keys this off `FORCED_DEPT_CURRENCY`
  (a `Record<string, PayCurrency>`, currently `{ us_manager_bonus: 'USD' }`) via
  `effectiveCurrency(deptKey, bonus)` — the single resolver every cell, column
  subtotal, member total, and department total funnels through. So the
  **US - Manager Bonus** department renders entirely in `$` (totals included), and
  `saveDept` converts those amounts to PHP on save exactly as an explicitly-typed
  bonus would (`computeAmount(..., effectiveCurrency(...))`), so the Payroll Wizard
  "KPI Sub." stays PHP and round-trips back to the native currency in the Payment
  Dispatch USD/COP tab. Add an entry to `FORCED_DEPT_CURRENCY` (e.g. a Colombian
  team → `'COP'`) to force more.

  > **Note (2026-06-18):** the `us_manager_bonus` department is now **labelled "US Team"** (the internal key is unchanged). All US-based staff — not just the former *US Manager Bonus* members — fold into it. See the "US Team department consolidation" section in `docs/reference/business-logic.md`.
- **Assign:** an "Add common" picker assigns a bonus department-wide; an employee
  picker (optionally filtered to one department) assigns to a single person.
  Remove via the trash icon on each assignment row.
- **Attribution:** a "by <name>" / "imported" chip per bonus; `created_by` /
  `created_at` are immutable at the DB layer.
- Optimistic updates with refetch-on-error; framer-motion for expand/collapse and
  card transitions.

---

## 4. API (`app/api/bonus-catalog/route.ts`)

| Method | Action |
|---|---|
| `GET` | `{ bonuses, assignments, error }` -- full catalog (any authenticated employee may read; tab visibility is permission-scoped). |
| `POST` | `{ type: 'bonus' \| 'assignment', bonus?, assignment? }` -- create/update; `created_by`/`updated_by` from session. Bonus payload validated via `validateBonus()`. |
| `DELETE` | `?type=bonus&id=` (cascades to assignments) or `?type=assignment&id=`. |

Visibility is governed by the `bonus_catalog` feature in the Accounting view --
see [rbac-feature-permissions.md](./rbac-feature-permissions.md).

---

## 5. Pay Structures (authoritative rates)

A **Pay Structure** (`src/lib/payment-catalog/pay-structure.ts`) is the
authoritative starting Regular + OT hourly rate, scoped either to a whole
**department** ("common") or a single **employee** ("specific"), each carrying
its own `currency` (`'PHP' | 'USD' | 'COP'`). OT is optional and defaults to `1.5x`
the regular rate (`OT_MULTIPLIER`, `defaultOtRate()`). They are stored in
`payment_catalog_pay_structures` and managed via
`app/api/payment-catalog/pay-structures/route.ts` (`GET` list / `POST` upsert /
`DELETE`, all `requireElevatedSession`).

These structures are the **source of truth for hourly rates** across the app.
HR onboarding reads department-scoped structures as the prefilled-rate source
(`src/lib/supabase/department-rates.ts`), and -- as of 2026-06-16 -- all pay
math resolves rates through them at compute time.

### 5.1 Compute-time overlay (`src/lib/payroll/resolve-rate.ts`)

The overlay is a **pure in-memory** layer -- it **never writes to the DB**. It
builds a `CatalogRateIndex` from the flat `listPayStructures()` result:

| Field | Keyed by | Holds |
|---|---|---|
| `byEmail` | normalized employee email | employee-scoped `PayStructure` |
| `byDeptKey` | canonical department key | department-scoped `PayStructure` |

(`buildCatalogRateIndex()`; later entries win on a key collision, matching
upsert-by-id semantics.)

Resolution is **two functions**, not one combined resolver:

- `resolveEmployeeCatalogRate(index, emails, fxRate)` -- the INDIVIDUAL rate.
  Tries each alias email (work / personal / alternates) against `byEmail`;
  returns `null` when the person has no personal structure.
- `resolveDeptCatalogRate(index, deptRaw, fxRate)` -- the DEPARTMENT BASE.
  Normalizes the department name to a key (`normalizeDeptToKey`) and looks it up
  in `byDeptKey`. This is the lowest-priority fallback, **not** an override.

Callers interleave the existing HRIS sheet rate themselves:

```
effective = resolveEmployeeCatalogRate(...)   // INDIVIDUAL catalog rate
         ?? sheetRate                          // SHEET / history (employee_rate_history / employee_hourly_rates)
         ?? resolveDeptCatalogRate(...)        // DEPARTMENT base (only when no sheet rate at all)
```

So the **final priority is INDIVIDUAL -> SHEET -> DEPARTMENT base**. A person's
negotiated individual rate always wins; a tenured employee with no personal
entry keeps their existing raised sheet rate; the department structure only
fills in for someone with no individual rate *and* no sheet rate (e.g. a brand-
new hire).

**Currency:** each structure resolves to a PHP-equivalent (`regPhp` / `otPhp`).
A non-PHP structure is multiplied by `phpPerUnit(currency, fx)` at compute time
(USD → `usd_to_php_rate`; COP → the USD-anchored cross-rate
`usd_to_php_rate / usd_to_cop_rate`); the native rate + `currency` are returned
alongside (`regNative` / `otNative`) for display. The resolvers now take an
`FxRates` (`{ usdToPhp, usdToCop }`) instead of a single number. The returned
`ResolvedCatalogRate.source` records which scope matched
(`'employee' | 'department'`).

### 5.2 Live-cycle-only application

Callers decide *when* to apply the overlay so historical replays/estimates stay
accurate against dated rate history:

| Consumer | When the overlay applies |
|---|---|
| `src/lib/payroll/current-pay.ts` (Payment Dispatch server mirror) | **Always** (the live dispatch cycle) |
| `src/lib/payroll/member-monthly-pay.ts` (manager + employee monthly estimate) | Only when the viewed month is **current/future** (`viewedIsCurrentOrFuture`); exposes `rateFromCatalog` on its result |
| `src/components/PayrollWizard.tsx` (client calc -> everything staged to dispatch) | Only when **`!isReplay`** |
| `app/api/employee-hourly-rates` `?email=` self-view branch (Dashboard / Profile / Mesa) | Applied to the returned "your current rate" row (PHP-equivalent) |
| `src/components/employee/EmployeeMyHours.tsx` calendar | **Indirectly** -- reads `member-monthly-pay`'s `rateFromCatalog` flag; when set, uses the catalog rate for every day and bypasses per-day history (mirrors the server). It does not call `resolve-rate.ts` directly. |

### 5.3 USD corruption fix (`syncRateHistory` in the pay-structures route)

When an **employee** structure is saved, `POST .../pay-structures` fires
`syncRateHistory()` (fire-and-forget). For **USD** structures it now **skips**
all PHP-denominated writes -- the `employee_rate_history` row, the
`employee_hourly_rates` cache, the Google Sheet rates tab, and the Hogan Pay
Plan sheet -- because writing a USD number into those PHP fields would corrupt
them (and the sheet sync would later read it back as PHP). The overlay handles
USD->PHP at pay-calc time instead. PHP structures still write all of the above.
The employee `rate.change` notification fires for **both** currencies, and the
payload now carries `currency`. Department-scoped saves never call
`syncRateHistory` at all.

### 5.4 Known gap

The admin **Rates** tab (`Rates.tsx`) still displays the cached sheet number for
catalog-covered employees because it reads the `employee_hourly_rates` cache
table directly and does not apply the overlay. This is intentional / left as-is
-- the cache is not authoritative for those rows.

---

## 6. System Bonuses (PAB + Technology Bonus)

A fourth tab (**System Bonuses**, Award icon) makes the two built-in payroll
bonuses configurable instead of hardcoded constants:

| Bonus | Was | Now |
|---|---|---|
| Perfect Attendance Bonus (`pab`) | `PAB_BONUS_PHP = 5000` constant | editable `amount` + dept allowlist |
| Technology Bonus (`tech`) | `TECH_BONUS_PHP = 1850` constant | editable `amount` + dept allowlist |

Each row has an editable **amount** (PHP), an **enabled** toggle, and a
**department allowlist** (`department_keys`) -- the bonus is only paid to
employees whose normalized department key is in the list. The seed lists every
`DEPARTMENTS` key **except `us_manager_bonus`**, so US managers (paid in USD)
no longer pick up these PHP bonuses, while every other department's behavior is
unchanged. **Timing/eligibility is NOT configurable** -- PAB still fires the
final week of the PAB period (perfect-attendance check); Tech still fires the
3rd-week salary date (30-day service check).

- **Table:** `payment_catalog_system_bonuses` (codes `pab`/`tech` as PK, `amount`,
  `currency`, `enabled`, `department_keys text[]`, audit + touch trigger, in
  `supabase_realtime`). Migration `references/create_payment_catalog_system_bonuses.sql`.
- **Model + resolver:** `src/lib/payment-catalog/system-bonus.ts` --
  `resolveSystemBonuses(rows)` → `{pab, tech}` config; `isDeptEligible(cfg, deptKey)`
  is **fail-open** when the allowlist is empty (pre-migration) or the department
  can't be normalized, so only deliberately-omitted departments are dropped.
- **DB-lib / API:** `src/lib/supabase/system-bonuses-db.ts` +
  `app/api/payment-catalog/system-bonuses/route.ts` (GET any-authed; POST gated
  by `requireFeatureEdit('accounting','bonus_catalog')`; no DELETE -- the set is fixed).
- **Threaded everywhere:** `computeEmployeeBonus` (`dispatch-bonuses.ts`) now
  accepts `pabAmountPHP`/`techAmountPHP`/`pabDeptEligible`/`techDeptEligible`
  (defaults = legacy constants + applies-to-everyone). The two server math paths
  (`current-pay.ts`, `member-monthly-pay.ts`) read `listSystemBonuses()` and pass
  the resolved values; the Payroll Wizard + Overview read the prefetched
  `initialData.systemBonuses`; the Employee Dashboard + My Hours fetch the GET
  endpoint on mount (with the legacy constants as fallback). Pass-through surfaces
  (Processor/Urgent queues, dispatch CSV) inherit the dynamic values automatically.

> The standalone "Technology Bonus" Payroll Rule was removed from **System
> Settings** -- it is managed here now.

### Bonus Library star/highlight

Each Bonus Library card has a **star** on the right (`BonusDef.starred`, column
added by `references/add_bonus_catalog_starred.sql`). Starred bonuses float to
the top of the list and render with an amber star + ring. Display-only -- it
does not affect payout.

---

## 7. Payout cadence — Weekly / Monthly *(added 2026-07-07, migration #103)*

Every catalog bonus carries a **cadence** (`BonusDef.cadence`,
`src/lib/bonus-catalog/types.ts`). Payroll runs **weekly** (one Hubstaff CSV per
week), so the cadence decides how often a bonus can be applied and paid:

| Cadence | Behaviour |
|---|---|
| `weekly` (default, legacy) | Pays every payroll week it is applied. |
| `monthly` | Pays **once** per month, on the **last payroll week of the month** — mirroring how PAB attaches only to the final weekly paystub of its period. |

**Which week is "the last payroll week"** is decided by one shared, override-free
calendar helper so the KPI Calculator and the Payroll Wizard always agree from
the pay-period Monday alone: `isFinalPayrollWeekOfMonth(mondayIso)` in
`src/lib/payroll/bonus-cadence.ts` — true when the *next* Monday-anchored week
(`Monday + 7d`) falls in a different calendar month.

**Enforcement is app-side, in three layers** (only the two `cadence` columns are
needed in the DB):

1. **Manager KPI Calculator** (`DeptBonusCalculator.tsx`) — a monthly bonus is
   filtered out of `commonByDept` / `individualByDept` in every week except the
   month's final payroll week (`isMonthlyPayWeek`). So a monthly bonus can only
   be *applied* (and thus written to `bonus_catalog_applied`) once a month. On
   non-final weeks a hint banner lists the monthly bonuses that are hidden
   (`hiddenMonthlyBonusNames`), and applied rows snapshot `cadence`.
2. **Applied-row snapshot** — `bonus_catalog_applied.cadence` records the
   definition's cadence at apply time (alongside `bonus_name` / `kind`), so the
   payout path never has to join back to the definition.
3. **Payroll Wizard** (`PayrollWizard.tsx`, KPI-Sub aggregation) — a backstop:
   an applied row with `cadence === 'monthly'` is only summed into a week's
   "KPI Sub." total when `isFinalPayrollWeekOfMonth(info.period_start)` is true.

Reads coalesce a missing `cadence` to `'weekly'` (`bonus-catalog-db.ts`,
`bonus-catalog-applied-db.ts`), so legacy rows and a pre-migration DB behave
exactly as weekly. The `/api/bonus-catalog` route passes `cadence` through
unchanged. Migration: `references/sql/alter/add_bonus_catalog_cadence.sql`
(adds `cadence` to both `bonus_catalog_bonuses` and `bonus_catalog_applied`).
