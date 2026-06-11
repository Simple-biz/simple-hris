# Bonus Catalog

An Accounting tab for authoring reusable custom bonuses -- either a flat peso
amount or an Excel-style formula -- and assigning them either department-wide
("common") or to a specific employee. As of the 2026-06 rework it is **database-
backed** (moved off `app_settings`) so a teammate's edits show up live, and it
ships with a real spreadsheet formula engine.

> Scope today: this is a **standalone authoring tool**. The bonuses defined here
> are not yet wired into the Payroll Wizard / paystubs.

Code: `src/components/accounting/BonusCatalog.tsx`,
`src/lib/bonus-catalog/{types,formula}.ts`,
`src/lib/supabase/bonus-catalog-db.ts`, `app/api/bonus-catalog/route.ts`.
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
| `amount` | numeric(14,2)? | peso amount when `kind='flat'` |
| `formula` | text? | Excel-style expression when `kind='formula'` |
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
  (animated transition). Flat shows a peso input; Formula shows a monospace
  editor with live validation and a generated-TypeScript preview.
- **Inline tester:** for formula bonuses with variables, an `InlineTester` lets
  you type sample variable values and see the computed result in real time.
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
