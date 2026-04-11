# Simple HRIS: API Reference

Complete documentation for all REST API endpoints. Base URL: `http://localhost:3000` (development).

> **Auth status**: All endpoints are currently **unauthenticated**. See [IMPLEMENTATION_PLAN_RBAC.md](./IMPLEMENTATION_PLAN_RBAC.md) for the planned role-based access control.

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
10. [Planned Endpoints (Payroll Automation)](#10-planned-endpoints-payroll-automation)

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

## 10. Planned Endpoints (Payroll Automation)

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
| `global_master_list` | employees, add-employee, delete-employee, update-employee-profile, employee-profile-photo | R, C, U, D |
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
