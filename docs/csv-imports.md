# CSV Imports & Google Sheet Sync

Admin-only data ingestion for the three CSV-shaped sources the HRIS depends on: the global master list (employee roster), the All-Dept payroll rates ledger, and Hubstaff weekly timesheets. Two transport mechanisms are supported per source: **direct CSV upload** and (for master + rates) **manual sync from a configured Google Sheet**. There is no automated cron — every sync runs only on a user click.

> Last updated: 2026-05-07. This doc is the umbrella reference for the **Admin → CSV imports** tab, the underlying API endpoints, and the case-handling fixes made during the Google Sheet sync rollout.

---

## Table of Contents

1. [The Admin tab](#1-the-admin-tab)
2. [Upload sources & destinations](#2-upload-sources--destinations)
3. [Google Sheet sync (manual button-only)](#3-google-sheet-sync-manual-button-only)
4. [Ingest pipeline behavior & guarantees](#4-ingest-pipeline-behavior--guarantees)
5. [Endpoints](#5-endpoints)
6. [Environment variables](#6-environment-variables)
7. [Schema & history model](#7-schema--history-model)
8. [Audit log actions](#8-audit-log-actions)
9. [Recent fixes & gotchas](#9-recent-fixes--gotchas)

---

## 1. The Admin tab

`Admin → CSV imports` (`src/components/admin/AdminCsvImports.tsx`, registered in `app/admin/page.tsx`) is a parallel surface to the Payroll Wizard's step-1 upload step. It mirrors the wizard's functionality so admins can re-ingest, hotfix, or sync without spinning up the wizard's full state.

### Two sub-tabs

| Tab | Purpose |
|---|---|
| **Upload** | Three coloured cards (master / rates / Hubstaff) for picking a CSV. Each card shows last-action status (idle / uploading / success / error) with a coloured panel. Below the cards, an "Uploaded Hubstaff batches" list with delete buttons. |
| **Files** | Sub-tabbed by archive: Hubstaff / Master list / Payroll rates. Hubstaff supports per-batch row inspection (paginated, searchable). Master + Rates currently show metadata-only lists (filename, timestamp, row count, `Current` badge). |

### Each upload card shows

- Coloured icon tile + caption (e.g. emerald "Global master list", sky "Payroll rates", indigo "Hubstaff timesheets").
- Description and footnote explaining what columns are expected and where the data lands.
- Result panel: `idle` → `uploading` → `success` (with row counts and breakdown sublines) or `error` (with the API error message).
- Primary "Choose CSV" button.
- Secondary **"Sync from Google Sheet"** link (master + rates cards only, hubstaff is CSV-upload-only).

The Hubstaff card additionally surfaces a **client-side validation + confirm dialog** before posting (mirrors the wizard's `handleWeeklyFileChosen`). Master + rates cards POST immediately on file pick, no preview.

---

## 2. Upload sources & destinations

| Source | Endpoint | Destination table(s) | Archive table | Identity key |
|---|---|---|---|---|
| Master list CSV / Sheet | `POST /api/global-master-list` (CSV) and `POST /api/cron/sync-master-from-sheet` (Sheet) | `global_master_list` | `master_list_uploads` (newly archived row promoted to `is_current = true`) | `(LOWER("Personal Email"), LOWER("Department"))` partial index where both non-null |
| Rates CSV / Sheet | `POST /api/employee-hourly-rates-upload` (CSV) and `POST /api/cron/sync-rates-from-sheet` (Sheet) | `employee_hourly_rates` | `rates_uploads` | `Work Email` (single column) |
| Hubstaff weekly | `POST /api/hubstaff-hours` (CSV upload only — no sheet sync) | `hubstaff_hours` | `hubstaff_uploads` | `(source_file, row position)` — append-only with upload_id stamp |

Every successful sync **promotes the new upload to `is_current = true`** and demotes all prior uploads. The dashboard, payroll wizard, etc. read from `is_current` rows only via the `active_employees` view (master) or by filtering on `upload_id = current` (hubstaff/rates).

**The data is materialized in Supabase between syncs.** Nothing in the HRIS reads from Google Sheets at request time. If the sheet is offline, edited, or the service account loses access, the HRIS keeps working — it just can't be re-synced until the connection is restored.

---

## 3. Google Sheet sync (manual button-only)

### Why it exists

HR keeps the canonical roster + rates in shared Google Sheets. Pre-sync, admins had to export each as a CSV and upload it manually. The sync replaces that two-step (export → upload) with a single button click that pulls the latest sheet content directly via the Sheets API.

### Trigger

- **Admin → CSV imports → Upload tab → "Sync from Google Sheet"** under the Master list card or the Payroll rates card.
- No automated cron. `vercel.json` has no `crons` array. The two endpoints (`/api/cron/sync-{master,rates}-from-sheet`) carry a `cron/` path segment for legacy reasons but are now invoked only by the in-app button.

### Authentication

A single Google Cloud **service account** owns the read access. The same account is shared with both the master list sheet and the rates sheet as Viewer (or Editor — Viewer is enough). Auth flow:

1. `src/lib/google-sheets/auth.ts → getServiceAccountAccessToken(scope)` builds an RS256 JWT from `GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY` using Node's built-in `crypto.createSign`.
2. POST the JWT to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
3. Receive an OAuth2 access token; cache in-memory until 30s before expiry.
4. Use `Authorization: Bearer <token>` to call `https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}`.

No `googleapis` npm dependency. Hand-rolled with `crypto` to keep the dep footprint minimal.

### Master list fetch (`src/lib/google-sheets/fetch-master-sheet.ts`)

1. Request the configured tab's full grid with `valueRenderOption=FORMATTED_VALUE`.
2. **Auto-detect the header row** by scanning each row for a cell exactly equal to `department` (case-insensitive) **and** a cell equal to `name` or `personal email`. Drops everything above the matched row — so sheets with title rows, blanks, or a pre-existing `MASTERLIST` banner are tolerated.
3. **Synthesize two `MASTERLIST` sentinel rows** at the top of the resulting CSV. The existing `validateMasterListCsvLayout()` requires the `MASTERLIST` text in rows 1–2 (an Excel-export artifact). Synthesizing them lets a "naturally laid out" Google Sheet (row 1 = headers, row 2+ = data) flow through unchanged.
4. Format as RFC-4180 CSV (rectangular grid, RFC-style quoting for commas / newlines / quotes).

### Rates fetch (`src/lib/google-sheets/fetch-rates-sheet.ts`)

1. Same auth + Sheets API call.
2. No header auto-detection — the `All Dept` sheet has its headers on row 1 by convention.
3. No sentinel synthesis — the rates ingest has no analogous `MASTERLIST` marker.
4. Tab name is **always wrapped in single quotes** in the URL's A1 notation (`'All Dept'` → `%27All%20Dept%27`). Sheets API requires this for tab names with spaces or punctuation.

### Endpoint orchestration

Both endpoints follow the same pattern:

```
1. Auth check (CRON_SECRET if set; otherwise open).
2. Fetch sheet → CSV text.
3. If empty → throw "no rows" error.
4. Build source label: `google-sheet:<sheetIdShort>…@<UTC stamp>`.
5. Pipe CSV through replaceGlobalMasterListFromCsvText / replaceEmployeeHourlyRatesFromCsv.
6. Insert audit log entry (csv.master.sync / csv.rates.sync, with diagnostic fields).
7. Return JSON with sheet stats + ingest stats + diagnostic counts.
```

Errors are caught and re-thrown as JSON with `success: false` and a descriptive message. The route also writes a `*.sync.error` audit log entry on failure.

---

## 4. Ingest pipeline behavior & guarantees

### Master list (`replaceGlobalMasterListFromCsvText`)

Input: a CSV text + a source label string. Output: `{ rowCount, uploadId, inserted, updated, rowsMissingPersonalEmail, duplicatesInCsv }`.

1. **Parse + validate** — `parseCsv` then `validateMasterListCsvLayout` (rows 1–2 contain `MASTERLIST`, row 3 has `Department` + `Name`/`Personal Email`).
2. **Filter empty rows** — drop fully-empty rows + rows where every mapped column is empty.
3. **Partition** rows into:
   - `dedupableRows` — has both `personal_email` AND `department`. Goes into the upsert flow.
   - `orphanRows` — missing one or both. Inserted every upload (no dedup).
4. **Dedupe within CSV** *(added 2026-05-07)* — collapse `dedupableRows` by `(LOWER(personal_email), LOWER(department))`. Last occurrence wins. Without this, duplicate identity rows in the same CSV both queue for INSERT and the second hits the partial unique index.
5. **Build `existingByKey`** — single full-table SELECT *(rewritten 2026-05-07 to be case-insensitive in memory; the previous chunked `.in('"Personal Email"', …)` lookup missed mixed-case DB rows from the legacy backfill, causing duplicate-key INSERT errors)*.
6. **Apply** — UPDATEs in parallel chunks of 20 *(added 2026-05-07; was sequential, ~3min for 700 rows; now ~5 sec)*. INSERTs in batches of 50.
7. **Promote** new upload to `is_current = true`.

### Rates (`replaceEmployeeHourlyRatesFromCsv`)

Input: CSV text + source label. Output: `{ rowCount, uploadId, inserted, updated, uniqueEmployees, skippedNoWorkEmail, skippedNoRate }`.

1. **Header lookup** — read only `Work Email`, `Personal Email`, `Week`, `Regular Rate`, `OT Rate`. All other columns (~54 of them on the All Dept sheet) are ignored.
2. **Per-employee dedup** — multiple weekly rows per `Work Email` are expected. Pick the one with the latest parsed `Week M/D/YY - M/D/YY`. Result: at most one row per work email.
3. **Build existing maps** — single full-table SELECT *(rewritten 2026-05-07 to mirror the master list fix)*. `existingByWorkEmail` + `existingByPersonalEmail` indexed case-insensitively.
4. **Apply** — UPDATEs in parallel chunks of 20 *(added 2026-05-07)*. INSERTs in batches of 50.
5. **Promote** new upload to `is_current = true`.

### Hubstaff (`replaceHubstaffHoursFromCsvText`) — unchanged this session

Append-only with `upload_id` stamp on every row. New upload promoted to current; old `upload_id` rows kept for history but excluded from current-payroll reads. No identity-key dedup (every row is its own data point).

---

## 5. Endpoints

### Master list

#### `POST /api/global-master-list`
CSV upload to `global_master_list` + archive. Multipart `file=<csv>`. Returns `{ success, rowCount, inserted, updated, rowsMissingPersonalEmail, duplicatesInCsv, uploadId, ratesReconcile }`.

#### `GET /api/global-master-list`
Without query string: returns `{ ok, masterCount, ratesCount }` for diagnostics.
With `?uploads=1` *(added 2026-05-07)*: returns `{ uploads: [{ id, source_file, uploaded_at, uploaded_by, row_count, is_current }], error }` ordered newest-first. Powers the Files tab → Master list section.

#### `POST /api/cron/sync-master-from-sheet` *(added 2026-05-07)*
Fetches the configured Google Sheet master list and pipes it through the same ingest as the CSV upload. GET also accepted (for legacy cron-style triggers, if any). Returns `{ success, sheetId, tabName, totalRows, dataRows, headerRowIndex, headerColumns, apiRowCount, rowCount, inserted, updated, rowsMissingPersonalEmail, duplicatesInCsv, uploadId }`. Emits `[fetch-master-sheet]` + `[sync-master-from-sheet] result` console diagnostics.

### Payroll rates

#### `POST /api/employee-hourly-rates-upload`
CSV upload to `employee_hourly_rates`. Multipart `file=<csv>`. Returns `{ success, rowCount, inserted, updated, uniqueEmployees, skippedNoWorkEmail, skippedNoRate, uploadId }`.

#### `GET /api/employee-hourly-rates-upload?uploads=1` *(added 2026-05-07)*
Returns `{ uploads: [...], error }` newest-first from `rates_uploads`. Powers the Files tab → Payroll rates section. Calling without `?uploads=1` returns 400 with a hint (the route doesn't expose any other GET behavior).

#### `POST /api/cron/sync-rates-from-sheet` *(added 2026-05-07)*
Fetches the configured rates Sheet and pipes it through the rates ingest. Returns `{ success, sheetId, tabName, totalRows, dataRows, ...rates-result-fields }`.

### Hubstaff

#### `POST /api/hubstaff-hours`, `GET ?source_files=1`, `GET ?source_file=<f>`, `DELETE ?source_file=<f>` — unchanged this session. See [api-reference.md](./api-reference.md).

---

## 6. Environment variables

```bash
# ── Supabase (always required) ──
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>   # required for every write path here

# ── Google service account (shared by both syncs) ──
GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL=<sa>@<project>.iam.gserviceaccount.com
# Paste the private_key field from the GCP service-account JSON, INCLUDING the
# leading/trailing -----BEGIN/END PRIVATE KEY-----. Literal `\n` is fine — code
# unescapes it. Vercel's multi-line value field also accepts real newlines.
GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMII…\n-----END PRIVATE KEY-----\n"

# ── Master list source ──
GOOGLE_SHEETS_MASTER_SHEET_ID=<the long string between /d/ and /edit in the sheet URL>
GOOGLE_SHEETS_MASTER_TAB_NAME=MASTERLIST          # case-sensitive; spaces preserved

# ── Rates source ──
GOOGLE_SHEETS_RATES_SHEET_ID=<rates sheet id>
GOOGLE_SHEETS_RATES_TAB_NAME=All Dept              # tab names with spaces are auto-quoted

# ── Optional auth gate on the sync endpoints ──
# When set, both /api/cron/sync-*-from-sheet endpoints require
#   Authorization: Bearer <CRON_SECRET>
# The in-app button does NOT send this header, so setting CRON_SECRET will break
# the manual button unless we also add session-based admin auth as an alternate
# path. Default: leave unset, button works, endpoint is open (mitigated by
# service-role gating downstream and audit logging).
CRON_SECRET=
```

**Vercel:** all six Google vars must be set on Vercel for production. Vercel does not auto-redeploy on env var changes — trigger a redeploy after editing.

---

## 7. Schema & history model

Two pairs of "data + archive" tables follow the same pattern (see [project_upload_archive_schema.md] in memory; migration ran 2026-04-22 + 2026-04-22 rates round):

| Data table | Archive table | What's tracked |
|---|---|---|
| `global_master_list` | `master_list_uploads` | `id, source_file, uploaded_at, uploaded_by, row_count, is_current` |
| `employee_hourly_rates` | `rates_uploads` | same shape |
| `hubstaff_hours` | `hubstaff_uploads` | same shape |

A partial unique index `WHERE is_current = TRUE` enforces "only one current upload" per archive table. Data rows carry `upload_id` (rates / hubstaff) or `first_seen_upload_id` + `last_seen_upload_id` (master list, to support active/inactive without hard-deleting offboarded staff).

The `active_employees` view filters `global_master_list` to rows where `last_seen_upload_id = (SELECT id FROM master_list_uploads WHERE is_current = TRUE)`. Rows missing from the new upload retain their old `last_seen_upload_id` and silently drop out of the view — no DELETE.

---

## 8. Audit log actions

Every sync (success OR failure) writes a row to `audit_log` with:

| Action | Resource | Details payload (selected fields) |
|---|---|---|
| `csv.master.upload` | `global_master_list` | `file, rows, inserted, updated, rows_missing_personal_email, duplicates_in_csv, upload_id` |
| `csv.master.sync` | `global_master_list` | adds `source: 'google-sheet', sheet_id, tab, sheet_total_rows, sheet_data_rows, sheet_header_row_index, sheet_header_columns` |
| `csv.master.sync.error` | `global_master_list` | `error: <message>` (always written on the failure path) |
| `csv.rates.upload` | `employee_hourly_rates` | `file, rows, inserted, updated, unique_employees, skipped_no_work_email, skipped_no_rate, upload_id` |
| `csv.rates.sync` | `employee_hourly_rates` | adds the same `source: 'google-sheet'` payload as master |
| `csv.rates.sync.error` | `employee_hourly_rates` | `error: <message>` |
| `csv.upload` | `hubstaff_hours` | `file, rows, upload_id` |
| `csv.delete` | `hubstaff_hours` | `file, rows_deleted` |

Every entry includes `user_name`, `user_role`, `ip_address`, and `created_at`. Sync entries use the synthetic system user `{ name: 'GSheets Sync', role: 'System' }`; CSV uploads use `{ name: 'Fran M', role: 'Senior Admin' }`.

---

## 9. Recent fixes & gotchas

### Master list ingest

- **Case-sensitivity** *(2026-05-07)*: existing-row lookup was case-sensitive on `personal_email`; mixed-case DB rows from the legacy backfill bypassed dedup → INSERT collisions. Fixed by switching to a single full-table SELECT and folding case in memory.
- **Within-CSV duplicates** *(2026-05-07)*: two rows in the same CSV with the same identity collided in the INSERT batch. Fixed by deduping `dedupableRows` by identity key before partition; last occurrence wins.
- **3-minute runtime** *(2026-05-07)*: sequential UPDATE loop. Fixed with parallel chunks of 20.
- **MASTERLIST sentinel synthesis** *(2026-05-07)*: Google Sheet sync prepends two synthetic `MASTERLIST` rows + auto-detects the real header row, so naturally laid out sheets work without manual sentinel rows in the sheet itself.

### Rates ingest

- **Same case-sensitivity + sequential UPDATE** issues as master *(2026-05-07)*. Fixed with parallel pattern.

### Rates page Department chip not displaying

- **Symptom** *(reported 2026-05-07)*: every Rates card showed an empty space where the Department chip belongs, even for employees with a real department on the master list.
- **Root cause**: `mergeSourcesDeduped([rates, master])` in `src/lib/supabase/employee-rate-profiles.ts` kept the first occurrence of each field key. The rates row has `Department: null` (the rates ingest never writes Department), so it claimed the key with a null value, and the master's actual department was silently dropped.
- **Fix**: `mergeSourcesDeduped` now skips `null`, `undefined`, and whitespace-only string values so later sources can fill gaps. Side benefit: same fix covers any other field where the rates row has null but master has data (Phone, Address, Organization, etc.).
- **Cache caveat**: `getEmployeeRateProfileSummaries` caches results for 60 seconds in module scope. After the fix, restart `npm run dev` (or wait 60s) before hard-refreshing the Rates page to see the corrected chip.

### Tab names with spaces

- The Sheets API treats `'My Tab'` (with single quotes) and `My Tab` differently in A1 notation. Both fetchers (`fetch-master-sheet.ts`, `fetch-rates-sheet.ts`) wrap the configured tab name in single quotes before URL-encoding, so spaces and punctuation in tab names work transparently.

### Diagnostic logs

The master + rates sync endpoints emit `[fetch-{master,rates}-sheet]` and `[sync-{master,rates}-from-sheet] result` console blocks with the full sheet/ingest stats. Useful when comparing "rows in sheet" vs "rows ingested" — see [the master list fix flow above](#master-list-ingest) for what each filter step drops.

### Path-naming oddity

The two sync endpoints live under `/api/cron/...` for backward-compat with the period when a Vercel cron called them. Cron is disabled. The path is purely cosmetic at this point; the routes accept both GET and POST so external schedulers can still trigger them if needed.
