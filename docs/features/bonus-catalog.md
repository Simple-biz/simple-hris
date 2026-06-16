# Bonus Catalog

An Accounting tab (renamed **Payment Catalog**) covering two concerns:

1. **Bonuses** -- author reusable custom bonuses (a flat amount or an
   Excel-style formula, in **PHP or USD**) and assign them department-wide
   ("common") or to a specific employee. As of the 2026-06 rework it is
   **database-backed** (moved off `app_settings`) so a teammate's edits show up
   live, and it ships with a real spreadsheet formula engine. A USD bonus is
   converted to PHP at the live FX rate when it is **applied** (see §3), so the
   payout layer (`bonus_catalog_applied` + the Payroll Wizard) stays PHP.
2. **Pay Structures** -- the authoritative starting Regular/OT hourly rate for a
   department or an individual, in PHP or USD (see
   [§5 Pay Structures (authoritative rates)](#5-pay-structures-authoritative-rates)).

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
| `currency` | text | `'PHP'` (default) \| `'USD'`; USD is converted to PHP at the live FX rate when the bonus is **applied** (see §3). Added by `add_bonus_catalog_currency.sql`. |
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
  (animated transition), plus a **PHP / USD** currency toggle (same control as
  Pay Structures). The amount input + all amount displays render in the chosen
  currency; a sky **USD** badge flags USD bonuses in the cards, detail modal, and
  assignment rows. Flat shows an amount input; Formula shows a monospace editor
  with live validation and a generated-TypeScript preview.
- **Inline tester:** for formula bonuses with variables, an `InlineTester` lets
  you type sample variable values and see the computed result (in the bonus's
  currency) in real time.
- **Currency conversion happens at apply time, not here.** A USD bonus stores its
  native USD `amount`; the **KPI Calculator** (`DeptBonusCalculator.tsx`) fetches
  the live `usd_to_php_rate` and multiplies USD bonuses by it inside
  `computeAmount()` — the single chokepoint every projected total and the saved
  `bonus_catalog_applied.amount` flow through — so the applied row, the Payroll
  Wizard "KPI Sub." sum, Bonus History, and Employee KPI Results all stay PHP. The
  converted PHP value is snapshotted into `bonus_catalog_applied.amount` at save
  time, and **that stored value is what the Wizard pays** — it never re-converts.
  The calculator shows a sky `$X` / `USD` tag on USD bonus columns; the grid
  figures are the FX-converted pesos.
  > **Known limitation (display only):** the calculator grid is a *live*
  > projection — it recomputes `computeAmount(bonus, vars, usd_to_php_rate)` at
  > the current rate every render (it doesn't read back the stored `amount`). So
  > if `usd_to_php_rate` changes after a USD bonus week was saved, re-opening that
  > past week shows a peso figure that differs from the stored/paid amount. This
  > is the same live-recompute behavior PHP formula bonuses already have (editing a
  > catalog formula changes the projection until re-saved); **payouts are
  > unaffected** because the Wizard reads the stored PHP snapshot. To make the
  > historical display match exactly, snapshot the rate on the applied row and
  > render the stored amount for saved non-live weeks.
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
its own `currency` (`'PHP' | 'USD'`). OT is optional and defaults to `1.5x`
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
A USD structure is multiplied by the FX rate at compute time; the native rate +
`currency` are returned alongside (`regNative` / `otNative`) for display. The
returned `ResolvedCatalogRate.source` records which scope matched
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
