# Time Adjustment Requests

> **Status:** Implemented 2026-06-02. Manager approval stage added 2026-06-02 (same session).
> Requires three manual Supabase steps before use — see [Prerequisites](#prerequisites).

A distinct, evidence-backed mechanism for employees to ask Accounting to correct the tracked hours for any past day. Designed to handle cases where work happened but Hubstaff did not record it (forgot to start the tracker, tracker crashed, worked offline or in a meeting, etc.).

**Key design decisions:**

- **Separate from PAB disputes.** PAB disputes (`pab_day_disputes`) are scoped to under-7h weekdays and gate Perfect Attendance forgiveness. Time adjustment requests have no hour threshold, work on any past day — including days with zero or missing Hubstaff data, and including days from past payroll cycles — and produce an explicit "corrected total" that Accounting sets.
- **Two-stage approval.** A manager must approve the request first; only then can Accounting act on it. Accounting can see all requests in every state for visibility but cannot set hours or approve until the manager sign-off is recorded. Only one manager approval is required.
- **Never mutates Hubstaff data.** The approved `approved_hours` value is a SET-semantics overlay applied at pay-calculation time; the `hubstaff_hours` rows in Supabase are never touched.
- **Requestable before Hubstaff upload.** An employee can file a request for a day even if no Hubstaff CSV has been uploaded yet for that period, because the request is independent of tracked hours.

---

## Status lifecycle

```
employee submits
       |
   pending          <- manager sees it; Accounting sees it read-only
       |
manager_approved    <- Accounting can now set hours and approve
manager_denied      <- flow ends; employee notified
       |
   approved         <- approved_hours overlay applied to pay
   denied           <- Accounting declined
```

---

## Prerequisites

Three one-time Supabase steps are required before the feature works end-to-end:

1. **Run the base migration** (`references/time_adjustment_requests.sql`) — creates the `time_adjustment_requests` table with a unique index on `(work_email, adjust_date)`.
2. **Run the manager approval migration** (`references/add_manager_approval_to_time_adjustments.sql`) — adds `manager_decided_by`, `manager_decided_at`, and `manager_decision_note` columns.
3. **Create a private Storage bucket** named `time-adjustment-evidence` (Dashboard → Storage → New bucket, **public = off**). Evidence images are served via short-lived signed URLs; they are never publicly accessible.

Without the table the API 500s on every request. Without the manager columns the manager approve/deny writes will fail. Without the bucket, image uploads fail but a request with no images still works.

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

- **Correct total (optional):** numeric hours input (0–24, 0.5 step). When filled the Review step shows the delta callout.
- **Explanation (required):** free-text paragraph. Required for all reason codes.

#### Step 3 — Proof (evidence upload)

Drag-and-drop image uploader capped at 5 images (`MAX_ADJUSTMENT_IMAGES = 5`). File previews are `URL.createObjectURL` blobs revoked on remove and dialog reset. This step is optional; the review step warns if no images are attached.

#### Step 4 — Review

Shows a **delta callout card** when a corrected total was entered:

| Scenario | Card | Text |
|---|---|---|
| Corrected > tracked | Green | `{N}h will be added to your day` |
| Corrected < tracked | Rose | `{N}h will be removed from your day` |
| Corrected = tracked | Zinc | `No change to your tracked hours` |

The callout shows the progression: `1.0h tracked → 8.0h corrected (+7.0h)`. A deadline / carry-over notice (amber) reminds the employee to submit before the next payroll cycle.

#### Existing-request read-only view

When `existingRequest` is set, the dialog renders a status card instead of the wizard. Status labels are human-readable:

| Status | Label shown to employee |
|---|---|
| `pending` | Awaiting manager approval |
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

The tab fetches from `GET /api/manager/time-adjustments` — scoped to the manager's departments via `department_managers`, with **no date restriction** (requests from any past period appear). A `useEffect` keyed on `activeTab` keeps the sidebar pending-count badge live.

**Pending cards** (status = `pending`) show:
- Employee email, adjust date, reason, requested hours, period label.
- Explanation paragraph.
- Evidence thumbnails (signed URLs).
- Optional manager note field.
- **Approve & forward to Accounting** → `PATCH /api/time-adjustments/[id]` with `action: manager_approve`.
- **Decline** → `PATCH /api/time-adjustments/[id]` with `action: manager_deny`.

**Already-actioned list** (compact, status ≠ `pending`) shows each request's email, date, reason, and current status.

### Authorization for manager approval

`managerDecideTimeAdjustment` (in `src/lib/supabase/time-adjustments.ts`):
1. Fetches the manager's department assignments via `listDepartmentsForManager(managerEmail)`.
2. Looks up the employee's department from `active_employees` (by `work_email`).
3. Checks the employee's dept is in the manager's assigned depts; returns 403 if not.
4. Only one manager sign-off is required — the first manager in that department to act moves the status to `manager_approved` or `manager_denied`.

---

## Accounting flow

### Payroll Wizard Additions tab

The `TimeAdjustmentReviewPanel` now shows **three sections** for the selected department:

**Manager-approved** (actionable — blue badge):
- Full decision UI: hours input, Approve button (requires hours value), Deny button.
- Shows the manager's name and any manager note.
- Approve/Deny → `PATCH /api/time-adjustments/[id]` with `action: approve|deny`.

**Awaiting manager** (read-only — lock icon + amber rows):
- Accounting can see these but cannot act on them.
- A note explains: "Waiting for manager sign-off before you can act."

**Decided** (compact list — approved, denied, manager_denied):
- Shows date, email, status badge, and approved hours if applicable.

The panel fetch (`fetchTimeAdjustmentReview` in `PayrollWizard.tsx`) has **no date range restriction** — all statuses across all periods are fetched. This means a request submitted for a date two months ago will still appear in the Additions panel and be actionable once the manager approves it.

### Department rail amber badge

The left department rail shows an amber badge only for rows with status `pending` or `manager_approved` (i.e. any request that still needs action from someone). `manager_denied`, `approved`, `denied` rows do not count toward the badge.

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
| `requested_hours` | numeric nullable | Employee's claimed total |
| `image_paths` | text[] | Storage object paths (not URLs); max 5 enforced in app |
| `status` | text | `pending` \| `manager_approved` \| `manager_denied` \| `approved` \| `denied` |
| `approved_hours` | numeric nullable | Set by Accounting on approval; the override value |
| `decided_by` | text nullable | Accounting user email |
| `decided_at` | timestamptz nullable | |
| `decision_note` | text nullable | |
| `manager_decided_by` | text nullable | Manager email (added by migration #2) |
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
| Manager approve / deny | `manager`/`admin` role + caller manages the employee's department |
| Accounting approve / deny | Accounting role (`canActOnDisputes`) + row must be `manager_approved` |
| Evidence signed URLs | Included in GET response only for elevated/accounting callers |

---

## Files changed / created

| Path | Change |
|---|---|
| `references/time_adjustment_requests.sql` | **New** — base DB migration |
| `references/add_manager_approval_to_time_adjustments.sql` | **New** — adds manager decision columns |
| `src/lib/supabase/time-adjustments.ts` | **New/Edited** — added `manager_approved`/`manager_denied` statuses, `managerDecideTimeAdjustment`, status helper functions; `decideTimeAdjustment` now requires `manager_approved` before Accounting can act |
| `app/api/time-adjustments/route.ts` | **New** — GET (list) + POST (create) |
| `app/api/time-adjustments/upload/route.ts` | **New** — POST (image upload) |
| `app/api/time-adjustments/[id]/route.ts` | **New/Edited** — PATCH now handles `approve`, `deny`, `manager_approve`, `manager_deny` |
| `app/api/manager/time-adjustments/route.ts` | **New** — GET scoped to manager's departments, no date restriction |
| `src/components/employee/TimeAdjustmentDialog.tsx` | **New** — 4-step wizard + human-readable status labels for all five statuses |
| `src/components/payroll/TimeAdjustmentReviewPanel.tsx` | **New/Edited** — three sections (actionable / awaiting manager / decided); locked UI on pending rows |
| `src/components/manager/ManagerApp.tsx` | **Edited** — replaced `TimeAdjustments` stub with live `ManagerTimeAdjustments` component; pending badge wired to real API |
| `src/components/employee/EmployeeMyHours.tsx` | **Edited** — hover popover, adjustmentsByDate, fetchTimeAdjustments, dialog render, Forgiven badge + legend |
| `src/components/PayrollWizard.tsx` | **Edited** — effectiveOverrides, timeAdjustDeltaHoursByEmail, dept rail, AnimatePresence, no-date-restriction fetch, bonus rules hidden |
| `src/lib/payroll/current-pay.ts` | **Edited** — mergeApprovedTimeAdjustments |
