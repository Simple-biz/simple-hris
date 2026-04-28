# Simple HRIS: API Reference

Complete documentation for all REST API endpoints. Base URL: `http://localhost:3000` (development).

> **Auth status** (as of 2026-04-21): most endpoints are still **unauthenticated** pending SSO. The PAB dispute decide/edit endpoints (`PATCH /api/pab-disputes/[id]`) enforce server-side role-based access via `canActOnDisputes(email)` — caller must hold an active role from `DISPUTE_ACTOR_ROLES` in `employee_roles`. Orphanage-visit endpoints still trust a client-supplied `admin_name` (auth gap). See [IMPLEMENTATION_PLAN_RBAC.md](./IMPLEMENTATION_PLAN_RBAC.md) and [AUDIT_2026-04-21.md](./AUDIT_2026-04-21.md) for the full picture.

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
13. [Planned Endpoints (Payroll Automation)](#13-planned-endpoints-payroll-automation)

---

## 1. Employees

### `GET /api/employees`

Fetches all employees from the `global_master_list` table.

**Query Parameters**: None

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
  "ratesReconcile": {
    "masterCount": 120,
    "ratesCount": 115,
    "ratesFewerThanMaster": true,
    "hint": "employee_hourly_rates has 5 fewer rows than the master list — add or sync rates for payroll."
  }
}
```

`ratesReconcile` may be `null` if counts could not be read after import.

**Tables**: Writes `global_master_list` only (does not change `employee_hourly_rates`).

**Service Role**: Required

---

### `GET /api/global-master-list`

Lightweight check that the service role can read row counts on the master and rates tables. No file upload.

**Response** `200`: `{ "ok": true, "masterCount": 120, "ratesCount": 115, "masterError": null, "ratesError": null }`

**Service Role**: Required

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

**Query Parameters**: None

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
  "otRate": 225.00
}
```

| Field | Type | Required |
|---|---|---|
| `workEmail` | string | At least one email required |
| `personalEmail` | string | At least one email required |
| `regularRate` | number/string | Yes |
| `otRate` | number/string | Yes |

**Response** `200`:
```json
{ "success": true }
```

**Tables**: Updates `employee_hourly_rates`
**Service Role**: Depends on utility function

---

## 3. Employee IDs & Bank Info

### `GET /api/employee-ids`

Fetches all employee IDs and bank information from the `employee_ids` table.

**Query Parameters**: None

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

**Allowed update fields**: Only the fields listed above are accepted. All others are silently ignored. Empty strings are converted to `null`.

**Response** `200`:
```json
{ "success": true }
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

Three modes depending on query parameters:

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

**Query Parameters**: `?source_file=simple-biz_daily_report_2026-03-01_to_2026-03-07.csv`

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

**Tables**: Reads `hubstaff_hours`
**Service Role**: Required for Mode 3 full fetch; Modes 1-2 use service role if available, fall back to anon

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

Reads a single application setting.

**Query Parameters**:

| Param | Type | Required |
|---|---|---|
| `key` | string | Yes |

**Known keys**:
- `usd_to_php_rate` — USD to PHP exchange rate
- `hubstaff_daily_breakdown` — cached daily breakdown data
- `pab_period_overrides` — JSON map `{ "YYYY-MM": { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } }`. Per-month PAB window overrides; months without an entry fall back to `getPabMonthRange(year, month)`. Written from the PAB settings modal in Payroll Wizard → Additions.
- `pab_period_active_month` — `"YYYY-MM"`. Which month the Additions tab currently evaluates. Absent → today's PAB month.
- `pab_scope_department_keys` — JSON array of department keys in PAB scope (`null`/missing = all, `[]` = none). Edited in System Settings.
- `pab_period_manual`, `pab_period_start`, `pab_period_end` — **legacy** single-range override. Still read for back-compat; auto-migrated into `pab_period_overrides` on first load when the new map is empty. New code should write to `pab_period_overrides` instead.
- `pab_dispute_reason_codes` — JSON array of permitted reason codes for `/api/pab-disputes`.

**Response** `200`:
```json
{ "value": "56.00", "error": null }
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

Endpoints backing the PAB dispute flow (employees challenge failing days; Accounting approves / denies) and the admin Orphanage Visits roster. Behaviour is documented in [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md#pab-day-dispute-system).

> **Auth status** (as of 2026-04-21): dispute decide/edit endpoints enforce role-based access on the server via `canActOnDisputes(email)` against `employee_roles`. The orphanage-visits endpoints currently accept `admin_name` as a client-supplied string and do **not** enforce auth — this gap is tracked and will be closed once SSO lands.

### `GET /api/pab-disputes`

List disputes, optionally filtered.

**Query Parameters**:
- `email` (optional): normalised work email filter
- `from` (optional): `YYYY-MM-DD` inclusive lower bound on `dispute_date`
- `to` (optional): `YYYY-MM-DD` inclusive upper bound on `dispute_date`
- `status` (optional): `pending` | `approved` | `denied`
- `limit` (optional): integer; default unlimited, typical caller sets `500`

**Response** `200`:
```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "jane@simple.biz",
      "dispute_date": "2026-04-14",
      "reason": "orphanage_visit",
      "explanation": "Visit to nearby orphanage, home late",
      "status": "approved",
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
  "reason": "orphanage_visit",
  "explanation": "Visited the orphanage — home at 3pm",
  "created_by": "jane@simple.biz"
}
```

- `work_email`, `dispute_date` (`YYYY-MM-DD`), `reason` are required.
- `reason` is validated against the current `pab_dispute_reason_codes` list in `app_settings` when any codes are configured.

**Response** `200`:
```json
{ "success": true, "id": "uuid", "error": null }
```

**Error Response**:
- `400` — missing / malformed fields
- `409` — a dispute already exists for that `(work_email, dispute_date)` pair
- `500` — server error

Audit log: `pab_dispute.submitted` (user_role resolved from `employee_roles`, falling back to `Employee`).

**Tables**: `pab_day_disputes`, `audit_log`, `app_settings` (read `pab_dispute_reason_codes`)
**Service Role**: Required

---

### `PATCH /api/pab-disputes/[id]`

Decide or edit a dispute. Gated server-side by `canActOnDisputes(decided_by)` — caller must have an active role in `DISPUTE_ACTOR_ROLES` (`payroll_coordinator`, `payroll_manager`, `finance`, `hr_coordinator`, `admin`).

**Body** (approve / deny a pending dispute):
```json
{
  "action": "approve",          // or "deny"
  "decided_by": "carla@simple.biz",
  "decision_note": "Confirmed",
  "override_hours": 6.5          // null or number >= 0; ignored when action=deny
}
```

**Body** (edit an already-decided dispute):
```json
{
  "action": "edit",
  "status": "approved",          // required; "approved" | "denied"
  "decided_by": "carla@simple.biz",
  "decision_note": "Updated note",
  "override_hours": null         // null (clear), 0 (zero-out), or > 0 (set total)
}
```

**Response** `200`:
```json
{ "success": true, "stage": "final", "error": null }
```

**Error Response**:
- `400` — invalid action, missing `decided_by`, pending dispute edited via `edit` action
- `403` — caller not in an accounting role (`Not authorized — only Accounting roles can …`)
- `404` — dispute id not found
- `500` — server error

Audit log: `pab_dispute.approved`, `pab_dispute.denied`, or `pab_dispute.edited` with the dynamically-resolved user role.

**Tables**: `pab_day_disputes`, `audit_log`, `employee_roles` (read)
**Service Role**: Required

---

### `DELETE /api/pab-disputes/[id]`

Employee withdraws their own pending dispute.

**Query Parameters**:
- `employee_email` (required): must match the dispute's `work_email` (normalised); otherwise `403 Forbidden`.

**Response** `200`:
```json
{ "success": true, "error": null }
```

**Error Response**:
- `400` — only pending disputes can be withdrawn
- `403` — email does not match the dispute owner
- `404` — dispute not found

Audit log: `pab_dispute.withdrawn`.

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

The Payment Dispatch feature exposes three endpoints under `/api/payment-dispatches/`. See [PAYMENT_DISPATCH.md](./PAYMENT_DISPATCH.md) for the broader feature context.

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

Read / set the global `payroll.dispatch_locked` flag. Documented in [PAYMENT_DISPATCH.md §6](./PAYMENT_DISPATCH.md).

---

## 12. Disbursement Reports

> Added 2026-04-28. Backed by `public.disbursement_records` (one row per (week, employee)) seeded by `references/seed_disbursement_records.sql`. See [PAYMENT_DISPATCH.md §6.5](./PAYMENT_DISPATCH.md) for the full feature doc.

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
