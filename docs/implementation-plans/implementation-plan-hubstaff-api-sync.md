# Implementation Plan: Hubstaff API Sync

> **Goal**: Replace the manual weekly CSV export/upload workflow with a "Sync from Hubstaff" button that calls the Hubstaff REST API v2 directly, pulling the same weekly hours data into the existing `hubstaff_hours` pipeline without changing the downstream payroll flow.

---

## 1. Current State

| Area | Status |
|---|---|
| Hours import | Manual: admin downloads a weekly CSV from Hubstaff app, uploads via the Payroll Wizard UI |
| Hubstaff API usage | None. Zero direct API calls exist in the codebase. |
| Hubstaff invite | n8n webhook fires on hire promote — one-way push only, no data pull |
| Data shape | Weekly summary per employee: Mon–Sun day columns + `Total worked` |
| Known pain points | Manual download/upload step is error-prone; Sunday overlap issue (documented separately); dedup relies on SHA-256 of file contents — no file, no dedup |

---

## 2. User Stories

1. **Sync hours without downloading a file** — Admin clicks "Sync from Hubstaff" in the Payroll Wizard, enters the week range, and the system fetches and loads hours automatically.
2. **Keep CSV upload as fallback** — If the API is unavailable or credentials are not configured, the CSV upload path still works exactly as before.
3. **See sync provenance** — The `hubstaff_uploads` archive records whether a batch came from a CSV upload or an API sync, so Accounting can audit the source.
4. **Error feedback** — If the sync fails (bad token, no data for the week, rate limit), the admin sees a clear message rather than a silent empty import.

---

## 3. Prerequisites

| Requirement | Notes |
|---|---|
| `HUBSTAFF_PAT` env var | Personal Access Token from Hubstaff account settings (Settings → Access Tokens). Server-side only — never exposed to the client. |
| `HUBSTAFF_ORG_ID` env var | Numeric organization ID from the Hubstaff URL or API. |
| Hubstaff plan | PAT + time entries API is available on all paid Hubstaff plans. Webhooks (not used here) require Business tier. |
| No DB migrations needed | The existing `hubstaff_hours` + `hubstaff_uploads` schema is unchanged. |

Add both vars to `.env.local` and Vercel project settings:

```
HUBSTAFF_PAT=your_personal_access_token_here
HUBSTAFF_ORG_ID=123456
```

---

## 4. Hubstaff API Overview

Base URL: `https://api.hubstaff.com`  
Auth header: `Authorization: Bearer <HUBSTAFF_PAT>`  
All dates: ISO 8601 UTC.

### 4.1 Endpoints Used

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/organizations/{org_id}/members` | GET | Fetch all org members — maps `user_id` to email + name |
| `/v2/organizations/{org_id}/time_entries` | GET | Fetch raw time entries for a date range |

### 4.2 Members Response Shape

```json
{
  "members": [
    {
      "user_id": 11111,
      "name": "Jane Doe",
      "email": "jane@simple.biz"
    }
  ]
}
```

### 4.3 Time Entries Request

```
GET /v2/organizations/{org_id}/time_entries
  ?date_start=2026-06-09
  &date_stop=2026-06-15
  &page_size=500
  &page_start_id=<cursor>   // for pagination
```

### 4.4 Time Entries Response Shape

```json
{
  "time_entries": [
    {
      "id": 999,
      "user_id": 11111,
      "starts_at": "2026-06-09T09:00:00Z",
      "stops_at": "2026-06-09T17:30:00Z",
      "tracked": 30600
    }
  ],
  "pagination": {
    "next_page_start_id": 998
  }
}
```

`tracked` is total seconds for that entry. Multiple entries can exist per user per day.

---

## 5. Data Mapping: API Entries → DB Row Shape

The existing `hubstaff_hours` table stores one row per employee per week, with ISO-date columns for each day (`2026-06-09`, `2026-06-10`, ...) plus `Total worked` in `HH:MM:SS`.

### Aggregation Logic

```
for each time_entry:
  user = members[entry.user_id]
  date = toManilaDate(entry.starts_at)   // convert UTC → Asia/Manila before bucketing
  dailySeconds[user.email][date] += entry.tracked

for each user email:
  totalSeconds = sum(dailySeconds[email])
  row = {
    Member:        user.name,
    Email:         user.email,
    "Total worked": toHHMMSS(totalSeconds),
    [monday_iso]:   toHHMMSS(dailySeconds[email][monday] ?? 0),
    [tuesday_iso]:  toHHMMSS(dailySeconds[email][tuesday] ?? 0),
    ...
    [sunday_iso]:   toHHMMSS(dailySeconds[email][sunday] ?? 0),
    source_origin: "api"   // new provenance field
  }
```

### Timezone Note

Hubstaff timestamps are UTC. Employees work in Manila (UTC+8). A session that starts at 23:00 UTC on Monday is 07:00 Tuesday Manila time. All day-bucketing **must** use the Manila local date, not the UTC date — matching what the CSV export already does.

### Sunday Overlap

The existing Sunday overlap issue (documented in `docs/notes/hubstaff-sunday-overlap.md`) does not apply to the API path: we request an exact 7-day window (Mon–Sun) and aggregate by Manila date, so there is no leading/trailing Sunday ambiguity. Note this in the upload archive so ops can tell which batches used which method.

---

## 6. New Files

### 6.1 `src/lib/hubstaff/api-client.ts`

Thin HTTP client. Handles auth header, pagination, and rate-limit retries.

```typescript
// Key exports:
fetchHubstaffMembers(orgId: string, pat: string): Promise<HubstaffMember[]>
fetchHubstaffTimeEntries(orgId: string, pat: string, dateStart: string, dateStop: string): Promise<HubstaffTimeEntry[]>
```

Pagination: follow `pagination.next_page_start_id` until the field is absent. No page has more than 500 entries.

Rate limits: Hubstaff v2 is 1000 req/hour. A full week sync is 2 requests (members + entries). No throttling needed.

### 6.2 `src/lib/hubstaff/build-weekly-summary.ts`

Pure function — no I/O. Converts raw members + entries into the same row array that the CSV parser currently produces.

```typescript
// Key export:
buildWeeklySummaryRows(
  members: HubstaffMember[],
  entries: HubstaffTimeEntry[],
  weekStart: string,   // "YYYY-MM-DD" Monday
  weekEnd: string      // "YYYY-MM-DD" Sunday
): HubstaffHoursRow[]
```

This function can be unit-tested in isolation with fixture data.

---

## 7. API Route Changes

### 7.1 Existing Route: `app/api/hubstaff-hours/route.ts`

Add a new action to the existing POST handler — or add a dedicated sub-route `POST /api/hubstaff-hours/sync`.

**Preferred**: add `action=api_sync` to the existing POST to keep all hubstaff-hours mutations in one place.

**Request body** (JSON, not FormData):

```json
{
  "action": "api_sync",
  "weekStart": "2026-06-09",
  "weekEnd": "2026-06-15",
  "uploaded_by": "admin@simple.biz"
}
```

**Server-side flow**:

1. Read `HUBSTAFF_PAT` + `HUBSTAFF_ORG_ID` from `process.env` — return `503` if either is missing.
2. Call `fetchHubstaffMembers` → `fetchHubstaffTimeEntries`.
3. Call `buildWeeklySummaryRows` → rows.
4. If `rows.length === 0` → return `400 { error: "No time entries found for this week" }`.
5. Call the existing `replaceHubstaffHoursFromRows(rows, fileName, uploadedBy)` (refactored from `replaceHubstaffHoursFromCsvText`) to insert into DB.
6. Return the same shape as the CSV upload response.

**`source_file` naming convention for API syncs**:

```
simple-biz_api_sync_2026-06-09_to_2026-06-15.json
```

This fits the existing filename-based period parser and distinguishes API batches from CSV batches in the archive.

### 7.2 Refactor: `src/lib/supabase/hubstaff-hours-db.ts`

Extract the DB-insert logic from `replaceHubstaffHoursFromCsvText` into a shared `replaceHubstaffHoursFromRows(rows, fileName, uploadedBy)` function that both code paths (CSV and API) call. The CSV parser becomes a thin adapter that parses CSV → rows then calls the shared function.

---

## 8. UI Changes

### 8.1 Payroll Wizard — Upload Step

Add a "Sync from Hubstaff" button alongside the existing file input. Both lead to the same downstream state.

**Behavior**:

- Button is only shown if `NEXT_PUBLIC_HUBSTAFF_API_ENABLED=true` (set in env — avoids showing a broken button to instances without credentials).
- Clicking opens a small inline date-range picker (Mon → Sun, defaults to the most recent full week).
- "Sync" triggers `POST /api/hubstaff-hours` with `action: "api_sync"`.
- Loading state replaces the button with a spinner + "Fetching from Hubstaff…".
- On success: same toast + table refresh as the CSV upload path.
- On error: inline error message beneath the button (e.g., "No data found for this week", "API credentials not configured").

**CSV upload is not removed** — it stays as the fallback and for backfill.

### 8.2 Upload Archive Panel

Add a "Source" column to the upload history table showing `CSV` or `API Sync` based on whether the `source_file` contains `_api_sync_`.

---

## 9. Implementation Phases

### Phase 1 — API Client + Data Builder

- [ ] Create `src/lib/hubstaff/api-client.ts` with `fetchHubstaffMembers` + `fetchHubstaffTimeEntries` (paginated)
- [ ] Create `src/lib/hubstaff/build-weekly-summary.ts` with `buildWeeklySummaryRows`
- [ ] Add Manila-timezone day bucketing utility (reuse or extend existing date helpers)
- [ ] Write unit tests with fixture data covering: multi-entry same day, UTC midnight boundary, employee with zero hours

### Phase 2 — DB Refactor + API Route

- [ ] Refactor `replaceHubstaffHoursFromCsvText` → extract shared `replaceHubstaffHoursFromRows` in `hubstaff-hours-db.ts`
- [ ] Add `action=api_sync` branch to `POST /api/hubstaff-hours/route.ts`
- [ ] Add `source_origin` column to `hubstaff_uploads` (optional — can also infer from filename pattern)
- [ ] Smoke test: hit the new route with `weekStart`/`weekEnd`, verify rows in DB match a known CSV for the same week

### Phase 3 — UI

- [ ] Add `NEXT_PUBLIC_HUBSTAFF_API_ENABLED` env var + conditional render in the upload step
- [ ] Build the "Sync from Hubstaff" button + date-range picker in `PayrollWizard.tsx`
- [ ] Add loading / error / success states
- [ ] Add "Source" column to upload archive panel
- [ ] Test: run a sync for the current week, verify the Payroll Wizard table renders identically to what the CSV upload produces

### Phase 4 — Hardening

- [ ] Handle Hubstaff API errors gracefully: 401 (bad token), 404 (bad org ID), 429 (rate limit), 500
- [ ] Log sync events to the server console with duration + row count (for Vercel log monitoring)
- [ ] Add the two env vars to the deployment checklist / README
- [ ] Verify Vercel region `sin1` is still set — API calls to Hubstaff from `iad1` add unnecessary latency

---

## 10. Key Design Decisions

| Decision | Rationale |
|---|---|
| **CSV upload stays as fallback** | API credentials may not be configured on all environments (local dev, staging). Removing CSV breaks those workflows. |
| **No schema changes** | The `hubstaff_hours` row shape already accommodates ISO-date day columns. The API path populates the same columns. |
| **Manila timezone bucketing** | The CSV export already buckets by local Manila date. The API path must match or pay summaries will differ by up to 8 hours near midnight. |
| **Single POST route, `action` field** | Keeps all hubstaff-hours mutations in one route file and one audit trail. Avoids a parallel `/sync` route that duplicates auth/validation logic. |
| **PAT over OAuth** | OAuth requires a registered app and user-consent flow. A PAT is simpler, already available, and sufficient for a server-side cron/admin action. Rotate via Hubstaff account settings if compromised. |
| **`source_file` naming encodes method** | `_api_sync_` in the filename lets the archive display and period parser distinguish batches without a new DB column. |
| **`NEXT_PUBLIC_HUBSTAFF_API_ENABLED` flag** | Decouples credential deployment from code deployment. The button stays hidden on environments without credentials rather than showing and erroring. |

---

## 11. Out of Scope

- **Real-time / webhook tracking** — Hubstaff webhooks (Business plan) can push start/stop events. This plan covers on-demand weekly pulls only. Webhooks would require a schema redesign to store per-entry data and are a separate feature.
- **Project-level breakdown** — The API returns `project_id` on each entry. This plan ignores it to match the CSV shape. A future enhancement could add a project breakdown column.
- **Automated scheduled sync** — A cron job that auto-syncs every night is not included here. The button is manual-trigger. Scheduling can be layered on top via the existing cron infrastructure once the API client is stable.
- **Member invite via API** — The n8n Hubstaff invite webhook is unchanged.
