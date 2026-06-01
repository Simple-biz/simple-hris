# Simple HRIS: API Reference

Complete documentation for all REST API endpoints. Base URL: `http://localhost:3000` (development).

> **Auth status** (as of 2026-04-21): most endpoints are still **unauthenticated** pending SSO. The PAB dispute decide/edit endpoints (`PATCH /api/pab-disputes/[id]`) enforce server-side role-based access via `canActOnDisputes(email)` — caller must hold an active role from `DISPUTE_ACTOR_ROLES` in `employee_roles`. Orphanage-visit endpoints still trust a client-supplied `admin_name` (auth gap). See [IMPLEMENTATION_PLAN_RBAC.md](../implementation-plans/implementation-plan-rbac.md) and [AUDIT_2026-04-21.md](../audits/audit-2026-04-21.md) for the full picture.

> **Google Sheet sync endpoints** (`/api/cron/sync-master-from-sheet`, `/api/cron/sync-rates-from-sheet`) and the new **`?uploads=1`** GET shapes on the master + rates upload routes are documented inline below. For the full feature picture (Admin tab, env setup, ingest fixes, troubleshooting), see [csv-imports.md](../features/csv-imports.md).

---

## Table of Contents

1. [Employees](#1-employees)
2. [Employee Hourly Rates](#2-employee-hourly-rates)
3. [Employee IDs & Bank Info](#3-employee-ids--bank-info)
4. [Employee Rate Profiles](#4-employee-rate-profiles)
5. [Employee Profile Photo](#5-employee-profile-photo)
6. [Hubstaff Hours](#6-hubstaff-hours)
7. [App Settings](#7-app-settings)
8. [Import Daily Report](#8-import-daily-report)
9. [Avatar (Gravatar)](#9-avatar-gravatar)
10. [PAB Day Disputes](#10-pab-day-disputes)
11. [Payment Dispatches](#11-payment-dispatches)
12. [Disbursement Reports](#12-disbursement-reports)
12.5. [Leave Requests](#125-leave-requests)
12.7. [Admin Diagnostics](#127-admin-diagnostics)
13. [Planned Endpoints (Payroll Automation)](#13-planned-endpoints-payroll-automation)

---

## 1. Employees

### `GET /api/employees`

Fetches all employees from the `global_master_list` table.

**Query Parameters**:
- `email` *(optional, added 2026-05-14)* — when provided, returns just the matching employee (1-row array) instead of the full roster. Matched against Work Email then Personal Email (case-insensitive). Tries the active roster first so `employee_id` reflects the same-month serial numbering; falls back to `global_master_list` for people not on the current upload. Used by the employee portal to avoid downloading the whole table for self-lookup.

**Response** `200`:
```json
{
  "employees": [
    {
      "name": "Fran M",
      "department": "HR",
      "personal_email": "franm@simple.biz",
      "work_email": "fran@company.com",
      "start_date": "2024-11-01",
      "employee_id": "2411-0001",
      "profile_photo_url": "https://..."
    }
  ],
  "error": null
}
```

**Error Response** `200`:
```json
{
  "employees": [],
  "error": "Error message"
}
```

**Tables**: Reads `global_master_list`
**Service Role**: Not required

---

### `POST /api/global-master-list`

Imports the configured employees table (`NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE`, default `global_master_list`) from an uploaded CSV. Same transport as Hubstaff: `multipart/form-data` with field `file` (CSV). Requires **`SUPABASE_SERVICE_ROLE_KEY`**. The table must have a bigint **`id`** primary key. Each upload **deletes all rows in the table, then inserts** the CSV; when **`import_batch_id`** exists, the new rows get the next batch id (after a wipe, typically `1`). Legacy tables without `import_batch_id` use the same clear-then-insert behavior.

**CSV layout (strict):**

1. **Rows 1–2** (first two lines): at least one cell must contain the text **`MASTERLIST`** (case-insensitive) so only the MASTERLIST export is accepted—not Hubstaff or other sheets.
2. **Row 3** is the **header** row (Department, Name, Personal Email, Work Email, Start Date, …).
3. **Row 4 onward** are data rows. Row 3 is rejected if it looks like a Hubstaff weekly header (e.g. Member + Email + Total worked without Department).

**Request**: `multipart/form-data` — field `file` = CSV file.

**Response** `200`:
```json
{
  "success": true,
  "rowCount": 120,
  "inserted": 12,
  "updated": 108,
  "rowsMissingPersonalEmail": 0,
  "duplicatesInCsv": 3,
  "uploadId": "2fd56fde-08bb-4608-80cb-77246260e5bb",
  "ratesReconcile": {
    "masterCount": 120,
    "ratesCount": 115,
    "ratesFewerThanMaster": true,
    "hint": "employee_hourly_rates has 5 fewer rows than the master list — add or sync rates for payroll."
  }
}
```

`ratesReconcile` may be `null` if counts could not be read after import. `duplicatesInCsv` *(added 2026-05-07)* counts CSV rows that shared a `(personal_email, department)` key with another CSV row — last occurrence wins; earlier ones are silently dropped instead of triggering the partial unique index.

**Tables**: Writes `global_master_list` + a new row in `master_list_uploads` (promoted to `is_current`). Does **not** change `employee_hourly_rates`.

**Service Role**: Required

---

### `GET /api/global-master-list`

**Without query string** — lightweight check that the service role can read row counts on the master and rates tables. No file upload.

**Response** `200`: `{ "ok": true, "masterCount": 120, "ratesCount": 115, "masterError": null, "ratesError": null }`

**With `?uploads=1`** *(added 2026-05-07)* — returns archived `master_list_uploads` rows newest-first. Powers the **Files** tab → Master list section in the Admin → CSV imports UI.

**Response** `200`:
```json
{
  "uploads": [
    {
      "id": "2fd56fde-…",
      "source_file": "google-sheet:1ModkjXlI2_K…@2026-05-07 17:41:19 UTC",
      "uploaded_at": "2026-05-07T17:41:38.083906+00:00",
      "uploaded_by": null,
      "row_count": 784,
      "is_current": true
    }
  ],
  "error": null
}
```

**Service Role**: Required

---

### `POST /api/cron/sync-master-from-sheet` *(added 2026-05-07)*

Manual-button-only Google Sheet sync for the master list. Reads the configured Google Sheet via service-account JWT, builds a CSV that `replaceGlobalMasterListFromCsvText()` accepts (auto-detects the header row, prepends two synthetic `MASTERLIST` sentinel rows), and pipes it through the same ingest as `POST /api/global-master-list`. **No daily cron** — `vercel.json` has no schedule for this path despite the legacy URL segment. Both `GET` and `POST` accepted.

**Auth**: if `CRON_SECRET` env var is set, requires `Authorization: Bearer <secret>`; otherwise open. The in-app button posts without that header, so leave `CRON_SECRET` unset (or wire session auth) to keep the button working.

**Required env**: `GOOGLE_SHEETS_MASTER_SHEET_ID`, `GOOGLE_SHEETS_MASTER_TAB_NAME`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

**Response** `200`:
```json
{
  "success": true,
  "sheetId": "1ModkjXlI2_KoiRVpxCo202oTxdZsVLlvCrd_547IKsQ",
  "tabName": "MASTERLIST",
  "totalRows": 786,
  "dataRows": 784,
  "headerRowIndex": 2,
  "headerColumns": ["Department", "Name", "Personal Email", "Work Email", "Start Date", "..."],
  "apiRowCount": 786,
  "rowCount": 781,
  "inserted": 24,
  "updated": 757,
  "rowsMissingPersonalEmail": 0,
  "duplicatesInCsv": 3,
  "uploadId": "…"
}
```

Emits `[fetch-master-sheet]` and `[sync-master-from-sheet] result` console diagnostics for debugging row drops. Audit log entry `csv.master.sync` (or `csv.master.sync.error` on failure).

See [csv-imports.md](../features/csv-imports.md) for the full feature doc.

---

### `POST /api/add-employee`

Creates a new employee in both `employee_hourly_rates` and `global_master_list`.

**Request Body** `application/json`:
```json
{
  "name": "John Doe",
  "department": "HR",
  "workEmail": "john@company.com",
  "personalEmail": "john@gmail.com",
  "startDate": "2026-01-15",
  "regularRate": "125.00",
  "otRate": "187.50"
}
```

| Field | Type | Required |
|---|---|---|
| `name` | string | Yes |
| `workEmail` | string | At least one email required |
| `personalEmail` | string | At least one email required |
| `department` | string | No |
| `startDate` | string | No |
| `regularRate` | string | No |
| `otRate` | string | No |

**Response** `200`:
```json
{ "success": true }
```

**Error Response** `400`:
```json
{ "error": "Name and at least one email are required." }
```

**Tables**: Writes to `employee_hourly_rates` + `global_master_list`
**Service Role**: Required (falls back to anon)

---

### `DELETE /api/delete-employee`

Removes an employee from both `employee_hourly_rates` and `global_master_list`.

**Request Body** `application/json`:
```json
{
  "workEmail": "john@company.com",
  "personalEmail": "john@gmail.com",
  "name": "John Doe"
}
```

| Field | Type | Required |
|---|---|---|
| `workEmail` | string | At least one identifier required |
| `personalEmail` | string | At least one identifier required |
| `name` | string | Fallback identifier |

**Response** `200`:
```json
{ "success": true }
```

**Error Response** `400`:
```json
{ "error": "At least one identifier (work email, personal email, or name) is required." }
```

**Deletion order**:
- `employee_hourly_rates`: matches by `Work Email`, falls back to `Personal Email`
- `global_master_list`: matches by `Personal Email`, falls back to `Name`

**Tables**: Deletes from `employee_hourly_rates` + `global_master_list`
**Service Role**: Required (falls back to anon)

---

### `POST /api/update-employee-profile`

Updates employee demographic fields (not rates) in both tables.

**Request Body** `application/json`:
```json
{
  "originalWorkEmail": "old@company.com",
  "originalPersonalEmail": "old@gmail.com",
  "name": "Updated Name",
  "department": "New Dept",
  "workEmail": "new@company.com",
  "personalEmail": "new@gmail.com",
  "startDate": "2026-02-01"
}
```

| Field | Type | Required |
|---|---|---|
| `originalWorkEmail` | string | At least one original email required |
| `originalPersonalEmail` | string | At least one original email required |
| `name` | string | No |
| `department` | string | No |
| `workEmail` | string | No |
| `personalEmail` | string | No |
| `startDate` | string | No |

**Response** `200`:
```json
{ "success": true }
```

**Tables**: Updates `employee_hourly_rates` + `global_master_list`
**Service Role**: Required (falls back to anon)

---

## 2. Employee Hourly Rates

### `GET /api/employee-hourly-rates`

Fetches all rows from the `employee_hourly_rates` table.

**Query Parameters**:
- `email` *(optional, added 2026-05-14)* — server-side ilike filter on `"Work Email"` then `"Personal Email"`. Returns a 1-row array (or empty). Used by the employee portal to avoid downloading every rate row just to read its own.

**Response** `200`:
```json
{
  "rows": [
    {
      "work_email": "john@company.com",
      "personal_email": "john@gmail.com",
      "department": "HR",
      "regular_rate": "125.00",
      "ot_rate": "187.50"
    }
  ],
  "error": null
}
```

**Tables**: Reads `employee_hourly_rates`
**Service Role**: Not required

---

### `POST /api/update-employee-rates`

Updates the regular and overtime pay rates for an employee.

**Request Body** `application/json`:
```json
{
  "workEmail": "john@company.com",
  "personalEmail": "john@gmail.com",
  "regularRate": 150.00,
  "otRate": 225.00,
  "effectiveDate": "2026-05-21"
}
```

| Field | Type | Required |
|---|---|---|
| `workEmail` | string | At least one email required |
| `personalEmail` | string | At least one email required |
| `regularRate` | number/string | Yes |
| `otRate` | number/string | Yes |
| `effectiveDate` | string (YYYY-MM-DD) | No — defaults to today |

**Effective-date semantics** *(added 2026-05-15)*:
- Always inserts a row into `employee_rate_history` with the given `effective_from`. Past dates are allowed (retroactive prorating).
- If `effectiveDate <= today` → also updates the `employee_hourly_rates."Regular Rate"`/`"OT Rate"` cache + invalidates the rate-profiles cache.
- If `effectiveDate > today` → cache stays old; payroll compute (`current-pay.ts`, `member-monthly-pay.ts`) reads from history table per day, so the new rate naturally kicks in on the effective date.
- Notification (`employee_notifications`) is always written; tone is `positive` when any rate ticked up, `neutral` otherwise. Message reflects scheduled vs. immediate.

**Response** `200`:
```json
{ "success": true, "effective_from": "2026-05-21", "applied_to_cache": false }
```

**Tables**: `employee_hourly_rates` (conditional), `employee_rate_history` (always), `employee_notifications`, `audit_log`
**Service Role**: Yes

---

### `POST /api/employee-hourly-rates-upload`

Imports the **All-Dept payroll dashboard CSV** into `employee_hourly_rates`. Multipart `file=<csv>`. Reads only 5 columns by header: `Work Email`, `Personal Email`, `Week`, `Regular Rate`, `OT Rate`. Multiple weekly rows per employee are expected — the function picks the row with the latest parsed `Week M/D/YY - M/D/YY` value per work email. **Recent fixes (2026-05-07)**: existing-row lookup is now a single full-table SELECT with case-insensitive in-memory matching (was a chunked case-sensitive `.in()`); UPDATEs run in parallel chunks of 20 (was sequential).

**Response** `200`:
```json
{
  "success": true,
  "rowCount": 1062,
  "uploadId": "5b671c02-…",
  "inserted": 12,
  "updated": 1050,
  "uniqueEmployees": 1062,
  "skippedNoWorkEmail": 0,
  "skippedNoRate": 3
}
```

**Tables**: Writes `employee_hourly_rates` + new row in `rates_uploads` (promoted to `is_current`).
**Service Role**: Required

---

### `GET /api/employee-hourly-rates-upload?uploads=1` *(added 2026-05-07)*

Returns archived `rates_uploads` rows newest-first. Powers the **Files** tab → Payroll rates section in the Admin → CSV imports UI. Calling without `?uploads=1` returns 400 — the route does not expose any other GET shape.

**Response** `200`: identical schema to `GET /api/global-master-list?uploads=1`.

---

### `POST /api/cron/sync-rates-from-sheet` *(added 2026-05-07)*

Manual-button-only Google Sheet sync for the rates ledger. Reads the configured Google Sheet via the same service-account auth as the master list sync, expects headers on row 1 (no sentinel synthesis — rates have no `MASTERLIST` analogue), and pipes the resulting CSV through `replaceEmployeeHourlyRatesFromCsv()`.

**Required env**: `GOOGLE_SHEETS_RATES_SHEET_ID`, `GOOGLE_SHEETS_RATES_TAB_NAME`, plus the shared `GOOGLE_SHEETS_SERVICE_ACCOUNT_*` and `SUPABASE_SERVICE_ROLE_KEY`.

**Response** `200`: same shape as the master sync but with the rates ingest result fields (`uniqueEmployees`, `skippedNoWorkEmail`, `skippedNoRate`).

Audit log entry `csv.rates.sync` (or `csv.rates.sync.error` on failure). See [csv-imports.md](../features/csv-imports.md).

---

## 3. Employee IDs & Bank Info

### `GET /api/employee-ids`

Fetches all employee IDs and bank information from the `employee_ids` table.

**Query Parameters**:
- `email` *(optional, added 2026-05-14)* — server-side ilike filter on `work_email` then `personal_email`. Returns a 1-row array (or empty). Used by the employee portal (Profile page) to avoid downloading every employee_ids row.

**Response** `200`:
```json
{
  "rows": [
    {
      "employee_id": "2411-0001",
      "name": "John Doe",
      "work_email": "john@company.com",
      "personal_email": "john@gmail.com",
      "bank_name": "BDO",
      "account_holder_name": "John Doe",
      "account_number": "1234567890",
      "routing_number": "001",
      "alt_bank_name": null,
      "alt_account_holder_name": null,
      "alt_account_number": null,
      "alt_routing_number": null
    }
  ],
  "error": null
}
```

**Tables**: Reads `employee_ids`
**Service Role**: Not required

> **Security note**: This endpoint exposes full bank account numbers. Will require `employee` (own row) or `payroll_manager`+ role after RBAC is implemented.

---

### `POST /api/update-employee-ids`

Updates bank information and other employee ID fields.

**Request Body** `application/json`:
```json
{
  "work_email": "john@company.com",
  "personal_email": "john@gmail.com",
  "bank_name": "BDO",
  "account_holder_name": "John Doe",
  "account_number": "1234567890",
  "routing_number": "001",
  "alt_bank_name": "BPI",
  "alt_account_holder_name": "John Doe",
  "alt_account_number": "0987654321",
  "alt_routing_number": "002"
}
```

| Field | Type | Required |
|---|---|---|
| `work_email` | string | At least one email required |
| `personal_email` | string | At least one email required |
| `name` | string | No |
| `bank_name` | string | No |
| `account_holder_name` | string | No |
| `account_number` | string | No |
| `routing_number` | string | No |
| `alt_bank_name` | string | No |
| `alt_account_holder_name` | string | No |
| `alt_account_number` | string | No |
| `alt_routing_number` | string | No |
| `preferred_processor` | string | No |
| `hurupay_email` | string | No |
| `wepay_email` | string | No |
| `higlobe_email` | string | No |
| `higlobe_account_name` | string | No |
| `wise_email` | string | No |
| `wise_tag` | string | No |
| `phone_number` | string | No |
| `swift_code` | string | No |
| `full_address` | string | No |
| `preferred_bank_slot` | string | No |
| `bootstrap_display_name` | string | No |

**Allowed update fields**: Only the fields listed above are accepted. All others are silently ignored. Empty strings are converted to `null`.

**Behavior notes**:
- Writes to Supabase table `employee_ids`.
- If no existing row matches and `work_email` is present, the route bootstraps a new `employee_ids` row with a temporary `SELF-...` employee ID, then saves the submitted fields.
- `preferred_processor` must be one of: `hurupay`, `wepay`, `higlobe`, `wise`, `jeeves`, `wires`.
- `preferred_bank_slot` must be one of: `primary`, `alternative`.

**Response** `200`:
```json
{ "success": true, "created": false }
```

**Error Response** `400`:
```json
{ "error": "At least one email (work_email or personal_email) is required to identify the employee." }
```

**Tables**: Updates `employee_ids`
**Service Role**: Required (falls back to anon)

---

## 4. Employee Rate Profiles

### `GET /api/employee-rate-profiles`

Fetches merged employee profiles combining data from multiple Supabase tables.

**Query Parameters**: None

**Response** `200`:
```json
{
  "profiles": [
    {
      "name": "John Doe",
      "workEmail": "john@company.com",
      "personalEmail": "john@gmail.com",
      "department": "HR",
      "regularRate": "125.00",
      "otRate": "187.50",
      "startDate": "2024-11-01"
    }
  ],
  "error": null,
  "mergeNotes": ["RLS blocked access to global_master_list — profile data may be incomplete."]
}
```

**`mergeNotes`**: Array of warnings when some tables couldn't be read (e.g., RLS blocking). Displayed as a yellow banner in the Rates view.

**Tables**: Reads `global_master_list` + `employee_hourly_rates` + optionally more via profile merge engine
**Service Role**: Not required

---

## 5. Employee Profile Photo

### `GET /api/employee-profile-photo`

Fetches the stored profile photo URL for an employee.

**Query Parameters**:

| Param | Type | Required |
|---|---|---|
| `email` | string | Yes |

**Response** `200`:
```json
{ "profilePhotoUrl": "https://supabase-storage-url/..." }
```

Returns `null` if no photo is stored.

**Error Response** `400`:
```json
{ "error": "Missing email parameter" }
```

**Tables**: Reads `global_master_list` (profile_photo_url column)
**Service Role**: Not required

---

### `POST /api/employee-profile-photo`

Uploads or replaces an employee's profile photo.

**Content-Type**: `multipart/form-data`

| Field | Type | Required |
|---|---|---|
| `email` | string | Yes |
| `file` | File/Blob | Yes (image/*, max 5 MB) |

**Validation**:
- Content-Type must include `multipart/form-data`
- File must be an image (MIME type starts with `image/`)
- File size must be ≤ 5 MB (5,242,880 bytes)

**Response** `200`:
```json
{ "profilePhotoUrl": "https://supabase-storage-url/..." }
```

**Error Response** `400`:
```json
{ "error": "File exceeds 5 MB limit." }
```

**Tables**: Writes to Supabase Storage + updates `global_master_list` (profile_photo_url column)
**Service Role**: Required for storage upload

---

## 6. Hubstaff Hours

### `GET /api/hubstaff-hours`

Four modes depending on query parameters:

#### Mode 1: List source files

**Query Parameters**: `?source_files=1`

**Response** `200`:
```json
{
  "files": [
    "simple-biz_daily_report_2026-03-01_to_2026-03-07.csv",
    "simple-biz_daily_report_2026-03-08_to_2026-03-14.csv"
  ],
  "error": null
}
```

#### Mode 2: Fetch by source file

**Query Parameters**: `?source_file=…` + optional `&email=…` *(added 2026-05-14)*.

When `email` is supplied the route post-filters the file's rows down to the one matching that employee (case-insensitive across `Email`, `Work Email`, `work_email`, `Personal Email`, `personal_email`, `user_email`). `columns` is unchanged; `rows` is `[match]` or `[]`. Used by the employee portal so each weekly file ships a single row instead of the full roster.

**Response** `200`:
```json
{
  "columns": ["id", "Email", "Member", "monday", "tuesday", "...", "Total worked", "source_file"],
  "rows": [
    {
      "id": 1,
      "Email": "franm@simple.biz",
      "Member": "Fran M",
      "monday": "8:30:00",
      "tuesday": "7:15:00",
      "Total worked": "43:53:21",
      "source_file": "simple-biz_daily_report_2026-03-01_to_2026-03-07.csv"
    }
  ],
  "payrollRows": [...],
  "error": null
}
```

#### Mode 3: Fetch all (no params)

Returns all rows ordered, with OpenAPI column discovery when service role is available.

**Response** `200`: Same shape as Mode 2.

#### Mode 4: All-files merge for one employee *(added 2026-05-14)*

**Query Parameters**: `?merge_all=1&email=…`

Server-side replacement for the employee portal's old N-parallel `?source_file=…` fan-out. Iterates every upload in `hubstaff_uploads` (falling back to `getUploadedSourceFiles()`), filters each file's rows by `email` server-side, and returns this one employee's row per file plus the union of columns. The client still resolves canonical weekday columns (`monday`, `tuesday`, …) to ISO dates using each filename's embedded date range — the response preserves `source_file` tagging for that.

**Response** `200`:
```json
{
  "columns": ["id", "Email", "Member", "monday", "...", "source_file"],
  "perFile": [
    {
      "source_file": "simple-biz_daily_report_2026-03-01_to_2026-03-07.csv",
      "row": { "Email": "franm@simple.biz", "monday": "8:30:00", "...": "..." }
    },
    { "source_file": "simple-biz_daily_report_2026-03-08_to_2026-03-14.csv", "row": null }
  ],
  "error": null
}
```

`row` is `null` when the employee didn't appear in that file.

**Tables**: Reads `hubstaff_hours`, `hubstaff_uploads`
**Service Role**: Required for Mode 3 full fetch and Mode 4 merge; Modes 1-2 use service role if available, fall back to anon

---

### `POST /api/hubstaff-hours`

Uploads a Hubstaff CSV file.

**Content-Type**: `multipart/form-data`

| Field | Type | Required | Notes |
|---|---|---|---|
| `file` | File/Blob | Yes | Hubstaff-format CSV |
| `mode` | string | No | `"replace"` = full table replace; default = append |
| `fileName` | string | No | Fallback if `file.name` unavailable |

**CSV requirements**:
- Must have header row + at least 1 data row
- Must contain `Email` and `Total worked` columns
- Column mapping: two-pass (exact match + date-aware ISO conversion)

**Response** `200`:
```json
{ "success": true, "rowCount": 641 }
```

**Error Response** `400`:
```json
{ "success": false, "error": "SUPABASE_SERVICE_ROLE_KEY is required." }
```

**Tables**: Writes to `hubstaff_hours` (append or full replace)
**Service Role**: **Mandatory** (returns 400 without it)

---

### `DELETE /api/hubstaff-hours`

Deletes all rows from a specific source file.

**Query Parameters**:

| Param | Type | Required |
|---|---|---|
| `source_file` | string | Yes |

**Response** `200`:
```json
{ "success": true, "deleted": 641 }
```

**Tables**: Deletes from `hubstaff_hours`
**Service Role**: **Mandatory** (returns 400 without it)

---

## 7. App Settings

### `GET /api/app-settings`

Reads application settings — single key or bulk.

**Query Parameters**:

| Param | Type | Required |
|---|---|---|
| `key` | string | One of `key` or `keys` |
| `keys` | string (comma-separated) | One of `key` or `keys` |

**Bulk mode** *(added 2026-05-14)* — pass `?keys=a,b,c` for a single round-trip. Response shape: `{ values: { a, b, c }, error }`, with `null` for any key that isn't in the table. Added to collapse the Payroll Wizard's ~10 parallel single-key fetches (global + per-dept OT flags) into one.

**Known keys**:
- `usd_to_php_rate` — USD to PHP exchange rate
- `hubstaff_daily_breakdown` — cached daily breakdown data
- `pab_period_overrides` — JSON map `{ "YYYY-MM": { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } }`. Per-month PAB window overrides; months without an entry fall back to `getPabMonthRange(year, month)`. Written from the PAB settings modal in Payroll Wizard → Additions.
- `pab_period_active_month` — `"YYYY-MM"`. Which month the Additions tab currently evaluates. Absent → today's PAB month.
- `pab_scope_department_keys` — JSON array of department keys in PAB scope (`null`/missing = all, `[]` = none). Edited in System Settings.
- `pab_period_manual`, `pab_period_start`, `pab_period_end` — **legacy** single-range override. Still read for back-compat; auto-migrated into `pab_period_overrides` on first load when the new map is empty. New code should write to `pab_period_overrides` instead.
- `pab_dispute_reason_codes` — JSON array of permitted reason codes for `/api/pab-disputes`.

**Response** `200` (single-key):
```json
{ "value": "56.00", "error": null }
```

**Response** `200` (bulk):
```json
{ "values": { "ot_global_suspended": "false", "ot_dept_hsl": "true" }, "error": null }
```

Returns `null` value if key doesn't exist.

**Tables**: Reads `app_settings`
**Service Role**: Not required

---

### `POST /api/app-settings`

Creates or updates an application setting.

**Request Body** `application/json`:
```json
{
  "key": "usd_to_php_rate",
  "value": "56.50"
}
```

| Field | Type | Required |
|---|---|---|
| `key` | string | Yes |
| `value` | string | Yes |

**Response** `200`:
```json
{ "error": null }
```

**Tables**: Upserts to `app_settings`
**Service Role**: Not required (uses utility function)

---

## 8. Import Daily Report

### `POST /api/import-daily-report`

Imports a CSV file as a new dynamically-created PostgreSQL table.

**Content-Type**: `multipart/form-data`

| Field | Type | Required |
|---|---|---|
| `file` | File/Blob | Yes |

**Timeout**: 60 seconds (`maxDuration = 60`)

**Validation**:
- CSV must have header row + at least 1 data row
- Data rows are padded/trimmed to match header column count

**Response** `200`:
```json
{
  "success": true,
  "schema": { "column_name": "text", "...": "..." },
  "tableName": "daily_report_2026_03_01",
  "rowCount": 150,
  "fileName": "report.csv"
}
```

**Tables**: Creates a new dynamic table via direct PostgreSQL connection
**Service Role**: Required (via `importDailyReportToPostgres()`)

> **Note**: This endpoint creates arbitrary database tables. Admin-only access is critical after RBAC implementation.

---

## 9. Avatar (Gravatar)

### `GET /api/avatar`

Redirects to a Gravatar URL based on the employee's email hash.

**Query Parameters**:

| Param | Type | Required | Default |
|---|---|---|---|
| `email` | string | Yes | — |
| `s` | string | No | `"128"` (pixel size) |
| `d` | string | No | `"404"` (Gravatar default) |

**Response** `302` Redirect to:
```
https://www.gravatar.com/avatar/{md5_hash}?s={size}&d={default}&r=pg
```

**Error Response** `400`: Missing email parameter

**Tables**: None (pure redirect)
**Service Role**: Not required

---

## 10. PAB Day Disputes

Endpoints backing the PAB dispute flow (employees challenge failing days; Accounting approves / denies) and the admin Orphanage Visits roster. Behaviour is documented in [BUSINESS_LOGIC.md](./business-logic.md#pab-day-dispute-system).

> **Auth status** (as of 2026-04-21): dispute decide/edit endpoints enforce role-based access on the server via `canActOnDisputes(email)` against `employee_roles`. The orphanage-visits endpoints currently accept `admin_name` as a client-supplied string and do **not** enforce auth — this gap is tracked and will be closed once SSO lands.

### `GET /api/pab-disputes`

List disputes, optionally filtered.

**Query Parameters**:
- `email` (optional): normalised work email filter. When omitted, requires an **elevated** session (cross-employee listing).
- `from` (optional): `YYYY-MM-DD` inclusive lower bound on `dispute_date`
- `to` (optional): `YYYY-MM-DD` inclusive upper bound on `dispute_date`
- `status` (optional): repeat param for a single status **or** multiple values, e.g. `status=approved&status=accounting_approved`. If a single value is sent, a simple equality filter is used; if multiple, `status IN (...)`.
- `awaiting_accounting` (optional): when `1`, restricts to rows Accounting should see as actionable: `pending` **or** `orphanage_manager_approved` (used by `PabDisputeQueue` default filter).
- `reason` (optional): filter by dispute reason code
- `limit` (optional): integer; default unlimited, typical caller sets `500`

**Response** `200`: Same shape as before. `status` may be any value from `PabDisputeStatus` (see [BUSINESS_LOGIC.md](./business-logic.md#pab-day-dispute-system)).

```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "jane@simple.biz",
      "dispute_date": "2026-04-14",
      "reason": "orphanage_visit",
      "explanation": "Visit to nearby orphanage, home late",
      "status": "accounting_approved",
      "decided_by": "carla@simple.biz",
      "decided_at": "2026-04-15T02:15:00Z",
      "decision_note": "Confirmed with team lead",
      "override_hours": null,
      "created_at": "2026-04-14T12:00:00Z",
      "created_by": "jane@simple.biz",
      "updated_at": "2026-04-15T02:15:00Z"
    }
  ],
  "error": null
}
```

`override_hours` uses **tri-state SET semantics**:
- `null` — no override; Hubstaff hours stand; 4h floor-drop applies on `dispute_date`.
- `0` — intentional zero-out; day counts as 0h (fails PAB).
- `> 0` — replaces Hubstaff hours for `dispute_date`.

For `reason === 'orphanage_visit'`, the 4h floor also applies on `dispute_date + 1` via a synthesized forgiveness map entry in the PAB calculators (no second DB row is written).

**Error Response** `500`:
```json
{ "rows": [], "error": "<message>" }
```

**Tables**: `pab_day_disputes`
**Service Role**: Required

---

### `POST /api/pab-disputes`

Employee-facing: submit a new dispute against a failing day.

**Body**:
```json
{
  "work_email": "jane@simple.biz",
  "dispute_date": "2026-04-14",
  "reason": "medical",
  "explanation": "Doctor appointment 2–4pm",
  "created_by": "jane@simple.biz"
}
```

- `work_email`, `dispute_date` (`YYYY-MM-DD`), `reason` are required.
- `reason` is validated against the current `pab_dispute_reason_codes` list in `app_settings` when any codes are configured.
- **`orphanage_visit` and `ceo_visitation` are blocked** with a 403 — those reasons are manager-submitted only. Use `POST /api/pab-disputes/orphanage-manager-submit` instead.
- Initial `status`: `pending`.

**Response** `200`:
```json
{ "success": true, "id": "uuid", "error": null }
```

**Error Response**:
- `400` — missing / malformed fields
- `403` — reason is orphanage-style (manager-submitted only)
- `409` — a dispute already exists for that `(work_email, dispute_date)` pair
- `500` — server error

Audit log: `pab_dispute.submitted` (user_role resolved from `employee_roles`, falling back to `Employee`).

**Tables**: `pab_day_disputes`, `audit_log`, `app_settings` (read `pab_dispute_reason_codes`)
**Service Role**: Required

---

### `POST /api/pab-disputes/orphanage-manager-submit`

Bulk-create orphanage-style disputes on behalf of a list of employees. Used by Alyson's Orphanage view and Carla's Accounting Orphanage Visits queue, both via the shared **Create disputes** dialog.

**Auth**: requires elevated session via `requireElevatedSession`. Server-side role check is `orphanage_manager` OR any role in `DISPUTE_ACTOR_ROLES` — the role determines the audit-log tag.

**Body**:
```json
{
  "reason": "ceo_visitation",
  "dispute_date": "2026-04-14",
  "employee_emails": ["kane@simple.biz", "alyson@simple.biz"],
  "explanation": "Travelled with Bob Apr 13–14, dinner with leadership Apr 14"
}
```

- `reason` must be `'orphanage_visit'` or `'ceo_visitation'` (validated via `isOrphanageStyleReason`).
- `dispute_date` (`YYYY-MM-DD`) — applied to every email in the batch.
- `employee_emails` — non-empty array of normalized work emails.
- `explanation` — optional; copied into both `explanation` and `decision_note` for receipt.

Each row is inserted at `status = 'orphanage_manager_approved'` with `override_hours = null`, skipping the `pending_orphanage_manager` stage. Carla then gives final accounting approval.

**Response** `200`:
```json
{
  "created": [{ "id": "uuid", "work_email": "kane@simple.biz" }],
  "skipped": [{ "work_email": "alyson@simple.biz", "reason": "already on file for this date" }],
  "errors": [],
  "error": null
}
```

The `skipped` list catches duplicate `(work_email, dispute_date)` rows (Postgres `23505`). The `errors` list catches per-row insert failures (other emails still go through).

**Error Response**:
- `400` — invalid `reason`, malformed `dispute_date`, empty `employee_emails`
- `401` — not signed in
- `403` — actor lacks `orphanage_manager` AND accounting roles
- `500` — server error (rare; per-row errors are returned in `errors[]`)

Audit log: one entry per created row — `pab_dispute.orphanage_manager_created` if the actor's primary role is `orphanage_manager`, otherwise `pab_dispute.accounting_created`. `details` includes `employee, dispute_date, reason, explanation, submitted_by, actor_role`.

**Tables**: `pab_day_disputes`, `audit_log`
**Service Role**: Required

---

### `GET /api/pab-disputes/orphanage-overlap`

Returns existing orphanage-style disputes (any status) so the Create disputes dialog can render the active person's calendar with the **real** forgiveness state of each day — green for already-forgiven, amber for in-flight, red+disabled for denied. Pre-fetched on parent mount (`OrphanageApp.tsx`, `OrphanageVisits.tsx`) so dialog open is instant.

**Auth**: `orphanage_manager` OR any accounting role from `DISPUTE_ACTOR_ROLES`. Returns 403 otherwise. Intentionally NOT routed through `authorizeEmailAccess` because `orphanage_manager` is not in `ELEVATED_ROLES` and would otherwise be blocked.

**Query params**: `from`, `to` (optional ISO `YYYY-MM-DD` bounds), `email` (optional — single-employee scope), `limit` (default 2000).

**Response** `200`:
```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "cobb@simple.biz",
      "dispute_date": "2026-04-06",
      "reason": "orphanage_visit",
      "status": "accounting_approved",
      "override_hours": null,
      "decided_by": "carla@simple.biz",
      "decided_at": "2026-05-01T00:45:11Z",
      "decision_note": "...",
      "explanation": "...",
      "created_by": "alyson@simple.biz",
      "created_at": "2026-05-01T00:44:50Z",
      "updated_at": "2026-05-01T00:45:11Z"
    }
  ],
  "error": null
}
```

Filters server-side to `reason IN ('orphanage_visit', 'ceo_visitation')`. The dialog reshapes the array into `Map<email → Map<dispute_date → row>>` via `fetchOrphanageOverlap`.

**Tables**: `pab_day_disputes`
**Service Role**: Required (read-only)

---

### `PATCH /api/pab-disputes/[id]`

Decide, edit, run orphanage-manager steps, or return to the Orphanage queue. Gated server-side by role-specific helpers — Accounting actions require `canActOnDisputes(decided_by)` (active role in `DISPUTE_ACTOR_ROLES`: `payroll_coordinator`, `payroll_manager`, `finance`, `hr_coordinator`, `admin`). Orphanage Manager approve/deny uses `canActOnOrphanageManagerQueue`.

**Body** (Accounting: approve / deny a dispute that is pending in their queue):

- Non-orphanage: `status` must be `pending`.
- Orphanage visit: `status` must be `orphanage_manager_approved` before Accounting can approve or deny.

```json
{
  "action": "approve",
  "decided_by": "carla@simple.biz",
  "decision_note": "Confirmed",
  "override_hours": 6.5
}
```

`action` may be `approve` or `deny`. `override_hours`: null or number ≥ 0; ignored when `deny`. **Ignored for `reason === 'orphanage_visit'`** (Hubstaff + orphanage rules apply).

**Body** (Orphanage Manager — verify or deny a row in `pending_orphanage_manager`):

```json
{
  "action": "orphanage_manager_approve",
  "decided_by": "manager@simple.biz",
  "decision_note": "Receipt on file"
}
```

Use `orphanage_manager_deny` to deny. Moves row to `orphanage_manager_approved` or `orphanage_manager_denied`.

**Body** (Accounting: push back to Orphanage Manager — only `orphanage_visit` with `orphanage_manager_approved`):

```json
{
  "action": "return_to_orphanage",
  "decided_by": "carla@simple.biz",
  "decision_note": "Need clearer documentation"
}
```

**Body** (edit an already-decided dispute — same authorization as approve/deny):

```json
{
  "action": "edit",
  "status": "approved",
  "decided_by": "carla@simple.biz",
  "decision_note": "Updated note",
  "override_hours": null
}
```

`status` must be `approved` or `denied`. For `orphanage_visit`, the stored status is mapped to `accounting_approved` / `accounting_denied` automatically. Use `edit` with `status: "denied"` and `override_hours: null` to **revoke PAB forgiveness** after an approval (see [BUSINESS_LOGIC.md](./business-logic.md#editing-decided-disputes)). Pending / in-review rows cannot use `edit`.

**Response** `200`:
```json
{ "success": true, "stage": "final", "error": null }
```

(`stage` may be omitted for some actions.)

**Error Response**:
- `400` — invalid action, missing `decided_by`, wrong state for action (e.g. orphanage not yet manager-approved)
- `403` — caller not authorized for the action
- `404` — dispute id not found
- `500` — server error

Audit log: `pab_dispute.approved`, `pab_dispute.denied`, `pab_dispute.edited`, `pab_dispute.orphanage_manager_approved`, `pab_dispute.orphanage_manager_denied`, or `pab_dispute.orphanage_returned_to_manager` as appropriate, with dynamically resolved `user_role`.

**Tables**: `pab_day_disputes`, `audit_log`, `employee_roles` (read)
**Service Role**: Required

---

### `GET /api/orphanage-disputes`

Orphanage Manager queue + recent verified log. Requires NextAuth session and `canActOnOrphanageManagerQueue(session email)` (`orphanage_manager` or `admin`).

**Query Parameters**:
- `section` (optional): `pending` | `verified` — return only that bucket; default returns both.

**Response** `200`:
```json
{
  "pending": [ /* rows: reason orphanage_visit, status pending_orphanage_manager */ ],
  "verified": [ /* rows: reason orphanage_visit, status orphanage_manager_approved, sorted by decided_at desc */ ],
  "error": null
}
```

**Tables**: `pab_day_disputes`
**Service Role**: Required (via server lib)

---

### `DELETE /api/pab-disputes/[id]`

Two modes, selected by query string:

#### Mode A — Employee withdraw (default)

Employee withdraws their own pending dispute. Used by the `My Disputes` view (currently hidden — see `docs/orphanage-dispute-flow.md`).

**Query Parameters**:
- `employee_email` (required): must match the dispute's `work_email` (normalised); otherwise `403 Forbidden`.

**Constraints**:
- Only `pending` and `pending_orphanage_manager` statuses can be withdrawn.

Audit log: `pab_dispute.withdrawn`.

#### Mode B — Admin hard delete *(added 2026-05-02)*

Accounting permanently deletes a dispute regardless of status. Used by the trash button in the `PabDisputeQueue`.

**Query Parameters**:
- `mode=admin` (required to enter this branch).

**Authorization**: NextAuth session must include a role in `DISPUTE_DELETE_ROLES` (`'admin'`, `'payroll_manager'`). Tighter than `DISPUTE_ACTOR_ROLES` (which controls approve/deny) because deletion wipes the row entirely. Other accounting roles (`payroll_coordinator`, `finance`, `hr_coordinator`) cannot delete.

**Constraints**: works on any status; no email match required.

Audit log: `pab_dispute.admin_deleted` with snapshot of `prior_status`, `prior_decided_by`, `prior_decision_note` so deletions remain traceable after the row is gone.

#### Common response

`200`:
```json
{ "success": true, "error": null }
```

**Error Response**:
- `400` — (Mode A) only pending disputes can be withdrawn
- `401` — (Mode B) not signed in
- `403` — (Mode A) email does not match the dispute owner; (Mode B) session lacks a `DISPUTE_DELETE_ROLES` role
- `404` — dispute not found

**Tables**: `pab_day_disputes`, `audit_log`
**Service Role**: Required

---

### `GET /api/pab-disputes/orphanage-visits`

Lists approved orphanage-visit rows from `pab_day_disputes`, filtered to `reason = 'orphanage_visit'` and `status = 'approved'`. Used by the admin roster.

Query params: `from`, `to` (`YYYY-MM-DD`); `limit` (integer, default 500).

**Response** `200`:
```json
{ "rows": [ { "id": "…", "work_email": "…", "dispute_date": "2026-04-14", "reason": "orphanage_visit", "status": "approved", … } ], "error": null }
```

**Tables**: `pab_day_disputes`
**Service Role**: Required

---

### `POST /api/pab-disputes/orphanage-visits`

Admin inserts (or upserts) an orphanage-visit record. Performs atomic `.upsert({ onConflict: 'work_email,dispute_date' })` — concurrent inserts for the same employee/date do not race.

**Body**:
```json
{
  "work_email": "jane@simple.biz",
  "visit_date": "2026-04-14",
  "note": "Visited nearby orphanage",
  "admin_name": "Fran M"
}
```

- No `override_hours` is written; the row is a floor-drop marker only. The PAB calculators extend the 4h floor to `visit_date + 1` as well (synthetic forgiveness map entry).
- `admin_name` is currently trusted from the client body (auth gap — see note at top of section).

**Response** `200`:
```json
{ "success": true, "id": "uuid", "error": null }
```

**Error Response**:
- `400` — missing/invalid `work_email`, `visit_date`, or `admin_name`
- `500` — server error

Audit log: `pab_dispute.approved` with `source: "admin_orphanage_roster"` in details.

**Tables**: `pab_day_disputes`, `audit_log`
**Service Role**: Required

---

### `DELETE /api/pab-disputes/orphanage-visits/[id]`

Admin removes a recorded orphanage visit. The forgiveness on both visit day and day-after reverts.

**Query Parameters**:
- `admin_name` (required): trusted from client for now (same caveat as POST).

**Response** `200`:
```json
{ "success": true, "error": null }
```

**Error Response**:
- `400` — missing `admin_name`, or the targeted row is not an orphanage-visit entry
- `404` — row not found

Audit log: `pab_dispute.withdrawn` with `source: "admin_orphanage_roster"`.

**Tables**: `pab_day_disputes`, `audit_log`
**Service Role**: Required

---

## 11. Payment Dispatches

The Payment Dispatch feature exposes three endpoints under `/api/payment-dispatches/`. See [PAYMENT_DISPATCH.md](../features/payment-dispatch.md) for the broader feature context.

### `GET /api/payment-dispatches`

Lists every persisted dispatch (i.e. each row in `payment_dispatches`), newest first.

**Query Parameters**:
- `cycle_id` *(optional)* — UUID. When present, returns only dispatches for that Hubstaff upload's cycle. Pass an empty string for "any cycle".

**Response** `200`:
```json
{
  "rows": [
    {
      "id": "…uuid…",
      "cycle_id": "…uuid…",
      "cycle_period_start": "2026-04-12",
      "cycle_period_end": "2026-04-18",
      "cycle_source_file": "simple-biz_daily_report_2026-04-12_to_2026-04-18.csv",
      "recipient_email": "franm@simple.biz",
      "recipient_name": "Fran M",
      "processor": "hurupay",
      "bank_preferred_raw": "Hurupay",
      "recipient_preferred_bank": "Hurupay",
      "recipient_account_number": "fran@simple.biz",
      "recipient_account_holder": "Fran M",
      "recipient_swift_code": null,
      "amount_usd": 240.50,
      "amount_php": 13348.50,
      "transaction_id": "HRP-9001",
      "bank_used": "Hurupay",
      "sent_date": "2026-04-19",
      "arrival_date": "2026-04-19",
      "status": "paid",
      "note": null,
      "created_by": "lenny@simple.biz",
      "created_at": "2026-04-19T07:45:11.231Z"
    }
  ],
  "error": null
}
```

**Tables**: `payment_dispatches`
**Service Role**: Read uses `createSupabaseServiceRoleClient() ?? createSupabaseServerClient()`.

### `POST /api/payment-dispatches`

Logs a single dispatch and (via trigger) writes through to `disbursement_records`.

**Request body** (`InsertPaymentDispatchInput`):
```json
{
  "cycle_id": "…uuid…",
  "cycle_period_start": "2026-04-12",
  "cycle_period_end": "2026-04-18",
  "cycle_source_file": "simple-biz_daily_report_2026-04-12_to_2026-04-18.csv",
  "recipient_email": "franm@simple.biz",
  "recipient_name": "Fran M",
  "processor": "hurupay",
  "bank_preferred_raw": "Hurupay",
  "recipient_preferred_bank": "Hurupay",
  "recipient_account_number": "fran@simple.biz",
  "recipient_account_holder": "Fran M",
  "recipient_swift_code": null,
  "amount_usd": 240.50,
  "amount_php": 13348.50,
  "transaction_id": "HRP-9001",
  "bank_used": "Hurupay",
  "sent_date": "2026-04-19",
  "arrival_date": "2026-04-19",
  "status": "paid",
  "note": null
}
```

Required: `recipient_email`, `processor`, `transaction_id`, `bank_used`, `sent_date`. `status` defaults to `'paid'`.

**Response** `200`: same shape as `GET`'s row entries.

Side effects:
- Inserts into `payment_dispatches`.
- Trigger `payment_dispatches_sync_disbursement` updates the matching `disbursement_records` row's `status / paid_amount_usd / paid_at / bank_used / transaction_id / dispatch_id` (matched on `(cycle_source_file, LOWER(recipient_email))`).
- Writes a `payment.dispatched` audit log entry tagged `payroll_clerk`.

**Tables**: `payment_dispatches`, `disbursement_records` (via trigger), `audit_log`
**Service Role**: Required (writes).

### `GET /api/payroll-dispatch-lock` & `POST /api/payroll-dispatch-lock`

Read / set the global `payroll.dispatch_locked` flag. Documented in [PAYMENT_DISPATCH.md §6](../features/payment-dispatch.md).

---

## 12. Disbursement Reports

> Added 2026-04-28. Backed by `public.disbursement_records` (one row per (week, employee)) seeded by `references/seed_disbursement_records.sql`. See [PAYMENT_DISPATCH.md §6.5](../features/payment-dispatch.md) for the full feature doc.

### `GET /api/payment-dispatches/reports`

Returns a per-cycle summary list, newest period first. One entry per Hubstaff upload (one row per source CSV).

**Response** `200`:
```json
{
  "reports": [
    {
      "cycleId": "…uuid…",
      "periodStart": "2026-04-12",
      "periodEnd": "2026-04-18",
      "sourceFile": "simple-biz_daily_report_2026-04-12_to_2026-04-18.csv",
      "uploadedAt": "2026-04-19T03:12:55.802Z",
      "uploadedBy": "kaner@simple.biz",
      "rowCount": 738,
      "isCurrent": true,
      "reportName": "April 12-18, 2026",
      "totals": {
        "paidCount": 738,
        "paidUSD": 106963.89,
        "paidPHP": 5936420.51,
        "notPaidCount": 0,
        "thresholdCount": 0,
        "problemCount": 0,
        "pendingDispatchedUSD": 0,
        "sentCount": 738,
        "totalDispatchedUSD": 106963.89,
        "outstandingCount": 0,
        "outstandingUSD": 0,
        "totalRecipients": 738,
        "totalOwedUSD": 106963.89
      },
      "byProcessor": {
        "hurupay": { "count": 510, "usd": 72100.40 },
        "wepay": { "count": 0, "usd": 0 },
        "higlobe": { "count": 95, "usd": 14903.20 },
        "wise": { "count": 60, "usd": 9100.50 },
        "jeeves": { "count": 5, "usd": 805.30 },
        "wires": { "count": 68, "usd": 10054.49 }
      }
    }
  ],
  "error": null
}
```

`cycleId` is the matching `hubstaff_uploads.id` UUID, or a `source:<filename>` synthetic id when no upload row exists. The detail endpoint accepts both forms.

`reportName` is computed by `formatDisbursementReportName()`:
- Same month: `"April 12-18, 2026"`
- Cross-month: `"April 30 - May 3, 2026"`
- Cross-year: `"December 30, 2025 - January 5, 2026"`

`byProcessor` is derived per-row from `employee_hourly_rates."Bank Preferred"` (using `processorIdFromBankPreferred`), not from `payment_dispatches.processor`. This is so the breakdown still works for backfilled / direct-UPDATE rows that don't have a `payment_dispatches` parent.

**Tables**: `disbursement_records`, `hubstaff_uploads`, `employee_hourly_rates`
**Service Role**: Uses service role when available, else server client.

### `GET /api/payment-dispatches/reports/[cycleId]`

Returns a single report's full detail. `cycleId` accepts:
- A `hubstaff_uploads.id` UUID
- A `source:<filename>` synthetic id from the list endpoint

**Response** `200`:
```json
{
  "report": {
    "cycleId": "…",
    "periodStart": "2026-04-12",
    "periodEnd":   "2026-04-18",
    "sourceFile":  "simple-biz_daily_report_2026-04-12_to_2026-04-18.csv",
    "uploadedAt":  "…",
    "uploadedBy":  "…",
    "rowCount":    738,
    "isCurrent":   true,
    "reportName":  "April 12-18, 2026",
    "totals":      { …same shape as list endpoint… },
    "byProcessor": { …same shape… },
    "dispatches": [
      { …PaymentDispatchRow with processor + banking detail… }
    ],
    "outstanding": [
      { "email": "ada@simple.biz", "amountUSD": 312.40, "amountPHP": 17338.20 }
    ],
    "outstandingUSD": 312.40
  },
  "error": null
}
```

`outstanding` is sourced from `disbursement_records WHERE source_file=… AND status='pending'`, ordered by `amount_usd DESC` (limit 500). It works for **any cycle**, not just the current one — because `disbursement_records` already stores the per-row pay snapshot.

`dispatches` is sourced from `payment_dispatches WHERE cycle_source_file=…`, ordered by `created_at DESC`. The flat record table doesn't store processor / banking, so the table view still uses `payment_dispatches` for those columns.

**Error responses**:
- `400` — missing `cycleId`
- `404` — cycle not found in `disbursement_records` (i.e. no rows for that source_file)
- `500` — DB error

**Tables**: `disbursement_records`, `payment_dispatches`, `hubstaff_uploads`, `employee_hourly_rates`

---

## 12.5 Leave Requests

### `GET /api/leave-requests`

Lists leave requests scoped by query string.

**Query Parameters**:
- `scope=mine` — only the caller's own requests (employee view).
- `scope=all` — full list (manager + accounting view).

**Tables**: `leave_requests`

---

### `POST /api/leave-requests`

Creates a new leave request. Used by the Employee Leaves panel.

**Body**:
```json
{
  "employee_email": "jane@simple.biz",
  "employee_name": "Jane Doe",
  "department": "Client VA",
  "start_date": "2026-06-01",
  "end_date": "2026-06-05",
  "leave_type": "vacation",
  "reason": "Family trip",
  "manager_email": "manager@simple.biz"
}
```

Audit log: `leave.created`.

---

### `PATCH /api/leave-requests/[id]`

Approve, reject, or cancel a leave request.

**Body** (one of):
```json
{ "action": "approve", "approver_email": "manager@simple.biz", "approver_note": "Approved" }
{ "action": "reject",  "approver_email": "manager@simple.biz", "approver_note": "Conflicts with..." }
{ "action": "cancel",  "employee_email": "jane@simple.biz" }
```

**Approve / reject authorization** — the approver must satisfy at least one of:
1. Listed in the request's stored `manager_email` (comma-joined).
2. Currently active manager for the request's department (via `department_managers`).
3. Listed in the legacy `leave_department_managers_json` map for the department.
4. Listed in `leave_accounting_notify_emails` or `leave_approver_emails` settings.

**Cancel authorization** — `employee_email` must match the request's owner; only `pending` requests can be cancelled.

Audit log: `leave.approved` / `leave.rejected` / `leave.cancelled`.

---

### `DELETE /api/leave-requests/[id]` *(added 2026-05-02)*

Hard-delete a leave request. Used by the trash button in `LeaveRequestsPanel` (shared by accounting + manager dashboards).

**Authorization** — NextAuth session must include a role in `LEAVE_DELETE_ROLES`:

| Role | Scope |
|---|---|
| `admin`, `payroll_manager` | **Unrestricted** — any request, any department |
| `manager` | **Scoped** — only requests for departments they actively manage (verified via the same chain as approve/reject) |

Other accounting roles (`payroll_coordinator`, `finance`, `hr_coordinator`) cannot delete.

**Constraints**: works on any status. Cancellation (employee-initiated) goes through `PATCH { action: 'cancel' }`.

**Response** `200`:
```json
{ "success": true, "error": null }
```

**Error Response**:
- `401` — not signed in
- `403` — session lacks any `LEAVE_DELETE_ROLES` role, OR (manager) actor does not manage this request's department
- `404` — leave request not found

Audit log: `leave.admin_deleted` with `details.scope = 'unrestricted' | 'department'` so admin sweeps and in-scope manager deletions are distinguishable. Snapshot includes `prior_status`, `prior_approver`, `prior_approver_note`.

**Tables**: `leave_requests`, `audit_log`, `app_settings` (for manager-scope checks), `department_managers`
**Service Role**: Required

---

## 12.7 Admin Diagnostics

### `GET /api/admin/diagnostics` *(added 2026-05-02)*

Live health probe powering the Admin → Diagnostics tab. Runs server-side probes against Supabase, the pg pool (when `DATABASE_URL` is set), the audit log, and the data tables that the Service Map cares about. Returns a `DiagnosticsHealthResponse` the client renders directly — same shape as the local mock so the UI is unchanged whether it's live or fallback.

**Authorization**: NextAuth session must hold the `'admin'` role. Returns 401 if not signed in, 403 if role check fails. Belt-and-suspenders alongside the client-side `'diagnostics'` tab gate so non-admin sessions can never read probe results.

**Response** `200`:
```json
{
  "overallStatus": "warning",
  "source": "live",
  "generatedAt": "2026-05-02T14:32:01.234Z",
  "nodes": [
    {
      "id": "supabase-client",
      "label": "Supabase Client",
      "category": "infra",
      "status": "healthy",
      "summary": "Round-trip 187ms.",
      "details": ["Anon-key read succeeded against app_settings."],
      "suggestedChecks": ["Periodically verify service-role usage list."],
      "lastChecked": "2026-05-02T14:32:01.234Z"
    }
    // … 11 more nodes
  ],
  "alerts": [
    {
      "id": "alert-hubstaff-csv",
      "severity": "warning",
      "title": "Latest upload 12d ago.",
      "description": "Hubstaff cycle imports may have stalled.",
      "nodeId": "hubstaff-csv",
      "timestamp": "2026-05-02T14:32:01.234Z"
    }
  ]
}
```

**Probes** (run in parallel via `Promise.all`, each capped at 4s via `withProbeTimeout`):

| Probe helper | What it does | Status mapping |
|---|---|---|
| `probeSupabase` | `select head` on `app_settings`, latency | <500ms healthy, 500–2000ms warning, errors/timeouts critical |
| `probePgPool` | `SELECT 1` over a `pg.Pool` if `DATABASE_URL` set | unknown when env missing, healthy <1.5s, critical on connection error |
| `probeHubstaffCsv` | Latest `hubstaff_uploads` row + age | <7d healthy, 7–14d warning, >14d warning |
| `probeMasterList` | `count(*)` from `active_employees` view | 0 critical, <50 warning, else healthy |
| `probeAuditLog` | Latest `audit_log` row, age | <7d healthy, >7d warning, empty warning |
| `probeDisbursementRecords` | `count(*)` from `disbursement_records` | healthy if reads, warning on error |
| `probeAuth` | Recent login events from `audit_log` (24h window) | always warning until admin gate is enforced server-side |
| `probeDailyReport` | Latest `daily_reports.*` audit entry, age | <48h healthy, >48h warning, never warning |
| `probeRates` | `count(*)` from `employee_hourly_rates` | 0 warning, else healthy |

**Composite statuses**: `payroll-wizard` is derived from `hubstaff-csv` + `master-list` + `disbursement-records` worst-case, with a warning floor (CSV mismatches stay subtle even when probes look green). `admin-shell` is always healthy (you can read this response, the shell rendered). `supabase-client` and `supabase-postgres` share one probe.

**Security**: probe outputs never include raw stack traces, SQL text, secrets, or employee PII. Errors are trimmed via `trimError()` (one-line, capped at 120 chars). PostgREST error codes pass through (useful for diagnosis, not sensitive).

**Error Response**:
- `401` — not signed in
- `403` — session lacks the `'admin'` role
- `500` — unexpected server error (probes have their own timeout fallback so this is rare)

`Cache-Control: no-store, max-age=0` on the response to prevent any CDN caching.

**Tables**: `app_settings`, `hubstaff_uploads`, `active_employees` (view), `audit_log`, `disbursement_records`, `employee_hourly_rates`
**Service Role**: Required (for read-through past RLS on operational tables)

See [docs/system-diagnostics.md](../features/system-diagnostics.md) for the architecture, edge animation system, and how to extend with new probes.

---

### `POST /api/admin/backfill-employee-ids` *(added 2026-05-14)*

One-shot backfill that stamps the `employee_id` column on every `global_master_list` row currently lacking one. Mirrors the in-memory YYMM-NNNN assignment the UI has always shown (`generateEmployeeIds()` in `src/lib/supabase/employees.ts`), so persisted IDs match what users already see — the first run shouldn't change any visible numbers.

**Why this exists**: until 2026-05-14 the `employee_id` field was computed in-memory on every read and renumbered whenever a same-month starter joined, left, or had their name changed. The column was added by `references/add_employee_id_to_global_master_list.sql` and this route is the one-shot populator. From then on, every master-list upload + every HR Promote call fills the column for any new rows automatically (`backfillEmployeeIds()` is invoked after both).

**Authorization**: NextAuth session must hold an elevated role (admin / payroll_manager / hr_coordinator).

**Request Body**: none.

**Response** `200`:
```json
{ "assigned": 27, "skipped": 893, "error": null }
```

- `assigned` — rows that had a NULL `employee_id` and got one stamped this run.
- `skipped` — rows that already had an ID (left untouched).

**Error Response** `500`:
```json
{ "assigned": 0, "skipped": 0, "error": "column employee_id does not exist" }
```

Most common cause: the column-add migration (`references/add_employee_id_to_global_master_list.sql`) hasn't been run yet.

**Idempotent**: re-running only fills nulls, never renumbers an existing ID. Safe to invoke any time.

**Tables**: `global_master_list` (read full roster + write `employee_id`)
**Service Role**: Required.

---

## 12.8 Employee Notifications *(added 2026-05-15)*

### `GET /api/employee-notifications`

Returns the 50 most recent notifications for `?email=`. Admin-or-self.

**Response**: `{ notifications: Array<{ id, type, tone, title, message, details, read_at, created_at }> }`.

### `PATCH /api/employee-notifications`

Marks rows read. Body: `{ id?, ids?, email? }` — if `ids` given, marks those; otherwise marks every unread row for `email`. The `NotificationsPanel` calls this with `{ email }` 2 seconds after the panel renders so badges clear automatically.

### `DELETE /api/employee-notifications?id=…`

Removes a single notification row. Powers the trash-can icon on each card.

**Tables**: `employee_notifications`
**Service Role**: Yes

---

## 12.9 Feature Permissions *(added 2026-05-15)*

Per-user, per-view, per-feature access overlay on top of `employee_roles`. See [`data-sources.md` → `employee_feature_permissions`](./data-sources.md#8-employee_feature_permissions-added-2026-05-15) for table schema.

### `GET /api/employee-feature-permissions?email=…`

Admin-only. Lists every active feature grant for the email. Response: `{ rows: Array<{ id, work_email, view_key, feature, access, granted_by, granted_at }> }`.

### `POST /api/employee-feature-permissions`

Admin-only. Upsert one permission. Body:
```json
{ "email": "kane@simple.biz", "view": "accounting", "feature": "rates", "access": "view" }
```
- `access` is one of `"hidden"` (revoke any active row — default state), `"view"`, or `"edit"`.
- Writes an `audit_log` entry (action `feature_permission.grant` or `.revoke`).
- Auto-bumps `auth.force_logout_map` for the affected user so their JWT reflects the new permission set on the next request — **except** when the admin is editing their own row (would self-403 the in-flight session).

**Tables**: `employee_feature_permissions`, `app_settings`, `audit_log`
**Service Role**: Yes

---

## 12.10 Force Logout *(added 2026-05-15)*

### `POST /api/auth/force-logout`

Admin-only. Stamps the target email in `app_settings.auth.force_logout_map`; the NextAuth `jwt` callback then wipes any token for that email whose `iat` is older. Used by `AdminRoles` after a role revoke. Body:
```json
{ "email": "carla@simple.biz", "reason": "revoked finance" }
```

Refuses self-targeted force-logouts (returns `{ success: true, skipped: 'self' }`) so admins can't lock themselves out of their own browser session.

**Tables**: `app_settings`, `audit_log`
**Service Role**: Yes

---

## 12.11 MESA Requests *(added 2026-06-01)*

Employee-submitted MESA (Medical Emergency Savings Account) requests. Backed by `public.mesa_requests` — run `references/add_mesa_requests.sql` before using these endpoints.

### `GET /api/mesa-requests`

List requests. Behaviour depends on query params:

- `?email=<work_email>` — returns that employee's own submissions. Auth: `authorizeEmailAccess` (self or elevated).
- *(no email)* — returns all submissions. Auth: `requireElevatedSession` (Accounting / admin only).

**Additional query params** (all optional):
- `status` — filter to `pending`, `approved`, or `denied`
- `request_type` — filter to `opt_in`, `opt_out`, `disbursement`, or `return`
- `limit` — integer, default 200

**Response** `200`:
```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "jane@simple.biz",
      "full_name": "Jane Doe",
      "department": "Lead Gen",
      "request_type": "disbursement",
      "fpu_date": null,
      "disbursement_reason": "Medical Emergency",
      "explanation": "Unexpected hospital visit for my child.",
      "amount_needed": 5000.00,
      "status": "pending",
      "review_notes": null,
      "reviewed_by": null,
      "reviewed_at": null,
      "created_at": "2026-06-01T09:30:00Z"
    }
  ]
}
```

**Tables**: `mesa_requests`
**Service Role**: Required

---

### `POST /api/mesa-requests`

Employee submits a new MESA request. Auth: `authorizeEmailAccess(work_email)` — employees can only submit for themselves; elevated users may submit on behalf of another.

**Request Body** `application/json`:
```json
{
  "work_email": "jane@simple.biz",
  "full_name": "Jane Doe",
  "department": "Lead Gen",
  "request_type": "disbursement",
  "fpu_date": null,
  "disbursement_reason": "Medical Emergency",
  "explanation": "Unexpected hospital visit for my child.",
  "amount_needed": 5000.00
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `work_email` | string | Yes | Must match session (unless elevated) |
| `full_name` | string | Yes | |
| `department` | string | Yes | |
| `request_type` | string | Yes | One of `opt_in`, `opt_out`, `disbursement`, `return` |
| `fpu_date` | string | No | Opt-in only — date FPU was completed |
| `disbursement_reason` | string | No | Disbursement only — reason category |
| `explanation` | string | No | Disbursement / return notes (max 250 chars enforced by UI) |
| `amount_needed` | number | No | Disbursement only — amount in PHP |

**Response** `200`:
```json
{ "success": true, "id": "uuid" }
```

**Error Response**:
- `400` — missing required fields or invalid `request_type`
- `401` — not signed in
- `403` — attempting to submit for another employee without elevated role
- `500` — DB error

Audit log: `mesa.request.<request_type>`.

**Tables**: `mesa_requests`, `audit_log`
**Service Role**: Required

---

### `PATCH /api/mesa-requests/[id]`

Accounting approves or denies a pending MESA request. Auth: `requireElevatedSession`.

**Request Body** `application/json`:
```json
{
  "status": "approved",
  "review_notes": "Verified with accounting — disbursement queued for this Friday."
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | Yes | `approved` or `denied` |
| `review_notes` | string | No | Optional note surfaced back to the employee |

**Response** `200`:
```json
{ "success": true }
```

Side effects: stamps `reviewed_by` (session email), `reviewed_at` (server timestamp), and `review_notes` on the row. Note: approving an `opt_in` request does **not** automatically flip `employee_hourly_rates.mesa_member`; accounting must do that separately via `POST /api/toggle-mesa-member`. This is intentional — the request is a signal, not an automated toggle.

**Error Response**:
- `400` — `status` not `approved` or `denied`, or missing `id`
- `401` / `403` — auth
- `500` — DB error

Audit log: `mesa.request.approved` or `mesa.request.denied`.

**Tables**: `mesa_requests`, `audit_log`
**Service Role**: Required

---

## 13. Planned Endpoints (Payroll Automation)

These endpoints do not exist yet. They are required for automating Step 5 (Dispatch) and webhook-based paystub delivery.

### `POST /api/payroll/finalize` (planned)

Persists a completed payroll run.

```json
// Request
{
  "payrollMonth": "2026-03",
  "employees": [
    {
      "email": "franm@simple.biz",
      "totalHours": 43.89,
      "regularPay": 5486.25,
      "otPay": 730.31,
      "bonuses": { "perfect_attendance": 5000, "tech_bonus": 1850 },
      "finalPay": 13066.56
    }
  ]
}

// Response
{
  "payrollRunId": "uuid",
  "status": "finalized",
  "employeeCount": 50,
  "totalPayout": 653328.00
}
```

**New tables required**: `payroll_runs`, `payroll_line_items`

---

### `GET /api/payroll/paystub/:runId/:email` (planned)

Returns structured paystub data for a single employee in a specific payroll run.

```json
{
  "employee": { "name": "Fran M", "email": "franm@simple.biz", "department": "HR" },
  "period": { "month": "March 2026", "pabStart": "2026-03-02", "pabEnd": "2026-04-03" },
  "hours": { "total": 43.89, "regular": 40.0, "overtime": 3.89 },
  "pay": {
    "regularRate": 137.16, "otRate": 187.50,
    "regularPay": 5486.25, "otPay": 730.31,
    "bonuses": [
      { "name": "Perfect Attendance", "amount": 5000 },
      { "name": "Technology Bonus", "amount": 1850 }
    ],
    "totalBonuses": 6850,
    "grossPay": 13066.56
  },
  "bankInfo": { "bankName": "BDO", "accountLast4": "7890" }
}
```

---

### `POST /api/payroll/dispatch` (planned)

Triggers paystub delivery via configured webhooks.

```json
// Request
{
  "payrollRunId": "uuid",
  "channel": "email",
  "recipients": ["franm@simple.biz", "john@simple.biz"]
}

// Response
{
  "dispatched": 50,
  "failed": 2,
  "deliveries": [
    { "email": "franm@simple.biz", "status": "sent", "channel": "email" },
    { "email": "john@simple.biz", "status": "failed", "error": "Invalid email" }
  ]
}
```

**New tables required**: `payroll_dispatches`, `webhook_configs`

---

### `GET /api/payroll/runs` (planned)

Lists all finalized payroll runs.

```json
{
  "runs": [
    {
      "id": "uuid",
      "month": "2026-03",
      "finalizedAt": "2026-04-04T10:30:00Z",
      "finalizedBy": "franm@simple.biz",
      "employeeCount": 50,
      "totalPayout": 653328.00,
      "status": "dispatched"
    }
  ]
}
```

---

## Supabase Tables Summary

| Table | Used By | Operations |
|---|---|---|
| `global_master_list` | employees, global-master-list, add-employee, delete-employee, update-employee-profile, employee-profile-photo | R, C, U, D |
| `employee_hourly_rates` | employee-hourly-rates, add-employee, delete-employee, update-employee-profile, update-employee-rates | R, C, U, D |
| `employee_ids` | employee-ids, update-employee-ids | R, U |
| `hubstaff_hours` | hubstaff-hours | R, C, D |
| `app_settings` | app-settings | R, U (upsert) |
| `payroll_runs` | *(planned)* | C, R |
| `payroll_line_items` | *(planned)* | C, R |
| `payroll_dispatches` | *(planned)* | C, R, U |
| `webhook_configs` | *(planned)* | C, R, U, D |

---

## Environment Variables

| Variable | Required | Used By |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | All Supabase clients |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Read operations |
| `SUPABASE_SERVICE_ROLE_KEY` | For writes | Mutations, CSV upload, photo upload |
| `NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE` | No | Override `global_master_list` table name |
| `NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE` | No | Override `employee_hourly_rates` table name |
| `NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE` | No | Override `hubstaff_hours` table name |

---

## Error Handling

All endpoints follow a consistent error pattern:

- **Validation errors**: `400` with `{ "error": "description" }`
- **Auth errors** (planned): `401` with `{ "error": "Unauthorized" }`
- **Permission errors** (planned): `403` with `{ "error": "Insufficient permissions" }`
- **Server errors**: `500` with `{ "error": "description" }` or `{ "success": false, "error": "description" }`

Mutation endpoints that return `{ "success": boolean }` use `true` on success, `false` on failure with an accompanying `error` field.

---

## Rate Limiting (Planned)

No rate limiting is currently implemented. After RBAC:
- Login: 5 attempts per minute per IP
- CSV upload: 10 per hour per user
- All other mutations: 60 per minute per user
- Read endpoints: 120 per minute per user
