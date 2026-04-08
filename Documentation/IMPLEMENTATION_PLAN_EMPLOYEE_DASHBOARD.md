# Implementation Plan: Employee & Manager Dashboard

> **Goal**: Build a self-service dashboard where every employee can view their weekly hours, pay breakdown, and file hour disputes — and where department managers can see the same data plus approve/deny those disputes, triggering pay adjustments automatically.

---

## 1. Current State

| Area | Status |
|---|---|
| Employee self-service | None. Only admins interact with the system via the PayrollWizard. |
| Hour visibility | Employees cannot see their own Hubstaff hours or pay calculations. |
| Disputes | No dispute system exists. Hour corrections require manual admin intervention. |
| Manager tools | No per-department management view. All payroll actions are in a single admin wizard. |
| Notifications | None. No in-app or email notification system. |
| Authentication | Not implemented yet (see `IMPLEMENTATION_PLAN_RBAC.md`). Required before this feature. |

---

## 2. User Stories

### Employee
1. **View my weekly hours** — see total hours, regular/OT split, and daily breakdown for the current (and past) pay periods.
2. **View my pay breakdown** — see regular pay, OT pay, bonuses, deductions, and net pay in PHP (with USD equivalent).
3. **File an hour dispute** — submit a correction request for a specific day/period with a reason (e.g., "forgot to start time tracker", "tracker crashed", "worked offline").
4. **Track dispute status** — see whether my disputes are pending, approved, or denied, and any manager notes.
5. **Get notified** — receive a notification when my dispute is reviewed.

### Manager
6. **See my team** — view all employees in my department(s) with their hours, pay, and dispute counts.
7. **Review disputes** — see all pending disputes for my team, with the employee's stated reason and supporting details.
8. **Approve/deny disputes** — approve (adjusting the employee's hours and recalculating pay) or deny (with a reason) each dispute.
9. **Get notified** — receive a notification when a new dispute is filed by a team member.
10. **View dispute history** — see resolved disputes for audit and pattern detection.

### Admin
11. **Global dispute overview** — see all disputes across all departments.
12. **Override disputes** — approve/deny any dispute regardless of department.
13. **Configure dispute settings** — set max dispute window (e.g., 7 days after pay period), max hours adjustable per dispute, etc.

---

## 3. Prerequisites

This plan **depends on** the RBAC implementation (`IMPLEMENTATION_PLAN_RBAC.md`). Specifically:

- **Supabase Auth** must be active (login, sessions, JWTs).
- **`user_profiles`** table must exist (maps `auth.users` → role + full_name).
- **Employee ↔ Auth linkage** — each employee in `global_master_list` must be linkable to a `auth.users` row (via `work_email`). A new column `auth_user_id UUID REFERENCES auth.users(id)` on `global_master_list` will establish this link.
- **Role-based API guards** must be in place (or built alongside this feature).

If RBAC is not yet implemented, Phase 1 of this plan can be stubbed with a simple email-based session mock for development purposes.

---

## 4. Database Schema

### 4.1 `public.hour_disputes`

Core table for all dispute records.

```sql
CREATE TABLE public.hour_disputes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who filed it
  employee_email  TEXT NOT NULL,              -- work_email from global_master_list
  employee_name   TEXT NOT NULL,              -- snapshot at filing time
  department      TEXT,                       -- snapshot at filing time

  -- What period is disputed
  pay_period_start DATE NOT NULL,             -- e.g., 2026-03-24 (Tuesday of the week)
  pay_period_end   DATE NOT NULL,             -- e.g., 2026-03-30 (Monday end)
  disputed_date    DATE NOT NULL,             -- the specific day being disputed

  -- Current vs requested
  recorded_hours   NUMERIC(6,2) NOT NULL,     -- hours currently in hubstaff_hours for that day
  requested_hours  NUMERIC(6,2) NOT NULL,     -- hours the employee claims they worked

  -- Context
  reason           TEXT NOT NULL,             -- free-text: "forgot tracker", "power outage", etc.
  evidence_url     TEXT,                      -- optional link to screenshot, email, etc.

  -- Status
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn')),

  -- Manager resolution
  reviewed_by      TEXT,                      -- manager's email or auth user id
  reviewed_at      TIMESTAMPTZ,
  reviewer_notes   TEXT,                      -- reason for approval/denial
  hours_approved   NUMERIC(6,2),             -- may differ from requested_hours (partial approval)

  -- Timestamps
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_disputes_employee ON public.hour_disputes (employee_email, status);
CREATE INDEX idx_disputes_department ON public.hour_disputes (department, status);
CREATE INDEX idx_disputes_period ON public.hour_disputes (pay_period_start, pay_period_end);
```

### 4.2 `public.notifications`

Simple in-app notification system.

```sql
CREATE TABLE public.notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email TEXT NOT NULL,              -- who should see this
  type            TEXT NOT NULL               -- 'dispute_filed', 'dispute_reviewed', 'dispute_approved', 'dispute_denied'
                  CHECK (type IN ('dispute_filed', 'dispute_reviewed', 'dispute_approved', 'dispute_denied', 'system')),
  title           TEXT NOT NULL,              -- short summary
  body            TEXT,                       -- detail / markdown
  reference_id    UUID,                       -- links to hour_disputes.id (or other entity)
  reference_type  TEXT DEFAULT 'dispute',     -- extensible for future notification types
  read            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_recipient ON public.notifications (recipient_email, read, created_at DESC);
```

### 4.3 `public.department_managers`

Maps managers to their departments (a manager can oversee multiple departments).

```sql
CREATE TABLE public.department_managers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_email   TEXT NOT NULL,              -- work_email of the manager
  department      TEXT NOT NULL,              -- must match department values in global_master_list
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(manager_email, department)
);
```

### 4.4 `public.dispute_settings`

Global configuration for the dispute system (managed via System Settings).

```sql
CREATE TABLE public.dispute_settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed defaults
INSERT INTO public.dispute_settings (key, value) VALUES
  ('dispute_window_days', '7'),              -- employees can dispute up to 7 days after period ends
  ('max_hours_per_dispute', '12'),           -- max hours claimable in a single dispute
  ('require_evidence', 'false');             -- whether evidence_url is mandatory
```

---

## 5. API Routes

### 5.1 Employee-facing

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/my-hours` | GET | Get current employee's hours for a given pay period (from `hubstaff_hours`) | Employee (self only) |
| `/api/my-pay` | GET | Get current employee's pay breakdown (initial + bonuses) for a pay period | Employee (self only) |
| `/api/disputes` | GET | List disputes filed by the current employee (with status filter) | Employee (own disputes) |
| `/api/disputes` | POST | File a new hour dispute | Employee |
| `/api/disputes/[id]` | GET | Get a single dispute's full details | Employee (own) or Manager (team) |
| `/api/disputes/[id]/withdraw` | POST | Withdraw a pending dispute | Employee (own, pending only) |

### 5.2 Manager-facing

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/manager/team` | GET | List all employees in the manager's department(s) with hours + dispute counts | Manager |
| `/api/manager/disputes` | GET | List all pending/resolved disputes for the manager's department(s) | Manager |
| `/api/manager/disputes/[id]/review` | POST | Approve or deny a dispute (with notes + approved hours) | Manager |

### 5.3 Notification-facing

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/notifications` | GET | Get unread + recent notifications for the current user | Any authenticated |
| `/api/notifications/[id]/read` | POST | Mark a notification as read | Own notifications |
| `/api/notifications/read-all` | POST | Mark all notifications as read | Own notifications |

### 5.4 Admin

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/admin/disputes` | GET | All disputes across all departments (with filters) | Admin |
| `/api/admin/disputes/[id]/review` | POST | Override any dispute | Admin |
| `/api/admin/department-managers` | GET/POST/DELETE | Manage manager-department assignments | Admin |
| `/api/admin/dispute-settings` | GET/POST | View/update dispute system configuration | Admin |

---

## 6. UI Components

### 6.1 Employee Dashboard (`src/components/EmployeeDashboard.tsx`)

The default view for logged-in employees. Three sections:

**A. Weekly Summary Card**
- Current pay period dates (auto-detected from latest `hubstaff_hours`)
- Total hours (with reg/OT split)
- Daily hour bars (Mon–Sun, visual bar chart, highlight days < 7h)
- Status badge: "Finalized" / "In Progress" / "Pending Review"

**B. Pay Breakdown Card**
- Regular Pay = Reg Hours × Reg Rate
- OT Pay = OT Hours × OT Rate
- Bonuses (itemized: PA, Technology, department-specific)
- **Total Pay** (PHP, bold) with USD equivalent
- Historical toggle: dropdown to view past pay periods

**C. Disputes Panel**
- "File a Dispute" button → opens dispute form modal
- List of filed disputes (most recent first)
- Each dispute card shows: date, recorded vs requested hours, reason, status badge (pending/approved/denied), reviewer notes
- Filter tabs: All | Pending | Resolved

**Dispute Form Modal:**
- Pay period selector (auto-populated with current, can select past within window)
- Day selector (shows each day of the selected period with current hours)
- "Hours I Actually Worked" input (numeric, max governed by `max_hours_per_dispute`)
- "Reason" textarea (required) with suggested quick-fill tags:
  - "Forgot to start tracker"
  - "Tracker crashed / froze"
  - "Worked offline"
  - "Power / internet outage"
  - "Other (please specify)"
- Optional evidence URL field
- Submit button → POST `/api/disputes` → triggers manager notification

### 6.2 Manager Dashboard (`src/components/ManagerDashboard.tsx`)

Everything the Employee Dashboard has, **plus** team management. Two-panel layout:

**Left Panel — My Dashboard** (same as Employee Dashboard for the manager's own data)

**Right Panel — Team Management**

**A. Team Hours Overview**
- Table: employee name, total hours, reg/OT, current pay, dispute count (badge)
- Click a row → expand to see that employee's weekly breakdown
- Sort by: name, hours, disputes pending
- Department tab switcher (if manager oversees multiple departments)

**B. Pending Disputes Queue**
- Prominent count badge: "3 disputes pending review"
- List view, each card:
  - Employee name + avatar/initial
  - Disputed date + period
  - Recorded hours → Requested hours (with diff highlighted in amber/red)
  - Reason text (expandable)
  - Evidence link (if provided)
  - **Approve** button (green) — opens confirmation:
    - "Approved Hours" input (pre-filled with requested, can adjust for partial approval)
    - Optional notes
    - Confirm → POST `/api/manager/disputes/[id]/review` with `status: 'approved'`
    - → Creates notification for employee
    - → Recalculates pay (see Section 8)
  - **Deny** button (red) — opens confirmation:
    - "Reason for Denial" textarea (required)
    - Confirm → POST with `status: 'denied'`
    - → Creates notification for employee

**C. Dispute History Tab**
- All resolved disputes for the team
- Filterable by employee, date range, status (approved/denied)
- Export to CSV (future)

### 6.3 Notification Bell (`src/components/NotificationBell.tsx`)

Lives in the Sidebar or top bar. Shared by all roles.

- Bell icon with unread count badge (red dot with number)
- Click → dropdown panel with recent notifications
- Each notification: icon (by type), title, time ago, read/unread styling
- "Mark all as read" link
- Click a notification → navigates to the relevant dispute
- Polls `/api/notifications` every 30 seconds (or uses Supabase Realtime subscription)

### 6.4 Sidebar Updates (`src/components/Sidebar.tsx`)

- Show different nav items based on role:
  - **Employee**: My Dashboard, My Disputes
  - **Manager**: My Dashboard, Team Dashboard, Disputes Review
  - **Admin**: Overview, Rates, Payroll Wizard, All Disputes, System Settings
- Show logged-in user's name + role (replace hardcoded "Fran M")
- Notification bell with count

---

## 7. Navigation & Routing

Since the app is a single-page SPA (`activeTab` in `App.tsx`), add new tab values:

```typescript
type ActiveTab =
  | 'overview'
  | 'rates'
  | 'payroll'
  | 'hogan-suite'
  | 'disputes'         // existing placeholder → becomes admin disputes
  | 'settings'
  // New tabs:
  | 'my-dashboard'     // employee self-service
  | 'team-dashboard'   // manager team view
  | 'my-disputes'      // employee dispute list (also reachable from my-dashboard)
  | 'dispute-review';  // manager dispute queue
```

**Role-based default tab on login:**
- Employee → `my-dashboard`
- Manager → `my-dashboard` (with team panel visible)
- Admin / Payroll Manager → `overview` (existing behavior)

---

## 8. Pay Recalculation on Dispute Approval

When a manager approves a dispute, the system must:

1. **Update the source hours** — Modify the specific day column in `hubstaff_hours` for that employee's row. Also update "Total worked" to reflect the new total.
2. **Recalculate initial pay** — Re-run the CalcRow logic: new total hours → new reg/OT split → new reg pay + OT pay → new initial pay.
3. **Recalculate bonuses** — Re-check Perfect Attendance eligibility (if the corrected day now meets the 7h threshold, PA may flip on; if reduced, PA may flip off). Other bonuses may be affected.
4. **Store adjustment record** — Log the old vs new values in `hour_disputes.hours_approved` and optionally in an `audit_log` entry.
5. **Notify the employee** — Create a notification with the approved hours and new pay figures.

This recalculation can be:
- **Option A (MVP)**: Manual — manager approves, hours update in DB, next PayrollWizard run picks up the corrected hours automatically.
- **Option B (Full)**: Automatic — API endpoint runs the recalculation inline and stores updated pay figures in a `payroll_snapshots` table.

**Recommended**: Start with Option A for Phase 1. The PayrollWizard already reads from `hubstaff_hours` and recalculates everything. Approving a dispute just needs to update the hours in the DB.

---

## 9. Implementation Phases

### Phase 1 — Foundation (Database + API scaffolding)
**Estimated scope: Core tables + basic API routes**

- [ ] Create `hour_disputes` table in Supabase (run SQL)
- [ ] Create `notifications` table in Supabase
- [ ] Create `department_managers` table in Supabase
- [ ] Create `dispute_settings` table with seed values
- [ ] Build Supabase lib files:
  - `src/lib/supabase/disputes.ts` — CRUD for disputes
  - `src/lib/supabase/notifications.ts` — CRUD for notifications
  - `src/lib/supabase/department-managers.ts` — manager lookups
- [ ] Build API routes: `/api/disputes` (GET/POST), `/api/disputes/[id]`
- [ ] Build API routes: `/api/notifications` (GET), `/api/notifications/[id]/read`
- [ ] Add `auth_user_id` column to `global_master_list` (for future auth linkage)

### Phase 2 — Employee Dashboard
**Estimated scope: Employee-facing UI**

- [ ] Build `EmployeeDashboard.tsx` component
  - [ ] Weekly hours summary (fetch from `/api/my-hours`)
  - [ ] Pay breakdown card (fetch from `/api/my-pay`)
  - [ ] Daily hour bars visualization
- [ ] Build dispute filing form modal
  - [ ] Day selector with current hours display
  - [ ] Reason input with quick-fill tags
  - [ ] Validation (within dispute window, max hours, etc.)
- [ ] Build disputes list panel (pending/resolved)
- [ ] Add `my-dashboard` tab to Sidebar + App.tsx routing
- [ ] Build `NotificationBell.tsx` component (polling-based)

### Phase 3 — Manager Dashboard
**Estimated scope: Manager-facing UI + review flow**

- [ ] Build `ManagerDashboard.tsx` component
  - [ ] Team hours overview table
  - [ ] Employee detail expansion
- [ ] Build pending disputes queue
  - [ ] Approve flow (with partial approval support)
  - [ ] Deny flow (with required reason)
- [ ] Build API routes: `/api/manager/team`, `/api/manager/disputes`, `/api/manager/disputes/[id]/review`
- [ ] Implement hour update on approval (update `hubstaff_hours` row)
- [ ] Implement notification creation on dispute filed / reviewed
- [ ] Build dispute history tab with filters
- [ ] Add `team-dashboard` and `dispute-review` tabs to Sidebar

### Phase 4 — Admin Tools & Polish
**Estimated scope: Admin overrides + system settings**

- [ ] Build admin dispute overview (all departments)
- [ ] Build department-manager assignment UI (in System Settings)
- [ ] Build dispute settings configuration UI
- [ ] Add dispute count badges to Sidebar nav items
- [ ] Implement dispute window enforcement (reject disputes outside the allowed window)
- [ ] Add role-based Sidebar nav filtering
- [ ] Migrate notification polling to Supabase Realtime (optional upgrade)

### Phase 5 — Integration & Hardening
**Estimated scope: Connect to existing payroll flow**

- [ ] Ensure PayrollWizard Step 2 reflects dispute-adjusted hours
- [ ] Add "Disputes" column to Step 2 table (shows pending/approved count per employee)
- [ ] Add warning in Step 4 pre-flight if unresolved disputes exist
- [ ] Add RLS policies for `hour_disputes` and `notifications` tables
- [ ] E2E testing: file dispute → manager notification → approve → hours updated → payroll recalculated
- [ ] Mobile-responsive adjustments for employee dashboard

---

## 10. Dispute Flow Diagram

```
Employee                          System                         Manager
   │                                │                               │
   ├── Files dispute ──────────────►│                               │
   │   (day, hours, reason)         │                               │
   │                                ├── Creates dispute (pending)   │
   │                                ├── Creates notification ──────►│
   │                                │                               │
   │                                │              Reviews dispute ◄┤
   │                                │                               │
   │                                │◄── Approve / Deny ───────────┤
   │                                │    (notes, approved_hours)    │
   │                                │                               │
   │   ┌────────────────────────────┤                               │
   │   │ If approved:               │                               │
   │   │  • Update hubstaff_hours   │                               │
   │   │  • Recalc pay (next run)   │                               │
   │   └────────────────────────────┤                               │
   │                                │                               │
   │◄── Notification ──────────────┤                               │
   │   (approved/denied + notes)    │                               │
```

---

## 11. Key Design Decisions

| Decision | Rationale |
|---|---|
| **Disputes are per-day, not per-week** | Gives granularity — an employee may need to correct Monday but not Tuesday. Manager can review each day independently. |
| **Snapshot employee name/dept at filing time** | Prevents confusion if an employee changes departments after filing. The dispute record is self-contained. |
| **Partial approval supported** | Manager can approve fewer hours than requested (e.g., employee claims 8h, manager approves 6h based on evidence). |
| **MVP uses existing PayrollWizard for recalc** | Approving a dispute updates `hubstaff_hours` directly. The next PayrollWizard run automatically picks up corrected hours. No separate recalc engine needed initially. |
| **Notifications are polling-based first** | Supabase Realtime can be added later. Polling every 30s is simple and sufficient for the initial rollout. |
| **Department managers are a separate table** | Decoupled from roles — a Payroll Manager role doesn't automatically mean "manages the Accounting department." The `department_managers` table is an explicit assignment. |
| **Dispute window is configurable** | Different organizations may want 3 days, 7 days, or 14 days. Stored in `dispute_settings`, editable by Admin. |
| **Quick-fill reason tags** | Reduces friction for common dispute reasons. The employee can still type a custom reason. Tags are UI-only, not stored as structured data. |

---

## 12. Future Enhancements (Out of Scope for Now)

- **Email notifications** — Send an email when a dispute is filed/reviewed (requires email service integration).
- **File upload for evidence** — Allow attaching screenshots directly instead of just a URL (requires Supabase Storage).
- **Dispute analytics** — Dashboard showing dispute trends, frequent reasons, resolution times.
- **Auto-approve rules** — Auto-approve disputes under a certain hour threshold or from employees with a clean history.
- **Bulk dispute review** — Manager can approve/deny multiple disputes at once.
- **Pay period history page** — Full archive of all past pay periods with downloadable paystubs.
- **Mobile app / PWA** — Push notifications for dispute updates.
