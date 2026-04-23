# Simple HRIS: Data Sources & Flow

## Overview

The application reads from and writes to several Supabase tables, plus a direct PostgreSQL connection for table discovery and daily report imports. This document covers every data source, its schema, the code that touches it, and how data flows between layers.

---

## Supabase Tables

### 1. `global_master_list`

The canonical employee directory. Configured via `NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE`.

**Columns used by the app (column names have spaces):**

| Column | Type | Notes |
|---|---|---|
| `Department` | text | Used for department auto-assignment in PayrollWizard |
| `Name` | text | Display name, used in ID generation + profile merge |
| `Personal Email` | text | Primary identity key for payroll matching |
| `Work Email` | text | Secondary identity key |
| `Start Date` | text/date | Used to derive `YYMM` group for employee ID generation |
| `Profile Photo URL` | text | Optional; public avatar URL |

**Primary key:** A surrogate `id` (`bigint`, identity) is recommended so bulk CSV replace can delete all existing rows in batches (see `references/supabase_global_master_list.sql`).

**Who reads it:**
- `GET /api/employees` → `src/lib/supabase/employees.ts: getEmployees()`
- `GET /api/employee-rate-profiles` → profile merge engine

**Who writes it:**
- `POST /api/add-employee` — inserts a new row
- `DELETE /api/delete-employee` — deletes by email or name match
- `POST /api/global-master-list` — CSV import (`replaceGlobalMasterListFromCsvText()` in `src/lib/supabase/global-master-list-db.ts`). Service role only. **Layout:** rows 1–2 must contain the text `MASTERLIST`; row 3 is the fixed header row (Department + Name or Personal Email); row 4+ are data. Hubstaff-style headers on row 3 are rejected. Each upload **clears the table then inserts** the CSV (full replace; `import_batch_id` is still set for reads). **Does not** write to `employee_hourly_rates`.

**Key logic in `src/lib/supabase/employees.ts`:**
- `getEmployees()` selects the core directory columns (including optional profile photo), maps with flexible key aliases (handles both snake_case and space variants), filters blank rows, sorts by name.
- `generateEmployeeIds()` groups the result by `YYMM` (derived from `Start Date`), sorts each group alphabetically by first name, then assigns a 4-digit serial: `YYMM-0001`, `YYMM-0002`, etc. These IDs are **display-only and never persisted**.

---

### 2. `employee_hourly_rates`

Per-employee rate table. Configured via `NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE`.

**Columns used:**

| Column | Type | Notes |
|---|---|---|
| `Work Email` | text | Primary lookup key |
| `Personal Email` | text | Fallback lookup key |
| `Name` | text | Display / merge fallback |
| `Regular Rate` | numeric | Hourly regular pay rate (₱) |
| `OT Rate` | numeric | Hourly overtime pay rate (₱) |
| `Department` | text | Used for department assignment fallback |

**Who reads it:**
- `GET /api/employee-hourly-rates` → `src/lib/supabase/employee-hourly-rates.ts: getEmployeeHourlyRatesRows()`
- `GET /api/employee-rate-profiles` → profile merge engine

**Who writes it:**
- `POST /api/add-employee` — inserts a new row
- `DELETE /api/delete-employee` — deletes by email or name
- `POST /api/update-employee-rates` — updates `Regular Rate` + `OT Rate` by email

**Key logic in `src/lib/supabase/employee-hourly-rates.ts`:**
- `indexHourlyRatesByEmail()` builds a `Map<normalizedEmail, row>` that indexes **both** work and personal emails. This is the lookup used by PayrollWizard Step 2 to find rates for each Hubstaff row.
- `updateEmployeeRates()` prefers the service-role client (bypasses RLS) over anon.

---

### 3. `hubstaff_hours`

The weekly Hubstaff export. Replaced entirely on each upload. Configured via `NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE`.

**Columns (mirrored from Hubstaff CSV export):**

| Column | Type | Notes |
|---|---|---|
| `Member` | text | Employee display name |
| `Email` | text | Hubstaff account email |
| `Total worked` | text | Hours in `H:MM:SS` format |
| `Organization` | text | Hubstaff org name |
| `Time Zone` | text | Member's timezone |
| `Activity (%)` | text | Activity percentage |
| `Spent` | text | Billable amount |
| `Mon MM/DD` ... `Sun MM/DD` | text | Per-day hours (dynamic column names) |
| `Job Title` | text | From Hubstaff profile |
| `Job Type` | text | Used as last-resort department fallback |

**Who reads it:**
- `GET /api/hubstaff-hours` — service role: all columns in DB order; anon: payroll-focused columns only

**Who writes it:**
- `POST /api/hubstaff-hours` — full replace via `replaceHubstaffHoursFromCsvText()`

**Key logic in `src/lib/supabase/hubstaff-hours-db.ts`:**
- `fetchHubstaffRowsOrdered()`: Paginates 1,000 rows at a time (Supabase default limit), derives column order from the first row or the OpenAPI spec.
- `replaceHubstaffHoursFromCsvText()`:
  1. Deletes all existing rows (`.not('id', 'is', null)` filter — deletes everything).
  2. Parses incoming CSV text via `csv-parse/sync`.
  3. **Two-pass column mapping** against the DB schema (fetched from PostgREST OpenAPI spec):
     - **Pass 1 — Exact match**: CSV header `toLowerCase()` === DB column `toLowerCase()`. Handles fixed columns like `"Email"`, `"Total worked"`, `"Activity"`.
     - **Pass 2 — Date-aware match**: For any DB column that is an ISO date (`2026-03-24`) and any unmatched CSV header that contains a date (`"Mon 3/24"`, `"Monday 3/24/2026"`), `csvColToIsoDate()` parses both to ISO strings and maps them if they resolve to the same calendar date. This is critical because Hubstaff CSVs use `"Mon M/D"` headers while the Supabase table may have ISO column names.
     - **Fallback**: If the OpenAPI spec is unreachable, CSV headers are used directly as column names (minus `id`).
  4. Batch-inserts 50 rows at a time.
- `csvColToIsoDate()`: Parses Hubstaff date column headers (`"Mon 3/24"`, `"Tue 3/25/26"`, `"2026-03-24"`) into ISO date strings for the date-aware mapping pass. Defaults to the current year when the CSV header omits it.
- `rowsToPayrollRows()`: Converts raw DB rows to `PayrollHubstaffRow[]`, calling `parseHoursToDecimal()` on `Total worked`.

**Hours parsing (`src/lib/supabase/hubstaff-hours.ts`):**
- `parseHoursToDecimal()` handles three formats: `H:MM:SS`, `H:MM`, and plain decimal strings.
- All internal arithmetic uses **integer seconds** to avoid floating-point errors. Decimal hours are only produced for display.

---

### 4. `employee_ids` (optional)

An explicit `employee_id → email` mapping table for cases where the auto-generated YYMM-NNNN ID needs to be overridden.

**Columns:**

| Column | Type |
|---|---|
| `employee_id` | text |
| `name` | text |
| `work_email` | text |
| `personal_email` | text |

**Who reads it:**
- `GET /api/employee-ids` → `src/lib/supabase/employee-ids.ts: getEmployeeIds()`
- `buildEmployeeIdMap()` creates a `Map<normalizedEmail, employee_id>` used in the Rates view to display IDs.

---

### 5. Extra Profile Tables (optional, configurable)

Any number of additional tables can be merged into the employee profile view by listing them in `SUPABASE_PROFILE_TABLES` (comma-separated). The `import-daily-report` route creates tables in a separate `hubstaff_hours` schema, which may also be merged.

**Profile merge logic (`src/lib/supabase/employee-rate-profiles.ts`):**

The merge engine runs in five phases:

1. **Fetch**: All tables in the merge list are fetched in parallel.
2. **Key building**: `employee_hourly_rates` rows are indexed by email (both work + personal) as the anchor.
3. **Master list join**: Each anchor row is matched to `global_master_list` by personal email, then work email, then name.
4. **Extra table join**: Each extra table row is matched to the anchor by any email column or by name.
5. **Field deduplication**: All matched fields are merged into a single flat object. `normFieldKey()` normalizes field names to `snake_case` to collapse duplicates (e.g., `"Work Email"` and `work_email` become the same key).
6. **Finalization**: `finalizeProfileFields()` drops noisy internal fields (`teamindex`, `created_at`), extracts `department` into the profile header, and collapses all email columns into a subtitle string.

**Display name resolution** (in priority order):
1. Hubstaff `Member` name
2. Master list `Name`
3. Rates table `Name`
4. Email address as fallback

**Profile `id` format**: `e:<work_email>` or `e:<personal_email>` or `row:<index>`.

---

## API Routes

All routes are `export const dynamic = "force-dynamic"` (no caching).

| Route | Method | Auth Level | Handler Location |
|---|---|---|---|
| `/api/employees` | GET | Anon | `src/lib/supabase/employees.ts` |
| `/api/global-master-list` | GET | Service role required | `src/lib/supabase/global-master-list-db.ts` |
| `/api/global-master-list` | POST | Service role required | `src/lib/supabase/global-master-list-db.ts` |
| `/api/employee-hourly-rates` | GET | Anon | `src/lib/supabase/employee-hourly-rates.ts` |
| `/api/employee-rate-profiles` | GET | Service role preferred | `src/lib/supabase/employee-rate-profiles.ts` |
| `/api/employee-ids` | GET | Anon | `src/lib/supabase/employee-ids.ts` |
| `/api/hubstaff-hours` | GET | Service role preferred; anon fallback returns same JSON shape | `src/lib/supabase/hubstaff-hours-db.ts` |
| `/api/hubstaff-hours` | POST | Service role required | `src/lib/supabase/hubstaff-hours-db.ts` |
| `/api/add-employee` | POST | Service role preferred | Both tables |
| `/api/delete-employee` | DELETE | Service role preferred | Both tables |
| `/api/update-employee-rates` | POST | Service role preferred | `employee_hourly_rates` |
| `/api/update-employee-profile` | POST | Service role preferred | Both tables |
| `/api/app-settings` | GET/POST | Anon read; service role preferred write | `app_settings` table |
| `/api/import-daily-report` | POST | `DATABASE_URL` (pg direct) | `src/lib/supabase/import-daily-report.ts` |

---

## Direct PostgreSQL Access (pg Pool)

Two lib files bypass Supabase and use `pg` Pool directly with `DATABASE_URL`:

**`src/lib/supabase/list-public-tables.ts`**
- Queries `information_schema.tables` for all `BASE TABLE` rows in `public` schema.
- Used by the profile merge engine to discover which tables exist.
- Returns `null` if `DATABASE_URL` is not set (graceful degradation).

**`src/lib/supabase/import-daily-report.ts`**
- Creates the `hubstaff_hours` schema if it does not exist.
- Drops and recreates a table named `dr_<sanitized_filename>`.
- Inserts CSV rows in batches of 50.
- Grants `SELECT` to `anon` and `authenticated` roles.
- Used by `POST /api/import-daily-report` for importing per-day Hubstaff exports as separate tables.

---

## Data Flow Diagram

```
User uploads CSV
        │
        ▼
Browser: SHA-256 hash check (dedup guard)
        │
        ├──────────────────────────────────────┐
        ▼                                      ▼
POST /api/hubstaff-hours              Browser: parseCsv(csvText)
        │                              (client-side re-parse)
        ▼                                      │
replaceHubstaffHoursFromCsvText()              ▼
  ├─ Delete all existing rows         Sets hubstaffDisplayColumns
  ├─ Parse CSV (csv-parse/sync)       Sets hubstaffDisplayRows
  ├─ Pass 1: exact column match         (with real daily values)
  ├─ Pass 2: date-aware column match         │
  └─ Batch insert 50 rows                   ▼
        │                             Drives PA detection +
        ▼                             Step 1 preview table
hubstaff_hours table (Supabase)
  (daily data stored if dates match)


PayrollWizard Step 2 (Initial Calc)
        │
        ├─ GET /api/hubstaff-hours  → rowsToPayrollRows()
        │                              └─ parseHoursToDecimal()
        │                                 └─ rawValueToTotalSeconds() → integer seconds
        │
        ├─ GET /api/employee-hourly-rates → indexHourlyRatesByEmail()
        │
        └─ For each Hubstaff row:
             normalizeEmail(row.email)
             → lookup in rate map
             → regularHours = min(totalHours, 40)
             → otHours = max(0, totalHours - 40)
             → regularPay = regularHours × regularRate
             → otPay = otHours × otRate
             → initialPay = regularPay + otPay


Department Assignment (Step 3)
        │
        ├─ 1st: personal_email → global_master_list lookup → Department
        ├─ 2nd: name match → global_master_list → Department
        ├─ 3rd: work_email → global_master_list → Department
        └─ 4th: Hubstaff row "Job type" field (last resort)


Pre-Flight Validation (Step 4)
        │
        └─ comparePayrollToMaster()
             ├─ Build Set of master personal emails
             ├─ Map Hubstaff emails → max hours
             ├─ Count: on master with hours / on master without hours / Hubstaff-only
             └─ Return stats + up to 75 sample unmatched emails
```

---

## CSV Upload: Deduplication Guard

`src/lib/hash.ts` uses the browser's `crypto.subtle.digest("SHA-256")` API to hash the raw bytes of any uploaded CSV file. The hash is stored in component state after a successful upload. On the next upload attempt, if the new file's hash matches the stored hash, the app shows an approval dialog warning the user they are re-uploading identical data. The user can proceed or cancel.

---

## Email Normalization

`src/lib/email/norm-email.ts` applies `s?.trim().toLowerCase() || null` to every email before it is used as a lookup key. This single-line function is called consistently across all matching logic (rate lookup, master list join, profile merge, employee ID map) to prevent case and whitespace mismatches.

---

## PAB Data Flow: Canonical Column Resolution

Hubstaff source files are uploaded as weekly CSVs with names like `simple-biz_daily_report_2026-03-01_to_2026-03-07.csv`. When stored in Supabase, the daily hour columns use **canonical names** (`monday`, `tuesday`, etc.) rather than dated column headers.

This creates a problem for full-month PAB evaluation: merging multiple weekly source files naively causes each file's `monday` value to overwrite the previous one.

### Resolution logic (`src/lib/hubstaff/calendar-column-dedupe.ts`)

1. **`parseDateRangeFromFilename(filename)`** — Extracts the start/end dates from the source filename (regex: `YYYY-MM-DD_to_YYYY-MM-DD`).

2. **`columnsAreAllCanonical(cols)`** — Returns `true` if all day-type columns are canonical names (`monday`, `tuesday`, etc.) with no parseable ISO or Hubstaff-format dates.

3. **`resolveCanonicalColumnsToIso(row, filename)`** — When canonical columns are detected, maps each day name to its actual ISO date within the file's date range:
   - Iterates from `start` to `end`, building a `day-of-week → ISO date` map
   - Replaces `monday` → `2026-03-02`, `tuesday` → `2026-03-03`, etc.
   - Non-day columns (`Email`, `Total worked`, etc.) pass through unchanged

4. **Merge across files** — Each source file's row is resolved independently before merging. The merged row accumulates ISO-date columns across all weeks without collision:
   ```
   File 1 (Mar 1–7):  monday → 2026-03-02, tuesday → 2026-03-03, ...
   File 2 (Mar 8–14): monday → 2026-03-09, tuesday → 2026-03-10, ...
   Merged: { "2026-03-02": "8:30:00", "2026-03-03": "7:15:00", ..., "2026-03-09": "8:00:00", ... }
   ```

5. **`inferPabMonthFromColumns(cols)`** — Now successfully identifies the target month from the resolved ISO columns, enabling `getPabMonthRange()` to compute the PAB period.

This resolution happens in both `EmployeeDashboard.tsx` (PAB merge `useEffect`) and `PayrollWizard.tsx` (`mergeRowsInto` function).

---

## Employee Dashboard: All Time Accumulation

When the "All Time" file selector option is chosen, the dashboard aggregates data from all uploaded source files:

1. **Total seconds**: Sum of each file's `Total worked` value.
2. **Regular/OT split**: Each file's hours are split at the 40h threshold independently, then the regular and OT seconds are summed separately. This prevents a re-split of the combined total from incorrectly allocating hours (e.g., two 42h files = 80h regular + 4h OT, not 40h regular + 40h OT).
3. **PAB bonus**: `pabEligibleCount` (currently single-month) × ₱5,000.
4. **Pay Summary**: Total = Regular Pay + OT Pay + PAB bonus.
5. **Daily Hours & PAB Calendar**: Show the latest file / full month respectively (unaffected by All Time).
