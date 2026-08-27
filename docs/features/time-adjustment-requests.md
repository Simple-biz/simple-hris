# Time Adjustment Requests

> **Status:** Implemented 2026-06-02. Manager approval stage added 2026-06-02 (same session).
> **Dual approval (manager + a named second approver) added 2026-08-19** — migration APPLIED and
> verified 2026-08-20 (see `docs/features/INDEX.md` "Migrations & deploy state").
> **Second approver opened to the whole team, 2026-08-27** — see [Dual approval](#dual-approval).
> Requires four manual Supabase steps before use — see [Prerequisites](#prerequisites).

A distinct, evidence-backed mechanism for employees to ask Accounting to correct the tracked hours for any past day. Designed to handle cases where work happened but Hubstaff did not record it (forgot to start the tracker, tracker crashed, worked offline or in a meeting, etc.).

**Key design decisions:**

- **Separate from PAB disputes.** PAB disputes (`pab_day_disputes`) are scoped to under-7h weekdays and gate Perfect Attendance forgiveness. Time adjustment requests have no hour threshold, work on any past day — including days with zero or missing Hubstaff data, and including days from past payroll cycles — and produce an explicit "corrected total" that Accounting sets.
- **Dual approval, then Accounting** (changed 2026-08-19 — see [Dual approval](#dual-approval)). Stage 1 takes **two** sign-offs: the department manager **and** a **second approver the manager names per request**. Only when both have approved does the request reach Accounting; Accounting can see all requests in every state for visibility but cannot set hours or approve until stage 1 completes. **A denial from either party is terminal** and blocks the adjustment.
  > Superseded: until 2026-08-19 this read *"Only one manager approval is required"* — the first manager in the department to act decided it alone. Dual approval replaced that. There was never an "assistant team lead" stage; the second approver is the first one this feature has had.
- **Never mutates Hubstaff data.** The approved `approved_hours` value is a SET-semantics overlay applied at pay-calculation time; the `hubstaff_hours` rows in Supabase are never touched.
- **Requestable before Hubstaff upload.** An employee can file a request for a day even if no Hubstaff CSV has been uploaded yet for that period, because the request is independent of tracked hours.

---

## Status lifecycle

```
employee submits
       |
   pending                   <- manager has not decided; Accounting sees it read-only
       |
       |  manager approves (naming a second approver)
       v
awaiting_second_approval     <- still read-only to Accounting
       |
       |  second approver approves
       v
manager_approved             <- BOTH signed off; Accounting can now set hours and approve
       |
   approved                  <- approved_hours overlay applied to pay
   denied                    <- Accounting declined

manager_denied               <- EITHER reviewer declined; flow ends, employee notified
```

`status` is **derived, never written by hand** — `deriveAdjustmentStatus()` in
`src/lib/supabase/time-adjustments.ts` maps the two sign-offs onto it, which is what makes
the order they arrive in irrelevant. If the second approver acts first the row stays
`pending` (the manager still owes a decision) and only moves once they approve too.

---

## Dual approval

Added 2026-08-19. Stage 1 requires **two** sign-offs before Accounting sees anything.

| | Who | Authorized by | Recorded in |
|---|---|---|---|
| **Manager** | the employee's department manager | `department_managers` scope (unchanged) | `manager_decision`, `manager_decided_by/_at`, `manager_decision_note` |
| **Second approver** | anyone the manager names, **from any department** | the assignment on the row itself | `second_decision`, `second_decided_by/_at`, `second_decision_note` |

**The rules, and why each exists:**

- **Both must approve.** `manager_approved` is unreachable on one signature once a second
  approver is named — pinned by a test that walks every decision pair.
- **Either denial is terminal.** A denial from either party lands the row in
  `manager_denied`, deliberately reusing the existing terminal status so Accounting's
  decided list, delete-eligibility, and the employee's status card all keep working.
- **Approving requires naming someone.** The manager's Approve button is disabled until a
  second approver is chosen, and the server refuses `manager_approve` on a row with no
  `second_approver_email`. A request can never sit approved-but-uncountersigned.
- **Order-independent.** Either party may act first.
- **The pool is the employee's own team** (changed 2026-08-27; it was previously anyone
  in the company who already held Manager access). "The respective team" means the
  department of the employee **who filed the request** — not the union of the manager's
  departments. A manager running Edit *and* Design gets Edit people on an Edit request.
  The team is resolved server-side from the request id by
  `listSecondApproverCandidatesForRequest`; the route will not accept a department from
  the client, which would otherwise turn the picker into a roster-enumeration endpoint
  for teams the caller does not manage.
  > One resolver, `resolveAdjustmentDepartment`, feeds **both** the pool and the manager's
  > own authorization check. If they resolved the team differently, the dropdown could
  > offer a candidate the guard then refuses — or the reverse.
- **Naming someone now GRANTS them access — to this one surface and nothing else**
  (changed 2026-08-27; Kane's ruling, superseding the 2026-08-19 ruling that the picker
  could only list already-provisioned people). Being named is itself the authorization to
  countersign. The named approver needs no `manager` role and no feature grant.
  **How that stays narrow — by construction, not by hiding things:**
  - They review the request in the **employee portal**, on an Approvals tab that appears
    only while they have an assignment. They never load the Manager dashboard at all.
  - **No role is written.** Nothing is added to `employee_roles` or
    `employee_feature_permissions`, so `rbac-feature-permissions.md`'s admin-only grant
    rule is untouched for every other tab, and nobody is force-logged-out by being named
    (granting a role invalidates the target's JWT — see `employee-roles/route.ts`).
  - Leaves, transfers, offboarding, resignation, team roster, medals, notes and HSL bonus
    are gated on `manager:leaves` / `manager:team` / `manager:hsl_bonus` grants this
    person does not hold; suspension (`temp-pause`) additionally 403s on
    `departments.length === 0`. Default-deny (`no row == hidden`) closes the rest.
  - The seat is **derived, never stored**: it exists exactly as long as a row names them.
    Recall clears the assignment, and the tab goes with it. There is no grant to revoke
    and no stale seat to leak.
- **Authorization for their decision is the on-row assignment**, which remains
  **additive to** the manager's department check, never a replacement: the manager path
  still requires department scope, and `secondDecideTimeAdjustment` refuses anyone who is
  not the named person — a manager holding every grant in the system included.
- **Two signatures need two people.** A manager cannot name themselves, and neither
  reviewer may be the employee who filed the request.
- **Re-pointing is blocked once the second approver has decided** — recall instead, which
  clears all three decision sets *and* the assignment so the review restarts clean.
- **Recall also rescues a parked request.** `awaiting_second_approval` is recallable
  alongside `manager_approved`, so a request naming someone unavailable is never stuck.
- **The employee is locked out at the FIRST signature**, not when the status leaves
  `pending`. A row stays `pending` after the second approver approves, and letting the
  employee rewrite it then would apply a recorded sign-off to content that reviewer never
  saw (`createTimeAdjustment` checks `manager_decision`/`second_decision`, not status alone).

> **Not built (deliberate):** no "you were named second approver" notification. That
> would need a new `employee_notifications.type`, and that column IS a closed CHECK
> allowlist — a new value means a full DROP/ADD restatement of all 41 types plus a
> `notification-views.ts` mapping. Discovery is the tab's own **Awaiting your second
> approval** section and the sidebar count instead, which needs no migration. The denial
> notification reuses the existing `time_adjustment.denied` type and now names *which*
> reviewer declined (it always said "your manager", which would be wrong half the time).

---

## Prerequisites

Four one-time Supabase steps are required before the feature works end-to-end:

1. **Run the base migration** (`references/time_adjustment_requests.sql`) — creates the `time_adjustment_requests` table with a unique index on `(work_email, adjust_date)`.
2. **Run the manager approval migration** (`references/add_manager_approval_to_time_adjustments.sql`) — adds `manager_decided_by`, `manager_decided_at`, and `manager_decision_note` columns.
3. **Create a private Storage bucket** named `time-adjustment-evidence` (Dashboard → Storage → New bucket, **public = off**). Evidence images are served via short-lived signed URLs; they are never publicly accessible.
4. **Run the second-approver migration** (`references/sql/alter/2026-08-19_time_adjustment_second_approver.sql`) — adds the `second_approver_*` / `second_decision*` / `manager_decision` columns and backfills `manager_decision` on already-decided rows. **PENDING as of 2026-08-19.** Ship it with the Node gate, which dry-runs by default and writes a SELECT backup to disk before the backfill:
   ```
   node scripts/apply-time-adjustment-second-approver.mjs          # dry run
   node scripts/apply-time-adjustment-second-approver.mjs --apply  # execute
   ```
   No `status` CHECK exists (see `add_manager_approval_to_time_adjustments.sql:4`), so the new `awaiting_second_approval` value needs no constraint change.

Without the table the API 500s on every request. Without the manager columns the manager approve/deny writes will fail. Without the bucket, image uploads fail but a request with no images still works. **Without the second-approver columns every manager approval fails** — the write targets columns that do not exist, and the backfill is what stops already-decided rows from deriving back to `pending` and re-entering the queue.

---

## Employee flow

### Triggering the request (My Hours calendar)

Each day cell in the My Hours calendar (`src/components/employee/EmployeeMyHours.tsx`) shows a **hover popover** on all past and today in-month cells. The popover displays the full date and tracked hours, and contains:

- A primary **"Request time adjustment"** click target — available on any non-future, in-month day (no hour threshold).
- A secondary **"File PAB dispute" / "View PAB dispute"** button that appears only on cells eligible for the PAB dispute flow (under-7h weekdays). The two features are independent.

If a time adjustment request already exists for that day, clicking it opens the read-only status view instead of the new-request wizard.

### TimeAdjustmentDialog — 4-step guided wizard

**File:** `src/components/employee/TimeAdjustmentDialog.tsx`

A stepped modal that walks the employee through filing a request. Built with `motion/react` for slide and blur transitions between steps.

#### Progress rail

A horizontal step rail in the dialog header shows four nodes (Reason → Details → Proof → Review). The active node scales up (spring, `stiffness: 400, damping: 22`) and its icon cross-fades via `AnimatePresence`. The connector bar between nodes is a `motion.div` whose width animates to `100%` on completion with a spring (`stiffness: 280, damping: 28`).

#### Step 1 — Reason

Four reason cards in a 2-column grid. Each shows a contextual lucide icon, label, and a checkmark on selection.

| Code | Label |
|---|---|
| `forgot_tracker` | Forgot to start Hubstaff tracker |
| `tracker_crashed` | Tracker crashed / technical glitch (time not recorded) |
| `worked_offline` | Worked offline or untracked (meetings, calls, on-site) |
| `other` | Other |

#### Step 2 — Details

- **Missed time (required):** one or more **time in / time out** ranges (`<input type="time">`, up to `MAX_ADJUSTMENT_SEGMENTS = 6`) pointing at exactly the time that was NOT tracked — e.g. forgot the tracker 9:00–10:00 AM → one 1-hour range. Employees do **not** enter their whole shift; already-tracked time stays as is. Ranges must be complete, non-overlapping, with time out after time in (no crossing midnight — a stretch past midnight is a separate request for the next day). Stored in `requested_segments` (jsonb); `requested_hours` is computed server-side as the sum of the ranges = **hours to ADD** (note: legacy rows without segments stored a claimed day total instead).
- **Explanation (required):** free-text paragraph. Required for all reason codes.

#### Step 3 — Proof (evidence upload)

Drag-and-drop image uploader capped at 5 images (`MAX_ADJUSTMENT_IMAGES = 5`). File previews are `URL.createObjectURL` blobs revoked on remove and dialog reset. This step is optional; the review step warns if no images are attached.

#### Step 4 — Review

Lists the missed ranges, the time to add, and the corrected total (tracked + missed), plus a **delta callout card**:

| Scenario | Card | Text |
|---|---|---|
| Corrected > tracked | Green | `{N}h will be added to your day` |
| Corrected < tracked | Rose | `{N}h will be removed from your day` |
| Corrected = tracked | Zinc | `No change to your tracked hours` |

The callout shows the progression: `1.0h tracked → 8.0h corrected (+7.0h)`. A deadline / carry-over notice (amber) reminds the employee to submit before the next payroll cycle.

#### Existing-request read-only view + editing while pending

When `existingRequest` is set, the dialog renders a status card instead of the wizard. While the request is still `pending` (manager hasn't acted), the card shows an **Edit request** button that reopens the wizard prefilled with the request's reason, explanation, and missed-time ranges — so employees can fix mistakes or add more untracked stretches for the same day before review. Previously uploaded evidence appears as "Saved image N" chips (no thumbnails — the bucket is private) that can be individually removed; kept paths are resubmitted alongside any new uploads (combined cap still 5). Saving overwrites the pending row via the existing `(work_email, adjust_date)` upsert and returns it to the manager's queue; the audit log entry carries `resubmission: true`. Once a manager or Accounting has decided, editing is blocked server-side ("already been reviewed", HTTP 409). The POST route also validates that every `image_paths` entry lives under the session's or target employee's own storage folder (`adjustmentEvidencePrefix`).

Status labels are human-readable:

| Status | Label shown to employee |
|---|---|
| `pending` | Awaiting manager approval |
| `awaiting_second_approval` | Awaiting second approver |
| `manager_approved` | Manager approved — with Accounting |
| `manager_denied` | Declined by manager |
| `approved` | Approved |
| `denied` | Denied |

#### Submission sequence

1. Evidence images upload in parallel to `POST /api/time-adjustments/upload` → paths collected.
2. `POST /api/time-adjustments` with all fields including paths.
3. Toast + dialog close + `onSubmitted()` callback triggers a re-fetch.

---

## Manager flow

### Manager dashboard — Time adjustments tab

**File:** `src/components/manager/ManagerApp.tsx` → `ManagerTimeAdjustments` component (replaced the placeholder stub on 2026-06-02).

The tab fetches from `GET /api/manager/time-adjustments` — scoped to the manager's departments via `department_managers` **plus any request naming the viewer as second approver**, with **no date restriction** (requests from any past period appear). A `useEffect` keyed on `activeTab` keeps the sidebar count badge live; that count is **things waiting on this person under either hat**.

The tab renders **three** sections, because one viewer can wear two hats at once (never on the same row — a manager cannot name themselves):

**1. Awaiting your approval** — rows the viewer owes a decision on *as the department manager* (`status = pending`, `manager_decision` null, and the id is in the response's `managedIds`). Each card shows:
- Employee email, adjust date, reason, requested hours, period label.
- Explanation paragraph.
- Evidence thumbnails (signed URLs).
- **Second approver dropdown** (required) — fed by `GET /api/manager/approver-candidates?requestId=…`, **one fetch per request** because the pool is that request's own team and a manager of two departments gets a different list per row. Lists every ACTIVE member of the team, minus the filer and the manager themselves. The label names the team it is showing; an empty list says *nobody else is active on that team*, which since 2026-08-27 is the only way it can be empty — there is no longer an access grant to go and ask an admin for.
- Optional manager note field.
- **Approve & send to second approver** → `PATCH .../[id]` with `action: manager_approve` **and `second_approver_email`** in the same body, so the row can never land approved-but-uncountersigned. Disabled until someone is picked.
- **Decline** → `action: manager_deny`.

**2. Awaiting your second approval** — rows naming the viewer in `second_approver_email` with no `second_decision` yet. No picker (that is the manager's call); a banner names who asked and whether the manager has already signed off.
- **Approve** → `action: second_approve` · **Decline** → `action: second_deny`.

**3. History** — everything else: decided rows, plus rows in flight waiting on somebody *other than* the viewer. A request the manager already approved sits here as `awaiting_second_approval` — not their move any more, but not finished either, so the pill says so and **Retrieve** stays available. The expanded detail carries the full trail: manager decision, **second approver** (shown as soon as one is named, including "Has not decided yet", so a parked request says who it is parked on), and Accounting decision.

**Retrieve (recall)** → `action: recall`, on rows at `manager_approved` **or** `awaiting_second_approval`, and only for ids in `managedIds` (the server enforces the same department scope; hiding the button just avoids offering a 403). It returns the row to `pending` and clears **all three** decision sets plus the second-approver assignment, so the review restarts from scratch — including the choice of who countersigns.

### Authorization for manager approval

`managerDecideTimeAdjustment` (in `src/lib/supabase/time-adjustments.ts`):
1. Fetches the manager's department assignments via `listDepartmentsForManager(managerEmail)`.
2. Looks up the employee's department from `active_employees` (by `work_email`).
3. Checks the employee's dept is in the manager's assigned depts; returns 403 if not.
4. Records the manager's sign-off in `manager_decision` and re-derives `status`. Approving requires `second_approver_email` to be set (the route accepts it in the same call as the approval), so the row moves to `awaiting_second_approval`, not straight to `manager_approved`. Denying moves it to `manager_denied` on its own.

### Authorization for the second approver

`secondDecideTimeAdjustment` (same file) does **not** consult `department_managers` at all — the assignment IS the authorization:

1. The row must name the caller in `second_approver_email` (normalized compare); anyone else gets 403.
2. They must not have decided already, and the row must still be `pending` or `awaiting_second_approval`.
3. Records `second_decision` and re-derives `status`.

This is what lets an ordinary teammate countersign without any Manager access. It widens nothing else: the manager's own path still requires department scope, and `GET /api/manager/time-adjustments` widens the **read** by exactly the same rule (`manages the department` **OR** `is the named second approver`) so read and write can never disagree. The response also returns `managedIds`, the subset the caller may act on *as the manager*, so a row reaching them only as second approver never renders the manager's controls.

**The route-level gate changed with it (2026-08-27).** `second_approve` / `second_deny` are the only two actions in `PATCH /api/time-adjustments/[id]` that no longer require the `manager:time_adjustments` edit grant — they are authorized by the on-row assignment alone. That is a **narrowing**, not a relaxation: it replaces "holds a company-wide tab grant" with "is the exact person named on this exact row", so every manager who previously qualified but was not named is refused exactly as before. Naming the approver (`assign_second_approver`) stays a manager action, so a named approver cannot re-point a request at somebody else.

### Employee-portal surface

**File:** `src/components/employee/EmployeeSecondApprovals.tsx` — the Approvals tab, fed by `GET /api/time-adjustments/second-approvals`.

Two sections, matching the scope Kane set ("ONLY submitted time adjustments and time adjustment history"): **Awaiting your approval** (rows still owed their signature — keyed on `second_decision`, not status, so they can act before the manager does) and **History** (rows they were named on and already signed). Evidence images come back as signed URLs for these rows only; a reviewer who cannot see the proof cannot judge the request.

The tab is **absent** unless the portal shell's count comes back non-zero, and a failed count hides it rather than guessing one into existence. The shell asks without `?evidence=1` so it does not pay for Storage signing it will not render.

The endpoint takes **no email parameter**. There is nothing to authorize beyond "who are you", because the query itself is the authorization — it can only ever return rows naming the caller.

---

## Accounting flow

### Payroll Wizard Additions tab

The `TimeAdjustmentReviewPanel` now shows **three sections** for the selected department:

**Manager-approved** (actionable — blue badge):
- Full decision UI: hours input, Approve button (requires hours value), Deny button.
- Shows the manager's name and any manager note.
- Approve/Deny → `PATCH /api/time-adjustments/[id]` with `action: approve|deny`.

**Awaiting manager** (read-only — lock icon + amber rows) — status `pending` **or `awaiting_second_approval`**:
- Accounting can see these but cannot act on them.
- A note explains: "Waiting for manager sign-off before you can act."

**Decided** (compact list — approved, denied, manager_denied):
- Shows date, email, status badge, and approved hours if applicable.
- `denied` and `manager_denied` rows display a **trash icon** that calls `DELETE /api/time-adjustments/[id]`. Only Accounting roles can delete; only denied rows are eligible (enforced both client and server). Deleted rows are audit-logged with action `time_adjustment.deleted`.

The panel fetch (`fetchTimeAdjustmentReview` in `PayrollWizard.tsx`) has **no date range restriction** — all statuses across all periods are fetched. This means a request submitted for a date two months ago will still appear in the Additions panel and be actionable once the manager approves it.

### Department rail amber badge

The left department rail shows an amber badge only for rows still owed a decision upstream of Accounting — status `pending` or `awaiting_second_approval`. `manager_approved` (both signatures in, Accounting's move), `manager_denied`, `approved` and `denied` do not count toward the badge. The wizard's own fetch enumerates statuses explicitly, so `awaiting_second_approval` had to be added there too or a live request would be invisible to Accounting entirely.

### Bonus rule panels

The per-department formula info cards and bonus configuration inputs are hidden (`display: none`) to give the employee bonus table full width. The JSX remains in `PayrollWizard.tsx` if they need to be restored.

---

## Pay wiring

### How approved hours change pay

Approval does not modify Hubstaff data. `approved_hours` is a **SET-semantics override** that replaces the Hubstaff-tracked seconds for that date at calculation time only.

**Two integration points in the wizard:**

1. **`effectiveOverrides` memo** — merged map of `email → (ISO date → override hours | null)`. Built by layering approved PAB disputes then overlaying approved time adjustments (time adjustments win on a same-day collision). All three PAB memos read this map.

2. **`timeAdjustDeltaHoursByEmail` memo** — sums `(approved_hours − raw tracked hours)` over in-period adjustment dates per employee. Folded into `effectiveCalcResults.initialPay`:
```
adjPesos = phpHourlyPayFromSeconds(regularRate, |deltaHours| × 3600)
newInitialPay = initialPay ± adjPesos
```

**Email-drift caveat:** if `work_email` on the request does not match the Hubstaff row email, the delta is silently zero.

### `current-pay.ts` parity

`mergeApprovedTimeAdjustments` overlays approved time adjustments on the dispute override map before passing it to `computePabEligibleEmails`, so an approved adjustment also affects the employee's PAB eligibility in their live estimate.

---

## Data model

### Table: `time_adjustment_requests`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `work_email` | text | Normalized lowercase |
| `adjust_date` | date | The day being corrected (YYYY-MM-DD) |
| `reason` | text | One of the four reason codes |
| `explanation` | text nullable | Employee's paragraph |
| `requested_hours` | numeric nullable | Claimed MISSED hours to add (= sum of `requested_segments`); legacy rows: claimed day total |
| `requested_segments` | jsonb (default `[]`) | Missed time in/out ranges: `[{time_in:"HH:MM",time_out:"HH:MM"}]` (2026-07-17 alter) |
| `image_paths` | text[] | Storage object paths (not URLs); max 5 enforced in app |
| `status` | text | `pending` \| `manager_approved` \| `manager_denied` \| `approved` \| `denied` |
| `approved_hours` | numeric nullable | Set by Accounting on approval; the override value |
| `decided_by` | text nullable | Accounting user email |
| `decided_at` | timestamptz nullable | |
| `decision_note` | text nullable | |
| `manager_decided_by` | text nullable | Manager email (added by migration #2) |
| `manager_decision` | text nullable | `approved` \| `denied`. CHECK-constrained. Explicit because the second approver may act first, so `status` alone cannot say whether the manager decided (migration #4) |
| `second_approver_email` | text nullable | Who the manager named to countersign THIS request (migration #4) |
| `second_approver_assigned_by` | text nullable | The manager who named them |
| `second_approver_assigned_at` | timestamptz nullable | |
| `second_decision` | text nullable | `approved` \| `denied`. CHECK-constrained |
| `second_decided_by` | text nullable | |
| `second_decided_at` | timestamptz nullable | |
| `second_decision_note` | text nullable | |
| `manager_decided_at` | timestamptz nullable | |
| `manager_decision_note` | text nullable | |
| `period_label` | text nullable | YYYY-MM stamp of the payroll cycle at creation time |
| `created_at` | timestamptz | |
| `created_by` | text nullable | |
| `updated_at` | timestamptz | |

**Unique index:** `(work_email, adjust_date)` — one open or decided request per employee per day.

### Storage bucket: `time-adjustment-evidence`

Private. Object path: `{sanitized_email}/{requestKey}/{idx}-{timestamp}.{ext}`. Served only via 1-hour signed URLs generated server-side.

---

## Authorization

| Action | Gate |
|---|---|
| Create a request | Employee themselves (`authorizeEmailAccess`); elevated can file on behalf |
| List own requests | Employee with `?email=` |
| List all requests (accounting) | Elevated roles (`requireElevatedSession`) |
| List department requests (manager) | `manager` or `admin` role + scoped to `department_managers` assignments |
| Manager approve / deny | `manager:time_adjustments` **edit** grant + caller manages the employee's department |
| Name / re-name the second approver | same as manager approve; blocked once the second approver has decided |
| Second approver approve / deny | The row must name the caller in `second_approver_email`. **No role, no feature grant, no department check** — the assignment IS the authorization (2026-08-27) |
| Read own second-approver queue | Signed in. `GET /api/time-adjustments/second-approvals` is scoped to the caller's own assignments and takes no email parameter |
| Appear in the second-approver picker | ACTIVE roster member of the request's own department, excluding the filer and the naming manager. **No role required** (2026-08-27) |
| Recall | same as manager approve; allowed from `manager_approved` **or** `awaiting_second_approval` |
| Accounting approve / deny | Accounting role (`canActOnDisputes`) + row must be `manager_approved` |
| Accounting delete | Accounting role (`canActOnDisputes`) + row must be `denied` or `manager_denied` |
| Evidence signed URLs | Included in GET response only for elevated/accounting callers |

---

## Files changed / created

| Path | Change |
|---|---|
| `references/time_adjustment_requests.sql` | **New** — base DB migration |
| `references/add_manager_approval_to_time_adjustments.sql` | **New** — adds manager decision columns |
| `src/lib/supabase/time-adjustments.ts` | **New/Edited** — `manager_approved`/`manager_denied` statuses, `managerDecideTimeAdjustment`, `deleteTimeAdjustment` (accounting-only, denied rows only); `decideTimeAdjustment` now requires `manager_approved` |
| `app/api/time-adjustments/route.ts` | **New** — GET (list) + POST (create) |
| `app/api/time-adjustments/upload/route.ts` | **New** — POST (image upload) |
| `app/api/time-adjustments/[id]/route.ts` | **New/Edited** — PATCH handles `approve`, `deny`, `manager_approve`, `manager_deny`; DELETE added for accounting to remove denied rows |
| `app/api/manager/time-adjustments/route.ts` | **New** — GET scoped to manager's departments, no date restriction |
| `src/components/employee/TimeAdjustmentDialog.tsx` | **New** — 4-step wizard + human-readable status labels for all five statuses |
| `src/components/payroll/TimeAdjustmentReviewPanel.tsx` | **New/Edited** — three sections; portal lightbox modal (`createPortal` + `AnimatePresence`) for evidence images; trash button on denied rows (`onDelete` / `deletingId` props) |
| `src/components/manager/ManagerApp.tsx` | **Edited** — replaced `TimeAdjustments` stub with live smoked-glass `ManagerTimeAdjustments`; `max-w-2xl`; `AnimatePresence` lightbox; pending badge wired to real API |
| `src/components/employee/EmployeeMyHours.tsx` | **Edited** — hover popover, adjustmentsByDate, fetchTimeAdjustments, dialog render, Forgiven badge + legend |
| `src/components/PayrollWizard.tsx` | **Edited** — effectiveOverrides, timeAdjustDeltaHoursByEmail, dept rail, AnimatePresence, no-date-restriction fetch, bonus rules hidden |
| `src/lib/payroll/current-pay.ts` | **Edited** — mergeApprovedTimeAdjustments |

### 2026-08-19 — dual approval / second approver

| Path | Change |
|---|---|
| `references/sql/alter/2026-08-19_time_adjustment_second_approver.sql` | **New** — second-approver + `manager_decision` columns, two CHECKs, backfill, index |
| `scripts/apply-time-adjustment-second-approver.mjs` | **New** — dry-run-by-default `--apply` gate; SELECT backup to disk before the backfill |
| `src/lib/supabase/time-adjustments.ts` | **Edited** — `awaiting_second_approval` status, pure `deriveAdjustmentStatus`, `assignSecondApprover`, `secondDecideTimeAdjustment`, `listSecondApproverCandidates`, shared `authorizeManagerOverAdjustment` (was duplicated), recall clears all three sets, employee edit-lock now keys on the decisions not the status |
| `src/lib/supabase/time-adjustments.test.ts` | **New** — 20 tests. This surface previously had **none** |
| `app/api/time-adjustments/[id]/route.ts` | **Edited** — `assign_second_approver` / `second_approve` / `second_deny` actions; denial notification names which reviewer declined and no longer swallows its insert error |
| `app/api/manager/time-adjustments/route.ts` | **Edited** — reads widen by the same rule the writes do; returns `viewerEmail` + `managedIds` |
| `app/api/manager/approver-candidates/route.ts` | **New** — the eligible-approver pool |
| `src/components/manager/ManagerApp.tsx` | **Edited** — three queues, approver dropdown, second-approver card mode, second-approver trail in history, recall from `awaiting_second_approval` |
| `src/components/employee/TimeAdjustmentDialog.tsx` | **Edited** — status label + style for the new status |
| `src/components/payroll/TimeAdjustmentReviewPanel.tsx` | **Edited** — "Awaiting manager" includes `awaiting_second_approval` |
| `src/components/PayrollWizard.tsx` | **Edited** — status added to the review fetch; dept rail badge counts it |

### 2026-08-27 — team-scoped pool, and naming grants the seat

| Path | Change |
|---|---|
| `src/lib/supabase/time-adjustments.ts` | **Edited** — `listSecondApproverCandidates` is now team-scoped and role-free; pure `selectTeamApproverCandidates` split out for tests; `listSecondApproverCandidatesForRequest` (resolves the team from the request, manager-authorized); `listSecondApprovalsForApprover` (the portal feed); shared `resolveAdjustmentDepartment` extracted so the pool and the manager scope check cannot drift |
| `src/lib/supabase/time-adjustments.test.ts` | **Edited** — 8 new tests pinning the team rule: cross-team refused, union refused, filer + manager excluded, exclusions email-normalized, blank department yields NOBODY, blank work email skipped, naming variants collapse, duplicate rows collapse |
| `app/api/manager/approver-candidates/route.ts` | **Rewritten** — `requestId` is REQUIRED and the department is resolved server-side; returns the team label alongside the candidates |
| `app/api/time-adjustments/second-approvals/route.ts` | **New** — the approver's own queue for the employee portal; `?evidence=1` opts into signed URLs; returns `pendingCount` |
| `app/api/time-adjustments/[id]/route.ts` | **Edited** — `second_approve` / `second_deny` authorize on the on-row assignment instead of the `manager:time_adjustments` grant; every other action's gate is unchanged |
| `src/components/employee/EmployeeSecondApprovals.tsx` | **New** — the Approvals tab (awaiting + history, evidence lightbox) |
| `src/components/employee/EmployeeApp.tsx` | **Edited** — `approvals` render case + the shell's `pendingCount` fetch |
| `src/components/employee/EmployeeSidebar.tsx` | **Edited** — Approvals nav item, rendered only when `secondApprovalCount > 0` |
| `src/lib/pages/visibility.ts` | **Edited** — `approvals` added to the employee page registry |
| `src/components/manager/ManagerApp.tsx` | **Edited** — per-request candidate pools (`poolByRow`) replacing the single global list; picker names the team; empty-state copy no longer sends the manager to an admin |
