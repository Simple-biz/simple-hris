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

**Files:** `src/components/manager/ManagerTimeAdjustments.tsx` (the workspace) and
`src/lib/manager/time-adjustment-queue.ts` (every derivation, pure and unit-tested).
Extracted out of `ManagerApp.tsx` on 2026-09-02, which lost 1,051 lines in the move; the
shell keeps only `TA_REASON_LABEL`, which its Overview approvals gallery also reads.

**Rebuilt 2026-09-02** from the handoff in `references/design_handoff_time_adjustments/`
(`README.md` is the spec, `Time Adjustments.dc.html` the prototype, `original-ui.png` the
screen it replaced). It is a review workspace, not a list: a KPI row, a filter bar, a
master-detail split, and one merged decision trail. **The theme is Accounting → MESA in
blue** (Kane) — see [Look and feel](#look-and-feel-mesa-in-blue).

The tab fetches from `GET /api/manager/time-adjustments` — scoped to the manager's departments via `department_managers` **plus any request naming the viewer as second approver**, with **no date restriction** (requests from any past period appear). A `useEffect` keyed on `activeTab` keeps the sidebar count badge live on a tab switch, and while the tab is open the live refresh below keeps it live too; that count is **things waiting on this person under either hat**. See [Staying live](#staying-live--the-refresh-must-be-on-a-timer-never-on-a-render) — a render-driven refetch here is a loop, not a refresh.

#### The five queues

The three stacked sections became **one table behind a segmented control**, because a
viewer can wear two hats at once (never on the same row — a manager cannot name
themselves). `bucketOfRequest` puts every row in exactly one segment, and the two
"owed by me" buckets outrank the status buckets:

| Segment | What it holds |
|---|---|
| **Needs you** | owed a decision *as the department manager* — `pending`, `manager_decision` null, and the id is in the response's `managedIds` |
| **Countersign** | names the viewer in `second_approver_email` with no `second_decision` yet (keyed on the assignment, not the status: they may act before the manager) |
| **In review** | in flight, waiting on somebody who is not this viewer — `awaiting_second_approval`, `manager_approved` (with Accounting), or a `pending` row this viewer already countersigned |
| **Approved** | `approved` |
| **Declined** | `manager_denied` (a reviewer said no) or `denied` (Accounting said no) |

**The landing segment is load-bearing, not a nicety.** `defaultBucketFor` opens on the
first segment with outstanding work — Needs you, then Countersign, then All. There is
deliberately **no** "you were named second approver" notification (a new
`employee_notifications.type` means restating a closed CHECK allowlist), so this tab plus
the sidebar count ARE the discovery path for a countersign duty. A default that hid it
would remove the only way those people find their work. Pinned by a test.

**The segments are coarse; the per-row chip is not.** An `in-review` row says whether it
is parked on the manager, on a countersignature, or on Accounting (`rowStatusChip`), so a
coarse bucket never makes a row lie. Chip tone follows the handoff's rule — blue for what
needs action, amber for in flight, neutral for anything resolved — so the queue triages at
a glance.

#### The table

Six columns: Employee (status dot + email), Work date, Reason, Hours (right, tabular),
Submitted, Status. Clicking anywhere in a row opens it in the detail panel; the open row
takes a blue fill and a 2px inset left bar.

**Hours are rounded to 2dp for display and never for math** (`fmtAdjustmentHours`). The UI
this replaced printed `requested_hours` verbatim, so a manager read
`+4.566666666666666h req` on screen — visible in `original-ui.png`. The raw value is
untouched for payroll. The Overview approvals gallery in `ManagerApp.tsx` had the same
defect on the same field and was fixed with it.

Search (email, reason label **and** stored code, explanation, all three decision notes,
request id), a reason filter, and a pay-period filter, all AND-combined client-side over
the rows already fetched — the same shape as the Transfers tab. `periodOf` falls back to
the adjusted date's own month when `period_label` is unstamped, so a legacy row is never
hidden from a filter that claims to cover every period. The card header carries
"Showing N of M".

#### The detail panel

Docked beside the table at ≥1100px, a right-hand drawer below it (Escape closes the
lightbox first, then the panel). It carries the request's short id, the employee, a facts
grid (hours, pay period, **every** missed-time range, reason), the explanation, the real
evidence with a lightbox, and the decision trail.

**The trail is ONE chronology** — submission, the second-approver assignment, the
manager's sign-off, the countersignature, then Accounting — replacing the old separate
"Manager decision" / "Second approver" blocks. An **undated** decision is dropped rather
than dated today: an undated event placed in a chronology is a fabricated fact.

Actions, when the viewer owes a decision:
- as the **manager**: a **required** second-approver picker fed by
  `GET /api/manager/approver-candidates?requestId=…`, **one fetch per request** because
  the pool is that request's own team and a manager of two departments gets a different
  list per row. It lists every ACTIVE member of the team minus the filer and the manager,
  names the team it is showing, and an empty list says *nobody else is active on that
  team* — since 2026-08-27 the only way it can be empty, there being no access grant to
  go and ask an admin for. Then an optional note, **Approve {h}** (`action:
  manager_approve` **with `second_approver_email` in the same body**, so a row can never
  land approved-but-uncountersigned; disabled until someone is picked) and **Decline**
  (`manager_deny`).
- as the **second approver**: the note plus **Approve {h}** (`second_approve`) and
  **Decline** (`second_deny`). No picker — that is the manager's call.
- A failed action renders **inline above the buttons**, never as a modal, and leaves the
  row in its previous state.

**Deliberately not built:** the handoff's **bulk action bar** (Approve / Forward /
Decline on checked rows) and its **Export CSV** button. Kane dropped both on 2026-09-02.
Bulk approve cannot exist as designed — every approval needs an approver drawn from *that
request's own team*, the pool is fetched per request, and there is no bulk endpoint, so it
could only work by applying one approver across teams, which the server would refuse. Its
`Forward to accounting` is also not a third button here: approving **is** forwarding.

#### Look and feel: MESA in blue

The theme is lifted from Accounting → MESA (`src/components/payroll/AccountingMesa.tsx`)
with teal swapped for blue, so the two surfaces read as one product: a soft tinted page
wash in light mode and flat `#0d1117` in dark, a gradient icon tile with a tracked
uppercase eyebrow above a `text-2xl` heading, stat tiles as separate `rounded-xl` cards
with a `from-blue-50 to-white` gradient and `font-mono tabular-nums` values, a segmented
control whose active pill is a `from-blue-500 to-sky-500` gradient with a white label,
`Card`/`CardHeader` chrome on tinted borders and header fills, a blue-tinted `thead` with
blue dividers and row hovers, and inputs focusing to `border-blue-500 ring-blue-500/20`.
Only the first stat tile is accented: it is the manager's actual to-do number, and it
counts **both** hats because that is what the sidebar badge means too.

Four stat tiles: *Needs your review* (both hats, plus the requested hours), *Awaiting
second approver* (rows parked on somebody else's countersignature — the viewer's own are
excluded so one request is never counted twice on one strip), *Decided last 30 days* with
its approval rate, and *Median time to decide*. **Median, never mean** — one request left
for three months would drag an average far enough to make a healthy queue look broken. An
empty window reports `null`, never `0%`: "nothing decided yet" and "0% approved" are
different facts. The handoff's *"Target: under 2 days"* sub-line is **not** shipped;
nobody set that SLA, so the line states the sample the median is drawn from instead.

#### Responsive, verified in a browser

Every band below was measured in Chromium against a mocked payload, not eyeballed:

| Width | Layout |
|---|---|
| **≥1400px, panel open** | docked panel + 5 columns (Reason returns) |
| **1100–1399px, panel open** | docked panel + 4 columns; Reason and Submitted stand down or the Employee cell gets ~60px and the headers collide |
| **≥1024px, panel closed** | all 6 columns |
| **768–1023px** | Submitted stands down |
| **640–767px** | Reason stands down and reappears under the email |
| **<640px** | **not a table.** `src/index.css:1055` collapses every `<table>` in the app into stacked label/value cards, taking its labels from `data-label`, so every cell carries one and nothing is lost on a phone |

Two traps are recorded here because both cost a build:

1. **A Tailwind variant composed from a constant is never generated.** The first build
   wrote `` `${SPLIT_AT}:block` ``; Tailwind scans source text statically, so
   `min-[1100px]:block` never existed and the panel rendered as a drawer at every width,
   backdrop and all. Every variant is spelled out literally.
2. **Two rival `display` rules that both match are a coin flip.** `md:table-cell` and
   `min-[1100px]:hidden` both match at 1100px and the winner is whichever Tailwind emitted
   last, which is not a contract. Column visibility is expressed so that only ONE rule
   ever turns a cell on (`md:max-[1099px]:table-cell min-[1400px]:table-cell`), over a
   base `hidden`. The global `<640px` rule additionally forces `display:flex` on every
   `td`, so a Tailwind `hidden` cannot be relied on to remove a cell down there at all.

**Retrieve (recall)** → `action: recall`, on rows at `manager_approved` **or** `awaiting_second_approval`, and only for ids in `managedIds` (the server enforces the same department scope; hiding the button just avoids offering a 403). It returns the row to `pending` and clears **all three** decision sets plus the second-approver assignment, so the review restarts from scratch — including the choice of who countersigns.

### Staying live — the refresh must be on a timer, never on a render

Added 2026-09-02, after Kane reported the tab **flickering**. It was a fetch loop.

The shell handed the tab a fresh inline arrow every render
(`onCountChange={(n) => setPendingApprovals(n)}`); the tab folded that prop into
`fetchRows = useCallback(…, [onCountChange])` and mounted it with
`useEffect(() => fetchRows(), [fetchRows])`. Each answered fetch called the callback,
and `useManagerCachedState`'s setter returns a **new `{key, value}` object on every
call** (value and key are one piece of state), so React could never bail out on an
unchanged count — the shell re-rendered, the arrow changed identity, `fetchRows`
changed with it, and the mount effect refired. One `GET /api/manager/time-adjustments`
per lap (Supabase reads **plus** Storage signing for every evidence image) for as long
as the tab was open, and because `fetchRows` opened with `setLoading(true)` the list
was swapped for the spinner several times a second. That was the flicker.

Three rules now hold it closed, all pinned by
`src/lib/manager/manager-time-adjustments-live.test.ts` (each assertion confirmed
failing against the pre-fix source first):

1. **Nothing render-unstable reaches the fetch closure.** `onCountChange` is read
   through `countChangeRef` only — allowed in the signature and the ref assignment,
   nowhere else — so `fetchRows` carries an **empty** dependency array and the mount
   effect is genuinely once per mount. The shell's callback is additionally memoized
   (`handleApprovalCountChange`), so either half alone keeps the loop shut. Same
   pattern, same reason as `useLiveRefresh` refing its own `onRefresh`.
2. **The spinner is derived, never stored** — `const loading = !settled && rows.length === 0`,
   and `settled` is never reset. This is `manager-dashboard-cache.md` §
   *"Loading flags are part of the rule"*; without it the poll below would flash the
   list every 60s exactly as the loop did.
3. **The queue is kept live by `useLiveRefresh`**, like every other manager queue
   (Transfers, both bonus calculators): Realtime on `time_adjustment_requests`, a
   **60s poll** backstop, and a focus/visibility refresh. Before this the tab had **no
   refresh at all** — a co-manager's decision, the second approver's signature,
   Accounting's verdict, or a request filed while you sat there stayed invisible until
   you switched tabs. `manager-dashboard-cache.md` is explicit that a queue other
   people change must not be stale-and-stop: *"that is how two managers approve the
   same request twice."* The refresh also re-signs the evidence URLs, which expire on
   a long-open tab.

The refresh reuses `fetchRows` itself, so the mount and refresh paths cannot diverge,
and the route keeps `cache: 'no-store'` — this changed no endpoint's freshness.

> **OPEN — one badge, two meanings.** The shell writes `pendingApprovals =
> pendingRows.length` (every pending row in the manager's departments,
> `ManagerApp.tsx:358`) and the tab writes *things waiting on ME under either hat*
> (`ManagerApp.tsx:1821`) into the **same** `pendingApprovalCount` cache key. So the
> sidebar number means one thing while you are on the tab and another while you are
> elsewhere, depending on which fetch answered last. Pre-existing, not a polling
> defect, and left alone deliberately: picking a winner changes a number on screen.

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

### 2026-09-02 — the review workspace

| Path | Change |
|---|---|
| `src/lib/manager/time-adjustment-queue.ts` | **New** — every derivation, pure: buckets, filters, KPIs, median, trail, 2dp hours, `deriveQueue` |
| `src/lib/manager/time-adjustment-queue.test.ts` | **New** — 40 tests, failure-direction first |
| `src/components/manager/ManagerTimeAdjustments.tsx` | **New** — the workspace, extracted from the shell and rebuilt on the handoff + the MESA-in-blue theme |
| `src/components/manager/ManagerApp.tsx` | **Edited** — 1,051 lines removed; keeps `TA_REASON_LABEL` for the Overview gallery, whose raw-hours bug is fixed with it |
| `src/lib/manager/tab-cache.ts` | **Edited** — `timeAdjustmentQueue` key (the tab's RAW payload, distinct from the shell's pending-only copy) |
| `src/lib/manager/manager-time-adjustments-live.test.ts` | **Edited** — repointed at the extracted file; 9 guards |
