# Hubstaff weekly auto-sync (n8n-scheduled cron)

Every Sunday at midnight America/New_York an n8n workflow POSTs
`/api/cron/sync-hubstaff-week`, which pulls the **just-completed Sun→Sat pay
week** (the batch payroll pays, one week in arrears) live from the Hubstaff
API and runs it through the exact same ingest pipeline as a manual CSV upload.

Built Jul 25, 2026.

> **Jul 29, 2026 — the manual path is gone.** The Payroll Wizard's "Sync from
> Hubstaff" button and the `action: "api_sync"` JSON branch on
> `POST /api/hubstaff-hours` were removed: Hubstaff's 1000 req/hour cap made an
> on-demand pull unreliable, so the wizard is CSV-upload only. This weekly cron
> is now the **only** live-API ingest path and is unaffected (one pull a week).

## Key files

| Piece | File |
| --- | --- |
| Shared sync pipeline + week math + error classifier | `src/lib/hubstaff/run-weekly-sync.ts` |
| Cron endpoint (GET/POST) | `app/api/cron/sync-hubstaff-week/route.ts` |
| CSV upload ingest (the wizard's only path) | `app/api/hubstaff-hours/route.ts` |
| n8n scheduler workflow (import me) | `references/n8n/hubstaff-weekly-auto-sync.workflow.json` |
| CSV rendering + deterministic batch filename | `src/lib/hubstaff/build-weekly-summary.ts` (`apiSyncFileName`) |
| Elevated-session fallback auth | `src/lib/auth/cron-auth.ts` (`cronSessionElevated`) |

## Sync pipeline — `runHubstaffWeeklySync()`

Lives apart from the route so the endpoint only parses the request and maps
thrown errors to HTTP statuses.

1. Validates the week is **strictly Sunday→Saturday, 7 days** (guards against
   reintroducing the legacy 8-day Sun→Sun overlap / dropped-Sunday bug);
   throws 503 if `HUBSTAFF_PAT` / `HUBSTAFF_ORG_ID` are unset.
2. `fetchDailyActivities` pulls the week's daily aggregates from the Hubstaff
   REST API; an empty week throws a tagged `no_data` (400).
3. `buildWeeklySummaryCsv` renders the SAME weekly-summary CSV a manual
   export produces; `replaceHubstaffHoursFromCsvText` archives it and
   promotes it to current. The filename is deterministic
   (`apiSyncFileName(weekStart, weekEnd)`), so a cron retry or manual re-run
   **replaces** the same batch instead of duplicating it — idempotent, no
   double pay/notify.
4. Audit-logs `hubstaff.api_sync`, then (best-effort, never fails the sync):
   - `notifyPayrollAvailable` — "Salary Ready to View" `payroll.available`
     notification per employee, de-duped per (recipient, source_file);
   - `recordMesaWeeklyContributions` — the weekly MESA ledger deposit per
     opted-in member, idempotent per member/week;
   - `seedMissingDisbursementRecords({ sourceFiles: [fileName] })` *(added
     2026-08-12, replacing the removed Reports-tab "Seed" button)* — seeds the
     new week's `disbursement_records`. A cron retry re-ingests the same
     filename and **re-seeds it**: estimates refresh from the (possibly
     corrected) hours, the seeder collapses to the preferred upload batch,
     paid state is preserved, and a partially-failed earlier seed heals.
     Non-weekly uploads are refused, and so is a file whose pay week is
     already seeded under a **different** filename — seeding both the cron's
     `_api_sync_` file and a manual export of the same week would double-count
     it in every money reader. `WeeklySyncResult` carries the row count as
     `seeded` (`null` = the seed failed).

So a cron run produces exactly what a manual CSV upload does: a current
`hubstaff_hours` batch, the payroll notifications, the MESA deposits, and the
week's seeded `disbursement_records`.

**`mostRecentlyCompletedPayWeek(now)`** — pure-UTC math returning the last
fully-completed Sun→Sat week. The cron fires early Sunday UTC, when the new
week has just begun, so the week worth syncing is the one that ended the day
before; an off-schedule midweek trigger degrades gracefully to the last
completed week.

**`classifySyncError(e)`** — maps a pipeline throw to the route's HTTP
answer: upstream Hubstaff failures (`.upstream`) become 429
(retryable) / 502; the pipeline's own tagged validation/config errors keep
their status; anything untagged is a genuine bug (500).

## The endpoint

`GET`/`POST /api/cron/sync-hubstaff-week` — fail-closed auth: requires
`Authorization: Bearer <CRON_SECRET>` (401 if the env var is unset or the
header mismatches), OR an elevated in-app session (`cronSessionElevated`) so
an admin can trigger it manually from the app.

- `?weekStart=YYYY-MM-DD` (must be a Sunday) overrides the auto-computed week
  — for backfilling a missed week.
- A week with no tracked time answers **HTTP 200** with
  `{ success: false, skipped: true, reason: "no_data" }` — not a failure, but
  warned loudly in the logs.
- `maxDuration = 300` (the Hubstaff pull paginates with gaps + retry backoff;
  drop to 60 on a Vercel Hobby plan).
- Success returns `{ success, weekStart, weekEnd, fileName, members, rows,
  uploadId, notified, mesaRecorded }`.

## Scheduling is n8n, NOT vercel.json — deliberately

`vercel.json` **intentionally omits** this cron (its `crons` list only the
scheduled-deletions and scheduled-transfers jobs). Vercel Cron is UTC-only —
a fixed UTC hour drifts an hour across DST. The n8n workflow's Schedule
Trigger fires `0 0 * * 0` with `settings.timezone: "America/New_York"`, so it
stays true midnight ET through the spring/fall changes, and its failure
branch is a ready-made hook for a Slack/email alert. n8n is only the
trigger — the HRIS does all the work; do not reimplement the Hubstaff pull in
n8n. (The route's header comment still mentions a Vercel cron — that
predates the n8n decision; the schedule lives in n8n only.)

## Deploy steps

1. Env on the HRIS deployment: `HUBSTAFF_PAT`, `HUBSTAFF_ORG_ID`, and a
   `CRON_SECRET`.
2. Import `references/n8n/hubstaff-weekly-auto-sync.workflow.json` into n8n.
3. In the "Trigger HRIS Sync" node, replace `YOUR-HRIS-DOMAIN` with the
   production host and `YOUR_CRON_SECRET` with the same value as the HRIS
   `CRON_SECRET` (better: swap the inline header for an n8n Header Auth
   credential).
4. Optionally wire the "Sync Failed" NoOp node to a Slack/email alert so a
   failed Sunday sync pings someone.
5. Activate the workflow (it ships `active: false`).

No migration — the sync writes through the existing upload pipeline.
