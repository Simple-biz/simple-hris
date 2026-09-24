# Simple HRIS: API Reference

REST API endpoint documentation. Base URL: `http://localhost:3000` (development).

> **Coverage, measured 2026-09-22: this file documents 119 of the 325 `app/api/**/route.ts` files — 206 are absent.**
> It said *"complete documentation for all REST API endpoints"* until that count was taken. 41 of the 206 appear in **no doc at all**;
> the other 165 are described in a feature doc but never reached this index. Entire families are missing — `/api/hsl-bonus`,
> `/api/support`, `/api/orphanage-interns`, `/api/swall`, `/api/presence`, `/api/screening` have **zero** mentions here.
> **That is now fixed for the index question: § *Route index* at the foot of this file lists all 325.**
> An endpoint absent from **that table** does not exist; an endpoint absent from the hand-written sections above is
> merely **unspecified**. The two are different claims and only the first is safe to act on.
> Session log item 146; [[reference-docs-rot-silently]].

> **Auth status — the 2026-04-21 text below is STALE and kept only for its still-live gaps.** RBAC shipped: `requireFeatureAccess` (`src/lib/auth/authorize-feature.ts`) gates **58** route files and `requireElevatedSession` **46**; **189 of 325** routes carry a recognised auth or cron gate and **136 do not** (measured 2026-09-22 — a count of gates, **not** a security verdict: some of the 136 are public by design and some may gate in a helper this scan does not know). *An earlier pass the same day printed 121/204 against a narrower list of helper names; widening it to include `requirePageRoles`, `authorizeEmail`, `getServerSession`, cron secrets and service-role use gives 189/136, and the per-route result is in § Route index*. See [route-authorization.md](../features/route-authorization.md) (2026-06-23) and [rbac-feature-permissions.md](../features/rbac-feature-permissions.md), not the RBAC *plan* linked below. Original note follows.
>
> **Auth status** (as of 2026-04-21): most endpoints were then still **unauthenticated** pending SSO. The PAB dispute decide/edit endpoints (`PATCH /api/pab-disputes/[id]`) enforce server-side role-based access via `canActOnDisputes(email)` — caller must hold an active role from `DISPUTE_ACTOR_ROLES` in `employee_roles`. Orphanage-visit endpoints still trust a client-supplied `admin_name` (auth gap). See [IMPLEMENTATION_PLAN_RBAC.md](../implementation-plans/implementation-plan-rbac.md) and [AUDIT_2026-04-21.md](../audits/audit-2026-04-21.md) for the full picture.

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
12.5. [Leave Requests](#125-leave-requests)
12.7. [Admin Diagnostics](#127-admin-diagnostics)
12.9. [Time Adjustment Requests](#129-time-adjustment-requests)
12.12. [Onboarding (public)](#1212-onboarding-public)
14. [Paystub Dispatch Queue](#14-paystub-dispatch-queue)
13. [Planned Endpoints (Payroll Automation)](#13-planned-endpoints-payroll-automation)
15. [New endpoints (2026-07-08..10)](#15-new-endpoints-2026-07-0810)
16. [Audit log + routes gated 2026-09-09](#16-audit-log--routes-gated-2026-09-09)
17. [Penny AI (assistants)](#17-penny-ai-assistants-added-2026-09-12)
18. [QC Compare sheet (shared)](#18-qc-compare-sheet-shared-added-2026-09-14)
19. [Manager departed members, HSL scheduling and the QC assignments contract](#19-manager-departed-members-hsl-scheduling-and-the-qc-assignments-contract-added-2026-09-14)
20. [Department sub-teams — the contract changes](#20-department-sub-teams--the-contract-changes-added-2026-09-2122)

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
- `email` *(optional, added 2026-05-14)* — server-side ilike filter on `"Work Email"` then `"Personal Email"`. Returns a 1-row array (or empty). Used by the employee portal to avoid downloading every rate row just to read its own. **Auth: self-or-elevated** (`authorizeEmailAccess`) — a non-elevated caller may only read their own row; the requested `?email=` is resolved against the session.

**Payment Catalog overlay** *(added 2026-06-16)* — when `?email=` is supplied, the returned `regular_rate` / `ot_rate` are run through the compute-time **Payment Catalog** overlay (`src/lib/payroll/resolve-rate.ts`) so the self-view ("your current rate" on Dashboard / Profile / Mesa) matches what the Payroll Wizard pays. Priority: **individual catalog rate → the sheet row → department base** (the department structure fills in only when the row has no rate at all). The result is returned as the PHP-equivalent (USD structures are converted at the stored FX rate, `usd_to_php_rate`). The full-table fetch (no `?email=`) does **not** apply the overlay. Historical per-day pay still resolves from `employee_rate_history` elsewhere — the overlay is "live cycle only."

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

**Tables**: Reads `employee_hourly_rates`; reads `payment_catalog_pay_structures` + `app_settings` (`usd_to_php_rate`) when `?email=` is set
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

### `POST /api/cron/sync-rates-from-sheet` *(added 2026-05-07; **DISABLED 2026-06-16**)*

> **Disabled** — guarded by the module-level constant `RATES_SHEET_SYNC_DISABLED = true`. Employee rates are now managed in the **Payment Catalog** (see [bonus-catalog.md](../features/bonus-catalog.md)); letting the Google Sheet overwrite `employee_hourly_rates` / `employee_rate_history` would change pay inside HRIS, which is no longer allowed. The route short-circuits **after the auth check but before reading the sheet or writing any pay table**, returning HTTP `200` with `{ "success": false, "disabled": true, "error": "Google Sheet rates sync is disabled. …" }`. The admin CSV-imports UI surfaces this as an info toast rather than an error. Flip the constant back to `false` to re-enable.
>
> The separate **manual CSV rates upload** (`POST /api/employee-hourly-rates-upload`, above) is **not** affected — it remains enabled and still writes pay tables.

Manual-button-only Google Sheet sync for the rates ledger. Reads the configured Google Sheet via the same service-account auth as the master list sync, expects headers on row 1 (no sentinel synthesis — rates have no `MASTERLIST` analogue), and pipes the resulting CSV through `replaceEmployeeHourlyRatesFromCsv()`.

**Required env**: `GOOGLE_SHEETS_RATES_SHEET_ID`, `GOOGLE_SHEETS_RATES_TAB_NAME`, plus the shared `GOOGLE_SHEETS_SERVICE_ACCOUNT_*` and `SUPABASE_SERVICE_ROLE_KEY`.

**Response** (when re-enabled) `200`: same shape as the master sync but with the rates ingest result fields (`uniqueEmployees`, `skippedNoWorkEmail`, `skippedNoRate`).

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

**Allowed update fields**: Only the fields listed above are accepted. All others are silently ignored, **except `bank_preferred`** (below). Empty strings are converted to `null`.

**Behavior notes**:
- **The sending bank (`bank_preferred`) is not writable here** — it is Accounting's alone since 2026-09-24, set through `PATCH /api/people/[email]/banking` ([bank-preferred-routing.md](../features/bank-preferred-routing.md) §1). A body carrying a CHANGED `bank_preferred` gets **`403`** `"The sending bank can only be changed by Accounting, in People → Banking…"` from every caller, self-service or staff; the unchanged stored value (a page opened before the retirement still posts it) is a no-op; an unreadable stored value is **`503`** and nothing is saved. Until 2026-09-24 the field was accepted and filed as an approval request for Accounting → Issues.
- A save that writes `preferred_processor` and leaves the stored sending bank out of step with it (the 1:1 rule) still lands; the Accounting/CEO/Admin `people.banking.self_updated` alert then says *"Bank details updated — sending bank no longer matches"* and carries `details.send_from_mismatch`.
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

### `POST /api/payment-catalog/pay-structures`

Gate: `requireFeatureEdit('accounting','bonus_catalog')`; `423` via `rejectWhilePayrollProcessing` (admins bypass). Body: `{ structure, effectiveDate?, source? }`. Upserts a department- or employee-scoped Payment Catalog pay structure on its **natural key** (`resolvePayStructureWriteTargetId`; bonus-catalog.md §5.6). For an employee structure it also writes the dated `employee_rate_history` row, the `employee_hourly_rates` cache (when effective ≤ today), both Google Sheets (best-effort) and the employee notification, and audits `payroll.rate.set`. **Two behaviours by `source`:** the Payment Catalog editor (`payment_catalog`, default) supersedes history rows `effective_from >= today OR == effectiveDate` and fires the sync without awaiting it; the Readiness / Offboarded fixer (`payroll_wizard_readiness`) is a **complete override** (2026-09-15) — deletes the person's other employee-scope structures in every other department (named in the audit row as `superseded_structures`), supersedes history from `min(today, effectiveDate)` (`historySupersedeFloor`), and **awaits** the sync so a failure returns `500` with a retryable message. Returns `{ row, error, supersededStructures }`. `GET` lists structures (`requireRateVisibilitySession`); `DELETE ?id=` removes one. [route.ts](app/api/payment-catalog/pay-structures/route.ts)

### `GET /api/payroll-wizard/offboarded`

Gate: `requireFeatureAccess('accounting','payroll_wizard','view')`. Powers the Payroll Notes → **Offboarded** pane: recently-offboarded people with hours in the cycle's timesheet who may still need their final check's rate or bank set, scoped by `?source_file=` (default: the live upload). Each row carries `rateStatus` / `bankStatus`, the PAY department (`department`, resolved by `leaverPayDepartment` — the master cell unless the leaver's effective individual structure, touched on/after the departure, names a different department; `departmentSource` = `master` | `catalog`, `masterDepartment` verbatim), the payable identity (`hubstaffEmail`, `rateWriteEmail` = Hubstaff → work → personal), `rateCurrent` (rate, OT, currency, source, and the department the individual structure files under) and `bankCurrent` — a **server-masked** readout of the live payout record (effective rail, paid slot, bank, holder, last-4 account, tail-masked SWIFT, masked wallet email, payability). A full account number never leaves this route. `500` only when the leaver list itself cannot be read; partial reads land in `degraded[]`. [route.ts](app/api/payroll-wizard/offboarded/route.ts) · `src/lib/payroll/offboarded-payroll-candidates.ts`

### `GET /api/payroll-wizard/offboarded-roster`

Gate: `requireFeatureAccess('accounting','payroll_wizard','view')`. The Payroll Wizard's **final-pay roster overlay** — recently-offboarded people with hours in the cycle's timesheet (`?source_file=`, default the live upload), so tier 1 of the wizard's department resolver has something to say about a leaver (`active_employees` carries no off-boarded rows). Rows are `OffboardedRosterRow` (`src/lib/roster/offboarded-roster-row.ts`): identity aliases incl. `hubstaff_email`, `start_date`, `off_boarded_at`, and `department` — since 2026-09-15 the leaver's PAY department from `leaverPayDepartment` (master cell overridden by the department their effective individual Payment Catalog structure files under when it was touched on/after the departure and differs), with `department_source` and `master_department` alongside. **Never 500s**: an empty overlay is normal, so failures return `200` with `rows: []` and an `error` note; a failed Payment Catalog read keeps every row on its master cell and sets `catalog_error`. It can only annotate an email that already has a calc row — it never adds a payee. [route.ts](app/api/payroll-wizard/offboarded-roster/route.ts)

### `GET /api/payroll-wizard/first-hours-week`

Gate: `requireFeatureAccess('accounting','payroll_wizard','view')`. The Payroll Wizard's **"first paycheck" index** (2026-09-22): for every email that has ever appeared in `hubstaff_hours`, the EARLIEST upload week (parsed `_to_` period start, `YYYY-MM-DD`) carrying it — `{ byEmail, oldestWeek, filesIndexed, rowsSkipped, error }`. Step 2 (Initial Calculation) labels a calc row whose first-ever hours fall in the week in view, so a hire who worked a few hours and was off-boarded inside their first week is visible on the payroll table itself instead of missing from every active-roster new-hire list. Built by `src/lib/payroll/first-hours-index.ts`: two columns paged over the whole table (40,509 rows / 31 uploads on 2026-09-22), every parseable upload counted as history (backfills and junk-suffixed names included — never the junk regex), cached in-process per upload-list signature with a 10-minute TTL. No query parameters — the index is week-independent. **Never 500s**: a failed read returns `200` with an EMPTY `byEmail` and `error` set, and the wizard then says the labels are *unavailable* rather than labelling nobody. Display-only: it adds no payee and never enters the payload, the `final_pay` snapshot or dispatch. Rule module + tests: `src/lib/payroll/first-paycheck.ts`. [route.ts](app/api/payroll-wizard/first-hours-week/route.ts)

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

**Auth** *(since 2026-09-09, `ddf4c790`)*: `requireElevatedSession()` — this was one of the six ungated routes found by the pre-release sweep, and it is an unauthenticated **CSV → Postgres write**. Writes audit `daily_report.imported`. **No component in the app fetches it**; deletion is the right end state and is Kane's call (`features/audit-log.md` §8, `features/pre-release-security-readiness.md` §2).

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
- `email` *(optional)* — recipient email filter (passed to `listPaymentDispatches` as `recipientEmail`).

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

**Auth**: `requireFeatureEdit("accounting", "payment_dispatch")` — caller must hold edit access on the Payment Dispatch feature (this is the gate Lenny's Mark-Paid action runs under).

**Response** `200`: `{ "row": {…}, "error": null, "paystub": { "staged": false, "sent": false, "error": null } }` — `row` is the same shape as `GET`'s row entries; `paystub` reports the per-employee paystub send (see below).

Side effects:
- Inserts into `payment_dispatches`.
- Trigger `payment_dispatches_sync_disbursement` updates the matching `disbursement_records` row's `status / paid_amount_usd / paid_at / bank_used / transaction_id / dispatch_id` (matched on `(cycle_source_file, LOWER(recipient_email))`).
- Writes a `payment.dispatched` audit log entry tagged `payroll_clerk`.

**Per-employee paystub send** *(added 2026-06-16)* — when the dispatch lands as `status='paid'` **and** has a `cycle_source_file`, the route looks up the staged paystub row for that `(cycle_source_file, recipient_email)` in `paystub_dispatch_queue` (see [§14](#14-paystub-dispatch-queue)) and, if found, fires the n8n paystub webhook for **just that one person** via `forwardPaystubDispatch` (`src/lib/payroll/paystub-dispatch.ts`). This replaces the old batch email of every paystub at once. Behavior:
- **Best-effort** — a failed send never fails the payment (the money already moved); the error is stamped on the queue row (`markPaystubSendError`) so it can be re-sent from the Excluded tab. A success calls `markPaystubSent` (bumps `send_count`, stamps `sent_at`/`sent_by`).
- The `paystub` result tells the client what happened: `{ staged: true, sent: true }` (mailed), `{ staged: true, sent: false, error }` (staged but send failed / no resolvable personal email), or `{ staged: false }` (no staged row — nothing to mail).
- Writes a `paystub.sent` or `paystub.send_failed` audit entry.
- **Scope-safe**: MESA disbursements and orphanage-budget payouts go through their own routes, so they never reach this salary-paystub send path.

**Tables**: `payment_dispatches`, `disbursement_records` (via trigger), `paystub_dispatch_queue` (read staged row + stamp sent/error), `audit_log`
**Service Role**: Required (writes).

### `GET /api/payroll-dispatch-lock` & `POST /api/payroll-dispatch-lock`

Read / set the global `payroll.dispatch_locked` flag. Documented in [PAYMENT_DISPATCH.md §6](../features/payment-dispatch.md).

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

> **One endpoint, three maps (since 2026-09-18).** Admin → Diagnostics renders this *single*
> response as three dashboard-scoped service maps (System / HR / Accounting) plus two performance
> tabs. There are **no scoped endpoints** — the client filters by node id, and the tab shell owns
> **one** 30s poller shared by every mounted map. Do not add a per-map fetch: with the
> mount-once-then-hide panes, three pollers would be 3 × 24 service-role probes against
> production every 30 seconds, forever. If a map needs data this response does not carry, add it
> to this response. See [diagnostics-service-maps.md](../features/diagnostics-service-maps.md).

**Authorization**: NextAuth session must hold the `'admin'` role. Returns 401 if not signed in, 403 if role check fails. Belt-and-suspenders alongside the client-side `'diagnostics'` tab gate so non-admin sessions can never read probe results. **Nothing outside the Admin shell reads this route** — asked directly on 2026-09-18 whether HR and Accounting should see their own pipeline health on their own dashboards, Kane ruled *"Admin should bypass everything and should monitor everything that should be the absolute rule"*, and the proposed HR-shell / Accounting-shell widgets were dropped rather than this gate widened.

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
    // … 23 more nodes — 24 total as of 2026-09-18
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
  ],
  "metrics": {
    "hrisAdoption": { "onboarded": 812, "total": 1343 }
  }
}
```

`alerts` is derived, not separately probed: **one entry per non-healthy node**, `nodeId` pointing
back at it. `metrics.hrisAdoption` is present only on a live response (`computeHrisAdoption`) and
is a **whole-roster** figure — the client shows it on the System map only, because on a scoped map
a company-wide ratio would read as a claim about that pipeline.

**Probes** — 21 helpers producing 24 nodes, all run in parallel via `Promise.all`, each capped at
4s via `withProbeTimeout` (a probe that overruns returns `critical` / "Probe timed out." rather
than stalling the response). Total wall-clock is the slowest probe.

| Probe helper | What it reads | Status mapping |
|---|---|---|
| `probeSupabase` | `select head` on `app_settings`, latency (anon client) | <500ms healthy, 500–2000ms warning, errors/timeouts critical |
| `probePgPool` | `SELECT 1` over a `pg.Pool` if `DATABASE_URL` set | unknown when env missing, healthy <1.5s, warning slower, critical on connection error |
| `probeHubstaffCsv` | Latest `hubstaff_uploads` row + age | <7d healthy, 7–14d warning, >14d warning, unknown if empty |
| `probeMasterList` | `count(*)` from `active_employees` view | 0 critical, <50 warning, else healthy |
| `probeAuditLog` | Latest `audit_log` row, age | <7d healthy, >7d or empty warning |
| `probeDisbursementRecords` | `count(*)` from `disbursement_records` | healthy if reads, warning on error |
| `probeAuth` | Recent login events from `audit_log` (24h window) | always warning until the admin gate is enforced server-side |
| `probeDailyReport` | Latest `daily_reports.*` audit entry, age | <48h healthy, >48h warning, never warning |
| `probeRates` | `count(*)` from `employee_hourly_rates` | 0 warning, else healthy |
| `probeAppSettings` | Key count on `app_settings` + `auth.force_logout_map` parses as a JSON object | critical if unreadable, warning if the map is malformed, else healthy |
| `probeGoogleSheetsSync` | Recency of `csv.master.sync` / `csv.rates.sync` in `audit_log` | >7d warning, >30d critical |
| `probeRateHistory` | `employee_rate_history` — the authority for per-day rate resolution | healthy if the table reads |
| `probeNewHireChecklist` | `hr_new_hire_checklist` count + newest `period_start` + that week's `hr_new_hire_checklist_periods` lock row | warning **only** if the newest week has hires, is still `open`, and its Sunday is >7d past |
| `probeHrOnboarding` | Pending `hr_onboarding_submissions` + `hr_pending_employees` in `pending_work_email`/`ready`, hires stuck >7d | warning if any hire is stuck >7d or a table is missing |
| `probeHrOffboarding` | `hr.employee.offboarded` count (30d) + last 20 `hr.employee.webhook_fired.%` rows + total off-boarded | warning if any recent fire recorded `webhook_fired: false` |
| `probeTickets` | Active vs done counts on `tickets` (archived excluded) | healthy if reads, warning if missing / no SELECT |
| `probeTimeAdjustments` | Pending / manager-approved counts on `time_adjustment_requests`, plus stale >14d | warning if any request is pending >14d or the table is missing |
| `probePayrollWizardNotes` | Open (`done = false`) vs total on `payroll_wizard_notes` | healthy if reads, warning if missing / no SELECT |
| `probeMesa` | Event count on `mesa_ledger` + open-account count on `mesa_accounts` (best-effort) | warning if the ledger is empty / missing, else healthy |
| `probePaymentDispatch` | Total + paid counts on `payment_dispatches`, age of the newest row | warning if the newest dispatch is >14d old |
| `probeCycleCloseout` | Count of live `dispatch.cycle_closeout.%` keys + newest `updated_at` | healthy if the keys read — **no staleness threshold**, see below |

**Composite and constant nodes**: `payroll-wizard` is derived from `hubstaff-csv` + `master-list` + `disbursement-records` worst-case, with a **warning floor** (CSV mismatches stay subtle even when probes look green). `admin-shell` is always healthy — you can read this response, so the shell rendered. `supabase-client` and `supabase-postgres` share one probe. **The warning floor is specific to `payroll-wizard` and is not a pattern to copy**: a new node that reads healthy when it is healthy is the requirement, because a permanently amber node adds an alert nobody can clear and an alerts list that is never empty gets ignored.

**Two deliberate non-rules**, both of which look like omissions:

- **`payment-dispatch` reports counts and never a rate.** `payment_dispatches` structurally cannot see a payable person who was never dispatched, so any percentage over it sits at 97–99% by construction and flatters every week. Rates live on the Payroll Cycles tab, over a close-out's payable denominator, and nowhere else.
- **`cycle-closeout` has no age threshold.** Closing a week is a human cadence (22 of 27 cycles pre-date the feature existing), so a staleness rule would sit permanently amber. *Which* weeks are unclosed is already the Payroll Cycles tab's answer; a second implementation could only disagree with it.

**Row-cap safety**: every probe returns aggregates — counts via `head: true, count: 'exact'` and recency via `order(...).limit(1)`. **No probe fetches rows**, so the 1000-row PostgREST cap is unreachable by construction. This matters because `hr_new_hire_checklist` is already past it (1,479 rows live).

**Security**: probe outputs never include raw stack traces, SQL text, secrets, or employee PII. Errors are trimmed via `trimError()` (one-line, capped at 120 chars). PostgREST error codes pass through (useful for diagnosis, not sensitive). Aggregate counts, latencies and ages only.

**Error Response**:
- `401` — not signed in
- `403` — session lacks the `'admin'` role
- `500` — unexpected server error (probes have their own timeout fallback so this is rare)

`Cache-Control: no-store, max-age=0` on the response to prevent any CDN caching.

**Tables**: `app_settings` (incl. the `dispatch.cycle_closeout.%` keys), `hubstaff_uploads`, `active_employees` (view), `global_master_list`, `audit_log`, `disbursement_records`, `payment_dispatches`, `employee_hourly_rates`, `employee_rate_history`, `hr_new_hire_checklist`, `hr_new_hire_checklist_periods`, `hr_onboarding_submissions`, `hr_pending_employees`, `tickets`, `time_adjustment_requests`, `payroll_wizard_notes`, `mesa_ledger`, `mesa_accounts`
**Service Role**: Required (for read-through past RLS on operational tables)

**Adding a probe is a five-place change**, three of them enforced by source-scan tests because every way of forgetting fails *silently* — see [diagnostics-service-maps.md § Adding a node](../features/diagnostics-service-maps.md). Briefly: the helper here, the `node(...)` row in the route, the position + mock node in `SystemDiagnostics.tsx`, the id in `ALL_DIAGNOSTIC_NODE_IDS` (`src/lib/admin/diagnostics-scopes.ts`) with its scope, and the row in `system-diagnostics.md` § Probes.

See [features/system-diagnostics.md](../features/system-diagnostics.md) for per-node meanings, the edge animation system and the security contract; [features/diagnostics-service-maps.md](../features/diagnostics-service-maps.md) for the scoping rules and the single-poller constraint.

---

### `POST /api/admin/backfill-employee-ids` *(added 2026-05-14)*

One-shot backfill that stamps the `employee_id` column on every `global_master_list` row currently lacking one. Mirrors the in-memory YYMM-NNNN assignment the UI has always shown (`generateEmployeeIds()` in `src/lib/supabase/employees.ts`), so persisted IDs match what users already see — the first run shouldn't change any visible numbers.

**Why this exists**: until 2026-05-14 the `employee_id` field was computed in-memory on every read and renumbered whenever a same-month starter joined, left, or had their name changed. The column was added by `references/sql/alter/add_employee_id_to_global_master_list.sql` and this route is the one-shot populator. From then on, every master-list upload + every HR Promote call fills the column for any new rows automatically (`backfillEmployeeIds()` is invoked after both).

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

Most common cause: the column-add migration (`references/sql/alter/add_employee_id_to_global_master_list.sql`) hasn't been run yet.

**Idempotent**: re-running only fills nulls, never renumbers an existing ID. Safe to invoke any time.

**Tables**: `global_master_list` (read full roster + write `employee_id`)
**Service Role**: Required.

---

## 12.8 Employee Notifications *(added 2026-05-15)*

### `GET /api/employee-notifications`

Returns notifications for `?email=` (newest first), Admin-or-self. No fixed row cap — a dashboard shows all of its own notifications, not just the 50 most recent across every dashboard (PostgREST's `db.max-rows` ceiling still applies as a backstop). Optional `&view=<AppView>` scopes the result to the notifications that belong to that dashboard: every *mapped* type owned by a different dashboard is excluded, while unmapped types stay visible everywhere so nothing silently disappears (see `hiddenTypesForView` in `src/lib/notifications/notification-views.ts`). Feature-gated types the viewer isn't allowed to see are always excluded regardless of `view`. Omitting `view` returns every type — that's what the per-dashboard count/badge hooks use to bucket unread by view.

**Response**: `{ notifications: Array<{ id, type, tone, title, message, details, read_at, created_at }> }`.

### `PATCH /api/employee-notifications`

Marks rows read. Body: `{ id?, ids?, email? }` — if `ids` given, marks those; otherwise marks every unread row for `email`. The `NotificationsPanel` calls this with the `ids` of the notifications it currently shows, 2 seconds after they render, so opening one dashboard clears only that dashboard's unread badge (not the user's other dashboards).

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

Employee-submitted MESA (Medical Emergency Savings Account) requests. Backed by `public.mesa_requests` — run `references/sql/create/add_mesa_requests.sql` before using these endpoints.

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

## 12.12 Onboarding (public)

> Added 2026-06-16. The public onboarding flow gained an **Intellectual Property Assignment, Talent Release, and Copyright Waiver** as its first step (mirroring W-8BEN). On submit the server renders a filled PDF and stores it; HR views it through the submission-detail endpoint. See [onboarding-ip-assignment.md](../features/onboarding-ip-assignment.md) for the full feature doc (form, preview mode, PDF rendering, dark-mode/animation polish).

> **Rate limiting** — everything under `/api/onboarding/` is rate-limited in `middleware.ts`: `GET` 30 req/IP/min, `POST` 5 req/IP/min. These routes are public (no session) by design — the invite token *is* the auth.

> **PENDING migration #73** — `references/sql/alter/add_ip_assignment_to_onboarding.sql` adds 6 columns to `hr_onboarding_submissions` (`ip_agreement_agreed`, `ip_agreement_name`, `ip_agreement_signature`, `ip_agreement_date`, `ip_assignment_file_path`, `ip_assignment_file_name`). Until it is run, the live submit (`POST /api/onboarding/[token]`) errors on the IP write; the preview endpoint below works regardless.

### `GET /api/onboarding/[token]`

Loads the public onboarding form prefill for a real invite token (32-byte random string). Now also returns the IP Assignment fields (`ip_agreement_agreed`, `ip_agreement_name`, `ip_agreement_signature`, `ip_agreement_date`) alongside the existing prefill so a resumed form rehydrates the IP step.

### `POST /api/onboarding/[token]`

Submits the onboarding form for a real token. In addition to its prior behavior, it now:
- **Validates** the IP step: rejects with `400` listing the missing field(s) when `ip_agreement_agreed !== true`, `ip_agreement_name` is blank, `ip_agreement_signature` is missing, or `ip_agreement_date` is blank.
- **Renders + stores the signed PDF**: calls `generateIpAssignmentPdf({ name, signatureDataUrl, dateIso })` (pdf-lib) and uploads it via `uploadIpAssignmentFile(submissionId, bytes)` to the private **`hr-onboarding-files`** Supabase Storage bucket at **`<submission_id>/ip-assignment.pdf`**, then records `ip_assignment_file_path` + `ip_assignment_file_name` on the row. PDF generation/upload failure is logged but does not abort the submission.

**Tables**: `hr_onboarding_submissions`; Storage bucket `hr-onboarding-files`
**Service Role**: Required

---

### `POST /api/onboarding/ip-assignment-preview` *(added 2026-06-16)*

Public **dry-run** renderer for the IP Assignment PDF. Powers the no-save `/onboarding/preview` mode's Submit button so HR can see exactly what the signed document looks like before the feature is live — **no migration, real invite link, DB, or storage required**. Sits under the rate-limited `/api/onboarding/` prefix.

**Request Body** `application/json`:
```json
{
  "name": "Jane Doe",
  "signatureDataUrl": "data:image/png;base64,…",
  "dateIso": "2026-06-16"
}
```

All fields optional; `name` defaults to `"Participant"`, `signatureDataUrl`/`dateIso` default to `null`.

**Response** `200`: the rendered PDF bytes with headers:
- `Content-Type: application/pdf`
- `Content-Disposition: inline; filename="IP-Assignment-preview.pdf"`
- `Cache-Control: no-store`

**Error Response**:
- `400` — invalid JSON body
- `500` — `{ "error": "<message>" }` if PDF rendering throws

**Tables**: none. **Service Role**: not required (writes nothing).

---

## 14. Paystub Dispatch Queue

> Added 2026-06-16. Backs the per-employee paystub dispatch model — the Payroll Wizard stages each payable employee's authoritative paystub payload here on "Lock in Values & Send to Payment Dispatch", and the email fires one-by-one when Lenny marks each salary dispatch paid (see [`POST /api/payment-dispatches`](#post-apipayment-dispatches)). See [paystub-dispatch.md](../features/paystub-dispatch.md) for the full feature.

> **PENDING migration #72** — `paystub_dispatch_queue` (UNIQUE on `(cycle_source_file, recipient_email)`). Until it is run, the wizard's "Lock & Send" `POST` 500s. The migration also re-asserts `app_settings` in the `supabase_realtime` publication.

### `GET /api/paystub-dispatch-queue?source_file=<file>`

Lightweight list of staged rows for one cycle (no bank creds / full payload — see `LIST_COLUMNS` in `src/lib/supabase/paystub-dispatch-queue.ts`). Drives the dispatch queue's per-row sent/error badges and the routing of wizard-excluded people into the Excluded tab.

**Auth**: `requireFeatureAccess("accounting", "payment_dispatch", "view")`.

Returns `{ rows: [], error: null }` when `source_file` is missing.

**Response** `200`: `{ "rows": [ … ], "error": null }`.

### `POST /api/paystub-dispatch-queue`

The Payroll Wizard's "Lock in Values & Send to Payment Dispatch" stages **every** payable + excluded employee's paystub payload for the cycle here, replacing the prior staged set for that `source_file`.

**Auth**: `requireElevatedSession` (same gate as the wizard's other writes — payroll / admin).

**Request Body** `application/json`:
```json
{
  "source_file": "simple-biz_daily_report_2026-06-08_to_2026-06-14.csv",
  "pay_period": { "…": "…" },
  "entries": [
    { "recipient_email": "fran@simple.biz", "excluded": false, "payload": { "…": "…" } }
  ]
}
```

- `source_file` required (`400` otherwise).
- `entries` are filtered to those with a non-empty `recipient_email` before upsert.

**Response** `200`: `{ "staged": 42, "excluded": 3, "error": null }`. On DB error: `500` with `{ "staged": 0, "error": "<message>" }`.

Audit log: `paystubs.staged` (records `source_file`, `staged`, `payable`, `excluded`, and a capped `excluded_emails` list — the durable record of who was held this cycle).

**Tables**: `paystub_dispatch_queue`, `audit_log`
**Service Role**: Required

### `GET /api/paystub-dispatch-queue/arrears`

Cross-cycle unsettled pay for held (wizard-excluded) employees — one entry per employee with a running total + per-cycle breakdown. Drives the Payment Dispatch **Excluded** tab's "what we owe" rollup. View-gated (no bank creds / payload in the response).

**Auth**: `requireFeatureAccess("accounting", "payment_dispatch", "view")`.

**Response** `200`: `{ "entries": [ { "email": "…", "name": "…", "totalPhp": …, "totalUsd": …, "cycles": [ { "sourceFile": "…", "amountPhp": …, "amountUsd": …, "lockedAt": "…" } ] } ], "error": null }`. A cycle drops off the ledger once a matching `status='paid'` row exists in `payment_dispatches`.

**Tables**: `paystub_dispatch_queue` (+ `payment_dispatches` to detect settled cycles)
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
| `payment_catalog_pay_structures` | employee-hourly-rates (`?email=` overlay), payment-catalog | R |
| `hr_onboarding_submissions` | onboarding/[token], hr/onboarding-submissions/[id] | R, C, U |
| `paystub_dispatch_queue` *(migration #72 PENDING)* | paystub-dispatch-queue, paystub-dispatch-queue/arrears, payment-dispatches | R, C, U |
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

## 12.9. Time Adjustment Requests

> Added 2026-06-02. Requires the `time_adjustment_requests` table and private `time-adjustment-evidence` bucket in Supabase. See [time-adjustment-requests.md](../features/time-adjustment-requests.md) for the full feature description.

All three routes are fully authenticated via NextAuth. Employees may only act on their own requests; elevated/accounting roles may act on any.

---

### `GET /api/time-adjustments`

List time adjustment requests.

**Query parameters:**

| Param | Notes |
|---|---|
| `email` | Filter to a single employee. Self-or-elevated (same contract as `/api/pab-disputes`). Omit for a full list (elevated only). |
| `status` | One or more status values: `pending`, `approved`, `denied`. Repeat the param for multiple. |
| `from` | ISO date lower bound on `adjust_date` (inclusive). |
| `to` | ISO date upper bound on `adjust_date` (inclusive). |
| `limit` | Max rows returned (integer). |

**Response `200`:**
```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "employee@simple.biz",
      "adjust_date": "2026-05-28",
      "reason": "forgot_tracker",
      "explanation": "Was on client calls 9-11:30am...",
      "requested_hours": 8,
      "image_paths": ["employee/draft-abc/0-1234567890.jpg"],
      "status": "pending",
      "approved_hours": null,
      "decided_by": null,
      "decided_at": null,
      "decision_note": null,
      "period_label": "2026-05",
      "created_at": "2026-05-29T10:00:00Z",
      "created_by": "employee@simple.biz",
      "updated_at": "2026-05-29T10:00:00Z"
    }
  ],
  "signedUrls": {
    "employee/draft-abc/0-1234567890.jpg": "https://...supabase.co/storage/v1/..."
  },
  "error": null
}
```

`signedUrls` is only populated when the caller holds an elevated/accounting role (empty object for plain employees). Keys are the `image_paths` values; values are 1-hour signed download URLs.

---

### `POST /api/time-adjustments`

Create or upsert a time adjustment request.

**Auth:** session email must match `work_email` unless the caller is elevated.

**Body:**
```json
{
  "work_email": "employee@simple.biz",
  "adjust_date": "2026-05-28",
  "reason": "forgot_tracker",
  "explanation": "Was on client calls 9–11:30am, then working on ticket #4821 until 5pm.",
  "requested_hours": 8,
  "image_paths": ["employee/draft-abc/0-1234567890.jpg"],
  "created_by": "Employee Name"
}
```

| Field | Required | Notes |
|---|---|---|
| `work_email` | Yes | |
| `adjust_date` | Yes | YYYY-MM-DD; must not be a future date |
| `reason` | Yes | Must be one of the four `TIME_ADJUSTMENT_REASONS` codes |
| `explanation` | Required when `reason = other`; strongly expected otherwise | |
| `requested_hours` | No | Employee's claimed correct total (0–24) |
| `image_paths` | No | Storage paths returned by the upload endpoint; max 5 |
| `created_by` | No | Display name stamped on `created_by` for accounting view |

**Upsert semantics:** if a `pending` row already exists for this `(work_email, adjust_date)` pair it is overwritten. If a `approved` or `denied` row exists, the request returns `409 Conflict`.

**Response `200`:**
```json
{ "success": true, "id": "uuid", "error": null }
```

**Errors:** `400` (validation), `401` (not signed in), `403` (wrong employee), `409` (already decided).

---

### `POST /api/time-adjustments/upload`

Upload one evidence image to the private `time-adjustment-evidence` bucket. Called for each image before `POST /api/time-adjustments`.

**Auth:** any signed-in user (their session email becomes the path prefix).

**Body:** `multipart/form-data`

| Field | Notes |
|---|---|
| `file` | The image file. Must be `image/*`; max 5 MB. |
| `request_key` | An arbitrary slug grouping images for one in-progress request (e.g. `2026-05-28-abc12345`). Sanitized to `[a-zA-Z0-9_-]`. |
| `idx` | Integer index (0-based) for ordering within the request. |

Storage path: `{sanitized_session_email}/{request_key}/{idx}-{timestamp}.{ext}`

**Response `200`:**
```json
{ "path": "employee/2026-05-28-abc12345/0-1717000000000.jpg" }
```

**Errors:** `400` (no file / not image / too large), `401` (not signed in), `500` (upload failed).

---

### `PATCH /api/time-adjustments/[id]`

Two-stage decision endpoint. The caller identity is always taken from the session. Supports four actions split across two roles:

**Stage 1 — Manager (`manager_approve` / `manager_deny`)**

Requires `manager` or `admin` role. The DB layer additionally checks that the session email manages the employee's department (via `department_managers`), and since 2026-09-15 that the manager **is not the filer** (403). Row must be in `pending` status. **A manager-filed row has no stage 1**: `manager_approve` / `manager_deny` / `assign_second_approver` / `second_approve` / `second_deny` / `recall` all return `400` ("…went straight to Accounting") on a row whose `stage1_waived_reason = 'manager_filed'`.

```json
{
  "action": "manager_approve",
  "decision_note": "Confirmed with project activity log."
}
```

On `manager_deny` the employee receives an `employee_notifications` row. On `manager_approve` the row moves to `manager_approved` and Accounting can now act.

**Stage 2 — Accounting (`approve` / `deny`)**

Route gate: **`accounting:disputes` edit** (Accounting → Issues) since 2026-09-15 — previously `accounting:payroll_wizard` edit; the Issues tab and the Payroll Wizard panel both call this route, so both need the Issues grant. The DB layer additionally requires an active accounting role (`canActOnDisputes`), refuses the decider who **filed** the request (403), and refuses the named exclusions in `TIME_ADJUSTMENT_DECIDER_EXCLUSIONS` (jakec@, april@, lenny@ — 403). Row **must be `manager_approved`**; returns `400` if still `pending`.

```json
{
  "action": "approve",
  "decision_note": "Confirmed with Asana activity log."
}
```

| Field | Stage | Notes |
|---|---|---|
| `action` | both | `"approve"`, `"deny"`, `"manager_approve"`, or `"manager_deny"` |
| `approved_hours` | accounting only | **No longer sent since 2026-09-15** — approving applies the time ranges the employee submitted, and the day becomes tracked + that missed time wherever it is read. Still accepted and still a SET-semantics override when present, so a stored total from an older approval keeps winning. |
| `decision_note` | both | Optional free text forwarded to the employee notification. |

On accounting decision the employee receives an `employee_notifications` row (`type: time_adjustment.approved` or `time_adjustment.denied`).

**Response `200`:**
```json
{ "success": true, "error": null }
```

**Errors:** `400` (bad action / row not in the expected status), `401` (not signed in), `403` (wrong role or manager does not manage employee's dept), `404` (not found), `500`.

**Audit log actions:** `time_adjustment.manager_approved`, `time_adjustment.manager_denied`, `time_adjustment.approved`, `time_adjustment.denied`.

---

### `GET /api/manager/time-adjustments`

Returns time adjustment requests scoped to the authenticated manager's departments. No date restriction — requests from any past period are included so managers always see their team's queue regardless of the cycle the request was filed in.

**Auth:** `manager` or `admin` role required. Elevated users (admin/HR/finance) bypass department scoping and see all requests.

**Statuses returned:** `pending`, `manager_approved`, `manager_denied` (i.e. everything not yet finally decided by Accounting). Currently excludes `approved` and `denied` rows.

**Department scoping (non-elevated):**
1. Fetches the manager's active dept assignments from `department_managers`.
2. Batch-looks up each unique `work_email` in the result set against `active_employees."Department"`.
3. Keeps only rows where the employee's department is in the manager's assignments.

**Response `200`:**
```json
{
  "rows": [
    {
      "id": "uuid",
      "work_email": "employee@simple.biz",
      "adjust_date": "2026-03-15",
      "reason": "forgot_tracker",
      "explanation": "Was on client calls all morning...",
      "requested_hours": 8,
      "image_paths": ["employee/draft-abc/0-1234567890.jpg"],
      "status": "pending",
      "manager_decided_by": null,
      "manager_decided_at": null,
      "manager_decision_note": null,
      "approved_hours": null,
      "period_label": "2026-03"
    }
  ],
  "signedUrls": {
    "employee/draft-abc/0-1234567890.jpg": "https://...supabase.co/storage/v1/..."
  },
  "error": null
}
```

Signed URLs are always included (manager must be able to view evidence). 1-hour expiry.

---

### `DELETE /api/time-adjustments/[id]`

Hard-deletes a denied time adjustment request. Only callable by Accounting roles (`canActOnDisputes`). Only rows with `status = 'denied'` or `status = 'manager_denied'` may be deleted — attempting to delete any other status returns `400`.

**Auth:** route gate `accounting:disputes` edit (2026-09-15; was `payroll_wizard`) + accounting role + not one of the named exclusions (same gate as approve/deny). Session identity used — no body needed.

**Response `200`:**
```json
{ "success": true, "error": null }
```

**Errors:** `400` (row not denied), `401` (not signed in), `403` (not an accounting role), `404` (not found), `500`.

**Audit log:** `time_adjustment.deleted` with `prior_status`, `employee`, `adjust_date`.

**UI surface:** small trash icon button that appears only on `denied`/`manager_denied` rows in the Decided section of `TimeAdjustmentReviewPanel`. Spinner while in-flight (`deletingId` match). Accounting uses this to clean up the list after reviewing denials.

---

## 15. New endpoints (2026-07-08..10)

Endpoints added the week of 2026-07-08 for **Department Transfers v2**, the **People profile editor**, the **granular New Hire Checklist**, **3rd-Party Vendors**, and the **Offboarded-sheet backfill**. All are NextAuth-session-gated (no client-supplied identity). Three gate helpers recur below:

- `requireRateVisibilitySession()` — **rate-visible only**: `admin`, accounting roles, or `ceo` (`RATE_VISIBLE_ROLES`). Used for any pay-bearing read.
- `requireFeatureEdit(view, feature)` / `requireFeatureAccess(view, feature, level)` — the [feature-permissions overlay](../features/rbac-feature-permissions.md) (Hidden/View/Edit per tab).
- `requireElevatedSession()` — any elevated role.

Feature docs: [Department Transfers](../features/department-transfers.md), [3rd Party Vendors](../features/third-party-vendors.md), [New Hire Checklist](../features/new-hire-checklist.md), [Offboarding Automation](../features/offboarding-automation.md).

### Department Transfers

Managers own the pull-in / release handshake end-to-end (HR no longer approves in v2). Backed by [route.ts](app/api/department-transfers/route.ts) + [[id]/route.ts](app/api/department-transfers/[id]/route.ts).

| Method / path | Gate | Purpose |
|---|---|---|
| `GET /api/department-transfers` | signed-in; HR/admin, else `manager` | List transfer requests. HR (`hr_coordinator`)/admin → **all** rows (read-only history). Manager: `?scope=incoming` → pending release requests on depts they manage (consent queue); `?scope=done` → resolved rows (released/declined/applied/cancelled) on their team; default (outgoing) → requests they raised. `403` if neither manager, HR, nor admin. |
| `POST /api/department-transfers` | `manager` or `admin` | Initiate a **pull-in**: move an employee into a target dept. A non-admin manager may only pull *into* a dept they manage and *from* a dept they do **not** manage (admins unrestricted). Notifies the source-dept manager(s) via `employee_notifications` (`transfer.release_requested`). Audit `department_transfer.requested`. |
| `PATCH /api/department-transfers/[id]` | see below | Decide a request via `{ action, note? }`. |
| `DELETE /api/department-transfers/[id]` | admin, original requester, or source-dept manager | Hard-delete the request record (cleanup). Does **not** reverse an already-applied dept move. Audit `department_transfer.deleted`. |

`POST` returns `409` when the employee already has an in-flight transfer, `400` on missing email / equal from-to / non-ISO `proposed_effective_date`, `403` on the manager scope violations.

`PATCH` actions (all guard against acting on an already-decided row with **`409` `Request already <status>`**):
- **`release`** — source-dept manager consents. Locks the effective date to the requester's `proposed_effective_date` (falls back to today), then applies the dept move **immediately** (the effective date is retained only as the rate-proration anchor, not to defer the label change). If the master-list write fails the row stays `approved` (retry via `apply`) and the response carries `applied: false` with an explanatory `error` at `200`. Requires `requireFeatureEdit('manager','team')` + source-dept manager (or admin). Audit `department_transfer.released`.
- **`decline`** — source-dept manager refuses (`note` = reason); notifies requester. Audit `department_transfer.declined`. Row must be `pending`.
- **`cancel`** — the receiving/requesting manager withdraws their own **`pending`** request; `403` if the caller isn't the requester. Audit `department_transfer.cancelled`.
- **`apply`** — push through a released transfer stuck in `approved` (release-time apply failed). `409` if the row isn't `approved`. Requires `requireFeatureEdit('manager','team')` + source-dept manager (or admin). Audit `department_transfer.applied_manual`.

### `GET /api/manager/transfer-candidates`

Gate: `manager` or `admin` (`401`/`403`). Transfer-target picker for "Request transfer in" — active `global_master_list` people the manager could pull in, i.e. everyone **except** those already in a dept the manager manages (admins see everyone). Returns Name + Department + emails only — **no pay/rate data**. Optional `?q=` (name/department/work-email/personal-email substring) and `?department=` filters; also returns the `departments` list for the filter dropdown. Capped at 200 rows. [route.ts](app/api/manager/transfer-candidates/route.ts)

### Accounting: transfers + rate history + sync status

Pay-bearing reads, all gated by `requireRateVisibilitySession()`.

| Method / path | Purpose |
|---|---|
| `GET /api/accounting/transfers` | Read-only transfer history joined to the pay-rate change each move triggered. [route.ts](app/api/accounting/transfers/route.ts) |
| `POST /api/accounting/transfers` | `{ id, action: 'retry_sheet' }` — retry the Google Sheet dept write-back for an `applied` transfer whose sheet sync failed (`409` if not `applied`). Audit `department_transfer.sheet_retry`. |
| `GET /api/payroll/rate-history-bulk` | Every `employee_rate_history` row (`employee_email`, `regular_rate`, `ot_rate`, `effective_from`), newest-first, unpaginated. Feeds the Payroll Wizard's per-employee mid-cycle rate proration. [route.ts](app/api/payroll/rate-history-bulk/route.ts) |
| `GET /api/accounting/sync-status` | Last successful Google-Sheet sync timestamps `{ master, rates, hsl, error }` (from the audit trail, so both cron and manual syncs count). Powers the Wizard Initialize step. [route.ts](app/api/accounting/sync-status/route.ts) |

### `PATCH /api/people/[email]/profile`

Gate: `requireFeatureEditAnyView('people')` (`accounting` | `ceo` | `admin`). Edits one person's master-list identity/contact fields from the People → View Modal. Body: `{ id, original_work_email?, original_personal_email?, original_department?, patch }`. Writes `global_master_list` **by row id**, then best-effort flips the matching cells in the master Google Sheet so the next Sheet→DB sync won't revert the edit. The `patch` is allowlisted (`name`, `department`, `work_email`, `personal_email`, `alternate_work_email`(`_2`), `start_date`, `phone_number`, `location`, `street`, `city`, `province`, `postal_code`, `full_address`) — a crafted body can't touch `off_boarded_*`/`employee_id`/upload ids; structured-address fields have no sheet column. `400` (missing id / no editable fields / bad JSON), `409` (identity collision), `404`, `503` (sheet not configured). Audit `people.profile.updated`. [route.ts](app/api/people/[email]/profile/route.ts)

### `PATCH /api/people/[email]/banking`

Gate: `requireFeatureEditAnyView('people')` (`accounting` | `ceo` | `admin`). Accounting's direct edit of one person's payout record from People → View → Banking — and, since 2026-09-15, the write path behind the Payroll Notes → **Offboarded** tab's override "Set bank". Body: `{ patch, source? }`. `patch` is allowlisted to the `employee_ids` payout columns (incl. `bank_preferred`, `preferred_processor`, `preferred_bank_slot`); empty strings become `null`. `source` is optional and must be one of the known `CHANGE_SOURCES` (`readiness-audit.ts`), default `people_tab` — it labels `details.via` on the audit row and the `bank_update_history` entry. **Accounting's edit IS the approval**: `bank_preferred` is written directly (no change request), the 1:1 rule is checked against the receiving channel the save leaves in place (`400` on a mismatch), and both wallet mirrors apply immediately. `423` while the dispatch lock is on. Resolves the row by `employee_id` via a case-insensitive email lookup; bootstraps a `SELF-…` row when none exists. Awaits the audit write `people.banking.updated`. Returns `{ ok, created, banking, bankHistory }`. [route.ts](app/api/people/[email]/banking/route.ts)

### `/api/hr/new-hire-checklist`

Granular per-row checklist API (rows persist atomically as they're typed — no batch save). GET is `requireElevatedSession()`; every mutation is `requireFeatureEdit('hr','new_hire_checklist')`. Any mutation whose `period_start` names a **locked** week is refused with `409`. [route.ts](app/api/hr/new-hire-checklist/route.ts)

| Method | Body | Purpose |
|---|---|---|
| `GET` | `?period=YYYY-MM-DD` (required) | That week's rows + its lock state. `400` without a valid period. |
| `POST` | `{ period_start, period_end?, values }` | Add ONE hire (atomic insert; concurrent adders never collide). `409` if the week is locked. Audit `hr.new_hire_checklist.row_added`. |
| `PATCH` | single `{ id, values, expectedUpdatedAt? }` **or** bulk `{ ids[], field, value }` | Single: update named fields; a stale `expectedUpdatedAt` → `409 { conflict: true }` (co-editor won). Bulk: set one column across many ids (bulk-apply department/country). Audit `…row_updated` / `…bulk_set`. |
| `DELETE` | `{ id? }` or `{ ids[] }` | Delete exactly the named ids (never "everything not in the payload"). Audit `…row_deleted`. |
| `PUT` | `{ period_start, period_end?, action }` | `action: 'lock'` freezes the week and fires the orientation webhook off the **DB's** current rows (best-effort); `'reopen'` flips it back to `open`. Audit `…locked` / `…reopened`. |

### Orphanage Management System (OMS) pull — Payroll Wizard Orphanage step

Read-only against a SEPARATE Supabase project (env `OMS_*`, server-only; see
[orphanage-oms-pull.md](../features/orphanage-oms-pull.md)). Gate:
`requireFeatureAccess('accounting','payroll_wizard','view')`. Every branch answers JSON.

| Method / path | Purpose |
|---|---|
| `GET /api/orphanage-pay/oms?mode=status&week_start=YYYY-MM-DD` | Approved-row COUNT for the week + newest stamp — the tab's "ready to pull" indicator, fired ONLY by the manual Refresh button (no polling, no ping on tab open). Never returns rows. [route.ts](app/api/orphanage-pay/oms/route.ts) |
| `GET /api/orphanage-pay/oms/saves?week_start=YYYY-MM-DD` | The week's newest SAVE from `orphanage_oms_hours` (the HRIS's own append-only record of a pull + its resolution; NOT money), paged. `503 { tableReady:false, reason }` until the migration is applied. [saves/route.ts](app/api/orphanage-pay/oms/saves/route.ts) |
| `POST /api/orphanage-pay/oms/saves` | `requireFeatureEdit`. Body = `buildOmsSavePayload` output (week_start, mode test\|live, rows[] raw + resolved). One append-only snapshot under a new `save_id`; validated against the table's shape (`400` otherwise). Audit `wizard.orphanage_oms_saved`. Never touches `orphanage_pay` or the additions blob. |
| `GET /api/orphanage-pay/oms?mode=pull&week_start=YYYY-MM-DD` | The APPROVED rows for that Sunday's week, paged (`selectAllPaged`), capped at `OMS_MAX_ROWS` with a `truncated` flag. Fired ONLY by the Load Orphanage Hours button. `503 { configured:false, reason, missing }` when env is unset (names the variable, never a value); `502` when OMS is unreachable; `400` on a bad mode/week. |

### 3rd-Party Vendors (Orphanage)

Vendor directory + SIMPLE-branded invoices, separate from Payment Dispatch. Reads are `requireFeatureAccess('orphanage','third_party_vendors','view')` (rows carry vendor banking details — not an open read); writes are `requireFeatureEdit('orphanage','third_party_vendors')`.

| Method / path | Purpose |
|---|---|
| `GET /api/orphanage-vendors` | List vendors. [route.ts](app/api/orphanage-vendors/route.ts) |
| `POST /api/orphanage-vendors` | Create a vendor (`business_name` required). Audit `orphanage.vendor.saved`. |
| `PATCH /api/orphanage-vendors/[id]` | Update a vendor. [[id]/route.ts](app/api/orphanage-vendors/[id]/route.ts) |
| `DELETE /api/orphanage-vendors/[id]` | Delete a vendor. Audit `orphanage.vendor.deleted`. |
| `GET /api/orphanage-vendor-invoices` | List invoices; optional `?status=pending|paid`. [route.ts](app/api/orphanage-vendor-invoices/route.ts) |
| `POST /api/orphanage-vendor-invoices` | Create a pending invoice (`invoice_number` + `vendor_name` + ≥1 meaningful line item required). Returns `201`; duplicate `invoice_number` → `409`. Audit `orphanage.vendor_invoice.created`. |
| `PATCH /api/orphanage-vendor-invoices/[id]` | `body.action === 'mark_paid'` stamps the payment record + PAID watermark (`409` if not found/already paid); otherwise edits a still-pending invoice. Audit `…paid` / `…updated`. [[id]/route.ts](app/api/orphanage-vendor-invoices/[id]/route.ts) |
| `DELETE /api/orphanage-vendor-invoices/[id]` | Delete an invoice. Audit `orphanage.vendor_invoice.deleted`. |

### Documents (employee signing requests) *(added 2026-07-18)*

Employee submits a PDF (their Pay Stubs export, a COE, an award) from Profile → Request
Documents; it queues in **Accounting → Documents**. Approving stamps the approver's saved
signature into the PDF — an appended certification page carrying the **requested date**, the
**signed date** and the request id (so the document can be verified as real) — and the signed
copy is returned to the employee. Objects live in the private `document-requests` bucket
(originals are never mutated; signed copies are stored alongside). Requires the
`2026-07-18_documents_tab.sql` migration.

Employee side (always scoped to the caller's session email, like `/api/employee/paystub`):

| Method / path | Purpose |
|---|---|
| `GET /api/employee/documents` | The caller's own requests, newest-first. [route.ts](app/api/employee/documents/route.ts) |
| `POST /api/employee/documents` | Multipart `{ file, document_type: paystub\|coe\|award\|other, period_label?, note? }`. PDF-only (magic-byte checked), 10 MB server cap (~4 MB practical on Vercel). Fans a feature-gated `documents.requested` notification to accounting/admin role holders. Audit `documents.request_submitted`. |
| `GET /api/employee/documents/[id]?which=original\|signed` | `{ url }` 1-hour signed download URL for the caller's own row (`404` for anyone else's — ids aren't probeable). [[id]/route.ts](app/api/employee/documents/[id]/route.ts) |
| `DELETE /api/employee/documents/[id]` | Cancel the caller's own **pending** request (removes the uploaded objects). Audit `documents.request_cancelled`. |

Accounting side (gate: accounting `documents` feature — `view` for reads, `edit` for decisions; admin bypasses):

| Method / path | Purpose |
|---|---|
| `GET /api/accounting/documents?status=pending\|signed\|rejected` | The full queue. [route.ts](app/api/accounting/documents/route.ts) |
| `GET /api/accounting/documents/[id]?which=original\|signed` | `{ url }` preview/download URL. [[id]/route.ts](app/api/accounting/documents/[id]/route.ts) |
| `PATCH /api/accounting/documents/[id]` | `{ action: 'sign' }` stamps the CALLER's own enabled signature + dates into the PDF, stores `signed.pdf`, notifies the employee (`documents.signed`); `{ action: 'reject', note }` (note required) notifies with the reason (`documents.rejected`). `409` if already decided, `412` if the caller has no active signature. Audit `documents.request_signed` / `…rejected`. |
| `GET /api/accounting/documents/signature` | The CALLER's own saved signature row (never anyone else's). [signature/route.ts](app/api/accounting/documents/signature/route.ts) |
| `PUT /api/accounting/documents/signature` | Upsert own signature: `{ image_data_url? (PNG/JPEG data URL), owner_name?, title?, enabled? }`. `enabled: false` is the revoke switch — approvals are blocked until re-enabled. Enabling requires a drawing. Audit `documents.signature_*`. |

### `POST /api/hr/offboard-sheet-backfill`

Gate: `requireFeatureEdit('hr','offboarding')`. Fills the blank Location / Contact Number / Start Date / Offboard Reason / Offboarded Date cells in the Google "Offboarded" tab from the master record, matched on personal- (then work-) email. Only blank cells are touched (hand-typed values are preserved). **Defaults to a dry run** — the body is `{ apply?: boolean }` and you must pass `{ "apply": true }` to actually write; omit it to preview the exact cell changes. Response includes `scannedRows` / `matchedRows` / `filledCells` / `byField` / `unmatched`. Audit `hr.offboarded_sheet.backfilled` (only on `apply`). [route.ts](app/api/hr/offboard-sheet-backfill/route.ts)

---

## 20. FPU classes & enrollment *(added 2026-09-16)*

Governing doc: [fpu-enrollment.md](../features/fpu-enrollment.md). **Every write below broadcasts `fpu-classes-sync` / `changed` `{ kind, classId, emails?, ts }` from the server** (`broadcastFromServer`, fire-and-forget) — the two views subscribe via `useFpuLive` with a 15s poll floor. Every HR route answers `migrated: false` (503 on writes) until `scripts/apply-fpu-classes-migration.mts --apply` has run.

### `GET /api/hr/fpu-classes`
Gate: `requireFeatureAccess('hr','mesa','view')`. `{ classes: FpuClass[] (newest first), counts: { [classId]: { pending, approved, denied, completed } }, migrated }`.

### `POST /api/hr/fpu-classes`
Gate: `…'edit'`. Body `{ year, batch?, opens_on, closes_on, class_starts_on, class_ends_on?, schedule_note?, name? }` — `batch` defaults to the next number in that year; `name` is trimmed, blank → null, >80 chars → 400. Validated by `validateFpuClassInput` (real calendar dates, `closes_on >= opens_on`, `class_ends_on >= class_starts_on`) → 400 in words; duplicate `(year, batch)` → 409. Audits `fpu.class.created`.

### `PATCH /api/hr/fpu-classes`
Gate: `…'edit'`. Body = the full form plus `id`. Same validation. Audits `fpu.class.updated` with before/after.

### `POST /api/hr/fpu-classes/close`
Gate: `…'edit'`. Body `{ id, closed: boolean }`. `closed: true` stamps `enrollment_closed_on` = today (Manila) + `enrollment_closed_by`, which makes `fpuClassPhase` report `closed` whatever the dates say, so `POST /api/fpu-enroll` refuses; `false` clears both and the planned window governs again. **`closes_on` is never touched.** 503 with `migrated: false` until the 2026-09-17 ALTER has run. Audits `fpu.class.enrollment_closed` / `…_reopened`; broadcasts.

### `DELETE /api/hr/fpu-classes?id=`
Gate: `…'edit'`. Refuses (409) a class with any enrollment; the FK is `on delete restrict` as the backstop. Audits `fpu.class.deleted`.

### `GET /api/hr/fpu-enrollments?class_id=`
Gate: `requireFeatureAccess('hr','mesa','view')` — **this route was ungated until 2026-09-16.** `{ rows, migrated }`; legacy rows with `class_id NULL` are never returned. The audit-log fallback is gone.

### `PATCH /api/hr/fpu-enrollments`
Gate: `…'edit'`. Body `{ ids: string[] (≤200), status: 'approved' | 'denied' | 'pending', review_notes? }`. Touches only `fpu_enrollments`; `completed` rows are skipped and counted. `{ updated, skipped, rows }`. Audits `fpu.enrollment.approved|denied|reset` per row.

### `DELETE /api/hr/fpu-enrollments`
Gate: `…'edit'`. Body `{ ids: string[] (≤200) }`. Deletes pending / approved / denied entries; `completed` rows are skipped and counted (they record the FPU date + MESA enrollment). `{ deleted, skipped }`. Audits `fpu.enrollment.deleted` with the whole row. Broadcasts.

### `POST /api/hr/fpu-enrollments/complete`
Gate: `…'edit'`. Body `{ ids (≤200), completed_on: 'YYYY-MM-DD' }`. For each **approved** row: stamps `employee_hourly_rates.mesa_fpu_completed_on` on every rate row for the work email, marks the enrollment `completed`, then sorts the person into `toEnroll` (not a member, no open account under any alias — the client calls `POST /api/toggle-mesa-member` with `since = completed_on`), `alreadyMembers` (never sent to toggle), or `noRateRow`. Non-approved rows → `skipped`. Audits `fpu.enrollment.completed`.

### `GET /api/fpu-enroll?email=`
Gate: `authorizeEmailAccess` (self or elevated). `{ today, class, enrollment, verdict, history, fpuCompletedOn, isMesaMember, migrated }` — `class` is `pickCurrentFpuClass` (open → nearest upcoming → most recently closed), `verdict` is `fpuVerdict` computed server-side.

### `POST /api/fpu-enroll`
Gate: `authorizeEmailAccess`. Body `{ email?, shift_schedule_est }`. **Re-derives the verdict**; a refusal is 409 `{ error: <the sentence>, reason }`. Identity / name / department come from the active roster row, never the body. Duplicate → 409 `already_enrolled`. Audits `fpu.enroll`.

---

## 21. FPU groups, attendance and class close *(added 2026-09-17)*

Governing doc: [fpu-groups-attendance.md](../features/fpu-groups-attendance.md). Every route answers `migrated: false` (503 on writes) until `scripts/Apply FPU Groups migration.cmd` has run, and every write broadcasts on the FPU live topic.

### `POST /api/hr/fpu-classes/groups/preview`
Gate: HR · MESA · edit. Body `{ class_id, per_group, roll? }`. **Writes nothing.** Returns `{ groups, seed, roll, perGroup, population, sessionCount }`. 409 when the class has no `class_ends_on` (no sessions can be derived) or is already divided.

### `POST /api/hr/fpu-classes/groups/confirm`
Gate: `…edit`. Body `{ class_id, per_group, roll }` — **the membership is re-derived from the seed, never read from the request**. Inserts groups then members; a member-insert failure rolls the groups back so a retry is a clean deal. 409 `alreadyDivided` once groups exist. Audits `fpu.groups.divided` with the whole membership.

### `POST /api/hr/fpu-classes/groups/list`
Gate: HR · MESA · **view**. Body `{ class_id }`. A POST that only reads, deliberately — its sibling `preview` is a POST for safety and the panel's two calls must not disagree on verb. Returns groups, members and every mark.

### `PATCH /api/hr/fpu-classes/groups/leader`
Gate: `…edit`. Body `{ group_id, enrollment_id: string | null }`. The leader must be a member of that group and must not have left; `null` clears. Audits `fpu.groups.leader_set` / `_cleared`.

### `GET /api/fpu-attendance?email=`
Gate: `authorizeEmailAccess` (self or elevated). The viewer's group, its roster at directory parity, the derived sessions, which are markable today, and the marks they may see — own only, or the whole group if they lead it.

### `POST /api/fpu-attendance`
Gate: **elevated, or the leader of the target's group**, re-derived server-side every call. Body `{ enrollment_id, session_no, present, note? }`. Refuses: a leader marking themselves (403), a person outside their group (403), a session that has not happened or does not exist (409), a closed class (409). Idempotent per `(person, session)`. Audits `fpu.attendance.marked`.

### `POST /api/hr/fpu-classes/class-close`
Gate: `…edit`. Body `{ class_id, confirm }`. `confirm: false` returns the eligible/ineligible split and `unmarkedTotal` **without writing**. `confirm: true` stamps `mesa_fpu_completed_on` (= `class_ends_on`) for the eligible only, marks them `completed` and the rest `failed`, stamps `class_closed_on`, and returns `toEnroll` for the client to walk through `toggle-mesa-member`. Audits `fpu.class.closed` with the whole split.

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

---

## 16. Audit log + routes gated 2026-09-09

Governing doc: [audit-log.md](../features/audit-log.md) — the action registry (`src/lib/audit/registry.ts`) is the single
source for what an action name means; `registry.test.ts` fails the build on an `insertAuditLog` call whose action has no family.
Actor identity on every write comes from the verified session (`auditFrom(request, authz)` / `getSessionActor()`), **never** from
the request body.

### `GET /api/audit-log`

**Auth**: elevated session (`requireElevatedSession` — admin / accounting / hr_coordinator).

| Param | Meaning |
|---|---|
| `surface` | one of `AUDIT_SURFACES` ids (a dashboard) — expands to that dashboard's action prefixes via the registry |
| `action_prefix` | comma-separated prefixes; wins over `surface` |
| `actor` | exact match for an email, contains-match otherwise |
| `search` | free text over action / resource / actor / `details` — filtered in JS over a **2000-event window**, and the response says how far it reached |
| `since`, `until` | `YYYY-MM-DD`, Asia/Manila days |
| `before` | keyset cursor — a previous page's `next_cursor` (keyset, never `.range()`) |
| `limit` | 1–500, default 100 |

**Response** `200`: `{ rows, next_cursor, has_more, scanned, search_window, error: null }`. With `search`, `next_cursor` is
`null` and `search_window` is `{ complete, events_scanned, oldest_scanned, note }` — an incomplete window is stated, so "no
results" is never mistaken for "never happened".

### `POST /api/audit-log`

**Auth**: any signed-in session (`401` when anonymous). Body `{ action, resource, resource_id?, details? }` (`400` when
`action`/`resource` missing). `user_name`, `user_role` and `ip_address` are stamped from the session and request — a body value
for them is ignored.

### `DELETE /api/audit-log` — retention purge, not a clear

**Auth**: elevated session **and** role `admin` (`403` otherwise).

| Param | Meaning |
|---|---|
| `older_than_days` | **required**; anything below `AUDIT_PURGE_MIN_AGE_DAYS` (**90**) is refused with `400` |
| `preview=1` | count only → `{ preview: true, cutoff, matching }` |

Writes the `audit.purged` event (cutoff, days, row count, actor, IP) **before** deleting and abandons the purge (`500`) if that
write fails. Response `{ deleted, cutoff, error: null }`. The former wholesale `clearAuditLog()` behind a "Clear Log" button is
gone — it was the one action that could not record itself.

### Gated the same day (two of the six ungated routes)

| Route | Now |
|---|---|
| `GET /api/gift-tracker/recent-submissions` | `requireFeatureAccess('hr','gift_tracker','view')` — the same grant the rest of the Gift Tracker requires. It returns home addresses and phone numbers, so it is never the looser of the two. Reads `audit_log` for each row's channel over a bounded 120-day window; an unresolvable channel reports `null`, never a guess. |
| `GET` / `PUT /api/employee-gift-shipping` | `authorizeShippingAccess()` — the row's owner (matched through their master record, so a personal email resolves) or staff holding `hr / gift_tracker`; the un-scoped list is staff-only. `PUT` audits `employee_gift_shipping.submitted` with the `channel`. |
| `POST /api/import-daily-report` | `requireElevatedSession()` + `daily_report.imported` — see §8. Dead endpoint; delete it. |

**Still ungated as of 2026-09-10:** `manager/member-monthly-pay` (anyone's monthly pay by `?email=` — fix first),
~~`hr/fpu-enrollments`~~ (**gated 2026-09-16**, §20), `hsl-bonus/period-summary`, `presence/last-seen`. Helpers exist (`authorizeEmailAccess` /
`requireFeatureAccess` / `requireAdminSession`); this is wiring. See
[pre-release-security-readiness.md](../features/pre-release-security-readiness.md) §2.

---

## 17. Penny AI (assistants) *(added 2026-09-12)*

Governing docs: [admin-penny-console.md](../features/admin-penny-console.md) (the console surface),
[admin-penny-tools.md](../features/admin-penny-tools.md) (what it can be asked, and what it refuses),
[ceo-assistant.md](../features/ceo-assistant.md) (the shared widget), [employee-penny-ai.md](../features/employee-penny-ai.md).

Three chat routes, one per audience, sharing the widget but **not** the gate, the model or the tool set. All three stream
**`text/plain; charset=utf-8`** token deltas — not SSE, not JSON — with `Cache-Control: no-store`. Every tool is read-only;
none of them writes to the database.

| Route | Gate | Model | Tools |
|---|---|---|---|
| `POST /api/ceo/chat` | signed in **and** `ceo` or `admin` | `claude-opus-5-5` *(since 2026-09-23; was `claude-sonnet-4-6`)* | `CEO_TOOLS` + `CEO_ADMIN_TOOLS` (24) — every Admin tool except `list_employee_attachments` |
| `POST /api/admin/penny-chat` | `requireAdminSession()` — elevated **and** `admin` | `claude-opus-5` | `CEO_TOOLS` + `ADMIN_TOOLS` (25) |
| `POST /api/employee/penny-chat` | `authorizeEmailAccess(email)` | `claude-haiku-4-5` | employee set, **no identity argument** |

### `POST /api/ceo/chat`

**Body**: `{ messages: [{ role: 'user' | 'assistant', content: string }] }`. History is sanitized server-side: empties
dropped, content sliced to 8000 chars, last 20 turns kept, leading assistant turns dropped after the slice (an alternating
transcript sliced to an even count starts on an assistant turn, which the API rejects with a 400), trailing turn must be `user`.

`maxDuration = 300`, `MAX_TOKENS = 32000`, `MAX_TURNS = 10`, effort `high`, no `thinking` field (Opus 5.5 always thinks —
`disabled` is a 400), server-side refusal fallback to `claude-opus-4-8`. Emits **no** activity frames. Every tool result is
stamped `fetched_at`.

**Errors**: `401` not signed in · `403` not ceo/admin · `503` no Anthropic key configured (points at Admin → API tokens) ·
`400` invalid body or no trailing user message. Once streaming starts the status is already `200`, so mid-stream failures
arrive inline as `[Assistant error: …]`.

**Audit**: `ceo_assistant.query` in the stream's `finally`, **only when a tool ran** — it records *which* tools, never the
figures they returned. Pure-chat turns are deliberately unaudited.

### `POST /api/ceo/chat/feedback`

Thumbs up/down on one reply. **Auth**: `ceo` or `admin` (admins are admitted, so the Admin console uses this route too).
**Body**: `{ message_key, rating: 'up'|'down', assistant_message, user_message, comment?, context[] }`.
`400` on a bad rating or body, `500` on a write failure. **Audit**: `ceo_assistant.feedback`.

### `POST /api/admin/penny-chat`

Same body and sanitizing as the CEO route. `maxDuration = 300`, `MAX_TOKENS = 32000` (thinking shares the budget on Opus 5),
`MAX_TURNS = 8`, aborts on `request.signal`.

Uniquely, this route **interleaves NUL-delimited activity frames** with the text so the console can narrate real work:

```
<NUL>{"t":"tool","name":"search_audit_log"}<NUL>      one tool starting, enqueued BEFORE it runs
<NUL>{"t":"att","r":"<ref>","l":"<label>","k":"image"}<NUL>   one openable file the answer found
```

NUL because the model cannot emit one, so a reply can neither forge a frame nor be mistaken for one. The client strips them
in `useCeoChat`, upstream of every parser. **Routes that emit no frames get their text back byte-for-byte**, which is what
keeps the CEO and employee surfaces identical.

**Errors**: `401` / `403` from `requireAdminSession` · `503` no key · `400` bad body. A model refusal
(`stop_reason: 'refusal'`) is handled explicitly and reported as a decline, not an outage — the request has already been
re-run on `claude-opus-4-8` by then, via beta `server-side-fallback-2026-06-01`.

**Audit**: `admin_assistant.query`, same tools-only rule as the CEO route.

### `GET /api/admin/penny-chat/attachment` *(added 2026-09-12)*

Opens **one** file that Penny surfaced. The client names a **record**, never a path.

**Auth**: `requireAdminSession()`. Every file reachable here is already openable by the same caller through its own surface
(`requireFeatureAccess` admin-bypasses, `authorizeEmailAccess` elevated-bypasses), so this exposes nothing new — but those
surfaces write **no audit row at all** on a download, which makes this the better-recorded path.

| Param | Meaning |
|---|---|
| `ref` | `<source>~<record uuid>[~<slot>]`. Sources: `evidence` · `receipt` · `document` · `document_signed` · `w8ben` · `ip_assignment` · `photo` (whose id is an email, not a uuid) |

**Response** `200`:
```json
{ "url": "https://…signed…", "expires_in": 3600 }
```

The route resolves the ref to a row, reads the storage path **off that row**, and signs it against a bucket fixed by the
source — so no string from the request ever reaches `storage.from(...)` and traversal is unrepresentable rather than
filtered. `parseAttachmentRef` refuses an unknown source, a malformed id, a slot on an unslotted source, or a slot out of
range; there is no lenient path, because a ref is machine-written.

**Signed-URL lifetimes are per source and deliberately unequal** — W-8BEN **300s** ("sensitive tax document"),
IP assignment **600s**, evidence / receipts / documents **3600s**. The value lives in `ATTACHMENT_SOURCES` so the route
cannot pick one.

**Errors**: `400` malformed ref · `404` record not found, or the file is no longer on the row, or storage refused ·
`500` misconfigured source (a bucket with no lifetime, or the reverse) · `503` storage not configured.

**Tables**: reads `time_adjustment_requests`, `mesa_request_receipts`, `document_requests`, `hr_onboarding_submissions`,
or the master row (profile photo). **Service role**: required.
**Audit**: `admin_assistant.attachment_opened` — actor via `auditFrom(request, authz)`, `resource_id` = whose file it is,
`details` carrying the source, record id, slot and TTL. Best-effort: the read already happened, so failing the response
would only hide it.

### `POST /api/employee/penny-chat` · `GET /api/employee/penny-chat/quota`

**Auth**: `authorizeEmailAccess(email)` — the route resolves **one** email and every tool closes over it, so a
prompt-injected "show me Jane's pay" has no parameter to travel through. `maxDuration = 120`, `MAX_TOKENS = 4000`.

**Metered**: 10 questions per Asia/Manila day, counted as rows in `penny_employee_usage` (never a counter column — a lost
update would be a free prompt; never `audit_log` — an admin can truncate it). Reserve before the model call, refund when a
turn produced no text. Every read **fails closed**. Both routes report the count in an **`X-Penny-Quota`** header, including
on the `429` that says the allowance is spent — which is exactly when the indicator most needs to be right.

**Errors**: `401` / `403` from `authorizeEmailAccess` · `429` allowance spent · `503` no key or quota unavailable ·
`400` bad body. **Audit**: `employee_assistant.query`.

**Do not copy the Admin route's generation config here.** Haiku 4.5 is an older generation: `output_config.effort` errors
and adaptive `thinking` is the wrong shape.

---

## 18. QC Compare sheet (shared) *(added 2026-09-14)*

The manager's "Compare with your sheet" paste, shared per (QC department, pay-week Sunday). Feature doc:
[qc-scoring.md](../features/qc-scoring.md) § *The pasted sheet is SHARED per department-week*. Carrier:
one `app_settings` row, key `qc.compare_paste.<dept>.<YYYY-MM-DD>`, value
`{ v: 1, text, pastedBy, pastedAt, rowCount }` (`src/lib/qc/compare-paste.ts`). No migration.

### `GET /api/qc/compare-paste?dept=<key>&period_start=<sunday>`

**Auth**: `requireFeatureAccess('manager', 'hsl_bonus', 'view')` **and** a `department_managers` grant on `dept`
(`listManagedQcDepts`; the `admin` role bypasses the scope). The **`qc` role is deliberately not a reader** — the
officers being compared against must never see the sheet.

**Params**: `dept` must be a QC-scored department key (`isQcDeptKey`; Lead Gen only today); `period_start` must be a
pay-week **Sunday** (`qcPeriodStartError`), else `400` naming the weekday it actually is.

**Response `200`**: `{ "paste": { "v": 1, "text": "…", "pastedBy": "jackie@simple.biz", "pastedAt": "…Z", "rowCount": 207 } | null, "error": null }`.
A row that exists but does not decode is a **`500`** telling the caller to clear it and Compare again — never reported as
"nothing shared".

### `PUT /api/qc/compare-paste`

Body `{ "dept": "lead_gen", "period_start": "2026-09-06", "text": "<verbatim paste>" }`.

**Auth**: `requireFeatureEdit('manager', 'hsl_bonus')` + the same department scope. **`423`** while
`payroll.dispatch_locked` (`rejectWhilePayrollProcessing`; admin bypasses).

**Validation** (`parseComparePasteSaveBody`): text must be a non-blank string ≤ 200,000 chars with no control characters
other than TAB/LF/CR, and **must parse to ≥ 1 row** under `parseAppointmentPaste` — a paste with nothing parseable is
compared client-side but **not shared** (`400`, "nothing to share"). Stored **verbatim**. `pastedBy` = the **session**
email, `pastedAt` = server clock, `rowCount` = re-derived server-side — none of the three is read from the body.

**Write**: a plain `upsertAppSetting` — one scalar replaced whole, so last writer wins (the attribution says who); the
client skips the PUT when the text already equals the shared text.

**Response `200`**: `{ "paste": {…}, "error": null }`. **Audit**: `qc.compare_paste_saved` (`resource`
`qc_compare_paste`, `resource_id` `<dept>:<sunday>`), metadata only — `row_count`, `chars`, `replaced_pasted_by/at`,
`replaced_row_count`, `replaced_unreadable`.

### `DELETE /api/qc/compare-paste?dept=<key>&period_start=<sunday>`

**Auth / lock**: as `PUT`. **Order is fixed**: read the row → write `qc.compare_paste_cleared` carrying the **full
text**, `pasted_by`, `pasted_at`, `row_count` → **refuse the delete (`500`, nothing deleted) if that audit write fails**
→ `deleteAppSetting`. Another manager typed that sheet; after it is gone `audit_log` is the only place it survives.

**Response `200`**: `{ "cleared": true | false, "error": null }` — `false` when no row existed.

### The generic `/api/app-settings` route refuses the family

`qc.compare_paste.*` is refused with `400` on **bulk GET, single GET and POST** (`isComparePasteKey`) — that route
gates by role and this family is gated by **department**, which it cannot express. Pinned by a control test in
`compare-paste.test.ts`.

---

## 19. Manager departed members, HSL scheduling and the QC assignments contract *(added 2026-09-14)*

Three routes from the 2026-09-14 QC-start and My Team work, documented 2026-09-15. Feature docs:
[qc-scoring.md](../features/qc-scoring.md) (the deal, the departed guard),
[manager-scheduling.md](../features/manager-scheduling.md) (the periods table and route),
[hsl-kpi-calculator-2026-07.md](../features/hsl-kpi-calculator-2026-07.md) (the calculator that consumes the departed set).

### `GET /api/manager/departed-members?week=<sunday>`

Active-roster people who had already **left before the pay week being scored**, so the KPI calculator
(`DeptBonusCalculator`) can drop them from its member list. Consumed through `useDepartedMembers(weekStart)`
(`src/components/manager/useDepartedMembers.ts`), refetched **per week** — the answer is week-dependent, so it is
deliberately not a field on the cached roster payload (`MANAGER_CACHE_KEYS.teamRoster`).

**Auth**: session required (`401`); `qc`, `manager` or `admin` role (`403`).
**Params**: `week` must be a pay-week **Sunday** (`isQcPeriodStart`), else `400` naming the weekday it actually is —
the same lock the QC period key carries.

**Logic**: `loadQcDepartedEmails(employees, week)` (`src/lib/qc/departed-members.ts`) — the Payment Catalog's
`hasDepartedBeforeWeek` predicate with all four guards, including the hours guard: someone with a row in that week's
timesheet is **never** hidden, whatever the stamps say. Server-side because the client cannot read a timesheet.

**Response `200`**: `{ "emails": ["…"], "degraded": string | null, "error": null }`. **Fails OPEN**: an unreadable
evidence or timesheet read — and any thrown error — returns an empty set with `degraded` set, never a `500`. Hiding a
live person means their KPI bonus is never scored and never paid; showing a departed one is noise.

**Reads**: the roster via `getEmployeesForAuthorizedServerRoute`, offboard evidence via `loadOffboardEvidenceByEmail`,
the cycle's `hubstaff_hours` via `loadCycleHoursIndex`. No writes, no audit action.

### `GET /api/manager/scheduling`

Every `employee_schedule_periods` row in the caller's department scope, mapped to `SchedulePeriod`
(`toSchedulePeriod`, `src/lib/manager/scheduling-rows.ts`).

**Auth**: session (`401`); `manager`, `admin` or an elevated role (`403`). **Scope** is exactly
`/api/manager/department-members`: explicit `department_managers` rows win whenever the list is non-empty, and the
full set applies only to an elevated session with **no** assignments. `departmentMatchesManagedAssignments` collapses
every `hsl:*` onto the family key, so a sub-team grant reads the whole HSL family and the rail narrows it on screen.

**Response `200`**: `{ "migrated": true, "departments": [...], "periods": SchedulePeriod[] }`. Paged with
`selectAllPaged` from day one. **Before the migration has run** the route answers
`{ "migrated": false, "periods": [], "departments": [...] }` — a real `42P01` / "does not exist" check, **never**
`head: true` (which hides a missing table). A manager with no assignments and no elevated role gets `migrated: true`
with empty lists.

### `PUT /api/manager/scheduling`

Body `{ "workEmail": "…", "periods": SchedulePeriod[] }` — **the person's full period list**, replaced whole
(delete by `work_email`, then insert), which is what makes "close the current period and open a new one" one call.

**Auth**: as `GET`. **Validation** (`400`): `workEmail` and `periods[]` required; every period's `department` must pass
`departmentHasScheduling` (HSL family only) and must belong to the named person; a department outside the caller's
scope is `403`. **Overlaps are refused (`409`)**, not warned about — `findOverlaps`; an overlapping date has two
answers. Rows are written through `toScheduleRow` with `updated_by` = the session email.

**Response `200`**: `{ "migrated": true, "saved": <n> }`. **Missing table**: `503`
`{ "error": "Schedules cannot be saved until the migration has run", "migrated": false }`.
**Table**: `employee_schedule_periods` (DDL `references/sql/create/2026-09-14_employee_schedule_periods.sql`; runner
`scripts/apply-employee-schedules-migration.mts --apply` — **PENDING, verified absent in prod 2026-09-15**).
No audit action yet. Nothing here feeds pay.

### `GET /api/qc/assignments?period_start=<sunday>` — the contract that changed on 2026-09-14

Documented here for the first time because its contract moved three times in one day; the deal itself is in
[qc-scoring.md](../features/qc-scoring.md).

**This GET WRITES**: `ensureQcAssignmentsForPeriod` upserts a full week of slots for whatever key it is given, so the
key is validated **before** the deal — `period_start` must be a Sunday (`isQcPeriodStart`), else `400`. An unvalidated
Monday key manufactured **ten phantom weeks** (measured 2026-09-14; left in place, audited by
`scripts/audit-qc-period-key-drift.mts`).

**Auth**: session (`401`); `qc`, `manager` or `admin` (`403`). A plain department manager sees only the departments
they manage (`listManagedQcDepts`); officers and admins see every QC department.

**Since 2026-09-14**: officers are the **QC department's** roster (`officersFromRoster`, `src/lib/qc/officers.ts`), not
`employee_roles.role='qc'`; a dealt week is **frozen** to the officers on its slots; slots are the roster **as of the
scored week** (`src/lib/qc/roster-as-of-week.ts`); and rows whose holder had **left before the week** are filtered at
the read as well as at the deal (`departedEmails`), because slots are sticky and never deleted.

**Response `200`**: `{ periodStart, officers, officerCount, deptTotals, assignments, locks, review, mine: { memberEmails,
byDept, members }, error: null, degraded }` — `degraded` is non-null when the departed-member evidence was unreadable,
meaning the list **may still contain** people who have left, never the reverse. `500` only when the deal itself fails.

## 20. External read API — REST + MCP, per-client keys *(added 2026-09-16, widened 2026-09-17)*

Governing doc: [external-api-integrations.md](../features/external-api-integrations.md). Admin home: **Admin → Webhooks &
Integrations → Integrations**. The SSO proxy lets the whole `/api/external/` prefix through; `admitExternalCall`
(`src/lib/external-api/serve.ts`) is the gate — Bearer key → hash → row (revoked / expired / scope) → column grant →
DB-counted rate limit → request-log row. Fail-closed on every branch.

### `GET /api/external/v1/global-master-list`

`Authorization: Bearer hris_live_…`. Query: `department` (exact, needs Department visible), `email` (matches the VISIBLE
email columns), `search` (Name + visible emails), `limit` 1–500 (default 100), `cursor` (keyset on `id`, exclusive).
Returns `{ data: [rows — granted columns only], page: { limit, max_limit, returned, total, next_cursor }, meta: { as_of,
active_only: true, client, columns, expires_at } }`. Off-boarded people are unreachable. Errors: `400` invalid query /
`column_not_granted` (a filter on a hidden column, named), `401`/`403` one sentence (`Invalid or revoked API key` — also
for EXPIRED), `429` + `Retry-After`, `503` unconfigured / unavailable. Every call, denied ones included, writes one
`external_api_requests` row.

### `POST /api/external/mcp`

Streamable HTTP MCP server, stateless, JSON responses; same Bearer key. Tools: `describe_access`,
`query_global_master_list({ department?, email?, search?, limit?, cursor? })`. Every POST is one call against the same
per-client rate limit. `GET` / `DELETE` are `405`.

### Admin — `requireAdminSession()`

| Route | Body → result |
| --- | --- |
| `GET /api/admin/external-api-clients` | `{ clients: [+ calls_7d, denied_7d, throttled_7d], unattributed, unattributed_7d, configured, migration_applied, rest_path, mcp_path }` |
| `POST /api/admin/external-api-clients` | `{ name, system, contact_email?, granted_columns?: null \| string[], expiry: '1d' \| '15d' \| '30d' \| 'never', rate_limit_per_minute? (1..600, default 60) }` → `{ client, api_key }` — the plaintext key, ONCE |
| `PATCH /api/admin/external-api-clients/{id}` | `{ action: 'revoke' \| 'restore' \| 'rotate' \| 'update', name?, system?, contact_email?, granted_columns?, expiry?, rate_limit_per_minute? }` — rotate returns `api_key` ONCE; update audits before/after |
| `GET /api/admin/external-api-clients/{id}/requests?limit=` | the newest calls (≤500) |

No DELETE — `external_api_requests.client_id` is `ON DELETE RESTRICT`. Audit family `external_api.` (created / revoked /
restored / rotated / updated), actor from `auditFrom`.

---

## 20. Department sub-teams — the contract changes *(added 2026-09-21/22)*

Master-list (built-in) departments gained **data sub-teams**, stored as one JSON
blob in `app_settings` under `payment_catalog.departments.builtin_subs` — no
table, no migration. Feature docs:
[payment-catalog-departments.md](../features/payment-catalog-departments.md) §7,
[hsl-subdepartments.md](../features/hsl-subdepartments.md) §4/§6,
[bonus-catalog.md](../features/bonus-catalog.md).

**Key convention** `<builtinKey>:<subKey>` (`lead_gen:nurture`) — **except HSL**,
whose data teams are `hsl:<subKey>`, because `normalizeDeptToKey`'s `hsl:` branch
is what keeps a cell in the HSL family (week model, weekend premium, bonus
matching). The generic form would drop the person out of HSL.

> **The trap, if you read one line here.** `isHslSubDeptLabel` /
> `hslSubKeyFromRaw` answer **"is this one of the 16 CODE teams?"** — they are
> `false` / `null` for a data team. They were used at ten sites to mean "is this
> an HSL sub-team", and every one of them broke on the first data team Carla
> created. Use `startsWith('hsl:')` or `normalizeDeptToKey` for that question.

### `GET /api/departments`

Unchanged list semantics (roster labels ∪ registry names, HSL collapsed to one
`HSL`). **Now also returns `builtinSubs`** — the data sub-team map — so every
elevated picker can offer them without a second endpoint. Best-effort: a failed
read yields `{}` and the caller falls back to the code teams. Client helper:
`useBuiltinSubs()` (`src/lib/departments/use-builtin-subs.ts`), cached per page
load.

### `GET /api/manager/transfer-candidates`

**Now also returns `builtinSubs`**, so the manager Transfer dialog can expand a
parent-HSL grant to the code teams **and** the data teams.

### `POST /api/department-transfers`

**New 400 (2026-09-22): the target must be a PLACEMENT.** Previously there was
no server-side check at all — the route trusted the dialog. It now runs
`isPlaceableDeptLabel(toDept, placeableSubIndex(map))`, so a bare `HSL` (or the
bare label of any department that has sub-teams) is refused with *"Pick the
specific sub-team — it sets the base rate."*

### `PATCH /api/payment-catalog/departments` — master-list branch

Discriminated by a string `builtinKey`. Three stages, in this order, and the
order is load-bearing: **sub-departments → managers → people**, because a
sub-team added in the same save has to be a legal destination for a move in that
same save (people are validated against the *prospective* map).

| Payload | Effect |
| --- | --- |
| `scopes: [{ grantLabel, managers[] }]` | Manager access **per grant scope**. A flat built-in has ONE scope (its display name, claiming every alias spelling); **HSL has one per sub-team** (`hsl:<key>`, code + data), matched EXACTLY. A revoke is written inside its scope. Labels no scope claims (`"HSL"`, `"Hogan Smith Law"`) are reported and never written. |
| `subDepartments: [{ key, name }]`, `expectedSubsRevision` | The FULL resulting DATA list for this department. CAS on the sub map's own `app_settings` revision → **409** on mismatch. HSL's 16 code teams are pinned: a data key that shadows one is refused, as is the retired `lead_nurture`. A sub key may not contain a colon. Removing a sub is refused while the **live** `global_master_list` still has people in it (the count **fails closed**), and its own `<key>:<sub>` rate row is deleted with it. |
| `people: [{ workEmail, fromDepartment, toDepartment, … }]` | Moves as **real department transfers** — master list → master Sheet → an `applied` `department_transfer_requests` row (`applyDirectDepartmentMove`). Never registry member records. A bare family label is refused; a move must touch this department on one side. Per-person failures are collected, and a Sheet write that did not land is a warning, never swallowed. |

### `POST /api/bonus-catalog` — assignment

**New 400 (2026-09-21): an HSL sub-team is a dead target.** HSL bonuses are code
rules in `hsl-bonus/schema.ts`, the HSL calculator never reads the catalog, and
the wizard excludes the HSL family from the catalog's payable set — an
assignment there would save and never be drawn or paid (audit item 139). A
**non-HSL** sub-team (`lead_gen:nurture`) IS a valid target: it lands on the
parent's KPI card and reaches only the members whose master cell is that
sub-team (`src/lib/bonus-catalog/assignment-scope.ts`). Applied rows keep the
**parent** key, so the payable set and the namespaced-double-pay rule are
untouched.

### HR routes — `POST /api/hr/onboarding-bypass`, `POST /api/hr/onboarding-submissions/[id]/set-work-email`

Both already 400'd on a bare HSL; both now pass the data-team map to
`isPlaceableDeptLabel`, so a data team is accepted and the bare label of any
department that has sub-teams is refused.

### `POST /api/payment-catalog/pay-structures`

The Hogan pay-plan mirror now keys on `normalizeDeptToKey(key) === 'hogan_smith_law'`
rather than `isHslSubDeptLabel`, which knew only the code teams and would have
**silently stopped mirroring** a data team member's individual rate.

---

## Route index — every `app/api/**/route.ts` in the tree

**Generated 2026-09-22 by walking `app/api/`; 325 route files** (323 after
`/api/bank-preferred-requests` and its `[id]` route were deleted on 2026-09-24 with the retired
sending-bank approval gate; routes added by other commits since the walk are not counted here). This section exists because the
rest of this file documents 119 of them by hand, so for years an endpoint's absence here could not be
told apart from an endpoint that does not exist. **A route missing from this table is a route that
does not exist** — that is the only claim this table makes. It does not describe request or response
shapes; the hand-written sections above and the linked feature docs do that.

**Gate** is the first authorization helper found in the route file itself: `requireFeatureAccess`
(`src/lib/auth/authorize-feature.ts`), `requireElevatedSession`, a cron secret, and so on. **136 routes
show no gate in the file.** That is a **grep result, not a security finding** — a route may be public
by design, may be gated by its caller, or may use a helper this scan does not know. Do not read this
column as an audit; see [pre-release-security-readiness.md](../features/pre-release-security-readiness.md).

**Mentioned in** is a path-string match against `docs/features/` and this file — a mention is not a
specification, and a `[param]` route matches its parent path. **85 of the 325 routes are mentioned in no
feature doc and in no hand-written section here.**

| Route | Verbs | Gate | Mentioned in |
|---|---|---|---|
| `/api/accounting/documents` | GET | `requireFeatureAccess` | [documents-tab](../features/documents-tab.md) · *this file* |
| `/api/accounting/documents/[id]` | GET, PATCH, DELETE | `requireFeatureAccess` | [documents-tab](../features/documents-tab.md) · *this file* |
| `/api/accounting/documents/coe` | POST | — **none found** | — **no doc** |
| `/api/accounting/documents/coe/preview` | GET | — **none found** | — **no doc** |
| `/api/accounting/documents/coe/search` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/accounting/documents/signature` | GET, PUT | `requireFeatureAccess` | *this file* |
| `/api/accounting/documents/termination` | GET, POST | `requireFeatureAccess` | — **no doc** |
| `/api/accounting/documents/termination/[id]` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/accounting/documents/termination/facts` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/accounting/documents/termination/search` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/accounting/overview-snapshot` | POST | — **none found** | [audit-log](../features/audit-log.md) |
| `/api/accounting/payout-extras` | GET | — **none found** | [accounting-total-payout](../features/accounting-total-payout.md) |
| `/api/accounting/paystub` | GET | `requireFeatureAccess` | [cop-country-payees](../features/cop-country-payees.md) · [payment-dispatch](../features/payment-dispatch.md) |
| `/api/accounting/sync-status` | GET | — **none found** | [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) · *this file* |
| `/api/accounting/transfers` | GET, POST | — **none found** | [department-transfers](../features/department-transfers.md) · *this file* |
| `/api/add-employee` | POST | — **none found** | *this file* |
| `/api/admin/anthropic-key` | GET, POST, DELETE | — **none found** | [admin-api-keys](../features/admin-api-keys.md) |
| `/api/admin/backfill-employee-ids` | POST | service-role only | *this file* |
| `/api/admin/data-tables-status` | GET | — **none found** | — **no doc** |
| `/api/admin/diagnostics` | GET | `requireElevatedSession` | [diagnostics-performance-tabs](../features/diagnostics-performance-tabs.md) · [diagnostics-service-maps](../features/diagnostics-service-maps.md) · *this file* |
| `/api/admin/diagnostics/cycle-performance` | GET | `requireElevatedSession` | [diagnostics-performance-tabs](../features/diagnostics-performance-tabs.md) |
| `/api/admin/diagnostics/hr-pipeline` | GET | `requireElevatedSession` | [diagnostics-performance-tabs](../features/diagnostics-performance-tabs.md) |
| `/api/admin/external-api-clients` | GET, POST | — **none found** | [admin-dashboard-cache](../features/admin-dashboard-cache.md) · [external-api-integrations](../features/external-api-integrations.md) · *this file* |
| `/api/admin/external-api-clients/[id]` | PATCH | — **none found** | [admin-dashboard-cache](../features/admin-dashboard-cache.md) · [external-api-integrations](../features/external-api-integrations.md) · *this file* |
| `/api/admin/external-api-clients/[id]/requests` | GET | — **none found** | — **no doc** |
| `/api/admin/hsl-week-snapshot` | GET, POST | — **none found** | — **no doc** |
| `/api/admin/monday-sync` | GET, POST | — **none found** | [monday-board-sync](../features/monday-board-sync.md) |
| `/api/admin/penny-chat` | POST | — **none found** | [admin-penny-console](../features/admin-penny-console.md) · [admin-penny-tools](../features/admin-penny-tools.md) · *this file* |
| `/api/admin/penny-chat/attachment` | GET | `requireFeatureAccess` | [admin-penny-console](../features/admin-penny-console.md) · *this file* |
| `/api/admin/webhooks/automation` | GET, POST, PUT | — **none found** | [webhook-automations](../features/webhook-automations.md) |
| `/api/admin/workspace-license-config` | POST | — **none found** | — **no doc** |
| `/api/announcements` | GET, POST | — **none found** | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/announcements/[id]` | PATCH, DELETE | — **none found** | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/app-settings` | GET, POST | `requireElevatedSession` | [admin-api-keys](../features/admin-api-keys.md) · [ceo-assistant](../features/ceo-assistant.md) · *this file* |
| `/api/audit-log` | GET, POST, DELETE | `requireElevatedSession` | [audit-log](../features/audit-log.md) · [payment-dispatch](../features/payment-dispatch.md) · *this file* |
| `/api/auth/force-logout` | POST | `requireElevatedSession` | [rbac-feature-permissions](../features/rbac-feature-permissions.md) · *this file* |
| `/api/auth/session-status` | GET | — **none found** | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/avatar` | GET | `authorizeEmail` | *this file* |
| `/api/bank-update/lock-status` | GET | — **none found** | — **no doc** |
| `/api/bank-update/request-otp` | POST | — **none found** | — **no doc** |
| `/api/bank-update/save` | POST | service-role only | [bank-preferred-routing](../features/bank-preferred-routing.md) · [notification-alerts](../features/notification-alerts.md) |
| `/api/bank-update/verify-otp` | POST | — **none found** | — **no doc** |
| `/api/bonus-catalog` | GET, POST, DELETE | — **none found** | [audit-log](../features/audit-log.md) · [bonus-catalog](../features/bonus-catalog.md) · *this file* |
| `/api/bonus-catalog-applied` | GET, POST, DELETE | — **none found** | [kpi-scored-notification](../features/kpi-scored-notification.md) · [payment-dispatch](../features/payment-dispatch.md) |
| `/api/bonus-catalog/history` | GET | — **none found** | [bonus-catalog](../features/bonus-catalog.md) |
| `/api/ceo/accounting-team` | GET | — **none found** | — **no doc** |
| `/api/ceo/chat` | POST | `getServerSession` | [admin-api-keys](../features/admin-api-keys.md) · [audit-log](../features/audit-log.md) · *this file* |
| `/api/ceo/chat/feedback` | POST | `getServerSession` | [audit-log](../features/audit-log.md) · *this file* |
| `/api/ceo/financial-reports` | GET | — **none found** | — **no doc** |
| `/api/ceo/overview-kpis` | GET | — **none found** | — **no doc** |
| `/api/ceo/payments-live` | GET | — **none found** | — **no doc** |
| `/api/ceo/reports/pdf` | POST | `getServerSession` | — **no doc** |
| `/api/contractor/dispatch-queue` | GET | — **none found** | — **no doc** |
| `/api/contractor/invoices` | GET, POST, DELETE | `requireElevatedSession` | [employee-support-chat](../features/employee-support-chat.md) · [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) |
| `/api/contractor/invoices/[id]` | GET, PATCH | `requireFeatureAccess` | [employee-support-chat](../features/employee-support-chat.md) · [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) |
| `/api/contractor/profile` | GET, POST, PATCH | `authorizeEmail` | — **no doc** |
| `/api/cron/apply-scheduled-transfers` | GET, POST | cron secret | [department-transfers](../features/department-transfers.md) |
| `/api/cron/process-scheduled-deletions` | GET, POST | cron secret | [offboarding-automation](../features/offboarding-automation.md) |
| `/api/cron/sync-hsl-from-sheet` | GET, POST | cron secret | — **no doc** |
| `/api/cron/sync-hubstaff-week` | GET, POST | cron secret | [csv-imports](../features/csv-imports.md) · [hubstaff-weekly-auto-sync](../features/hubstaff-weekly-auto-sync.md) |
| `/api/cron/sync-master-from-sheet` | GET, POST | cron secret | [csv-imports](../features/csv-imports.md) · *this file* |
| `/api/cron/sync-offboarded-from-sheet` | GET, POST | — **none found** | — **no doc** |
| `/api/cron/sync-rates-from-sheet` | GET, POST | cron secret | [csv-imports](../features/csv-imports.md) · *this file* |
| `/api/cron/sync-screening-from-sheet` | GET, POST | `requireElevatedSession` | — **no doc** |
| `/api/current-cycle` | GET | — **none found** | — **no doc** |
| `/api/delete-employee` | DELETE | — **none found** | *this file* |
| `/api/department-managers` | GET, POST, DELETE | `requireElevatedSession` | — **no doc** |
| `/api/department-managers/by-department` | GET | `getServerSession` | — **no doc** |
| `/api/department-transfers` | GET, POST | `getServerSession` | [department-transfers](../features/department-transfers.md) · [hsl-subdepartments](../features/hsl-subdepartments.md) · *this file* |
| `/api/department-transfers/[id]` | PATCH, DELETE | `getServerSession` | [department-transfers](../features/department-transfers.md) · [hsl-subdepartments](../features/hsl-subdepartments.md) · *this file* |
| `/api/departments` | GET | `requireElevatedSession` | [hsl-subdepartments](../features/hsl-subdepartments.md) · [onboarding-pay-plans](../features/onboarding-pay-plans.md) · *this file* |
| `/api/dispatch-paystubs` | POST | — **none found** | [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) · [paystub-dispatch](../features/paystub-dispatch.md) |
| `/api/employee-feature-permissions` | GET, POST | `requireElevatedSession` | [identity-resolution](../features/identity-resolution.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) · *this file* |
| `/api/employee-forgot-password` | POST | — **none found** | — **no doc** |
| `/api/employee-gift-receipts` | GET, PUT, DELETE | `requireFeatureAccess` | [gift-tracker-receipts](../features/gift-tracker-receipts.md) |
| `/api/employee-gift-shipping` | GET, PUT | `requireFeatureAccess` | [audit-log](../features/audit-log.md) · [gift-alternate-recipient](../features/gift-alternate-recipient.md) · *this file* |
| `/api/employee-gift-shipping/[id]` | PATCH, DELETE | — **none found** | [audit-log](../features/audit-log.md) · [gift-alternate-recipient](../features/gift-alternate-recipient.md) · *this file* |
| `/api/employee-gift-shipping/[id]/decide` | PATCH | — **none found** | — **no doc** |
| `/api/employee-hourly-rates` | GET | `authorizeEmail` | [bonus-catalog](../features/bonus-catalog.md) · [csv-imports](../features/csv-imports.md) · *this file* |
| `/api/employee-hourly-rates-upload` | GET, POST | service-role only | [csv-imports](../features/csv-imports.md) · *this file* |
| `/api/employee-ids` | GET | `authorizeEmail` | [bank-preferred-routing](../features/bank-preferred-routing.md) · [employee-dashboard-cache](../features/employee-dashboard-cache.md) · *this file* |
| `/api/employee-login` | POST | — **none found** | — **no doc** |
| `/api/employee-master-record` | GET | `authorizeEmail` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) · [employee-id-card](../features/employee-id-card.md) |
| `/api/employee-notifications` | GET, PATCH, DELETE | `getServerSession` | [notification-alerts](../features/notification-alerts.md) · *this file* |
| `/api/employee-notifications/clear-all` | DELETE | `getServerSession` | — **no doc** |
| `/api/employee-profile-photo` | GET, POST, DELETE | `authorizeEmail` | *this file* |
| `/api/employee-rate-history` | GET | `authorizeEmail` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) |
| `/api/employee-rate-history/[id]` | DELETE | `requireElevatedSession` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) |
| `/api/employee-rate-profiles` | GET | `authorizeEmail` | [identity-resolution](../features/identity-resolution.md) · *this file* |
| `/api/employee-rate-profiles/summary` | GET | — **none found** | [identity-resolution](../features/identity-resolution.md) |
| `/api/employee-roles` | GET, POST, DELETE | `requireElevatedSession` | [ceo-assistant](../features/ceo-assistant.md) · [delete-authorization](../features/delete-authorization.md) |
| `/api/employee-skill-sets` | GET, PUT | `authorizeEmail` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) · [manager-dashboard-cache](../features/manager-dashboard-cache.md) |
| `/api/employee/commendations` | GET | `getServerSession` | — **no doc** |
| `/api/employee/documents` | GET, POST | `getServerSession` | [documents-tab](../features/documents-tab.md) · *this file* |
| `/api/employee/documents/[id]` | GET, DELETE | `getServerSession` | [documents-tab](../features/documents-tab.md) · *this file* |
| `/api/employee/documents/coe-preview` | GET | `getServerSession` | [documents-tab](../features/documents-tab.md) |
| `/api/employee/orphanage-hours` | GET | `getServerSession` | [orphanage-pab-coverage](../features/orphanage-pab-coverage.md) |
| `/api/employee/paystub` | GET | `getServerSession` | [cop-country-payees](../features/cop-country-payees.md) · [documents-tab](../features/documents-tab.md) · *this file* |
| `/api/employee/penny-chat` | POST | `authorizeEmail` | [employee-penny-ai](../features/employee-penny-ai.md) · *this file* |
| `/api/employee/penny-chat/quota` | GET | `authorizeEmail` | [employee-penny-ai](../features/employee-penny-ai.md) · *this file* |
| `/api/employee/support` | GET, POST | `authorizeEmail` | [employee-support-chat](../features/employee-support-chat.md) · [employee-support](../features/employee-support.md) |
| `/api/employee/support/[id]/messages` | GET, POST | `authorizeEmail` | [employee-support](../features/employee-support.md) |
| `/api/employee/support/chat` | GET, POST, DELETE | `authorizeEmail` | [employee-support-chat](../features/employee-support-chat.md) |
| `/api/employee/support/chat/[id]/messages` | GET, POST | `authorizeEmail` | — **no doc** |
| `/api/employees` | GET | `authorizeEmail` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) · [employee-id-card](../features/employee-id-card.md) · *this file* |
| `/api/external/mcp` | POST | — **none found** | [external-api-integrations](../features/external-api-integrations.md) · *this file* |
| `/api/external/v1/global-master-list` | GET | — **none found** | [external-api-integrations](../features/external-api-integrations.md) · *this file* |
| `/api/fpu-attendance` | GET, POST | `authorizeEmail` | [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/fpu-enroll` | GET, POST | `authorizeEmail` | [fpu-enrollment](../features/fpu-enrollment.md) · [mesa](../features/mesa.md) · *this file* |
| `/api/gift-address/owed` | POST | — **none found** | [gift-address-external-link](../features/gift-address-external-link.md) · [gift-alternate-recipient](../features/gift-alternate-recipient.md) |
| `/api/gift-address/request-otp` | POST | — **none found** | — **no doc** |
| `/api/gift-address/save` | POST | — **none found** | — **no doc** |
| `/api/gift-address/verify-otp` | POST | — **none found** | — **no doc** |
| `/api/gift-catalog` | GET, PUT | — **none found** | — **no doc** |
| `/api/gift-orders` | GET, POST | `requireFeatureAccess('hr','gift_tracker','view')` (GET) · `requireFeatureEdit('hr','gift_tracker')` (POST lock/reopen/delete) | [gift-tracker-orders](../features/gift-tracker-orders.md) |
| `/api/gift-payments` | GET, PUT | — **none found** | — **no doc** |
| `/api/gift-tracker/recent-submissions` | GET | `requireFeatureAccess('hr','gift_tracker','view')` | [gift-address-external-link](../features/gift-address-external-link.md) |
| `/api/gift-tracker-notes` | GET, PUT | — **none found** | — **no doc** |
| `/api/global-master-list` | GET, POST | service-role only | [csv-imports](../features/csv-imports.md) · *this file* |
| `/api/global-master-list/names` | GET | `requireElevatedSession` | — **no doc** |
| `/api/global-master-list/people` | GET | `getServerSession` | — **no doc** |
| `/api/hr/backfill-onboarding-notifications` | POST | — **none found** | [audit-log](../features/audit-log.md) |
| `/api/hr/department-rates` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/fpu-classes` | GET, POST, PATCH, DELETE | `requireFeatureAccess` | [fpu-enrollment](../features/fpu-enrollment.md) · [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/hr/fpu-classes/class-close` | POST | `requireFeatureAccess` | [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/hr/fpu-classes/close` | POST | `requireFeatureAccess` | [fpu-enrollment](../features/fpu-enrollment.md) · *this file* |
| `/api/hr/fpu-classes/groups/confirm` | POST | `requireFeatureAccess` | *this file* |
| `/api/hr/fpu-classes/groups/leader` | PATCH | `requireFeatureAccess` | *this file* |
| `/api/hr/fpu-classes/groups/list` | POST | `requireFeatureAccess` | *this file* |
| `/api/hr/fpu-classes/groups/preview` | POST | `requireFeatureAccess` | *this file* |
| `/api/hr/fpu-enrollments` | GET, PATCH, DELETE | `requireFeatureAccess` | [fpu-enrollment](../features/fpu-enrollment.md) · [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/hr/fpu-enrollments/complete` | POST | `requireFeatureAccess` | [fpu-enrollment](../features/fpu-enrollment.md) · [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/hr/new-hire-checklist` | GET, POST, PUT, PATCH, DELETE | `requireElevatedSession` | [new-hire-checklist](../features/new-hire-checklist.md) · *this file* |
| `/api/hr/new-hire-checklist/departments` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/new-hire-checklist/export` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/new-hire-checklist/periods` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/new-hire-checklist/recruiters` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/new-hire-checklist/referrals` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/new-hire-checklist/sources` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hr/offboard` | POST | — **none found** | [bonus-catalog](../features/bonus-catalog.md) · [identity-resolution](../features/identity-resolution.md) · *this file* |
| `/api/hr/offboard-fire-webhook` | POST | — **none found** | — **no doc** |
| `/api/hr/offboard-history` | GET | `requireElevatedSession` | [identity-resolution](../features/identity-resolution.md) · [offboarding-automation](../features/offboarding-automation.md) |
| `/api/hr/offboard-sheet-backfill` | POST | — **none found** | [offboarding-automation](../features/offboarding-automation.md) · *this file* |
| `/api/hr/offboard-sheet-delete` | POST | — **none found** | — **no doc** |
| `/api/hr/onboarding-bypass` | POST | — **none found** | [hsl-subdepartments](../features/hsl-subdepartments.md) · *this file* |
| `/api/hr/onboarding-submissions` | GET, POST | `requireElevatedSession` | [hsl-subdepartments](../features/hsl-subdepartments.md) · [onboarding-gmail-surname](../features/onboarding-gmail-surname.md) · *this file* |
| `/api/hr/onboarding-submissions/[id]` | GET, DELETE | `requireElevatedSession` | [hsl-subdepartments](../features/hsl-subdepartments.md) · [onboarding-gmail-surname](../features/onboarding-gmail-surname.md) · *this file* |
| `/api/hr/onboarding-submissions/[id]/send` | POST | — **none found** | [onboarding-pay-plans](../features/onboarding-pay-plans.md) |
| `/api/hr/onboarding-submissions/[id]/set-work-email` | POST | — **none found** | [hsl-subdepartments](../features/hsl-subdepartments.md) · [onboarding-gmail-surname](../features/onboarding-gmail-surname.md) · *this file* |
| `/api/hr/onboarding-submissions/[id]/verify-work-email` | POST | — **none found** | [workspace-account-verify](../features/workspace-account-verify.md) |
| `/api/hr/onboarding-submissions/[id]/workspace-status` | POST | — **none found** | [workspace-account-verify](../features/workspace-account-verify.md) |
| `/api/hr/orientation-attendance` | GET | `requireFeatureAccess` | [hr-orientation-attendance](../features/hr-orientation-attendance.md) |
| `/api/hr/pay-plans` | GET, POST | `requireFeatureAccess` | [onboarding-pay-plans](../features/onboarding-pay-plans.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/hr/pay-plans/[id]` | DELETE | — **none found** | [onboarding-pay-plans](../features/onboarding-pay-plans.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/hr/pending-employees` | GET, POST | `requireElevatedSession` | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/hr/pending-employees/[id]` | PATCH, DELETE | — **none found** | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/hr/pending-employees/[id]/promote` | POST | — **none found** | — **no doc** |
| `/api/hr/pending-employees/[id]/retry-workspace` | POST | — **none found** | — **no doc** |
| `/api/hr/pending-employees/[id]/unpromote` | POST | — **none found** | — **no doc** |
| `/api/hr/pending-employees/bulk-promote` | POST | — **none found** | — **no doc** |
| `/api/hr/pending-employees/bulk-unpromote` | POST | — **none found** | — **no doc** |
| `/api/hr/reonboard` | POST | — **none found** | [csv-imports](../features/csv-imports.md) · [offboarding-automation](../features/offboarding-automation.md) |
| `/api/hr/work-email/suggest` | POST | `requireElevatedSession` | [audit-log](../features/audit-log.md) · [workspace-account-verify](../features/workspace-account-verify.md) |
| `/api/hr/workspace-account/verify` | POST | — **none found** | [audit-log](../features/audit-log.md) |
| `/api/hr/workspace-license-info` | GET | `requireElevatedSession` | — **no doc** |
| `/api/hsl-bonus/entries` | GET, POST, DELETE | — **none found** | [audit-log](../features/audit-log.md) · [hsl-kpi-calculator-2026-07](../features/hsl-kpi-calculator-2026-07.md) |
| `/api/hsl-bonus/period` | DELETE | — **none found** | [audit-log](../features/audit-log.md) · [hsl-kpi-calculator-2026-07](../features/hsl-kpi-calculator-2026-07.md) |
| `/api/hsl-bonus/period-status` | GET, POST | — **none found** | [hsl-kpi-calculator-2026-07](../features/hsl-kpi-calculator-2026-07.md) · [kpi-scored-notification](../features/kpi-scored-notification.md) |
| `/api/hsl-bonus/period-summary` | GET | — **none found** | [pre-release-security-readiness](../features/pre-release-security-readiness.md) |
| `/api/hsl-bonus/team-members` | GET | `getServerSession` | [hsl-subdepartments](../features/hsl-subdepartments.md) |
| ↳ | | | **503 when `?dept=` names a branch it cannot resolve** (2026-09-22). DATA sub-teams live in `app_settings`, so an unreadable map makes a data key indistinguishable from a typo — and the reply would be a confident empty roster, i.e. "this team has nobody in it". Code teams still resolve and still answer. |
| `/api/hubstaff-hours` | GET, POST, PATCH, DELETE | `authorizeEmail` | [csv-imports](../features/csv-imports.md) · [employee-my-hours-calendar](../features/employee-my-hours-calendar.md) · *this file* |
| `/api/import-daily-report` | POST | `requireElevatedSession` | [audit-log](../features/audit-log.md) · [pre-release-security-readiness](../features/pre-release-security-readiness.md) · *this file* |
| `/api/kpi-results` | GET | `authorizeEmail` | — **no doc** |
| `/api/leave-requests` | GET, POST | `requireElevatedSession` | [delete-authorization](../features/delete-authorization.md) · [manager-dashboard-cache](../features/manager-dashboard-cache.md) · *this file* |
| `/api/leave-requests/[id]` | PATCH, DELETE | `getServerSession` | [delete-authorization](../features/delete-authorization.md) · [manager-dashboard-cache](../features/manager-dashboard-cache.md) · *this file* |
| `/api/manager/approver-candidates` | GET | `getServerSession` | [time-adjustment-requests](../features/time-adjustment-requests.md) |
| `/api/manager/calltools-username` | PATCH | `getServerSession` | [onboarding-calltools-username](../features/onboarding-calltools-username.md) |
| `/api/manager/departed-members` | GET | `getServerSession` | *this file* |
| `/api/manager/department-members` | GET | `getServerSession` | [identity-resolution](../features/identity-resolution.md) · [manager-dashboard-cache](../features/manager-dashboard-cache.md) · *this file* |
| `/api/manager/medals` | GET, POST | `getServerSession` | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/manager/member-monthly-pay` | GET | — **none found** | [identity-resolution](../features/identity-resolution.md) · [pre-release-security-readiness](../features/pre-release-security-readiness.md) |
| `/api/manager/member-notes` | GET, PUT | `getServerSession` | [manager-my-team](../features/manager-my-team.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/manager/member-rate-history` | GET | — **none found** | — **no doc** |
| `/api/manager/orientation-history` | GET | `getServerSession` | [manager-orientation-attendance](../features/manager-orientation-attendance.md) |
| `/api/manager/pending-hires` | GET | `getServerSession` | [manager-orientation-attendance](../features/manager-orientation-attendance.md) · [offboarding-automation](../features/offboarding-automation.md) |
| `/api/manager/pending-hires/[id]/no-show` | POST | `getServerSession` | [offboarding-automation](../features/offboarding-automation.md) |
| `/api/manager/pending-hires/[id]/orientation` | POST, DELETE | `getServerSession` | [onboarding-calltools-username](../features/onboarding-calltools-username.md) |
| `/api/manager/scheduling` | GET, PUT | `getServerSession` | [manager-scheduling](../features/manager-scheduling.md) · *this file* |
| `/api/manager/temp-pause` | POST | `getServerSession` | [manager-my-team](../features/manager-my-team.md) |
| `/api/manager/time-adjustments` | GET | `getServerSession` | [manager-dashboard-cache](../features/manager-dashboard-cache.md) · [time-adjustment-requests](../features/time-adjustment-requests.md) · *this file* |
| `/api/manager/transfer-candidates` | GET | `getServerSession` | [department-transfers](../features/department-transfers.md) · [hsl-kpi-calculator-2026-07](../features/hsl-kpi-calculator-2026-07.md) · *this file* |
| `/api/mesa-ledger` | GET | `requireElevatedSession` | [mesa](../features/mesa.md) |
| `/api/mesa-notes` | GET, POST | `requireElevatedSession` | [mesa](../features/mesa.md) |
| `/api/mesa-requests` | GET, POST | `requireElevatedSession` | [fpu-enrollment](../features/fpu-enrollment.md) · [mesa](../features/mesa.md) · *this file* |
| `/api/mesa-requests/[id]` | PATCH, DELETE | — **none found** | [fpu-enrollment](../features/fpu-enrollment.md) · [mesa](../features/mesa.md) · *this file* |
| `/api/mesa-requests/[id]/dispatch` | POST | — **none found** | [mesa](../features/mesa.md) · [urgent-payments](../features/urgent-payments.md) |
| `/api/mesa-requests/[id]/receipts` | GET, POST, DELETE | `authorizeEmail` | [mesa](../features/mesa.md) |
| `/api/offboarding-queue` | GET, POST, PATCH | `getServerSession` | [manager-dashboard-cache](../features/manager-dashboard-cache.md) · [offboarding-automation](../features/offboarding-automation.md) |
| `/api/offboarding-queue/[id]` | PATCH, DELETE | `getServerSession` | [manager-dashboard-cache](../features/manager-dashboard-cache.md) · [offboarding-automation](../features/offboarding-automation.md) |
| `/api/onboarding/[token]` | GET, POST | — **none found** | [onboarding-calltools-username](../features/onboarding-calltools-username.md) · [onboarding-gmail-surname](../features/onboarding-gmail-surname.md) · *this file* |
| `/api/onboarding/[token]/calltools-username` | POST | `requireElevatedSession` | [onboarding-calltools-username](../features/onboarding-calltools-username.md) |
| `/api/onboarding/[token]/gmail-surname` | POST | `requireElevatedSession` | [onboarding-gmail-surname](../features/onboarding-gmail-surname.md) |
| `/api/onboarding/[token]/w8ben` | POST | — **none found** | — **no doc** |
| `/api/onboarding/ip-assignment-preview` | POST | — **none found** | [onboarding-ip-assignment](../features/onboarding-ip-assignment.md) · *this file* |
| `/api/orphanage-budget-requests` | GET, POST | — **none found** | [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/orphanage-budget-requests/[id]/decide` | PATCH | — **none found** | — **no doc** |
| `/api/orphanage-dispatches` | GET, POST | `requireFeatureAccess` | [paystub-dispatch](../features/paystub-dispatch.md) · [urgent-payments](../features/urgent-payments.md) |
| `/api/orphanage-disputes` | GET | `getServerSession` | *this file* |
| `/api/orphanage-interns` | GET, POST | `requireFeatureAccess` | [orphanage-interns](../features/orphanage-interns.md) · *this file* |
| `/api/orphanage-interns/[id]` | GET, PATCH, DELETE | `requireFeatureAccess` | [orphanage-interns](../features/orphanage-interns.md) · *this file* |
| `/api/orphanage-interns/[id]/rates` | POST | — **none found** | — **no doc** |
| `/api/orphanage-interns/hours` | GET, POST, DELETE | `requireFeatureAccess` | [orphanage-interns](../features/orphanage-interns.md) |
| `/api/orphanage-interns/pay-weeks` | POST, DELETE | — **none found** | — **no doc** |
| `/api/orphanage-interns/pay-weeks/config` | GET, POST | `requireFeatureAccess` | — **no doc** |
| `/api/orphanage-interns/pay-weeks/decide` | PATCH | — **none found** | — **no doc** |
| `/api/orphanage-interns/pay-weeks/inbox` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/orphanage-interns/pay-weeks/preview` | GET | `requireFeatureAccess` | — **no doc** |
| `/api/orphanage-pay` | GET, POST, DELETE | `requireFeatureAccess` | [orphanage-oms-pull](../features/orphanage-oms-pull.md) · [orphanage-pab-coverage](../features/orphanage-pab-coverage.md) · *this file* |
| `/api/orphanage-pay/oms` | GET | `requireFeatureAccess` | [orphanage-oms-pull](../features/orphanage-oms-pull.md) · *this file* |
| `/api/orphanage-pay/oms/saves` | GET, POST | `requireFeatureAccess` | [orphanage-oms-pull](../features/orphanage-oms-pull.md) · *this file* |
| `/api/orphanage-vendor-invoices` | GET, POST | `requireFeatureAccess` | [third-party-vendors](../features/third-party-vendors.md) · *this file* |
| `/api/orphanage-vendor-invoices/[id]` | PATCH, DELETE | — **none found** | [third-party-vendors](../features/third-party-vendors.md) · *this file* |
| `/api/orphanage-vendors` | GET, POST | `requireFeatureAccess` | [third-party-vendors](../features/third-party-vendors.md) · *this file* |
| `/api/orphanage-vendors/[id]` | PATCH, DELETE | — **none found** | [third-party-vendors](../features/third-party-vendors.md) · *this file* |
| `/api/orphanage-worker-payments` | GET, POST, PATCH, DELETE | `requireFeatureAccess` | — **no doc** |
| `/api/orphanages` | GET, POST | — **none found** | [audit-log](../features/audit-log.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/orphanages/[id]` | PATCH, DELETE | — **none found** | [audit-log](../features/audit-log.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) |
| `/api/orphanages/upload` | POST | — **none found** | [audit-log](../features/audit-log.md) |
| `/api/pab-disputes` | GET, POST | `requireElevatedSession` | [delete-authorization](../features/delete-authorization.md) · *this file* |
| `/api/pab-disputes/[id]` | PATCH, DELETE | `authorizeEmail` | [delete-authorization](../features/delete-authorization.md) · *this file* |
| `/api/pab-disputes/orphanage-manager-submit` | POST | — **none found** | *this file* |
| `/api/pab-disputes/orphanage-overlap` | GET | `authorizeEmail` | *this file* |
| `/api/pab-disputes/orphanage-visits` | GET, POST | — **none found** | *this file* |
| `/api/pab-disputes/orphanage-visits/[id]` | DELETE | — **none found** | *this file* |
| `/api/pab-exclusions` | POST | `requireElevatedSession` | [pab-exclusions](../features/pab-exclusions.md) · [payroll-wizard-pab-step](../features/payroll-wizard-pab-step.md) |
| `/api/payment-catalog/banks` | GET, POST, PATCH | — **none found** | [payment-catalog-current-banks](../features/payment-catalog-current-banks.md) |
| `/api/payment-catalog/banks/[key]/people` | GET | — **none found** | [payment-catalog-current-banks](../features/payment-catalog-current-banks.md) |
| `/api/payment-catalog/departments` | GET, POST, PATCH | — **none found** | [payment-catalog-departments](../features/payment-catalog-departments.md) · *this file* |
| `/api/payment-catalog/pay-processors` | GET, POST, PATCH | — **none found** | [payment-catalog-pay-processors](../features/payment-catalog-pay-processors.md) |
| `/api/payment-catalog/pay-structures` | GET, POST, DELETE | — **none found** | [bonus-catalog](../features/bonus-catalog.md) · [payroll-readiness](../features/payroll-readiness.md) · *this file* |
| `/api/payment-catalog/roster` | GET | `requireRateVisibilitySession` | [payment-catalog-departments](../features/payment-catalog-departments.md) §2 · [accounting-dashboard-cache](../features/accounting-dashboard-cache.md) |
| `/api/payment-catalog/system-bonuses` | GET, POST, DELETE | — **none found** | [audit-log](../features/audit-log.md) · [bonus-catalog](../features/bonus-catalog.md) |
| `/api/payment-dispatch/bank-override` | POST | service-role only | [bank-preferred-routing](../features/bank-preferred-routing.md) · [payment-dispatch](../features/payment-dispatch.md) |
| `/api/payment-dispatches` | GET, POST | `getServerSession` | [cycle-closeout](../features/cycle-closeout.md) · [dispatch-paid-toast](../features/dispatch-paid-toast.md) · *this file* |
| `/api/payment-dispatches/cycle-closeout` | GET, POST, DELETE | `getServerSession` | [cycle-closeout](../features/cycle-closeout.md) · [payment-dispatch](../features/payment-dispatch.md) |
| `/api/payment-dispatches/recent-paid` | GET | `requireFeatureAccess` | [dispatch-paid-toast](../features/dispatch-paid-toast.md) |
| `/api/payment-dispatches/undo` | POST | — **none found** | [dispatch-paid-toast](../features/dispatch-paid-toast.md) · [payment-dispatch](../features/payment-dispatch.md) |
| `/api/payment-dispatches/undo-history` | GET | `requireElevatedSession` | [payment-dispatch](../features/payment-dispatch.md) |
| `/api/payroll-current-pay` | GET | — **none found** | [payment-dispatch](../features/payment-dispatch.md) · [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) |
| `/api/payroll-dispatch-lock` | GET, POST | `getServerSession` | [bank-preferred-routing](../features/bank-preferred-routing.md) · [payment-dispatch](../features/payment-dispatch.md) · *this file* |
| `/api/payroll-wizard/additions` | POST | — **none found** | [orphanage-pay-step](../features/orphanage-pay-step.md) · [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) |
| `/api/payroll-wizard/audit` | GET | — **none found** | [payment-dispatch](../features/payment-dispatch.md) · [payroll-wizard-tutorial-mode](../features/payroll-wizard-tutorial-mode.md) |
| `/api/payroll-wizard/audit-week` | GET | — **none found** | [payroll-wizard-tutorial-mode](../features/payroll-wizard-tutorial-mode.md) |
| `/api/payroll-wizard/audit/export` | GET | — **none found** | — **no doc** |
| `/api/payroll-wizard/bank-exemptions` | GET, POST, DELETE | `requireFeatureAccess` | [payroll-readiness](../features/payroll-readiness.md) |
| `/api/payroll-wizard/manual-validation` | GET, PATCH | `requireFeatureAccess` | [payroll-wizard-manual-validation](../features/payroll-wizard-manual-validation.md) |
| `/api/payroll-wizard/notes` | GET, POST, PATCH, DELETE | `requireFeatureAccess` | [payroll-wizard-notes](../features/payroll-wizard-notes.md) |
| `/api/payroll-wizard/notes/adjustment` | POST | — **none found** | — **no doc** |
| `/api/payroll-wizard/notes/workers` | GET | `requireFeatureAccess` | [payroll-wizard-notes](../features/payroll-wizard-notes.md) |
| `/api/payroll-wizard/offboarded` | GET | `requireFeatureAccess` | [payroll-readiness](../features/payroll-readiness.md) · *this file* |
| `/api/payroll-wizard/offboarded-roster` | GET | `requireFeatureAccess` | [payroll-readiness](../features/payroll-readiness.md) · *this file* |
| `/api/payroll-wizard/first-hours-week` | GET | `requireFeatureAccess` | [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) · *this file* |
| `/api/payroll-wizard/pab-forgive-month` | POST | — **none found** | [payroll-wizard-pab-step](../features/payroll-wizard-pab-step.md) |
| `/api/payroll-wizard/rate-exemptions` | GET, POST, DELETE | `requireFeatureAccess` | [payroll-readiness](../features/payroll-readiness.md) |
| `/api/payroll-wizard/readiness` | GET | `requireFeatureAccess` | [payroll-readiness](../features/payroll-readiness.md) |
| `/api/payroll/hsl-transfers-bulk` | GET | — **none found** | [department-transfers](../features/department-transfers.md) · [paystub-dispatch](../features/paystub-dispatch.md) |
| `/api/payroll/rate-history-bulk` | GET | — **none found** | [department-transfers](../features/department-transfers.md) · [payroll-wizard-final-pay](../features/payroll-wizard-final-pay.md) · *this file* |
| `/api/payroll/settlement-currency` | POST | `getServerSession` | [bonus-catalog](../features/bonus-catalog.md) · [cop-country-payees](../features/cop-country-payees.md) |
| `/api/paystub-dispatch-queue` | GET, POST | `requireFeatureAccess` | [mesa](../features/mesa.md) · [payment-dispatch](../features/payment-dispatch.md) · *this file* |
| `/api/paystub-dispatch-queue/arrears` | GET | `requireFeatureAccess` | [payment-dispatch](../features/payment-dispatch.md) · [paystub-dispatch](../features/paystub-dispatch.md) · *this file* |
| `/api/people` | GET | — **none found** | [bank-preferred-routing](../features/bank-preferred-routing.md) · [employee-dashboard-cache](../features/employee-dashboard-cache.md) · *this file* |
| `/api/people/[email]` | GET | — **none found** | [bank-preferred-routing](../features/bank-preferred-routing.md) · [employee-dashboard-cache](../features/employee-dashboard-cache.md) · *this file* |
| `/api/people/[email]/banking` | PATCH | service-role only | [bank-preferred-routing](../features/bank-preferred-routing.md) · [payroll-readiness](../features/payroll-readiness.md) · *this file* |
| `/api/people/[email]/profile` | PATCH | — **none found** | *this file* |
| `/api/people/[email]/reveal-banking` | POST | — **none found** | [employee-profile](../features/employee-profile.md) · [people-bank-card](../features/people-bank-card.md) |
| `/api/people/bank-changes` | GET | — **none found** | — **no doc** |
| `/api/people/offboarded` | GET | — **none found** | [people-offboarded-pay](../features/people-offboarded-pay.md) |
| `/api/people/pay` | POST | — **none found** | [people-offboarded-pay](../features/people-offboarded-pay.md) · [urgent-payments](../features/urgent-payments.md) |
| `/api/people/request-bank-info` | POST | — **none found** | — **no doc** |
| `/api/people/special-transfers` | GET | `authorizeEmail` | [employee-dashboard-cache](../features/employee-dashboard-cache.md) |
| `/api/people/stats` | GET | — **none found** | — **no doc** |
| `/api/presence/active` | GET | — **none found** | — **no doc** |
| `/api/presence/heartbeat` | POST | `getServerSession` | [audit-log](../features/audit-log.md) · [employee-support-chat](../features/employee-support-chat.md) |
| `/api/presence/last-seen` | GET | — **none found** | [accounting-cobrowse](../features/accounting-cobrowse.md) · [manager-dashboard-cache](../features/manager-dashboard-cache.md) |
| `/api/qc/assignments` | GET | `getServerSession` | [qc-scoring](../features/qc-scoring.md) · *this file* |
| `/api/qc/compare-paste` | GET, PUT, DELETE | `requireFeatureAccess` | [hsl-kpi-calculator-2026-07](../features/hsl-kpi-calculator-2026-07.md) · [qc-scoring](../features/qc-scoring.md) · *this file* |
| `/api/qc/lock` | POST | — **none found** | [payment-dispatch](../features/payment-dispatch.md) |
| `/api/qc/review` | GET, POST | `getServerSession` | [payment-dispatch](../features/payment-dispatch.md) · [qc-scoring](../features/qc-scoring.md) |
| `/api/qc/submissions` | GET, POST | `getServerSession` | [payment-dispatch](../features/payment-dispatch.md) · [qc-scoring](../features/qc-scoring.md) |
| `/api/resignation-requests` | GET, POST | `requireElevatedSession` | [manager-dashboard-cache](../features/manager-dashboard-cache.md) |
| `/api/resignation-requests/[id]` | PATCH | `getServerSession` | [manager-dashboard-cache](../features/manager-dashboard-cache.md) |
| `/api/roster/gml-status` | GET | `requireElevatedSession` | — **no doc** |
| `/api/screening` | GET | `requireElevatedSession` | *this file* |
| `/api/secondary/hubstaff-projects` | GET | — **none found** | — **no doc** |
| `/api/support/chat/[id]/messages` | GET, POST | `requireFeatureAccess` | — **no doc** |
| `/api/support/chat/availability` | GET, POST, PATCH | `requireFeatureAccess` | — **no doc** |
| `/api/support/chat/queue` | GET, PATCH | `requireFeatureAccess` | — **no doc** |
| `/api/support/tickets` | GET, PATCH | `requireFeatureAccess` | [employee-support](../features/employee-support.md) |
| `/api/support/tickets/[id]/reply` | GET, POST | `requireFeatureAccess` | [employee-support](../features/employee-support.md) |
| `/api/suspend-employee` | POST | — **none found** | — **no doc** |
| `/api/swall/comments` | GET, POST | — **none found** | — **no doc** |
| `/api/swall/comments/[id]` | DELETE | — **none found** | — **no doc** |
| `/api/swall/posts` | GET, POST | — **none found** | — **no doc** |
| `/api/swall/posts/[id]` | DELETE | — **none found** | — **no doc** |
| `/api/swall/reactions` | POST | — **none found** | — **no doc** |
| `/api/swall/upload` | POST | — **none found** | — **no doc** |
| `/api/team-rankings` | GET | `getServerSession` | [employee-team-directory](../features/employee-team-directory.md) · [manager-my-team](../features/manager-my-team.md) |
| `/api/team-roster` | GET | `getServerSession` | [employee-team-directory](../features/employee-team-directory.md) |
| `/api/tickets` | GET, POST | `requireFeatureAccess` | [employee-support-chat](../features/employee-support-chat.md) · [employee-support](../features/employee-support.md) |
| `/api/tickets/[id]` | PATCH, DELETE | — **none found** | [employee-support-chat](../features/employee-support-chat.md) · [employee-support](../features/employee-support.md) |
| `/api/tickets/[id]/comments` | GET, POST | `requireFeatureAccess` | [employee-support](../features/employee-support.md) |
| `/api/tickets/[id]/events` | GET | `requireFeatureAccess` | [tickets-board](../features/tickets-board.md) |
| `/api/tickets/members` | GET | `requireFeatureAccess` | [tickets-board](../features/tickets-board.md) |
| `/api/time-adjustments` | GET, POST | `requireElevatedSession` | [employee-support](../features/employee-support.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) · *this file* |
| `/api/time-adjustments/[id]` | PATCH, DELETE | `getServerSession` | [employee-support](../features/employee-support.md) · [rbac-feature-permissions](../features/rbac-feature-permissions.md) · *this file* |
| `/api/time-adjustments/second-approvals` | GET | `getServerSession` | [time-adjustment-requests](../features/time-adjustment-requests.md) |
| `/api/time-adjustments/upload` | POST | — **none found** | [time-adjustment-requests](../features/time-adjustment-requests.md) · *this file* |
| `/api/toggle-mesa-member` | POST | — **none found** | [fpu-enrollment](../features/fpu-enrollment.md) · [fpu-groups-attendance](../features/fpu-groups-attendance.md) · *this file* |
| `/api/update-employee-ids` | POST | `authorizeEmail` | [bank-preferred-routing](../features/bank-preferred-routing.md) · [notification-alerts](../features/notification-alerts.md) · *this file* |
| `/api/update-employee-profile` | POST | — **none found** | *this file* |
| `/api/update-employee-rates` | POST | — **none found** | *this file* |
| `/api/urgent-payments` | GET | `requireElevatedSession` | [payment-dispatch](../features/payment-dispatch.md) · [people-offboarded-pay](../features/people-offboarded-pay.md) |
| `/api/urgent-payments/dispatches` | GET | `requireElevatedSession` | [payment-dispatch](../features/payment-dispatch.md) · [people-offboarded-pay](../features/people-offboarded-pay.md) |
| `/api/urgent-payments/dispatches/undo` | POST | — **none found** | [people-offboarded-pay](../features/people-offboarded-pay.md) · [urgent-payments](../features/urgent-payments.md) |
| `/api/urgent-payments/requests` | GET | `requireElevatedSession` | [urgent-payments](../features/urgent-payments.md) |
| `/api/urgent-payments/requests/[id]` | DELETE | — **none found** | [urgent-payments](../features/urgent-payments.md) |
| `/api/urgent-payments/requests/[id]/dispatch` | POST | — **none found** | [urgent-payments](../features/urgent-payments.md) |
