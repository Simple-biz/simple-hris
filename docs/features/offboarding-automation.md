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
- `app/api/cron/process-scheduled-deletions/route.ts` — fires the delayed delete after 14 days.

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
        │                                              └─ n8n: offboarding_deactivate / _delete
        ▼
(non-Lead-Gen) scheduled_deletion_at = now + 14d
        │
        ▼
daily cron /api/cron/process-scheduled-deletions ──▶ n8n: offboarding_delete
```

---

## 1 · Manager raises requests → the queue

A department manager multi-selects teammates in **My Team** and submits. `POST /api/offboarding-queue`
(gated by `requireFeatureEdit`; managers can only offboard people in departments they manage — enforced
via `listDepartmentsForManager` + `departmentMatchesManagedAssignments`):

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
   `off_boarded_note`, `scheduled_deletion_at` on **every** still-active row for that work email
   (covers dual-role employees with multiple rows). Rows already off-boarded are not re-stamped.
2. **Revoke ALL RBAC + force-logout.** `snapshotAndRevokeRbacGrants(work_email)` (below), then
   `bumpForceLogoutFor(work_email)` kills any live JWT session so a stale token can't stay privileged.
3. **Side-effects (best-effort, non-blocking):** insert into `offboarded_sheet`, append the row to
   the Google "Offboarded" sheet, and cancel any pending hires in `hr_pending_employees`.
4. **Audit:** `insertAuditLog({ action: "hr.employee.offboarded", ... })`.

### Department-aware teardown

- **Lead Gen** (every department the person holds normalizes to `lead_gen`) → phase `delete`,
  `deletion_mode: "immediate"`, fires `offboarding_delete` right away. No timer.
- **Anyone else** → phase `deactivate`, fires `offboarding_deactivate` immediately (suspend the
  Workspace account, send the termination email, remove the Hubstaff member at pay rate 0) **and**
  stamps `scheduled_deletion_at = now + 14 days`. The daily cron
  (`/api/cron/process-scheduled-deletions`) fires `offboarding_delete` once the timer elapses.

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
| `offboarding_deactivate` | `.../webhook/offboarding-deactivate` | HR offboards a non-Lead-Gen person |
| `offboarding_delete` | `.../webhook/offboarding-delete` | HR offboards Lead Gen **or** the 14-day cron elapses |

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

`/api/hr/offboard` coalesces a batch **by phase** and fires **at most two** POSTs (one
`deactivate`, one `delete`), each carrying an `employees[]` array so a batch of any size is two
webhooks. The exact envelope emitted (`app/api/hr/offboard/route.ts`):

```jsonc
{
  "event": "employee.offboarded",
  "phase": "deactivate",              // or "delete"
  "deletion_mode": "delayed_14d",     // "immediate" for the delete phase
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
      "scheduled_deletion_at": "2026-07-21T..Z"  // null for immediate delete
    }
  ]
}
```

`off_boarded_by` / `off_boarded_at` are duplicated onto each `employees[]` item so that after n8n's
**Split Out** on `employees`, the per-person email node is self-contained and doesn't have to reach
back to the parent envelope.

> The **delayed cron** (`process-scheduled-deletions`) fires a *slightly* different `delete`
> payload keyed on `work_email` (`deletion_mode: "delayed_14d"`, `scheduled: true`) — it processes
> due rows one at a time rather than an `employees[]` batch.

### n8n gotchas (see the n8n webhook-gotchas note)

- **`off_boarded_by` is mandatory.** A run that arrived without it was flagged invalid by the n8n
  flow; the envelope now always sends it (and duplicates it per employee).
- **`count` must be in the payload.** Both the manager-notify email and the teardown flows read
  `count` directly; don't rely on `employees.length` downstream.
- **Split Out on `employees`.** The teardown flows fan out the `employees[]` array; a single-person
  offboard still sends a 1-element array so the same Split Out node handles both.
- Gmail expands every `{{ }}`; keep template expressions off any free-text `note`.

---

## Related

- **Resignation flow** — Profile → Resign → manager approval → offboarding queue (same queue this
  doc processes).
- **Manager · My Team** — where a manager multi-selects and raises requests.
- **System Diagnostics** — the `probeHrOffboarding` probe (`diagnostics-probes.ts`) surfaces this
  pipeline's health: recent `hr.employee.offboarded` audit count (30d), `hr.employee.webhook_fired.%`
  webhook history, and the total off-boarded count on `global_master_list`.
