# Offboarding Automation (Queue + n8n)

End-to-end pipeline for taking someone off the roster: a **manager flags team members**, the
requests land in the **HR offboarding queue**, HR **processes them one-by-one**, and on offboard
the app both **tears down the person's Workspace/Hubstaff account via n8n** and **revokes every
RBAC grant** (snapshotted so re-onboarding restores it).

> Resignation is one of the on-ramps into this same queue. A self-service resignation
> (**Profile → Resign → manager approval**) drops the approved person into the offboarding queue
> exactly like a manager-raised request — see the resignation flow rather than re-reading it here.

Key files:

- `app/api/offboarding-queue/route.ts` — manager submits selections → queue; HR lists/processes.
- `src/lib/supabase/offboarding-queue.ts` — queue table read/write helpers.
- `app/api/hr/offboard/route.ts` — the actual offboard (single **or** batch), fires teardown webhooks.
- `src/lib/hr/offboard-webhooks.ts` — slugs, URL resolution, `fireOffboardWebhook`.
- `src/lib/hr/offboard-rbac.ts` — snapshot / revoke / restore RBAC grants.
- `app/api/cron/process-scheduled-deletions/route.ts` — legacy drain: fires the delayed delete for
  rows stamped with `scheduled_deletion_at` before the 2026-08-07 routing change (new offboards
  never set it).

---

## Pipeline

```
Manager · My Team  ── multi-select teammates ──▶ POST /api/offboarding-queue
        │                                              │
        │                                              ├─ scope check (dept-manager only)
        │                                              ├─ skip anyone already in-flight
        │                                              ├─ insert into offboarding_queue
        │                                              ├─ notify HR+admins (employee_notifications)
        │                                              └─ n8n: manager-offboard-notify (COUNT only)
        ▼
HR offboarding queue  ── HR processes one-by-one ──▶ POST /api/hr/offboard
        │                                              │
        │                                              ├─ stamp off_boarded_* on every active
        │                                              │  global_master_list row
        │                                              ├─ snapshot + revoke ALL RBAC grants
        │                                              ├─ force-logout live sessions
        │                                              ├─ insert offboarded_sheet + Google Sheet
        │                                              └─ n8n: offboarding_delete (EVERY offboard,
        │                                                 any reason) · offboarding_deactivate only
        ▼                                                 for temporary_pause (suspend, never delete)
(legacy only) daily cron /api/cron/process-scheduled-deletions drains rows whose
scheduled_deletion_at was stamped before 2026-08-07 ──▶ n8n: offboarding_delete
```

---

## 1 · Manager raises requests → the queue

A department manager multi-selects teammates in **My Team** and submits. `POST /api/offboarding-queue`
(gated by `requireFeatureEdit`; managers can only offboard people in departments they manage — enforced
via `listDepartmentsForManager` + `departmentMatchesManagedAssignments`):

- **Rejects `temporary_pause`.** Everything in this queue rides the DELETE pathway when HR
  processes it, so a Temporary Pause (a suspension) is a 400 here — that's the manager Suspend
  button's job (`isQueueableOffboardReason` in `offboard-reasons.ts` is the shared gate).
- **De-dupes in-flight work.** Anyone already holding a pending/processing queue row is skipped
  (`findEmailsWithActiveOffboarding`); the response reports `inserted` vs `skipped`.
- **Inserts** the survivors into the `offboarding_queue` table (`insertOffboardingQueueEntries`),
  stamped with `requested_by` / `requested_by_name`.
- **Notifies HR + admins in-app** by inserting `employee_notifications` rows
  (`type: 'offboarding.requested'`) to everyone holding the `hr_coordinator` / `admin` role. This
  notification *does* include names / a preview (it's internal HR tooling).
- **Fires the manager-offboard n8n notification** (see below) — count only, no names.

HR later reads the whole queue (GET on the same route returns every row for HR/admin; a manager
sees only their own raised requests) and works it **one entry at a time** through the offboard
endpoint.

---

## 2 · HR offboards → account teardown + RBAC revoke

`POST /api/hr/offboard` (gated by `requireFeatureEdit("hr", "offboarding")`) accepts **either** shape:

```jsonc
// single (back-compat)
{ "work_email": "...", "reason": "resigned", "note": "..." }
// batch — a batch body wins if present
{ "employees": [ { "work_email": "...", "reason": "...", "note": "..." }, ... ] }
```

For each person (`offboardOnePerson`, run in parallel, sharing one batch timestamp):

1. **Stamp `global_master_list`.** Sets `off_boarded_at`, `off_boarded_reason`, `off_boarded_by`,
   `off_boarded_note` on **every** still-active row for that work email (covers dual-role employees
   with multiple rows) and **clears** `scheduled_deletion_at` / `deletion_processed_at` —
   `scheduled_deletion_at` is never stamped anymore (retired 2026-08-07). Rows already off-boarded
   are not re-stamped, with ONE exception: a **temporary-pause suspension being escalated to a real
   offboard** (see pathway routing below) is re-stamped with the new reason/date.
2. **Revoke ALL RBAC + force-logout.** `snapshotAndRevokeRbacGrants(work_email)` (below), then
   `bumpForceLogoutFor(work_email)` kills any live JWT session so a stale token can't stay privileged.
3. **Side-effects (best-effort, non-blocking):** insert into `offboarded_sheet`, append the row to
   the Google "Offboarded" sheet, and cancel any pending hires in `hr_pending_employees`.
4. **Audit:** `insertAuditLog({ action: "hr.employee.offboarded", ... })`.

### Pathway routing (2026-08-07 — delete vs suspend, nothing department-aware)

- **Every offboard, ANY reason, ANY department** → phase `delete`, `deletion_mode: "immediate"`,
  fires `offboarding_delete` right away. No timer, no 14-day deferral — the n8n delete-button
  pathway IS the offboard automation. `scheduled_deletion_at` is never stamped anymore.
- **Reason `temporary_pause`** (the only exception) → phase `deactivate`, `deletion_mode: "none"`,
  fires `offboarding_deactivate` (suspend only) and stamps **no** `scheduled_deletion_at` — the
  account is suspended but never deleted. Intended for approved time-off; the person returns via
  re-onboarding (which restores the RBAC snapshot and clears the off-boarded stamps). The
  Manager → My Team **Suspend** button rides this same flow via its own `manager_suspend` slug
  (see `src/lib/hr/manager-temp-pause-webhooks.ts`) — so the deactivate flow is now exclusively
  the suspend/temporary pathway.
- **`temporary_pause` never enters the manager offboard pathway** (2026-08-10). The manager
  Offboard action (Cards/List → queue → HR processor) always means DELETE, whatever the reason —
  so `temporary_pause` is greyed out in the manager dialog, **rejected server-side** at
  `POST /api/offboarding-queue` (`isQueueableOffboardReason`), excluded from the HR queue
  processor's editable reason dropdown (legacy-seeded pauses coerce to unset), and rejected by the
  queue-completion PATCH. Suspensions belong to the Suspend button (`manager_suspend`) or HR's own
  Offboard dialog.
- **Escalation: offboarding someone who is currently suspended** (2026-08-10). A person off-boarded
  earlier with `temporary_pause` still has a live (suspended) account, so a later real offboard
  must not vanish: when the guarded stamp UPDATE matches zero active rows,
  `classifyZeroStampOffboard` (`src/lib/hr/offboard-escalation.ts`) checks the existing stamps —
  temporary-pause rows are **re-stamped with the new reason/date and ride the delete pathway**
  (`offboarding_delete` fires; audit row carries `escalated_from_temporary_pause: true`). A person
  already off-boarded with a **real** reason stays a hard no-op (409): the delete automation
  already ran, and re-firing it would send duplicate teardown/termination emails. Applying a
  Temporary Pause to an already-offboarded person is also rejected (409).

> Before 2026-08-07 the teardown was department-aware: only all-Lead-Gen people deleted
> immediately; everyone else got `offboarding_deactivate` + a 14-day `scheduled_deletion_at` timer
> for the cron. That deferral is retired — the cron remains only to drain rows stamped before the
> change.

### RBAC snapshot / restore (`offboard-rbac.ts`)

Revoking covers **three tables**, all soft-deleted via `revoked_at`:

| Table | Keyed by | Grant |
|---|---|---|
| `employee_roles` | `work_email` | role |
| `department_managers` | `manager_email` | department |
| `employee_feature_permissions` | `work_email` | `(view_key, feature, access)` |

Before revoking, the active grants are snapshotted to **`app_settings` under the key
`offboard.rbac.<email>`** as JSON (`{ email, snapshot_at, roles[], departments[], features[] }`).
Re-onboarding the same person calls `restoreRbacGrants`, which reads that snapshot, re-grants each
row (un-revoke-or-insert, idempotent), and deletes the snapshot key. If the person held no active
grants, an existing snapshot is preserved (a double-offboard can't clobber a good record with an
empty one).

---

## n8n automation

All three offboarding webhook URLs resolve through the **Admin → Webhooks** slug registry
(`resolveWebhookUrl`), so endpoints can be rotated from the UI without a redeploy; each also has an
env-var override and a hard-coded default. `fireOffboardWebhook` never throws (the DB write is the
source of truth) and uses a 25s timeout.

| Slug | Default endpoint | Fired by |
|---|---|---|
| `manager_offboard_notify` | `.../webhook/manager-offboard-notify` | manager submits to the queue |
| `offboarding_deactivate` | `.../webhook/offboarding-deactivate` | suspend/temp-pause ONLY (`temporary_pause` reason; Manager Suspend rides the same flow via `manager_suspend`) |
| `offboarding_delete` | `.../webhook/offboarding-delete` | EVERY offboard, any reason/department (plus the legacy cron draining pre-2026-08-07 timers) |

### Manager-offboard notify (count only → alissar@simple.biz)

When a manager submits to the queue, `/api/offboarding-queue` fires `manager_offboard_notify`
(`MANAGER_OFFBOARD_NOTIFY_SLUG`) best-effort. The n8n flow emails **alissar@simple.biz the COUNT
only — no names, no PII**:

```jsonc
{
  "event": "manager.offboarding.requested",
  "count": 3,                         // actual rows inserted this submission
  "manager": "Jane Manager",          // display name, falls back to email
  "manager_email": "jane@simple.biz",
  "requested_at": "2026-07-07T..Z"
}
```

### Offboard teardown payload (multi-employee)

`/api/hr/offboard` coalesces a batch **by (phase, deletion_mode)** and fires **at most two**
POSTs (`delete` with `deletion_mode: "immediate"` for every real offboard, and temporary-pause
`deactivate` with `deletion_mode: "none"`), each carrying an `employees[]` array. The exact
envelope emitted (`app/api/hr/offboard/route.ts`):

```jsonc
{
  "event": "employee.offboarded",
  "phase": "delete",                  // "deactivate" only for temporary_pause
  "deletion_mode": "immediate",       // "none" for temporary_pause
  "hubstaff_pay_rate": 0,
  "off_boarded_by": "hr@simple.biz",  // actor; REQUIRED (see gotchas)
  "off_boarded_at": "2026-07-07T..Z",
  "count": 2,
  "employees": [
    {
      "work_email": "...",
      "personal_email": "...",
      "name": "...",
      "departments": ["..."],
      "start_date": "...",
      "reason": "resigned",
      "note": null,
      "off_boarded_by": "hr@simple.biz",  // duplicated per-item on purpose
      "off_boarded_at": "2026-07-07T..Z",
      "scheduled_deletion_at": null       // never stamped anymore
    }
  ]
}
```

`off_boarded_by` / `off_boarded_at` are duplicated onto each `employees[]` item so that after n8n's
**Split Out** on `employees`, the per-person email node is self-contained and doesn't have to reach
back to the parent envelope.

> The **legacy delayed cron** (`process-scheduled-deletions`) fires a *slightly* different `delete`
> payload keyed on `work_email` (`deletion_mode: "delayed_14d"`, `scheduled: true`) — it processes
> due rows one at a time rather than an `employees[]` batch. Only rows whose
> `scheduled_deletion_at` was stamped before 2026-08-07 can appear there.

### n8n gotchas (see the n8n webhook-gotchas note)

- **`off_boarded_by` is mandatory.** A run that arrived without it was flagged invalid by the n8n
  flow; the envelope now always sends it (and duplicates it per employee).
- **`count` must be in the payload.** Both the manager-notify email and the teardown flows read
  `count` directly; don't rely on `employees.length` downstream.
- **Split Out on `employees`.** The teardown flows fan out the `employees[]` array; a single-person
  offboard still sends a 1-element array so the same Split Out node handles both.
- Gmail expands every `{{ }}`; keep template expressions off any free-text `note`.

---

## 2026-07 updates

Four changes landed in July 2026 — two new reasons, an explicit no-show teardown, and a fix for the
Google "Offboarded" sheet writer that had been leaving key columns blank.

### Temporary Pause reason (suspend-only, 2026-07-15)

`temporary_pause` (**"Temporary Pause"**) was added to the shared reason set for employees who
request approved time off and are expected back. It reuses the **existing**
`offboarding_deactivate` n8n automation (Workspace account suspension) but changes the teardown
plan: phase is always `deactivate` (even for all-Lead-Gen people, who would otherwise be deleted
immediately), `deletion_mode` is `"none"`, and `scheduled_deletion_at` stays **null** — so the
daily deletion cron never touches the row and the account is suspended, not deleted. Temporary
pauses are coalesced into their **own** deactivate envelope (`deletion_mode: "none"`, per-employee
`reason: "temporary_pause"`) so the n8n flow can branch — e.g. skip the termination email for a
pause. Bringing the person back is the normal re-onboard flow (`/api/hr/reonboard`), which clears
the off-boarded stamps and restores the RBAC snapshot; unsuspending the Workspace account itself
happens on the n8n/Workspace side.

Heads-up: the Google "Offboarded" sheet's Reason column is a data-validation dropdown of human
labels — **"Temporary Pause" must be added to that dropdown** or the best-effort sheet append will
fail validation for paused people.

### NCNS reason

`ncns` (**"NCNS (No Call, No Show)"** in the dialog, short label **"NCNS"**) was added at the **top**
of the offboarding reason dropdown. The reason set lives in **two hand-synced places** — there is no
DB `CHECK` constraint enforcing it:

- [offboard-reasons.ts](src/lib/hr/offboard-reasons.ts) — `VALID_OFFBOARD_REASONS` (shared by the HR
  Offboard dialog, the manager queue dialog, and the HR queue processor), `OFFBOARD_REASON_OPTIONS`
  (dropdown value+label), and `OFFBOARD_REASON_LABELS` / `offboardReasonLabel()` (slug → display label).
- [route.ts](app/api/hr/offboard/route.ts) — the server keeps its **own** `VALID_REASONS` copy
  authoritative for validation; its doc-comment notes it MUST stay in sync with the shared list. A
  body whose `reason` isn't in the list is rejected 400 before any write.

### Manager "Did not attend" fires the same teardown

Marking a pending hire **Did not attend** (a no-show) in the manager's Newly Hired panel already runs
the *same* offboarding webhooks HR uses — [no-show/route.ts](app/api/manager/pending-hires/[id]/no-show/route.ts)
fires `offboarding_delete` (every offboard rides the delete pathway since 2026-08-07, no matter the
department) keyed on the pending row's
`work_email`, with **`never_promoted: true`**, `event: "hire.no_show"`, and a defaulted
**`reason: "ncns"`** — a "did not attend orientation" no-show is by definition a No-Call-No-Show, so
the payload carries the same canonical `reason` key HR sends from the Offboard dialog, giving the n8n
automation something to branch on. Because the Hubstaff invite
only fires at **promote**, `never_promoted:true` tells n8n the Hubstaff removal step is a no-op for a
hire who never had a seat — Hubstaff is a step *inside* the webhook flow, not a guaranteed per-hire
effect here. When the pending row has **no** `work_email` yet, nothing is torn down — the row is just
flipped to `no_show`. Every no-show stamps `deletion_processed_at` immediately; the 14-day
`scheduled_deletion_at` timer is no longer set.

The warning copy is now explicit that this is a real offboard:
[NewlyHiredPanel.tsx](src/components/manager/NewlyHiredPanel.tsx) both the button tooltip, the panel
intro, and the confirm dialog spell out "same offboarding webhook HR uses — Workspace account removed,
access revoked. Cannot be undone," and the toast/dialog branch on `work_email` so a hire with no
account reads "recorded as a no-show only."

### Offboarded-tab sheet writer fixed

The Google "Offboarded" tab append had been writing **blank** Location / Start Date / Reason /
Offboarded Date cells. The fix spans three files:

- **Offboard route enriches the row.** [route.ts](app/api/hr/offboard/route.ts) now `select`s
  `city, province, full_address, "Location", "Phone Number"` on the stamped rows and builds a
  `location` string mirroring AdminGlobalMasterList — `"City, Province"`, falling back to the seeded
  `full_address`, then the onboarding-form `"Location"` string. Phone comes straight off the master
  row. These are **sheet-only enrichment** — the `offboarded_sheet` DB table ignores them.
- **Shared alias-map matcher.** [append-offboarded-sheet.ts](src/lib/google-sheets/append-offboarded-sheet.ts)
  replaced ad-hoc header detection with `HEADER_ALIASES` (a `FieldKey → alias[]` map, mirroring the
  reader in `fetch-offboarded-sheet.ts`) and an exported `fieldForHeader(header)` that does an exact
  match after `norm()`. Exporting it means the reader, writer, and backfill can't drift on which
  column is which.
- **Reason writes the LABEL, not the slug.** The append path is handed `offboardReasonLabel(reason)`
  (e.g. `"Resigned"`) because the sheet's "Offboard Reason" column is a data-validation dropdown of
  human labels — the raw enum slug (`resigned`) failed validation. The `offboarded_sheet` DB row keeps
  the slug, consistent with `off_boarded_reason` on the master.

**Dormant backfill endpoint.** [offboard-sheet-backfill/route.ts](app/api/hr/offboard-sheet-backfill/route.ts)
(`POST /api/hr/offboard-sheet-backfill`, gated by `requireFeatureEdit("hr", "offboarding")`) fills the
blank Location / Contact Number / Start Date / Offboard Reason / Offboarded Date cells from the master
record, matched on personal-then-work email. It **only** touches blank cells (never clobbers a
hand-typed value) and is **dry-run by default** — pass `{ "apply": true }` to actually write.
[backfill-offboarded-sheet.ts](src/lib/google-sheets/backfill-offboarded-sheet.ts) does the walk and
reuses the same `fieldForHeader` / `formatOffboardDate` helpers. A real run writes an
`hr.offboarded_sheet.backfilled` audit row.

---

## The merged Offboarded tab + `origin` (2026-08-28)

HR → Offboarding had **four** tabs: Overview, Queue, *Offboarded by HRIS*, *Offboarded*. The last two
now sit in one list with an **Origin** column, plus an origin filter — `All` / `HRIS` / `Google Sheet`.

**They were never two populations.** "Offboarded by HRIS" read completed `offboarding_queue` rows;
"Offboarded" read the `offboarded_sheet` ledger. But `/api/hr/offboard` writes **both**, so every one
of the 488 completed queue rows already existed in the ledger — measured 2026-08-28, the overlap is
488/488. The HRIS tab contributed **zero** additional people; the split was presentational. So the
merge is a **rename and a column**, not a union: the tab lists `offboarded_sheet` (the superset) and
consults the queue for one thing only — see *what the queue still owns* below.

### Where `origin` comes from

A stored column, `offboarded_sheet.origin`, `NOT NULL DEFAULT 'hris'`, CHECK-constrained to
`('hris','google_sheet')` — migration `references/sql/migrate/2026-08-28_offboarded_sheet_origin.sql`,
applied by `scripts/apply-offboarded-origin-migration.mjs` (`--dry` rehearses in a transaction it
rolls back; `--verify` re-checks). Backfilled from the split the live data already implied:

| | rows | `synced_at` |
|---|---|---|
| `off_boarded_by IS NOT NULL` → `hris` | 491 | all 2026-07 / 2026-08 |
| `off_boarded_by IS NULL` → `google_sheet` | 3,354 | all 2026-06 |

Two independent signals agreeing perfectly, because the sheet intake was retired 2026-08-07: every
row written since carries the HR actor who pressed the button, every row before it is the last
snapshot the sync took (2026-06-09).

**It had to be stored, not derived.** Both signals are accidents of that history — `off_boarded_by`
is nullable, and `synced_at` says when a row was *written*, never where it came from. The JSON import
below breaks the heuristic by construction: an imported row is written today with no actor, which the
old rule reads as "modern HRIS row with a missing actor". Provenance was captured once, while the
accident still told the truth.

An origin the column cannot answer renders as an amber **Unknown** chip and is counted separately —
never folded into either side, because a confident wrong answer to "which system recorded this
departure" is worse than an honest blank.

### What the queue still owns

Deleting a completed manager *request* was only ever reachable from the "Offboarded by HRIS" tab (the
Queue tab filters completed rows out). Merging must not silently drop a capability, so **Delete
request** rides along on the row it belongs to, keyed on the **work** email —
`offboarding_queue.employee_email` holds the PERSONAL address on all 488 completed rows, and personal
inboxes are shared across duplicate master identities, so matching on one would offer HR a button
that deletes somebody else's request. Rows with no matching request don't render the button at all.

### The one-off JSON backfill

`scripts/import-offboarded-from-json.mjs` (dry-run by default, `--apply` to write) landed **165**
sheet-era leavers the 2026-06-09 snapshot had missed, from
`references/data/Global Master List (PH) - Offboarded.json` (3,882 rows; 3,695 already on the ledger).
Ledger after: **4,010** rows — 3,519 `google_sheet` · 491 `hris`.

This does **not** reopen the spreadsheet as a source. The retired sync was dangerous because it was
RECURRING and REPLACING; this is neither, and both are enforced rather than intended:

- **INSERT-ONLY.** Never UPDATEs, never DELETEs. A person already on the ledger is skipped. That is
  what keeps hand-corrections durable — the export **still** carries `franm@simple.biz`'s `4/20/2027`
  typo (the cell the sync was retired over) while the DB holds the corrected `2026-04-20`. The script
  prints her outcome by name every run and **exits non-zero** if she would ever be inserted.
- **Dates sanitized, never guessed.** Parsing mirrors `normalizeMasterDate` and the future-date check
  mirrors `sanitizeOffboardDay`; anything failing either lands NULL. (The source has 301 unparseable
  cells — `6//3/2026`, `July 9, 2026` — all on already-present rows, so 0 of the 165 needed nulling.)
- **Reason stored VERBATIM**, `off_boarded_by` left NULL. The column is free text by design and every
  consumer that matters reads it through an allowlist of canonical departures, so an unrecognised
  sheet label keeps the person visible. Inventing an actor would fabricate an audit trail.
- **Work-email collisions are skipped, not merged.** 22 incoming rows named a work email already on
  the ledger under a *different* personal email — recycled emails, a documented hazard here. A second
  off-board record on a live work email becomes off-board **evidence** against whoever holds it now,
  so skipping is the only safe read. They are listed in the run report. **OPEN:** those 22 people are
  therefore still absent from the list.

### Money-surface consequence (decided, not incidental)

`offboarded_sheet` is evidence source #2 in `src/lib/roster/offboard-evidence.ts`, so these 165 rows
are visible to the Payment Catalog filter, Payroll Readiness and the final-pay overlay. Four of them
name someone on the **active** roster (`joyp@`, `mackp@`, `shanninp@`, `cathyp@`) — the import prints
every one for review. They are safe by existing design, not by luck: the catalog filter requires the
record to post-date the person's own Start Date, requires no hours in the current cycle, and matches
its reason against an allowlist that deliberately **excludes `temporary_pause`** (a suspension is not
a departure — which is exactly `cathyp@`'s row). All four guards resolve toward KEEPING the person.

---

## Weekly Pulse KPI cards (HR → Offboarding)

Added 2026-07-17 (Teal's request, commit `87053fb`):
`src/components/hr/OffboardingWeeklyPulse.tsx`, mounted in `HrOffboarding.tsx`
between the hero header and the tabbed Queue/Offboarded card — Offboarding
section only. (It was Queue/HRIS/Offboarded until the 2026-08-28 merge above.)

- **Own week selector** — a rose-recolored twin of the HR-dashboard picker
  (All time / By week toggle, prev/next chevrons, week-label pill with
  this-week/last-week badge), independent of the tab filters; next-week is
  disabled.
- **Card 1 · Offboarded** — weekly count from `off_boarded_at` (Sun–Sat
  weeks), a +N/−N vs-last-week chip, and an 8-week bar sparkline with the
  selected week highlighted.
- **Card 2 · Attrition rate** — reuses the HR Overview formula
  (`separations / (activeHeadcount + separations/2)`); by-week mode shows an
  **annualized (×52) run-rate** against the Overview's grade thresholds,
  all-time shows the raw ratio; raw counts printed beneath. Headcount comes
  from the shared `overviewRoster` cache.
- Motion: house rAF ease-out-cubic count-up, staggered bar draw-in, eased
  grade meter — transform/opacity only, all gated behind
  `prefers-reduced-motion`. Loading shimmer, zero-week, unknown-headcount, and
  light/dark states covered.

## Related

- **Resignation flow** — Profile → Resign → manager approval → offboarding queue (same queue this
  doc processes).
- **Manager · My Team** — where a manager multi-selects and raises requests.
- **System Diagnostics** — the `probeHrOffboarding` probe (`diagnostics-probes.ts`) surfaces this
  pipeline's health: recent `hr.employee.offboarded` audit count (30d), `hr.employee.webhook_fired.%`
  webhook history, and the total off-boarded count on `global_master_list`.
