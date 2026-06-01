# Simple HRIS: Component Reference

This document covers every UI component — what it renders, why it is designed that way, and all significant logic it contains.

---

## Dashboard Map

The app is no longer a single-operator tool. It is **eight role dashboards** that share one auth layer, one design system, and a pool of cross-cutting components (S-Wall, Announcements, Notifications, Presence, Audit). A logged-in user lands on a dashboard chosen from their roles and can hop between any they are entitled to via the in-sidebar **ViewSwitcher**.

| Dashboard | Route | Top component | Primary roles | What it does |
|---|---|---|---|---|
| Accounting | `/` -> `/accounting` | `src/App.tsx` | `payroll_coordinator`, `payroll_manager`, `finance`, `hr_coordinator`, `viewer` | The "Friday Path": Rates, Payroll Wizard, Payment Dispatch, Disputes, **MESA**, Settings |
| Admin | `/admin` | `app/admin/page.tsx` | `admin` | RBAC + feature permissions, employee directory, webhooks, CSV imports, diagnostics, audit |
| Employee | `/employee` | `EmployeeApp` | everyone except pure contractors | Self-service: hours, pay, PAB, disputes, leaves, profile, MESA/FPU, gifts, team |
| Manager | `/manager` | `ManagerApp` | `manager` | Department roster, leave approvals, KPI/HSL bonus calculators, medals, transfers |
| HR | `/hr` | `HrApp` | `admin`, `hr_coordinator` | Onboarding, offboarding, transfers, gift tracker, MESA/FPU, leaves |
| CEO | `/ceo` | `CeoApp` | `ceo` | Announcements, S-Wall, Notifications (executive analytics not yet built) |
| Orphanage | `/orphanage` | `OrphanageApp` | `orphanage_manager` | Orphanage-visit disputes + budget requests + tenure-gift tracking |
| Contractor | `/contractor` | `ContractorApp` | `contractor` | Self-authored invoices submitted to Accounting |
| Payroll Clerk | `/payroll-clerk` (+ Accounting "Payment Dispatch" tab) | `PayrollClerkApp` / `PayrollDispatch` | `payroll_*` | Pay the weekly cycle one transfer at a time per processor |

This reference is organized as: **Accounting dashboard** (the bulk of the historical doc -- App, Sidebar, Overview, Rates, PayrollWizard, Disputes, Orphanage visits, Leaves), then **each other dashboard**, then **Employee portal additions**, the **Orphanage budget/gift module**, and finally **shared / cross-cutting components** and the **shadcn primitives** appendix. Routing and access control are documented immediately below.

---

## Auth, RBAC & Role Routing

### Role-to-dashboard routing (the glue)

The view <-> route <-> role mapping lives in `src/lib/rbac/views.ts`. The eight `AppView`s and their `VIEW_ROUTES` are listed in the Dashboard Map above.

**End-to-end flow:**

1. **Middleware gate** (`middleware.ts`): every non-static, non-`/login`, non-`/api/auth/*`, non-`/onboarding/*` request requires a valid NextAuth JWT (`getToken`). A missing/neutralized token (no `email` and no `sub`) redirects to `/login?callbackUrl=<original>`. It also (a) bounces a **contractor-only** user off any `/employee*` path to `/contractor`, and (b) enforces `?email=` ownership: on personal routes (`/manager`, `/employee`, `/ceo`) a mismatched `?email=` is rewritten to the session email; on other page routes only **elevated** users may view another email. API routes enforce ownership server-side instead.
2. **Login** (`app/login/page.tsx`): Google SSO via NextAuth. After `useSession()` resolves it fetches `GET /api/employee-roles?email=`, computes `viewsForRoles(roles)`, and **always lands on `employee`** when present (otherwise `defaultViewFor`). Caches `SESSION_EMAIL_KEY`, `ACTIVE_VIEW_KEY`, and a role key into `sessionStorage`, then redirects to `VIEW_ROUTES[target]?email=` (or honors a safe `?callbackUrl=`).
3. **Root** (`app/page.tsx`): a thin client redirect -- always `router.replace('/employee')` (preserving any query string). Multi-role users hop elsewhere via the ViewSwitcher; there is no auto-jump to `/accounting`.
4. **`viewsForRoles(roles)`**: builds the allowed view set, then orders it by `VIEW_PRIORITY = [admin, ceo, hr, accounting, orphanage, manager, contractor, employee]`. `employee` is added for everyone **except** pure contractors.

`SESSION_EMAIL_KEY = 'employee_session_email'` and `ACTIVE_VIEW_KEY = 'active_view'` are the shared `sessionStorage` keys all dashboards read to discover "who am I / which view am I in." Every dashboard shell resolves its viewer from `?email=` (validated + normalized via `normEmail`, persisted to `SESSION_EMAIL_KEY`) and falls back to the stored value.

### `src/lib/rbac/views.ts`

Single source of truth for view/route/role mapping; used by login, ViewSwitcher, and every dashboard shell. Exports types `AppView`, `Role`; constants `VIEW_ROUTES`, `VIEW_LABELS`, `ACTIVE_VIEW_KEY`, `SESSION_EMAIL_KEY`; functions `viewsForRoles`, `defaultViewFor`, and the React hook `useAvailableViews(email)` (fetches `GET /api/employee-roles?email=`, returns `{ views, loading }`, defaults to `['employee']`). Roles are resolved client-side per email here, independent of the JWT `roles` claim -- so this list reflects live DB state even when a stale JWT has not refreshed.

### `src/components/rbac/ViewSwitcher.tsx`

Sidebar control that lets a multi-role user hop between their dashboards. Rendered inside every sidebar. **Returns `null` when `views.length <= 1`** (single-role users see nothing). On click it writes `ACTIVE_VIEW_KEY` to sessionStorage, then after a ~520 ms `ViewSwitchOverlay` animation `router.push(VIEW_ROUTES[view]?email=)` wrapped in `withViewTransition`. Props `{ email, currentView }`; only data access is the roles lookup via `useAvailableViews`.

### `src/lib/rbac/feature-permissions.ts`

Server-side **per-tab access overlay** layered on top of role grants. Today enforcement is wired only for the Accounting view (see `accounting-tabs.ts` + `App.tsx`), but the catalog covers `accounting | manager | hr | orphanage | ceo | contractor`. Exports `FEATURE_ACCESS_LEVELS` (`hidden`/`view`/`edit`), `FEATURE_CATALOG` (per-view tab list -- the source of truth for the AdminRoles grid and JWT shape), `ROLE_TO_FEATURE_VIEW`; types `FeatureAccess`, `FeatureViewKey`, `FeaturePermissionsMap`; functions `fetchFeaturePermissionsForEmail`, `resolveFeatureAccess` (defaults `hidden`), `canSeeFeature`, `canEditFeature`. Backed by Supabase table `employee_feature_permissions` (`work_email, view_key, feature, access`, filtered `revoked_at IS NULL`). **`admin` intentionally has no `ROLE_TO_FEATURE_VIEW` entry** -- admins bypass tab gating everywhere. The map is deliberately not stashed on the JWT (would exceed Node's ~8 KB header limit -> 431); clients fetch `GET /api/employee-feature-permissions?email=` instead.

### `src/lib/rbac/accounting-tabs.ts`

Computes which Accounting tabs a user may see, combining role grants with the feature-permission overlay; consumed by `src/App.tsx`. Exports `ACCOUNTING_TAB_IDS`, type `AccountingTabId`; `allowedAccountingTabsForRoles`, `allowedAccountingTabsForUser`, `canAccessAccountingTab*`, `accountingTabToFeatureKey`. `payroll_manager` without a privileged accounting role is restricted to `['overview','payment-dispatch','disputes']`; otherwise the role layer returns all tabs. `allowedAccountingTabsForUser` then filters by the overlay -- a tab survives only if its `employee_feature_permissions` access is `view`/`edit` -- except `admin` (in `BYPASS_PERMS_ROLES`). `TAB_TO_FEATURE` maps UI ids (e.g. `payroll-wizard`) to stored feature keys (`payroll_wizard`). **MESA tab** (`'mesa'` -> feature key `'mesa'`) was added 2026-06-01; it falls in the full-access tab set and is gated by the feature-permission overlay like all other tabs.

### `src/lib/auth/auth-options.ts`

NextAuth config (Google SSO, JWT sessions, no DB adapter), imported by the server entry points via `getServerSession`. The Google provider is restricted to the `simple.biz` Workspace (`hd` param + `signIn` callback rejecting non-`simple.biz`/unverified emails). On first sign-in the `jwt` callback fetches active roles from `employee_roles` (`fetchRolesForEmail`, service-role, `revoked_at IS NULL`) and stamps `token.roles`, `token.elevated`, `token.hd`; it also fire-and-forget persists the Google profile photo to `global_master_list.google_photo_url`. **Force-logout:** every `jwt` call checks `getForceLogoutEpochFor(email)`; if the cutoff `iat` is newer than the token's, it returns `{}` to neutralize the session (middleware then redirects to `/login`). Roles are baked into the JWT only at sign-in -- a user must sign out/in to pick up role changes; the force-logout map (written on role revoke + feature-permission changes) is the escape hatch admins use to invalidate immediately.

### Auth entry-point pages

- **`app/page.tsx`** -- client-only `Suspense`-wrapped root redirect to `/employee` (preserving query string). No data.
- **`app/accounting/page.tsx`** -- server entry for Accounting; renders `AppShell` (`src/App.tsx`). Runs `getServerSession`; if `hasAccountingRole(roles)` it `prefetchAccountingData()` and passes it as `initialData` so `App` skips mount-time fetches (best-effort try/catch). The other dashboard pages (`manager/hr/ceo/orphanage/contractor/page.tsx`) are simpler `Suspense` wrappers around their `*App` client component, no server prefetch.
- **`app/login/page.tsx`** -- the Google SSO sign-in screen (marketing left panel + "Continue with Google" card). Turns NextAuth `?error=` into a sonner toast. `signIn('google', { callbackUrl: '/login' })`; data via `GET /api/employee-roles?email=`.
- **`src/components/employee/EmployeeLogin.tsx`** -- legacy email + password login (password = `MMDDYY` of start date), an alternate/embedded path; `POST /api/employee-login`, forgot-password via `POST /api/employee-forgot-password`. Distinct from the Google SSO page.
- **`src/components/auth/NextAuthProvider.tsx`** -- client root provider; wraps the tree in NextAuth `SessionProvider` and `PresenceProvider` so `useSession()` and app-wide presence are available everywhere.

---

## `src/App.tsx` — Root Shell

The top-level `"use client"` component. Owns the `activeTab` state (string), `mobileNavOpen` for the off-canvas nav below the `md` breakpoint, resolves dark/light theme from `next-themes`, and renders the two-column layout: `<Sidebar>` on the left and the active view on the right.

On viewports narrower than `md` (768px), a top bar with a menu button opens the sidebar as a fixed drawer; backdrop tap or **Escape** closes it. `navigate()` wraps tab changes and closes the drawer.

Also renders a global `<Toaster>` (sonner) for toast notifications that can be triggered from any child component.

See [RESPONSIVE-DESIGN.md](../design/responsive-design.md) for breakpoints, safe areas, and testing notes.

**RBAC tab gating** (no longer single-operator). On mount `App` fetches the viewer's roles (`GET /api/employee-roles`) and feature permissions (`GET /api/employee-feature-permissions`) in parallel, then computes `allowedAccountingTabsForUser(roles, featurePerms)`. `navigate()` and a settling effect bounce the user off any tab they cannot access (onto `allowedTabs[0]` or `payment-dispatch`), but only after `permsLoaded` flips so the initial render does not kick a non-admin off `overview`. `initialData` (from the server prefetch in `app/accounting/page.tsx`) lets Overview + PayrollWizard skip mount-time fetches.

The `activeTab` cases are: `overview` -> `Overview`, `rates` -> `Rates`, `payroll-wizard` -> `PayrollWizard`, `payment-dispatch` -> `PayrollDispatch` (the same component the Payroll Clerk shell uses), `disputes` -> `PabDisputeQueue`, `mesa` -> `AccountingMesa`, `notifications` -> `NotificationsPanel`, `settings` -> `SystemSettings`, `announcements` -> a general announcement composer + wall, `s-wall` -> `SWall`. `canPostGeneral`/`isElevated` derive from roles to gate posting.

---

## `src/components/payroll/PabDisputeQueue.tsx`

**Accounting → Disputes.** Lists `pab_day_disputes` via `GET /api/pab-disputes` with `awaiting_accounting=1` when the status filter is **Pending** (so Accounting sees both plain `pending` and `orphanage_manager_approved` rows). Search, pagination, and filters for Approved / Denied / All.

**Manager-submitted note display.** For orphanage-style rows (`orphanage_visit` + `ceo_visitation`, tested via `isOrphanageStyleReason`), the **Explanation** column widens to 240–320px, drops truncation, and renders a small "Manager note" badge before the text — Carla reads Alyson's submission context before deciding without expanding any row.

**Actions (gated by `DISPUTE_ACTOR_ROLES` from `/api/employee-roles`):**

- **Approve / Deny** — for rows awaiting Accounting (`pending` or `orphanage_manager_approved`). Orphanage-style rows do not collect hour overrides at approval (manager-submitted disputes always have `override_hours = null` and the field is hidden); other reasons can set override hours in the dialog.
- **Return** — only for orphanage-style with `orphanage_manager_approved`; calls `PATCH` with `return_to_orphanage` and optional note.
- **Edit** — for terminal rows. Toggle Approved/Denied, adjust hours (non-orphanage-style), notes. When the row currently grants PAB forgiveness (`disputeGrantsPabForgiveness`), shows **Revoke PAB forgiveness** → confirm dialog → `PATCH` `edit` with `status: denied` and `override_hours: null`.
- **Delete** *(2026-05-02)* — trash icon button gated by `DISPUTE_DELETE_ROLES` (`admin`, `payroll_manager`). Available on rows in **any** status. Confirmation dialog warns when deleting a previously-decided dispute. On confirm, calls `DELETE /api/pab-disputes/[id]?mode=admin`. Audit log: `pab_dispute.admin_deleted`. See [docs/delete-authorization.md](../features/delete-authorization.md).

All reason-specific gating uses `isOrphanageStyleReason(reason)` rather than the literal `reason === 'orphanage_visit'` check — so `ceo_visitation` follows the same hour-override / two-stage approval / day-after-removed semantics as orphanage_visit.

See [BUSINESS_LOGIC.md](./business-logic.md#pab-day-dispute-system) and [API_REFERENCE.md](./api-reference.md#patch-apipab-disputesid).

---

---

## `src/components/payroll/AccountingMesa.tsx` *(added 2026-06-01)*

**Accounting -> MESA.** Review queue for employee-submitted MESA requests (opt-in, opt-out, disbursement, return). Replaces the meeting ask for "a MESA tab in Accounting sidebar for mid-week disbursements."

**Layout**: header with stats strip (Total / Pending / Approved / Denied counters), toolbar (free-text search + status filter dropdown + type filter dropdown + Refresh), and a paginated table.

**Table columns**: Employee (name + email), Department, Type (badge), Details (FPU date, disbursement reason + explanation excerpt, return notes), Amount (PHP), Status badge, Submitted date, Action.

**Review modal**: clicking **Review** on a `pending` row opens a modal with all submission fields expanded — email, department, FPU date, disbursement reason + explanation, amount — plus a **Review Notes** textarea (optional), and **Approve** / **Deny** buttons. Approve/Deny calls `PATCH /api/mesa-requests/[id]` with `{ status, review_notes }`. On success the cache is cleared and the table refreshes.

**Module-level cache** (`cachedRequests`) avoids re-fetching when navigating away and back within the session; the Refresh button clears it.

| Endpoint | Use |
|---|---|
| `GET /api/mesa-requests` | list all requests (elevated) |
| `PATCH /api/mesa-requests/[id]` | approve or deny a pending request |

---

## `src/components/orphanage/CreateOrphanageStyleDisputeDialog.tsx`

**Shared bulk-create dialog** for orphanage-style disputes (`orphanage_visit`, `ceo_visitation`). Used by both:

- **Alyson's Orphanage view** (`OrphanageApp.tsx`) — the "+ Create disputes" button in the header.
- **Carla's Accounting Orphanage Visits queue** (`payroll/OrphanageVisits.tsx`) — same button, separate from the legacy single-row admin form.

**Layout**: two-column, `max-w-[1200px] w-[95vw]`. Left column: reason dropdown, multi-employee picker (chips + search across `name / work_email / personal_email / department`), optional note textarea. Right column: PAB-style calendar grid (Mon–Fri, week numbers, 5-column).

**Per-person dates.** State holds `selectedEmployees: string[]` and `perPersonDates: Map<email, Set<dispute_date>>`. Clicking a person chip activates them; the calendar swaps to that person's hours. Each chip shows a count badge (`Kane [3]`) of dates picked. Different people can have completely different forgiveness dates.

**Calendar awareness.** Pre-fetches three datasets in parallel from the parent on mount:
1. **Roster** via `/api/employee-rate-profiles/summary` (same as Rates).
2. **Hubstaff hours** via `fetchHoursByEmployee` (`src/lib/hubstaff/fetch-hours-by-employee.ts`).
3. **Existing orphanage-style disputes** via `fetchOrphanageOverlap` (`src/lib/pab-disputes/fetch-orphanage-overlap.ts`).

Each cell renders one of six states based on the active person's data:

| State | Color | Clickable? |
|---|---|---|
| Picked this session | Pink ring + shadow | ✅ click to un-pick |
| Existing `accounting_approved` | Emerald + ring | ❌ "already forgiven" |
| Existing pending stage | Amber + ring | ❌ "pending review" |
| Existing denied | Rose | ❌ "previously denied" |
| Hubstaff ≥ 7h, no dispute | Emerald (no ring) | ❌ "already passes" |
| Hubstaff < 7h, no dispute | Red | ✅ "click to forgive" |

The click guard (`isClickable = !noActive && !existing && (isBelow7h || isPicked)`) prevents the user from re-picking a day that already has a dispute on file — the "already on file" 23505 path on the server is now a defence-in-depth fallback, not a UX path.

**Submit pivot.** `handleSubmit` groups per-person dates by date (`peopleByDate: Map<dispute_date, email[]>`) and sends one `POST /api/pab-disputes/orphanage-manager-submit` per date with the matching subset of people. Counts aggregated into a single toast: `"3 disputes sent to Accounting · 1 skipped (already on file)"`.

---

## `src/components/orphanage/OrphanageApp.tsx`

**Orphanage Manager view** (Alyson). Sidebar with view-switcher, dispute queue table for `pending_orphanage_manager` rows, and a "verified for Accounting" receipt log of `orphanage_manager_approved` rows.

**"+ Create disputes" button** in the header opens `CreateOrphanageStyleDisputeDialog`. Parent pre-fetches roster + Hubstaff hours + existing orphanage disputes on mount and passes them to the dialog as props — opening the dialog is instant.

The legacy "verify or deny pending orphanage_visit submitted by employee" flow continues to work for any in-flight `pending_orphanage_manager` rows; new dispute creation is exclusively via the dialog.

---

## `src/components/payroll/OrphanageVisits.tsx`

**Accounting → Orphanage Visits** queue. Lists `accounting_approved` orphanage-style visits.

**Two creation paths coexist:**
- **Single-row admin form** (legacy) — directly inserts at `accounting_approved` via `adminCreateOrphanageVisit`. Used for one-off admin shortcuts that bypass the manager step.
- **"+ Create disputes" dialog** (`CreateOrphanageStyleDisputeDialog`) — manager-submitted, two-stage. Pre-fetches roster, hours, existing-disputes overlap on mount.

UI copy was updated 2026-05-01 to drop the "and the following day" language (D+1 auto-forgiveness rule was removed).

---

## `src/components/LeaveRequestsPanel.tsx`

Shared leave-request queue mounted by both **Accounting** (`/`) and **Manager** (`/manager`) dashboards.

**Stats strip**: pending / approved / rejected counts.

**Filters**: status (all / pending / approved / rejected / cancelled), free-text search across name, email, department, type, reason, dates.

**Table columns**: Employee, Dept, Type, Dates (with day count), Manager, Status, Action.

**Per-row actions:**

- **Approve / Reject** — only on `pending` rows. Opens a dialog requesting the approver email + optional note. The approver must satisfy at least one of the four authorization paths (stored manager, live `department_managers`, legacy json map, or settings allow lists). See [API_REFERENCE.md](./api-reference.md#patch-apileave-requestsid).
- **Delete** *(2026-05-02)* — trash icon button gated by `LEAVE_DELETE_ROLES` (`admin`, `payroll_manager`, `manager`). Visible on rows in any status when the user holds one of those roles. Confirmation dialog warns when deleting a previously-actioned request. On confirm, calls `DELETE /api/leave-requests/[id]`. Audit log: `leave.admin_deleted` with `details.scope = 'unrestricted' | 'department'`. Managers are scoped to their own department server-side via `isAuthorizedLeaveApprover`. See [docs/delete-authorization.md](../features/delete-authorization.md).

---

## `src/components/Sidebar.tsx`

**Layout**: Fixed-width (`w-64`), full height (`h-dvh`), flex column. Below `md`, the sidebar is `fixed` with a slide-in transform; `mobileOpen` (from `App`) controls visibility. From `md` up it is `static` in the flex row. Background uses the orange-to-white gradient (light) or navy gradient (dark) from CSS variables.

**Nav items** (top section, RBAC-filtered): the full set is Overview, Rates, Payroll Wizard, Payment Dispatch, Disputes, **MESA**, Announcements, Notifications, System Settings, and a separately-styled (violet) S-Wall button. The list is filtered to `allowedAccountingTabsForRoles(roles)` so each user sees only their permitted tabs. The **Notifications** item shows an animated unread-count badge (`useEmployeeNotificationsUnread`) or, when unread is 0 but payroll processing is active, a pulsing red dot (`useDispatchLock`).
- Active item: orange gradient background, right-aligned chevron icon, bold text
- Inactive item: ghost hover state, muted text
- Icons from `lucide-react`; logo has a periodic "heartbeat" pulse

**Bottom section** (pinned via `mt-auto`):
- `<ViewSwitcher email currentView="accounting">` for multi-role users (hidden if the user has only one view).
- Dark mode toggle wrapped in `withViewTransition()` for the cross-fade.
- User card: shows the **real signed-in email + live roles** (from `GET /api/employee-roles`) and an `<EmployeeAvatar>` (Google photo -> uploaded -> Gravatar -> initials via `useViewerProfilePhoto`). The old hardcoded "Fran M / Senior Admin" is gone.
- Sign Out: clears `SESSION_EMAIL_KEY` and calls NextAuth `signOut({ callbackUrl: '/login' })` -- it is now wired, not a placeholder.

**Design rationale**: On laptop and desktop, the sidebar stays visible for orientation during long payroll workflows. On phones and small tablets, it becomes a drawer so content can use the full width.

---

## `src/components/Overview.tsx`

The dashboard view. Loaded when `activeTab === "overview"`.

### CSV Source Selector

A `<select>` dropdown in the header allows switching between:
- **All Time** (`__all__`): fetches every source file individually, accumulates payroll rows, splits regular/OT per file per employee (same per-file split logic as the Employee Dashboard), then sums.
- **Specific file**: fetches that single file's data.
- **Default**: the latest file (lexicographically last, which corresponds to the most recent week for ISO-style filenames).

A loading spinner appears beside the dropdown while stats are recomputing.

### Stat Cards (top row — 4 cards, responsive grid)

| Card | Value Source | Notes |
|---|---|---|
| Total Payout | Computed live from selected Hubstaff file + rate map | Sum of all `initialPay` values; reacts to CSV selector |
| Active Workers | Distinct work emails in selected payroll data | Count of unique employees in the selected file(s) |
| In Payroll not in Master | Cross-reference payroll emails vs master list | Potential unregistered contractors |
| In Master not in Payroll | Cross-reference master list vs payroll emails | Employees missing from Hubstaff this period |

**Total Payout computation** runs in-browser after both Hubstaff data and rates resolve. For "All Time", hours are accumulated per employee across files with per-file regular/OT split, then pay is computed from the summed seconds. Stat card subtexts adapt to show the source (filename or "all uploads combined").

### Employee Table (middle-left, spans 2/3 of second row)

- Columns: Employee ID, Department, Name, Personal Email, Start Date
- **Pagination**: `PAGE_SIZE = 5`. `buildPageRange()` helper generates an ellipsis-aware array (e.g., `[1, 2, '...', 8, 9, 10]`) for the page buttons.
- **Search**: Filters across all rendered columns simultaneously (case-insensitive string match).
- **Department filter**: Dropdown that extracts unique department values from the data.
- Employee IDs are assigned by `generateEmployeeIds()` from `src/lib/supabase/employees.ts` — format `YYMM-NNNN`, grouped by start-date month, sorted by first name within group.

### Bonus & Status Panel (middle-right, 1/3 of row)

Three real metric sections replacing the old hardcoded "System Health" panel:

**Perfect Attendance Bonus**
- Fetches all source files on mount, merges per-employee data with canonical-to-ISO column resolution (same `resolveCanonicalColumnsToIso()` logic as the Employee Dashboard), then evaluates PAB eligibility for every employee using `buildPabCalendarWeeks()`.
- Shows: PAB period label (e.g., "Mar 2026"), eligible count (green), not eligible count (red), progress bar with percentage (eligible / total).
- Loading state with spinner while computing across all files.

**Technology Bonus**
- Fixed ₱1,850 per employee per cycle.
- "Payroll Discretion" badge — applied manually by the operator, not auto-computed from hours.

**Dispute Requests**
- Pending / Resolved / Rejected counts with color-coded icons.
- Currently shows 0 for all with a note that the dispute system is planned.
- Ready to wire up once the `hour_disputes` table and dispute API are implemented.

---

## `src/components/Rates.tsx`

Employee rate profile viewer with add/edit/delete capabilities.

### Data Loading

On mount, fetches two endpoints in parallel:
- `/api/employee-rate-profiles` — full merged profiles from all tables
- `/api/employee-ids` — explicit ID overrides

If the profile response includes merge errors (a `mergeNotes` field), a yellow banner appears at the top explaining which tables were inaccessible or blocked by RLS.

### Cards & Table Views *(view toggle added 2026-05-02)*

A sliding pill toggle in the toolbar (right of the rate filter) switches between **Cards** and **Table**, persisted to `localStorage` under `rates-view-mode`. The toggle is hidden under `md` because the table doesn't fit phones — mobile always renders cards. Active-pill animation uses `motion.layoutId="rates-viewmode-pill"` (same spring as the Overview view toggle).

- `PAGE_SIZE = 12`
- **Card view**: 1-column on mobile, 2-column at `sm`, 3-column at `xl`. Each card shows avatar + name + status pill, ID/department/organization chips, work email, Regular/OT rate tiles, and an action bar (View / Suspend·Unsuspend / Delete).
- **Table view**: 8 columns — Employee (avatar + name + organization), ID, Department, Email, Regular, OT, Status (Complete / Master only / Rates blank / Suspended), Actions (View / Suspend·Unsuspend / Delete as ghost icon buttons). Sticky header with the orange-blue gradient; hover row tint; suspended rows dim to 75% opacity.
- **Employee Avatar**: Each row shows an `<EmployeeAvatar>` beside the name — fallback chain is **Google SSO photo → uploaded photo → Gravatar → initials**. Photo URL, Google photo URL, and email extracted via `getAvatarInfoFromSummary()`. Google photos require migration `references/seed_global_master_list_google_photo.sql` and per-user sign-in to populate the `google_photo_url` column.
- Search: filters across name, emails, department, employee ID
- Rates formatted as `₱X,XXX.XX` using `en-PH` locale
- Employee ID shown if found in the ID map; otherwise `—`

**`tableRowFromProfile()`**: Extracts flat values from a nested profile by building a normalized field map (`buildNormFieldMap()`), then looking up canonical keys like `work_email`, `regular_rate`, `ot_rate`, `department`.

**`buildNormFieldMap()`**: Iterates all profile fields, normalizes each key with `normFieldKey()` (lowercases, replaces spaces with underscores), and indexes them. This lets the table work regardless of whether columns come from a table using `"Work Email"` or `work_email`.

**Hidden fields**: Fields with keys matching `profile_photo_url`, `photo_url`, `avatar_url` (and variants) are filtered from the displayed field list via `isHiddenField()`. The photo is shown visually via the avatar instead of as a raw URL string.

### View Profile Modal

Triggered by the eye icon. Opens a `<Dialog>` up to 1,200px wide.

**Sections**:
1. **Header**: Large avatar (h-14 w-14) on the upper left with ring border, display name + employee ID badge to the right, department + organization badges below, email subtitle.
2. **Quick Rate Editor**: Shows current regular and OT rates. "Edit" button opens inline inputs. "Save" calls `POST /api/update-employee-rates`. "Cancel" restores original values. "Edit Profile" button opens inline form for name, department, emails, start date.
3. **All Fields**: Rendered as a `<dl>` grid. Each field is a `<motion.div>` with staggered fade-in (`delay: i * 0.01`, capped at 0.28s). Date fields (keys containing `date` or `start`) are auto-formatted to "January 1, 2025" using `Date` constructor. Photo URL fields are filtered out (shown as avatar in header instead).

### Add Employee Modal

Fields: Name (required), Department, Work Email, Personal Email, Start Date, Regular Rate, OT Rate.

On submit: calls `POST /api/add-employee` which inserts to both `employee_hourly_rates` and `global_master_list`. After success, re-fetches profiles to refresh the table.

### Delete Confirmation Modal

Triggered by trash icon. Shows the employee name + email. On confirm: calls `DELETE /api/delete-employee`. The API removes from both tables. After success, re-fetches profiles.

---

## `src/components/PayrollWizard.tsx`

The core feature. A multi-step wizard for the weekly payroll cycle, called the **"Friday Path"**. Steps: Upload & Preview → Initial Calculation → Additions → Validation → HSL Payroll → Contractors → Dispatch.

**Step navigation**: Left sidebar shows numbered steps with a `layoutId="active-indicator"` animated pill (Framer Motion) that slides between steps. Forward/back buttons in each step. Steps are rendered as `<motion.div>` wrappers inside `<AnimatePresence>` — entering steps slide in from the right (+x), exiting steps slide out to the left (-x), and the direction reverses when going back.

---

### Step 1 — Upload & Preview

**Purpose**: Load existing Hubstaff data from the DB and allow uploading a new CSV.

**On mount**: Fetches `GET /api/hubstaff-hours`. Both the service-role and anon-key paths now return the same JSON shape: `{ columns, rows, payrollRows, error }`. The service-role path uses `fetchHubstaffRowsOrdered()` (OpenAPI column discovery); the anon path does a direct `select("*")` and builds the same structure. This ensures `hubstaffDisplayColumns` and `hubstaffDisplayRows` are always populated.

**Table lock mechanism**: Once Hubstaff data is present (`hubstaffDisplayRows.length > 0`), the component sets `hubstaffTableLocked = true`. The upload area shows a "Data locked" badge and the table is rendered. A "Replace data" button sets `hubstaffTableLocked = false`, which shows the upload button again. This prevents accidental re-upload mid-wizard.

**CSV upload flow**:
1. File chosen via `<input type="file">`.
2. SHA-256 hash computed client-side (`src/lib/hash.ts`).
3. If hash matches last uploaded file: show duplicate-data approval dialog.
4. Approval dialog confirmed → `POST /api/hubstaff-hours` with CSV as `FormData`.
5. On success: **the CSV text is re-parsed client-side** using `parseCsv()` and `buildHubstaffDataFromParsedGrid()`. This sets `hubstaffDisplayColumns` and `hubstaffDisplayRows` directly from the CSV — not from a Supabase re-fetch.
6. **Why client-side re-parse?** The Supabase table may have ISO date column names (`"2026-03-24"`) while the CSV has Hubstaff-format names (`"Mon 3/24"`). Even with the server-side date-aware column mapping, there can be cases where daily column values end up as `null` in Supabase (e.g., different week's dates). Parsing client-side guarantees the daily breakdown data is always available for Perfect Attendance detection in Step 3.
7. Store hash, lock table. The previous `loadHubstaffPreview()` call is skipped — the CSV data is authoritative.

**Preview table**:
- Up to 8 columns shown. Priority order: Member, Email, Total Worked, Overtime Hours, Activity, Spent Total, Organization, Time Zone. Remaining actual columns fill slots after these.
- A computed `__overtime__` pseudo-column is inserted showing OT hours > 40 in indigo text.
- Pagination: 15 rows/page, compact `«‹›»` buttons.
- Search filters across all visible column values.

**Hogan Cycle toggle**: A `<Switch>` that sets an `isHoganCycle` flag. This marks the upload as the Mon–Sun cycle (Hogan Smith Law) vs the standard Tue–Mon cycle. Currently a flag only — no filtering logic changes downstream.

---

### Step 2 — Initial Calculation

**Purpose**: Compute base pay for every Hubstaff employee by matching them to their hourly rates.

**`CalcRow` type** (defined inline):
```
{
  member: string
  email: string          // Hubstaff email
  totalHours: number     // decimal
  regularHours: number   // min(total, 40)
  otHours: number        // max(0, total - 40)
  regularRate: number    // from employee_hourly_rates
  otRate: number         // from employee_hourly_rates
  regularPay: number
  otPay: number
  initialPay: number
  matched: boolean       // false if no rate found
}
```

**Overtime rule**: 40-hour weekly threshold. `regularHours = Math.min(totalHours, 40)`, `otHours = Math.max(0, totalHours - 40)`.

**Rate matching**: Email from Hubstaff row is normalized → looked up in the rate map from `indexHourlyRatesByEmail()`. If no match, `matched: false`, rates default to 0, initialPay is 0.

**Table design**: Frozen header (sticky `position: sticky top-0`), horizontally scrollable, tall fixed height. 10 columns. OT-related values (OT Hrs, OT Rate, OT Pay) rendered in `text-indigo-600` to visually separate them from regular pay columns. Unmatched employees shown with an orange warning badge.

**"Refresh Rates" button**: Re-fetches `/api/employee-hourly-rates` and rebuilds the calc rows without leaving the step.

**Currency**: Philippine Peso `₱` with `en-PH` locale formatting (`toLocaleString("en-PH", { style: "currency", currency: "PHP" })`).

---

### Step 3 — Additions (Department Bonuses)

**Purpose**: Apply per-department bonus rules on top of initial pay.

**15 department tabs** (rendered as `<Tabs>`):
Accounting, Edit, Devs, Lead Gen, US-Manager Bonus, Callback, QC, Discovery, HR, Sales Assistant, Smart Staff, Hogan Smith Law, Social Media, PM Team, Client VA, Site Building.

#### Department Auto-Assignment

Runs as a `useEffect` after calc rows are available. For each Hubstaff employee, tries 4 resolution tiers in order, stopping at the first match:

1. `personal_email` from their rate row → look up in master list → use `Department`
2. `name` from rate row → name match in master list → use `Department`
3. `work_email` from rate row → look up in master list → use `Department`
4. Hubstaff row `Job type` field → use as department string directly

Manual tab clicks override the auto-assignment. Once a user manually assigns someone, the effect will not overwrite it on re-render.

The **unassigned count** badge in the header shows how many Hubstaff employees have no department yet.

#### Perfect Attendance Auto-Detection

**Data source**: `hubstaffDisplayRows` — the raw row data with daily columns. After a CSV upload, this comes from the **client-side CSV re-parse** (not Supabase), so daily values are always present. On initial page load (no upload this session), it comes from Supabase — daily columns may be `null` if the original upload had a column-name mismatch (see Step 1 notes). When all daily values are null, a `dailyDataMissing` flag is set and an amber warning banner appears telling the user to re-upload.

**Weekday column detection** (`colIsWeekday()`): Uses a two-tier approach:
1. **Day-name prefix** takes priority: if the column starts with `Mon`, `Tue`, `Wed`, `Thu`, or `Fri` (short or full names like `Monday`), it is a weekday regardless of the date portion. This is authoritative because Hubstaff CSV headers always label the correct day.
2. **ISO date fallback**: for columns without a day-name prefix (e.g., `"2026-03-24"`), `parseColDate()` parses the date and `getDay()` determines the day of week.

`colDayPrefix()` + `DAY_PREFIX_MAP` drive identification, `colDayOrder()` sorts them Mon→Fri, and `dayLabel()` / `dayLetter()` produce the display labels.

**Per-employee eligibility** (`perfectAttendanceEligible` useMemo):
- Filters `hubstaffDisplayColumns` to weekday columns.
- For each employee row, parses every weekday cell to integer seconds with `rawValueToTotalSeconds()`.
- If **all** weekday values ≥ 25,200 seconds (7 hours), the employee is added to the eligible set.

**Per-employee breakdown** (`employeeWeekdayHours` useMemo):
- Maps each employee's normalized email to an array of `{ col, seconds, passes, forgivenByDispute }` for each weekday column in the PAB range.
- Used by the PAB cell pill and by the **PAB Calendar modal** (clickable from any cell in the Additions table) to render a full month view with per-day ✓/✗/★ states.

**Tri-state PAB pill** (`pabStatusByEmail` useMemo): the Additions table pill and the calendar-modal badge display **Eligible** / **Ineligible** / **In Progress** based on:
- Any past weekday in the PAB range with `!passes` → `ineligible` immediately (verdict locks, future days can't salvage the month).
- Today ≤ `pabMonthRange.end` with no past failures → `in_progress`.
- Period ended with all weekdays passing → `eligible`.

The underlying `perfectAttendanceEligible` set is still strict-pass only; this memo is display-only so in-progress months don't read as "Ineligible" just because future weekdays haven't happened yet.

**Auto-apply effect**: When `perfectAttendanceEligible` recomputes, a `useEffect` auto-toggles the `perfect_attendance` bonus for all department-assigned employees. Manual overrides after the effect are preserved.

#### PAB settings modal (Additions header)

PAB period configuration lives in the Payroll Wizard, not System Settings. A compact button in the Additions header (showing the active month + date range + any "Custom" badge) opens a modal containing:

- **Year navigation** (prev/next year arrows) scoping the month grid.
- **12-month picker**: each month pill shows a green dot when at least one Hubstaff date column falls in that month's range (`pabMonthDataCoverage` memo), an amber dot when a per-month override is saved, and a "Now" badge on today's PAB month. Months with no Hubstaff data are non-selectable (dashed border) — the constraint is *"a month can only be selected if it has data to evaluate"*, except the current month which is always selectable.
- **Active-month editor**: start/end date inputs that auto-save as an override for the selected month, plus **Auto-calc** (writes the canonical `getPabMonthRange(year, month)` window) and **Reset override** (deletes the override so the default formula takes over).
- **Refresh** — re-fetches PAB settings and Hubstaff uploads.

Storage keys: `pab_period_overrides` (JSON map), `pab_period_active_month` (`"YYYY-MM"`). Legacy `pab_period_manual`/`_start`/`_end` still honored on read and auto-migrated. See BUSINESS_LOGIC §"PAB period configuration" for the detailed schema.

#### Common Bonuses (all departments)

| Bonus | Amount | Type |
|---|---|---|
| Technology Bonus | ₱1,850 | Toggle |
| Perfect Attendance | ₱5,000 | Auto-toggle (can be overridden) |

#### Per-Department Bonus Logic

**Toggle-based** (on/off per employee):
- **US-Manager Bonus**: Leadership Bonus ₱3,500, Team Performance ₱3,000
- **Hogan Smith Law**: Case Resolution Bonus ₱3,000, Compliance & Accuracy ₱2,500
- Social Media, PM Team, Client VA, Site Building: have toggle UI but no specific bonuses defined yet

**Formula-based** (requires metric input):

| Department | Input | Formula |
|---|---|---|
| Accounting | Collected count | ≥30 → ₱450; 22–29 → ₱300; 17–21 → ₱200; else ₱0 |
| Edit | Ticket count | ₱50 per ticket |
| Devs | Ticket count + flags | ₱50/ticket; site delivery ₱50; specific named employees get ₱250 for checking work |
| Callback | Appointments + leads | ₱50/appt; plus internal lead-gen tier applied to callback employees |
| QC | Units sold + pool | Pool = units sold × ₱125–150 ÷ member count; Jerome Rosero exception: units×₱30 + callback×₱50 |
| Discovery | Prior week units | ₱25 per unit |
| HR | Headcount + new hires | Pool = headcount × ₱1,000 ÷ new hire count; "Teal" excluded from pool |
| Sales Assistant | Sales count | ₱150 per sale |
| Smart Staff | Appointments | ₱250 per appointment |

**Lead Gen**: Explicitly disregarded per company policy. Employees auto-assigned here see no bonus options.

#### Right Column Table

For each department tab, shows a table of that department's employees:
- Name, Hours (from calc), Metric input (number field for formula depts), Bonus toggles, **Additions** (separate editable field), **Deductions** (separate editable field), Per-employee bonus total, Final Pay (initial + bonuses)
- Footer row: department totals

Additions and Deductions are kept in **separate columns** (not a combined net-adjustment field) so accounting can clearly report each component. An employee may carry a bonus, an addition, and a deduction in the same week.

---

### Step 4 — Pre-Flight Validation

**Purpose**: Review the full payroll before dispatch.

**Three summary cards**:
- Total Initial Pay (sum of all calc rows' `initialPay`)
- Total Bonuses Added (sum of all bonus amounts from Step 3)
- Grand Total Payout + coverage ratio (employees with hours ÷ total master list employees)

**Full breakdown table**: All employees sorted by name. Columns: Department badge (or "Unassigned" in muted), Hours, Initial Pay, Bonuses, Final Pay. Grand total footer row.

**Validation checklist** (6 items, checkmark/warning icon):
1. Hubstaff Hours Uploaded
2. Initial Calculations Complete
3. All Employees Department-Assigned
4. Perfect Attendance Evaluated
5. Cycle Separation (Hogan toggle checked)
6. Master List Coverage (from `comparePayrollToMaster`)

**`comparePayrollToMaster()` from `src/lib/payroll/compare-to-master.ts`**:
- Builds a Set of all master personal emails (normalized).
- Maps each Hubstaff email to their max hours.
- Counts: on master + has hours, on master + no hours this week, Hubstaff-only (not on master).
- Returns stats object + up to 75 sample unmatched email strings.

---

### Step 5 — HSL Payroll

**Purpose**: Review and finalize pay for Hogan Smith Law employees — a separate calculation path from the main Additions tab.

**Header banner**: Shows department name, active PAB month, employee count, total initial pay, total KPI bonuses, and count of ready/locked KPI periods.

**KPI Bonus Periods summary**: Cards per HSL sub-department (Blue, Green, Yellow, etc.) showing the period type (weekly/monthly), employee count, total bonus amount, and status badge (ready / locked). Data comes from manager submissions via the HSL Bonus Calculator.

**Employee table**: Paginated (50 rows), searchable by name or email. Columns:

| Column | Details |
|---|---|
| Employee | Name + email |
| Hours | `totalHours` from Hubstaff |
| Initial Pay | Computed from HSL hourly rate |
| KPI Bonus | Pulled from manager-submitted HSL bonus periods |
| **PAB** | Tri-state pill: ✓ Eligible / ✗ Ineligible / ⏳ In Progress — clickable, opens the PAB Calendar modal. HSL uses Mon–Sun weeks (≥5 days at ≥7 h). ₱5,000 added to Total Pay when eligible. |
| **Tech Bonus** | Read-only pill: `+₱1,850` when the salary date falls in the 3rd full Mon–Sun week AND PHP rates exist AND ≥30 days tenure. `—` otherwise. |
| Override | Manual bonus override input (replaces KPI Bonus when set). Apply / Clear buttons. |
| Total Pay | `initialPay + effectiveBonus + pabAmt + techAmt` |

**Footer totals row**: sums Initial Pay, effective KPI/Override, PAB total, Tech Bonus total, and Grand Total across all HSL employees (not just the current page).

**PAB logic for HSL**: uses `checkHslPabEligibility()` — Mon–Sun weeks, ≥5-of-7 days at ≥7 h (vs the Mon–Fri every-day rule for regular staff). Eligibility is drawn from the same `pabStatusByEmail` / `perfectAttendanceEligible` memos used elsewhere; clicking the PAB pill opens the shared PAB Calendar modal which auto-detects the HSL employee and renders week-based rows.

**Tech Bonus logic for HSL**: same `techBonusEligible` set as regular employees — iterates `effectiveCalcResults` (which includes HSL employees) and applies the standard 3rd-week + 30-day + PHP-rates gates.

---

### Step 6 — Dispatch

**Purpose**: Confirm and send payroll.

**Layout**: Centered animated circle (indigo gradient) with a Send icon. Shows worker count from the payrollComparison stats.

**Buttons**:
- "Preview Paystubs" → `toast.info("Coming soon")` (placeholder)
- "Confirm & Dispatch" → `toast.success("Payroll dispatched")` + resets wizard to Step 1 (placeholder — no actual payment API call)

**Excel (XLSX) export.** The payroll report export includes the **Employee ID** (`YYMM-NNNN`) column so exported files can be cross-referenced with other records by ID. Columns: Employee, Email, Department, Hours, Regular, OT, Bonuses, MESA, Net Pay, **Employee ID**.

**Audit log attribution.** Every dispatched payroll run writes an audit entry attributed to the **currently logged-in user**. A bug that caused edits by one user (e.g. Carla T) to appear under a different user (e.g. Kane R) has been fixed. When no session user is resolvable the actor falls back to `Payroll Wizard`.

**Design note**: The large centered circle animation signals "this is a significant action." The indigo accent (distinct from the global orange/blue) is used throughout the wizard as a visual cue that you are inside a specific workflow, not the general app.

---

## Employee Portal (`src/components/employee/`)

### `EmployeeApp.tsx` — Employee Shell

Top-level employee-side shell. Manages `activeTab`, `mobileNavOpen` (drawer below `md`), renders `<EmployeeSidebar>` and switches content via `renderContent()`. Resolves employee email from URL query params. Uses the same mobile top bar, backdrop, and `navigate()` pattern as `App.tsx`.

### `EmployeeSidebar.tsx` — Employee Navigation

Sidebar with nav items (dashboard, profile, hours, leaves, disputes, orphanage visits, settings). Shows employee name, avatar, view switcher, and dark mode toggle. Below `md` it is an off-canvas drawer controlled by `mobileOpen`; from `md` up it stays in the layout column.

### `EmployeeDashboard.tsx` — My Dashboard

The primary employee-facing view. Shows weekly hours, pay calculations, and PAB status.

**Sections:**
- **Header**: Employee name, PAB period badge, CSV source file selector (includes "All Time" option)
- **Bonus Indicators Card**: PAB eligibility status with month/date range info, Technology Bonus info
- **Stats Cards** (5-column grid): Total Hours, Regular Pay, Overtime Pay, PAB, Initial Pay
- **Daily Hours Breakdown** (bar chart): Per-day bars with 7h threshold line, color-coded (green ≥7h, amber <7h, gray weekend)
- **PAB Calendar** (grid): Mon–Fri calendar for the full PAB month period with pass/fail per day, skeleton loading, staggered animations
- **Pay Summary**: Rate breakdown, Regular/OT/PAB line items, total with USD conversion

**Key features:**
- **All Time mode**: Aggregates totals across all uploaded source files. Regular/OT split computed per-file independently at the 40h threshold, then summed. PAB shows accumulated eligible months × ₱5,000.
- **Canonical column resolution**: Source files with `monday`/`tuesday` columns are resolved to ISO dates using filename date ranges so weekly data doesn't overwrite during merge.
- **PAB Calendar**: Built via `buildPabCalendarWeeks()` — generates expected weekdays in the PAB range, maps actual hours, renders a grid with date/hours/status per cell.
- **Skeleton loading**: Full-page skeleton (header, bonus cards, stats grid, chart/calendar/summary) shown during initial data load. PAB calendar has its own skeleton with staggered pulse.

### `EmployeeProfile.tsx` — Profile *(redesigned 2026-05-02)*

Employee profile screen — modern minimal layout (Linear/Vercel-style) with three tabs.

**Hero**: 64-80px circular avatar with hover camera overlay → photo upload, name (24-28px semibold, tight tracking), department · ID inline, **Active** pill (with ping animation on the dot), and a **Payroll locked** pill when relevant.

**Tabs** (motion.layoutId-driven sliding orange underline; cross-faded content via `AnimatePresence`):

1. **Overview** — read-only identity & employment.
   - **Personal**: Full Name, Work Email, Personal Email
   - **Employment**: Department, Start Date, Status (Active with pulse dot)
   - **Address** *(2026-05-02)*: only renders when at least one address field is populated. Top row shows Full Address with a small orange `MapPin` chip; below it, individual rows for Street / City / Province / Postal Code (mono).
2. **Compensation** — read-only pay info as `CompactStat` blocks (uppercase label, 22px mono number, hint).
   - **Hourly Rates**: Regular and Overtime in a 2-column grid.
   - **Currency**: USD → PHP reference rate, with a "Live · payroll" pip.
3. **Payment** — editable disbursement details. Wraps `PreferredPaymentMethodRadios` + `PayoutDetailsFields` with an editorial card frame; toolbar shows current channel as a stamp, plus Edit / Cancel / Save (orange CTA). Read-only when payroll is locked.

**Avatar fallback chain**: Google SSO photo → uploaded Supabase photo → Gravatar → initials. The Google URL is provided by `EmployeeApp` from the NextAuth session, gated by an email-match check so impersonation paths (`?email=other@simple.biz`) don't show the wrong person's photo.

**Data sources**: `/api/employees`, `/api/employee-hourly-rates`, `/api/employee-ids`, `/api/app-settings?key=usd_to_php_rate` in parallel. Always also calls `/api/employee-master-record` and merges its address fields into `master`, so the Address panel surfaces even when the `active_employees` view is stale (column added after the migration).

**Skeleton**: Matches the new layout exactly — hero with circular avatar placeholder, tab strip, three card placeholders with staggered pulses.

### `EmployeeSettings.tsx` — Settings

Employee self-service settings for personal email and bank information.

**Sections:**
- Personal email editor
- Primary bank account (account holder name, bank name, account number, routing number)
- Alternative bank account (same 4 fields)
- Save button with toast notifications

Updates via POST to `/api/update-employee-ids`.

### `EmployeeAvatar.tsx` — Avatar Component

Displays employee photo with fallback chain: **Google SSO photo → uploaded photo (Supabase Storage) → Gravatar → initials** (orange-to-blue gradient circle). Each layer self-heals if the image fails to load. Google photos use `referrerPolicy="no-referrer"` to avoid `googleusercontent.com` 403s. See [DATA_SOURCES.md](./data-sources.md) for migration prerequisites.

### `EmployeeMyHours.tsx` — My Hours

Calendar-month view of merged Hubstaff hours with a Pay Summary side panel. Mon–Sun grid that includes weekends + dashed cells for adjacent-month days (informational only).

**Pay Summary** (right column):
- **Estimated take-home** = `regular pay + OT pay + PAB bonus + Tech bonus`. The breakdown line below shows the components separately.
- **Total hours (month)** — every day from `monthStart` to `monthEnd`, weekends included.
- **Regular / Overtime split** — Mon–Sun weeks within the month; only the portion of each week's total that exceeds **40h** routes to OT (no assumption that Mon–Fri hits 40h on its own).
- **PAB Bonus row** — ₱5,000 when every weekday in the displayed month logged ≥7h.
- **Tech Bonus row** — ₱1,850 once the displayed month has fully concluded (`monthHasEnded` gate, so future / current months show `· month not yet ended`). Mirrors `PayrollWizard.hasThirtyDaysByWeek` for the 30-day service check (gates against the **pay-period Monday** = salary Tuesday − 8d, not the salary Tuesday itself). When `employeeStartDate` is unknown (master-row miss / email drift), defaults optimistic — assume past 30 days.

**Smooth transitions** (motion/react `AnimatePresence`):
- Month label in the picker fades + slides vertically (150ms) keyed on `${viewYear}-${viewMonth}-label`.
- Calendar grid body slides horizontally in the navigation direction (180ms) keyed on month.
- Pay Summary body uses the same direction-aware fade-slide.
- Initial mount skips the entrance animation (`initial={false}`); only month *changes* animate.

### `MyDisputes.tsx` — My Disputes

Employee-facing dispute filing UI. Reason dropdown is filtered to **non-orphanage-style reasons only** — `orphanage_visit` and `ceo_visitation` are excluded (manager-submitted only). Default reason is `medical`.

The form refuses orphanage-style at the API layer too (`POST /api/pab-disputes` returns 403 if a non-elevated employee picks one), so even a hand-crafted request can't bypass the dropdown filter.

Embedded `EmployeePabCalendar` shows the employee's PAB month with red / green / amber / pink-ring (forgiven via `accounting_approved` orphanage-style) cells. Clicking a sub-7h day pre-fills the form.

---

## `src/lib/hubstaff/calendar-column-dedupe.ts` — PAB Helpers

Shared module for PAB (Perfect Attendance Bonus) date logic, used by both PayrollWizard and EmployeeDashboard.

**Key exports:**
- `getPabMonthRange(year, month)` — Computes PAB start/end dates for a month (first Monday on/after 1st → Friday of last week with Monday in month)
- `inferPabMonthFromColumns(cols)` — Identifies target month from column date headers
- `filterColumnGroupsByPabRange(groups, cols, start, end)` — Filters column groups to PAB date range
- `buildPabCalendarWeeks(start, end, hoursByDateKey)` — Generates calendar grid (weeks × days) with hours data mapped
- `resolveCanonicalColumnsToIso(row, filename)` — Maps `monday`/`tuesday` columns to ISO dates using source filename date range
- `columnsAreAllCanonical(cols)` — Detects whether columns need resolution
- `pabDateKey(date)` — Stable date key for lookup maps
- `countMonFriInclusiveInRange(start, end)` — Counts weekdays in a range

---

## `src/components/SystemDiagnostics.tsx` *(added 2026-05-02)*

**Admin → Diagnostics.** Admin-only health map for the Simple HRIS stack. Renders a Supabase-Schema-Visualiser-style React Flow diagram with relationship-aware edge animations, an alerts list, and per-node detail panels. Mounted exclusively in the Admin shell (`app/admin/page.tsx`); not present in any other dashboard.

**Layout:**
- **Header** — orange `Radar` icon + title + Live/Mock chip + "Updated HH:MM:SS" + Refresh button
- **Summary cards** — 4-up grid with Healthy / Warnings / Critical / Unknown counts
- **Service Map** (left, xl+) — React Flow diagram, draggable cards, status-tinted edges, edge legend pinned bottom-right
- **Right panel** (top) — node details (label, category, status, summary, details, suggested checks, last-checked timestamp) when a card is clicked
- **Alerts list** (right panel, bottom) — clicking an alert focuses the related node

**Live data flow**: on mount, fetches `GET /api/admin/diagnostics` and replaces the mock baseline. Fetch errors fall back to mock with an amber banner explaining why ("HTTP 403", "Probe failed", etc.). The Live/Mock chip (`dataSource` state) is the source of truth — green when the last fetch succeeded, grey when it didn't.

**Node design** (`DiagFlowNode`): 280px-wide cards mimicking Supabase column rows. Status-tinted header (icon + label + status pill); body has 4 rows (`category/enum`, `status/status`, `summary/text`, `checked_at/timestamp`) with mono labels and right-aligned values. Left/right `Handle` anchors for stable edge connections.

**Edge animations** — relationship-driven via custom edge types (`MountEdge`, `FlowEdge`, `QueryEdge`, `EventEdge`):

| Relationship | Triggered by | Visual |
|---|---|---|
| `mount` | `admin-shell → *` | Slow flowing dashes (7s, 4s when critical) |
| `flow` | feature → data sink (e.g. payroll → records) | Solid line + traveling particle with halo (3.4s, 2.2s when critical) |
| `query` | anything → DB layer (`supabase-client`, `supabase-postgres`, `pg-pool`) | Fast flowing dashes (1.6s, 1s when critical) |
| `event` | `auth-login → audit-log` | Particle burst with discrete pause (4s cycle, 2.6s when critical) |

Edge stroke colour = max-of-endpoint-statuses; markers tinted to match.

**Drag and layout persistence**:
- Cards draggable; positions written to `localStorage["system-diagnostics-positions-v1"]` on drag-end
- Reset Layout button restores `NODE_POSITIONS` template and clears localStorage; disabled at template position
- **Twitch fix**: dash animations live on CSS classes (`.sd-edge-mount`, `.sd-edge-query`) instead of inline `style.animation` so they don't restart when the style object reference changes per render. Particles (`<animateMotion>`) unmount during drag and remount cleanly on drag-stop, avoiding SVG motion resets when the path string changes 60×/sec
- `.sd-paused` class freezes dash flow while any node drags

**Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables all edge animations, particles, and dash flow.

**Admin gate**: visible only when the AdminSidebar's `securityNav` includes `'diagnostics'` AND the page mounts via `app/admin/page.tsx`. The Accounting / Manager / Employee / Orphanage shells have no reference to `SystemDiagnostics`. The probe endpoint additionally enforces `roles.includes('admin')` server-side so probe data is unreachable from non-admin sessions.

See [docs/system-diagnostics.md](../features/system-diagnostics.md) for the architecture, probe definitions, and extension guide. See [API_REFERENCE.md](./api-reference.md#127-admin-diagnostics) for the live endpoint shape.

---

## `src/lib/admin/diagnostics-probes.ts`

Server-side probe helpers consumed by `app/api/admin/diagnostics/route.ts`. Each helper returns a `ProbeResult` (`status` + `summary` + `details` + `suggestedChecks`) and runs through `withProbeTimeout()` (4-second cap) so a hung Supabase doesn't stall the route.

**Helpers**: `probeSupabase`, `probePgPool`, `probeHubstaffCsv`, `probeMasterList`, `probeAuditLog`, `probeDisbursementRecords`, `probeAuth`, `probeDailyReport`, `probeRates`. See `docs/system-diagnostics.md` for the per-probe status mapping.

**Security policy**: every probe sanitizes errors via `trimError()` (one-line, 120-char cap) — no stack traces, no SQL text, no env secrets, no PII. PostgREST error codes (e.g. `42703`) pass through because they're useful for admin diagnosis.

---

## `src/components/admin/AdminSidebar.tsx`

**AdminSidebar nav** — left rail for the Admin shell at `app/admin/page.tsx`. Two grouped nav arrays:

- **systemNav**: Overview, Roles & permissions, Employees, Webhooks, CSV imports
- **securityNav**: Audit log, **Diagnostics** *(2026-05-02)*, API tokens, Backups

Diagnostics uses the `Radar` icon and is **only present in this sidebar** — not in the Accounting/Manager/Employee/Orphanage sidebars. Combined with the server-side `roles.includes('admin')` gate on `/api/admin/diagnostics`, this means the entire feature is admin-only at every layer.

---

## `src/components/ThemeProvider.tsx`

A thin wrapper around `next-themes`' `ThemeProvider`. Sets `attribute="class"` (Tailwind dark mode), `defaultTheme="system"`, `enableSystem`. The patch in `patches/next-themes+0.4.6.patch` fixes a hydration mismatch where the theme script was injected twice (once server-side, once client-side). The fix makes the `ScriptInjector` return `null` on the client.

### Theme cross-fade

All three sidebar toggles (Sidebar, AdminSidebar, EmployeeSidebar) wrap `setTheme()` with `withViewTransition()` (`src/lib/theme/with-view-transition.ts`), which uses the browser's **View Transition API** (`document.startViewTransition`) to snapshot the old theme, apply the new one, and cross-fade between them.

The fade is controlled by `::view-transition-old(root)` / `::view-transition-new(root)` keyframes in `src/index.css` (`theme-fade-out` / `theme-fade-in`, 420ms, `cubic-bezier(0.4, 0, 0.2, 1)`). Browsers without support fall back to an instant swap (Safari < 18).

An earlier attempt at a global `transition-property: background-color, …` on every element was removed because Tailwind utility classes overrode it on most components and the cumulative transitions made the rest of the UI feel sluggish. The View Transition approach is isolated to the theme swap and doesn't affect other hover/focus transitions.

---

## Admin Dashboard (`src/components/admin/`)

The Admin shell (`app/admin/page.tsx`) hosts five primary tab components plus the shared `AuditLogPanel` (audit tab) and `NotificationsPanel` (notifications tab). `AdminSidebar.tsx` and `SystemDiagnostics.tsx` are documented in their own sections above; the shell mounts both.

### `app/admin/page.tsx`

Client shell that gates the admin experience, resolves the viewer email (`?email=` -> normalized -> `sessionStorage[SESSION_EMAIL_KEY]`, else stored value), and switches tabs. There is no role gate in this file -- it surfaces whatever email it can and passes it down; RBAC gating lives upstream (middleware) and in the role-aware data APIs. A mount effect fetches employees, roles, and webhook config in parallel to compute nav **badge counts** (`{ employees, roles, webhookAlert }`; `roles` counts unique emails with >=1 grant; `webhookAlert` counts active webhooks with a blank URL). Wrapped in `<Suspense>` because it reads `useSearchParams`.

| `activeTab` | Component |
|---|---|
| `overview` | `AdminOverview` |
| `roles` | `AdminRoles` |
| `employees` | `AdminEmployees` |
| `webhooks` | `AdminWebhooks` |
| `csv-imports` | `AdminCsvImports` |
| `audit` | `AuditLogPanel` |
| `diagnostics` | `SystemDiagnostics` |
| `notifications` | `NotificationsPanel` |
| `api-tokens`, `backups`, `settings` | `Placeholder` (not-wired stubs) |

Data: `GET /api/employees`, `GET /api/employee-roles`, `GET /api/app-settings?key=webhooks.config` (all `cache: 'no-store'`).

### `src/components/admin/AdminOverview.tsx`

Read-only "control plane" landing dashboard -- metrics, RBAC mix, webhook health, core-table row counts, audit preview, plus two quick CSV-import shortcuts. Renders a terminal-style top bar (Sync / Export audit / Roles), a greeting hero with an all-clear/needs-attention pill, 4 stat cards (Employees, Role grants, Elevated, Webhooks `active/total`), a **Core data tables** health panel, two inline CSV uploaders (master list full-replace + payroll rates upsert), a **Services** grid, a **Role mix** SVG donut + count table, a **Hooks** mini-panel, and a searchable **Recent audit** preview (first 24 rows). A single `load()` fetches 5 endpoints in parallel and derives role counts, elevated totals, misconfigured webhooks, and donut segments. `auditRowKind` hard-codes severity per action string.

| Method/Endpoint | Use |
|---|---|
| `GET /api/employees` | employee count |
| `GET /api/employee-roles` | role mix/donut |
| `GET /api/app-settings?key=webhooks.config` | webhook entries |
| `GET /api/audit-log?limit=500` | audit preview (sliced to 24) |
| `GET /api/admin/data-tables-status` | core-table row counts + health |
| `POST /api/global-master-list` | master list full-replace upload |
| `POST /api/employee-hourly-rates-upload` | rates upsert upload |

Imports `formatActionLabel`/`formatRelativeTime` from `AuditLogPanel`. Audit search operates on the in-memory 24-row sample (full search lives in the Audit tab).

### `src/components/admin/AdminEmployees.tsx`

Read-only merged-profile directory -- master-list + rates + Hubstaff + any profile source unioned per person, with a master/detail browser. Left **Directory**: searchable, department-filtered, paginated (`PAGE_SIZE=10`) avatar rows. Right **Profile**: selected person's avatar, emails, org/department badges, **Roles**, and "Data from database" fields grouped into categories (Compensation, Banking, Location, Dates, Other). A `searchIndex` memo precomputes a lowercased blob per profile (perf fix to avoid re-walking fields per keystroke). `ProfileAvatar` cascades photo URL -> Gravatar (`/api/avatar?email=&s=&d=404`) -> initials. Loads `GET /api/employee-rate-profiles` (returns `profiles` + `mergeNotes`), `GET /api/employee-roles`, `GET /api/employees`. No writes.

### `src/components/admin/AdminRoles.tsx`

The RBAC + per-feature-permission control surface. Grants/revokes roles, sets per-tab feature access, manages department-manager assignments, and sets contractor invoicing currency. Left **People** card: searchable/paginated list with an **All / With roles** toggle and an **Add by email** affordance for off-roster ("Custom") emails. Right **Role assignments** card for the selected person:

- **Departments managed** (only when `manager` active) -- toggle pills writing `department_managers`; any one manager can approve leave.
- **HSL sub-departments** (only when an HSL parent dept is assigned) -- granular `hsl:<key>` grants.
- **Roles** group -- assign/revoke for `ASSIGNABLE_ROLE_KEYS` (admin, ceo, hr_coordinator, finance, orphanage_manager, contractor, manager). `ROLES` also lists legacy keys (viewer, payroll_coordinator, payroll_manager) for rendering existing grants but they are not assignable.
- Per-role **`FeaturePermissionGrid`** (Hidden/View/Edit per feature) for any active role mapping to a `FeatureViewKey`. Admin has no grid (bypasses gates).
- **Invoicing currency** (PHP/USD) toggle for the contractor role.

`toggleRole`: POST to grant / DELETE to revoke, **and on revoke fires `POST /api/auth/force-logout`** (fire-and-forget) to invalidate stale JWTs. `setCurrency` is an optimistic PATCH with rollback.

| Method/Endpoint | Use |
|---|---|
| `GET /api/employees`, `/api/employee-hourly-rates`, `/api/hubstaff-hours` | build merged directory |
| `GET/POST/DELETE /api/employee-roles` | role grants |
| `GET /api/departments` | available departments |
| `GET/POST/DELETE /api/department-managers` | manager<->dept |
| `GET/POST /api/employee-feature-permissions` | per-tab access |
| `GET/PATCH /api/contractor/profile` | invoicing currency |
| `POST /api/auth/force-logout` | kick session on revoke |

### `src/components/admin/AdminWebhooks.tsx`

Editor for the n8n/automation webhook registry -- a single JSON blob in `app_settings` (`webhooks.config`) of slug->URL->active entries. Merges in any missing `KNOWN_SLUGS` as inactive defaults so the five first-party automations always appear: `paystub_dispatch`, `create_workspace_account`, `hubstaff_invite_user`, `onboarding_send`, `offboarding`. `entryStatus` is `active` (toggled on + valid http(s) URL) / `inactive` / `missing`. **`toggleActive` persists immediately** (optimistic + rollback); URL/label/slug edits only set `dirty` and need an explicit Save. **Test** POSTs a sample `{test:true,...}` to the endpoint from the browser. Data: `GET /api/app-settings?key=webhooks.config`, `POST /api/app-settings`. The registry is a runtime override -- when a slug is active, server routes use its URL; otherwise they fall back to a hardcoded default in the API route.

### `src/components/admin/AdminCsvImports.tsx`

Standalone bulk-ingest console -- roster, payroll-rates, Hubstaff, and HSL data via CSV upload or Google-Sheet sync, plus a Files browser for archived batches. Two tabs: **Upload** (4 `UploadCard`s + a `SelectedBatchesSection` for the selected card's archived batches; Master card adds **Restore off-boarded** + a separate **Sync Offboarded sheet** button) and **Files** (sub-tabs Hubstaff / Master list / Payroll rates / HSL agents; only Hubstaff has row-level inspection + delete via `HubstaffFilesPane`, the others render an `ArchiveOnlyPane`). **Hubstaff is parsed client-side** (`parseCsv`), header-shape-validated, and only then surfaces a confirm dialog before POST -- wrong-shape files never hit the DB. `startProgress` animates a capped fake percentage during requests.

| Method/Endpoint | Use |
|---|---|
| `GET/POST/DELETE /api/hubstaff-hours` (`?source_files=1`, `?source_file=`) | Hubstaff list, detail, upload, delete batch |
| `GET/POST /api/global-master-list` (`?uploads=1`) | master batches + CSV upload |
| `GET/POST /api/employee-hourly-rates-upload` (`?uploads=1`) | rates batches + CSV upload |
| `GET/POST /api/cron/sync-hsl-from-sheet` (`?uploads=1`) | HSL batches + sheet sync (sheet-only, no CSV) |
| `POST /api/cron/sync-master-from-sheet` | master Google-Sheet sync (`clearOffboarded`) |
| `POST /api/cron/sync-rates-from-sheet` | rates Google-Sheet sync |
| `POST /api/cron/sync-offboarded-from-sheet` | stamp off-boarded rows from the "Offboarded" tab |

Tables/views (named in UI text): `global_master_list`/`master_list_uploads`, `employee_hourly_rates`/`rates_uploads`, `hubstaff_hours`/`hubstaff_uploads`, `hsl_team_members`/`hsl_agent_uploads` (+ `active_hsl_agents` view). All ingest endpoints require the service-role key and write audit rows. Delete is Hubstaff-only today.

`AdminSidebar` receives `counts` from the page (employees / roles / webhook-alert badges); it is documented in its own section above.

---

## HR Dashboard (`src/components/hr/`)

A single-page, tabbed client app at `/hr` targeting `admin` + `hr_coordinator`. It owns the people lifecycle: onboarding (staged hires + self-serve link flow), offboarding, department transfers, gift tracking, MESA/FPU programs, leaves, announcements, and S-Wall. Emerald/teal theme. A separate public, token-gated onboarding form (`app/onboarding/[token]/page.tsx`) feeds submissions into this dashboard.

Cross-cutting: roster everywhere = `GET /api/employees`; tables use the responsive `data-label` convention; all n8n side-effects resolve their URL through `resolveWebhookUrl(slug, ...)` (Admin -> Webhooks entry, else legacy `app_settings`, else hardcoded default). Slugs: `onboarding_send`, `offboarding`, `create_workspace_account`, `hubstaff_invite_user`.

### `app/hr/page.tsx`

Route entry; renders `<HrApp/>` inside `<Suspense>` (HrApp uses `useSearchParams`). Emerald spinner fallback.

### `src/components/hr/HrApp.tsx`

Dashboard shell -- auth gate, tab router, and the Overview tab body. **Access gating:** reads viewer email then `GET /api/employee-roles?email=`, allows only `admin`/`hr_coordinator`, else `router.replace('/employee?email=...')`. Tab map: `overview` -> `HrOverview` (local), `onboarding` -> `HrOnboarding`, `offboarding` -> `HrOffboarding`, `leaves` -> `LeaveRequestsPanel`, `transfers` -> `HrTransfers`, `gift-tracker` -> `GiftTracker`, `mesa` -> `HrMesa`, `announcements` -> composer + company-wide wall, `notifications` -> `NotificationsPanel`, `s-wall` -> `SWall`.

`HrOverview` is an editorial analytics dashboard derived from the roster + a few stat endpoints: KPI tiles (Active / Departments / Largest dept / **Attrition 12mo** / **MESA members** / **FPU enrollments**), a hand-rolled SVG `HeadcountStoryCard` sparkline of cumulative headcount over 12 months, a `TenureCohortCard` (Newcomers <=30d / Settling <=1y / Established <=3y / Veterans 3y+), `RecentHiresCard` (last 90 days), `DepartmentBarsCard` (top 8), and an active-roster table with `DeptFilter` + search + pagination.

| Concern | Source |
|---|---|
| Roster | `GET /api/employees` |
| Role check | `GET /api/employee-roles?email=` |
| Attrition | `GET /api/hr/offboard-history` |
| MESA count | `GET /api/employee-hourly-rates` (count `mesa_member=true`) |
| FPU count | `GET /api/hr/fpu-enrollments` |

### `src/components/hr/HrSidebar.tsx`

Persistent left nav for all HR tabs (Overview, Onboarding, Offboarding, Leave Requests, Transfers, Gift Tracker, MESA, Announcements, Notifications, S-Wall), a `ViewSwitcher`, theme toggle, and footer user card + Sign Out. Notifications badge subscribes to `useDispatchLock()` (pulsing red dot when locked). Exports the canonical `HrTab` union consumed by `HrApp`.

### `src/components/hr/HrOnboarding.tsx`

The **Onboarding** tab. Two sub-tabs: **Onboarding Form** (renders `HrOnboardingForm`) and **Pending Hires**. *Pending Hires* are interview-stage hires staged in `hr_pending_employees` before they hit the Global Master List. Lifecycle (`HrPendingStatus`): `pending_work_email` -> `ready` -> `promoted`, plus `cancelled`. A synthetic **"Awaiting orientation"** state badges any `ready` row missing `orientation_attended_at` amber and disables Promote (the department manager must mark orientation first). Renders an "Add person" dialog, three clickable stat tiles, and a filterable table with per-row Promote / Back to Ready / Cancel / hard Delete / Set work email.

| Action | Endpoint |
|---|---|
| List | `GET /api/hr/pending-employees` |
| Dept rate fallback | `GET /api/hr/department-rates` |
| Promote -> master list (+ Sheet append + Hubstaff invite) | `POST /api/hr/pending-employees/{id}/promote` |
| Send back to Ready | `POST /api/hr/pending-employees/{id}/unpromote` |
| Set work email | `PATCH /api/hr/pending-employees/{id}` |
| Cancel / hard delete | `DELETE /api/hr/pending-employees/{id}[?hard=true]` |

Promote copies the staged row into `global_master_list`, appends to the Google Sheet, and fires the `hubstaff_invite_user` webhook; partial failures surface as warning toasts.

### `src/components/hr/HrOnboardingForm.tsx`

The **Onboarding Form** sub-tab -- the self-serve, no-SSO onboarding-link manager. HR generates a unique link (row in `hr_onboarding_submissions`, status `pending`); the hire completes the public 6-step form (`/onboarding/[token]`); the row flips to `submitted`; HR reviews, then "Set work email" converts the submission into a `hr_pending_employees` row (status `ready`). Statuses: `pending`/`submitted`/`archived`. Main view = status filter pills + search + a multi-select table with a bulk action bar (Send / Archive / Delete). Dialogs:

- `GenerateLinkDialog` -- pre-fill name/email/department/note; `POST /api/hr/onboarding-submissions`.
- `LinkCreatedDialog` -- shareable URL + prewritten email body + "Send via webhook". **Send rotates the token server-side**, so the dialog caches the rotated token.
- `SetOnboardingWorkEmailDialog` (richest) -- suggests an `@simple.biz` address (`POST /api/hr/work-email/suggest`), debounced availability check, department select, regular/OT rate inputs, and a Hubstaff project multi-select. Save stages the pending hire and best-effort provisions the Hubstaff workspace via the `create_workspace_account` webhook.
- `SubmissionDetailDialog` -- folder-style tabs (Summary / Non-Solicitation / Privacy / Contract); Summary shows personal info, W-8BEN (signed-URL View + Download), payment method, signature previews; agreement tabs render the canonical legal copy from `agreement-texts.tsx` + signed/not-signed badge.

**Invite workflow (2026-06-01).** All onboarding invites — Hubstaff and Workspace — are sent simultaneously in a single weekly batch via a combined webhook call (one point of failure). The former staggered creation flow has been replaced. Each batch delivers two emails to the hire: **Hubstaff Overview** and **Roboform** (password manager, buttons link to Google Drive).

**Bulk onboarding for Lead Gen (required change).** The HRIS connects to the Lead Gen Google Sheet (same pattern as Master List / New Payroll Dashboard). Required additions:
- **Refresh button** — pulls all pending hires from the connected Lead Gen sheet.
- **Bulk link generation** — "Generate Link" sends invites to all personal emails in the batch simultaneously (same-department assumption).
- **Email-only input** — only a batch of personal emails is required; first name and last name are no longer collected at this stage (captured later via new hire paperwork).

> **Pending:** Confirm with Drew that the Lead Gen sheet is cleaned up weekly so stale entries do not receive duplicate links.

| Action | Endpoint / webhook |
|---|---|
| List / create | `GET/POST /api/hr/onboarding-submissions` |
| Send (rotates token) | `POST /api/hr/onboarding-submissions/{id}/send` -> slug `onboarding_send` |
| Archive / hard delete | `DELETE /api/hr/onboarding-submissions/{id}[?hard=true]` |
| Detail + W-8BEN URL | `GET /api/hr/onboarding-submissions/{id}` |
| Suggest / check email | `POST /api/hr/work-email/suggest` |
| Set work email -> stage hire | `POST /api/hr/onboarding-submissions/{id}/set-work-email` -> slug `create_workspace_account` |
| Departments / Hubstaff projects | `GET /api/departments`, `GET /api/secondary/hubstaff-projects` |

### `src/components/hr/HrOffboarding.tsx`

The **Offboarding** tab. Two tabs: **Active employees** (offboard) and **Offboarded** (history + restore). Offboarding stamps `off_boarded_at/_reason/_by/_note` on the master-list row; the person drops from active rosters/payroll/manager dashboards immediately but the record is retained. Offboard button is disabled when the row has no `work_email` (the offboard key). The Offboarded history dedupes by Personal Email (`global_master_list` keys on `(personal_email, department)`, so dual-dept people would inflate counts). `REASON_LABELS` covers both dashboard-set keys (`resigned`, `end_of_contract`, `performance`, `attendance`, `time_manipulation`, `other`) and verbatim values from the Offboarded sheet sync (`NCNS`, `Declined Offer`, `sheet_sync`).

| Action | Endpoint / webhook |
|---|---|
| Active roster | `GET /api/employees` |
| Offboard history | `GET /api/hr/offboard-history` |
| Offboard | `POST /api/hr/offboard` -> slug `offboarding` |
| Restore / re-onboard | `POST /api/hr/reonboard` |

The DB update commits independently of the n8n `offboarding` webhook (deactivates the Workspace account + termination email); a webhook hiccup is a warning toast, not a hard failure.

**Department-based deletion timeline (2026-06-01).** The offboarding automation applies different deletion timelines per department:
- **Lead Gen** — email and all accounts deleted **immediately**.
- **All other departments** — Gmail deactivated and held for a **two-week delay**, then deleted.

The n8n offboarding webhook reads the employee's department from the payload to branch accordingly. Kentshin W coordinates with Sir Vinci (automation owner) to keep this logic consistent.

**Attendance trigger.** When Manager Jackie marks a new hire as **"No Attend"** in orientation, the system automatically offboards them. Lead Gen → immediate; all other departments → two-week delay.

**Hubstaff member removal.** On offboard the "remove member" call to Hubstaff runs **immediately** (not after a one-week delay). The pay rate payload is set to **zero** on removal to prevent display artefacts.

**Known bug — duplicate UI entries.** The offboarding Active list can show two rows for the same person when `global_master_list` has duplicate `(personal_email, department)` keys. Offboarding either row currently removes both. Must be fixed so each action targets only the intended row.

### `src/components/hr/HrTransfers.tsx`

The **Transfers** tab -- approve/reject manager-submitted department-transfer requests. Approving updates the department in the HRIS immediately; a persistent amber reminder warns HR to also update the master Google Sheet so the next sync does not revert it. Renders a **Pending** section (cards with from->to dept chips, requester, reason, Approve/Reject) and a **History** list. Data: `GET /api/department-transfers`; decide via `PATCH /api/department-transfers/{id} {decision, note}`.

### `src/components/hr/HrMesa.tsx`

The **MESA** tab (Medical Emergency Savings Account). Two sub-tabs: **MESA Eligible** and **FPU Enrollments** (embeds `HrFpuEnrollments`). MESA membership is flagged per-employee via `mesa_member=true` on the rates table; **FPU completion is the only path into MESA**, which is why the two tabs live together. `MesaEligibleList` fetches `GET /api/employee-hourly-rates` + `GET /api/employees`, builds a `mesa_member` lookup keyed by work+personal email, and uses a module-level cache (`cachedEligible_v3`) so sub-tab switches skip refetch (Refresh clears it).

### `src/components/hr/HrFpuEnrollments.tsx`

FPU (Financial Peace University) sign-up submissions list, rendered inside MESA's FPU sub-tab. Stat strip (Total / This month / Distinct departments) + search + list (name, email, department, EST shift, submitted). Data: `GET /api/hr/fpu-enrollments` -> `{rows, source, error}`. **`source` is `'table'` or `'audit'`** -- when the `fpu_enrollments` table does not exist yet the API falls back to the audit log and the UI shows an amber notice pointing to `references/add_fpu_enrollments.sql`.

### `src/components/hr/DeptFilter.tsx`

Shared compact department-filter dropdown used across the Overview roster, Onboarding queue, and Offboarding tables. Generic over row type (takes `rows` + a `getDept` accessor) and **derives the unique sorted department list itself**. Empty-string value = "All departments". Built on raw Base-UI `Select` primitives (the shadcn wrapper's defaults fight an in-trigger icon).

### `src/components/hr/AddPersonDialog.tsx`

Modal to stage a new hire into the Pending Hires queue. Sections: Identity (name "Last, First", phone, personal email [required], optional work email), Role (department, job title from `JOB_TITLES` with an "Other" custom field, location, source), Compensation (regular/OT rate, start date), Notes. The **department select** is populated from `GET /api/secondary/hubstaff-projects`; selecting a department auto-fills rates from `GET /api/hr/department-rates`. Submit: `POST /api/hr/pending-employees`.

### `src/components/onboarding/agreement-texts.tsx`

**Single source of truth** for the legal copy a hire agrees to, rendered both on the public form (where they sign) and in the HR detail modal (where HR reviews). Exports `AGREEMENT_TITLES` and three pure-presentational components: `NonSolicitationText` (no-poaching, 1 year), `PrivacyText` (do not name Simple.biz on social media), `ContractWorkerText` (independent-contractor agreement). A comment warns never to inline this copy at a call site.

### `app/onboarding/[token]/page.tsx`

The **public, no-SSO onboarding form** new hires complete; auth is the random URL token. Loads via `GET /api/onboarding/{token}` (invalid -> error screen; already `submitted` -> `SubmittedScreen`). Otherwise a 6-step wizard: (1) welcome/personal info + Hurupay explainer, (2) Non-Solicitation + `SignaturePad`, (3) Privacy + signature, (4) W-8BEN (Yes/No outside-US -> file upload via `POST /api/onboarding/{token}/w8ben`), (5) Payment Method (Hurupay email or full Wires details), (6) Contract Worker Agreement + signature + date. Final Submit `POST /api/onboarding/{token}` flips the row to `submitted`. `SignaturePad` is a hand-rolled HiDPI `<canvas>` emitting a PNG data URL. Renders agreement copy from `agreement-texts.tsx` (kept in lockstep with the HR review modal).

---

## Manager Dashboard (`src/components/manager/`)

A blue-accented client SPA shell with sidebar nav, server-scoped team roster, dual KPI/bonus calculators (HSL + general departments), bonus history, and per-member profile/pay drill-down. All bonus persistence shares one Supabase-backed API surface (`/api/hsl-bonus/*`) keyed by `(department, period_start)`, reusing the `hsl_bonus_entries` / `hsl_bonus_period_status` tables even for non-HSL departments.

### `app/manager/page.tsx`

Route shell; `<Suspense>`-wraps `<ManagerApp />`. No server gating here -- access control is a soft client gate in `ManagerApp` plus hard enforcement at every `/api/manager/*` route (session + role check).

### `src/components/manager/ManagerApp.tsx`

Top-level client shell -- resolves viewer, gates access, loads the department-scoped roster, routes 9 tabs (~2000 lines; also defines `Overview`, `TeamPanel`, `TimeAdjustments`, announcement/S-Wall wrappers, `ActiveNowButton`, `StatTile`). **Access gate:** `GET /api/employee-roles?email=`; lacking `manager`/`admin` -> `router.replace('/employee')`. **Team roster:** `GET /api/manager/department-members` returns `{ rows, scope: 'elevated'|'department', departments }`. The server scopes the roster: explicit `department_managers` assignments win even for elevated users; full org roster only when elevated AND no assignments; empty when a plain manager has no assignments. Rows are decorated with `hsl_role`/`hsl_hourly_rate` (from `active_hsl_agents`) and `regular_rate`/`ot_rate`/`mesa_member` (from `employee_hourly_rates`). Pending-leaves badge from `GET /api/leave-requests?scope=all`.

Tabs (`ManagerTab`): `overview`, `time-adjustments` (stub), `leaves` (`LeaveRequestsPanel`), `team`, `announcements`, `s-wall`, `hsl-bonus` (the KPI Calculator -- renders `HslBonusCalculator` and/or `DeptBonusCalculator` based on `hslVisible`/`deptVisible`), `bonus-history`, `notifications`.

**TeamPanel (My Team)** is the most complex tab: wrapped in `<MedalProvider>`; toggles between **Roster** and **Newly Hired** (`NewlyHiredPanel`). A **per-department wallpaper banner** (multipart upload, 10 MB cap, drag-to-reposition that PATCHes a `background-position` string) via `GET/POST/PATCH/DELETE /api/manager/team-wallpaper?department=`. The roster table has client search + dept-filter + pagination (`TEAM_PAGE_SIZE=10`); rate columns (`hsl_hourly_rate ?? regular_rate`) are masked by default (`AnimatedRate`, opacity+translate, no blur for mobile perf); MESA badge; per-row **View** (`ManagerMemberDialog`) and **Transfer** (`ManagerTransferDialog`). Live presence via `useOnlineEmails()` (green dots + `ActiveNowButton`). Roster rows are medal drop targets.

### `src/components/manager/ManagerSidebar.tsx`

Fixed/translate-in sidebar. Two groups: **Workspace** (Overview, Time adjustments [badge `pendingApprovals`], Leaves [badge `pendingLeaves`], My team, Announcements, S-Wall [violet]) and **Bonuses** (KPI Calculator -> `hsl-bonus`, Bonus History, Notifications). Note the label/route mismatch: the **"KPI Calculator"** item routes to the `hsl-bonus` tab. Notifications red dot when `useDispatchLock().state.locked`. Footer: avatar, `ViewSwitcher`, theme toggle, Sign Out.

### `src/components/manager/HslBonusCalculator.tsx`

The HSL (Hogan Smith Law) per-department KPI bonus calculator; the primary half of the KPI Calculator tab. Also exports reusable `KpiTable`, `SsdSubTeamGrid`, `SsdEmployeeTable`, `SubTeamChips`, `recomputeSsdEntries`, `DEFAULT_SUB_TEAMS`, `SUB_TEAM_PALETTE`. Visible depts = `HSL_DEPT_KEYS.filter(canAccessHslDept)`; access needs an explicit `hsl:<deptKey>` grant (the parent "Hogan Smith Law" assignment does NOT implicitly grant sub-depts); elevated sees all. Weekly depts pivot on **Monday** (`isoWeekStart`, local time); monthly depts use month start.

Per-dept `loadDept` fetches in parallel: `GET /api/hsl-bonus/entries?dept=&period_start=` (existing scored rows win over roster), `GET /api/hsl-bonus/period-status` (`draft`/`ready`/`locked`), `GET /api/hsl-bonus/team-members?dept=` (roster from `hsl_team_members`). Save via `POST /api/hsl-bonus/entries`; status flips via `POST /api/hsl-bonus/period-status`. CSV export (elevated only).

**Bonus formulas** (engine `lib/hsl-bonus/schema.ts`, `calcBonus`): rule types `per_unit` (n x rate), `tiered` (band by count, then n x band.rate), `flat` (fixed, optional `managerOnly`), `team_split` (SSD-only). `dept.monthlyMax` caps the total. USD-denominated flats exist (Chelzy's Assistant $10). **SSD Medical Records (team_split)** is the special case: `calcBonus` skips it, so per-employee bonus is derived by `recomputeSsdEntries`/`calcTeamSplitShare`. Each colored sub-team (BLUE/GREEN/YELLOW/ORANGE/PURPLE/RED) has manager-entered Accuracy % + Records; threshold -> rate/record (`<90% -> 0`, `90-94.99% -> 250`, `>=95% -> 350`); **share per member = (records x ratePerRecord) / memberCount**. **Gotcha:** SSD sub-team pct/records are in-memory only (not persisted), so editing a past SSD week requires re-entry; future fix = `kpi_meta JSONB` on `hsl_bonus_period_status`.

### `src/components/manager/HslBonusReadyPreview.tsx`

Read-only modal showing a ready/locked HSL period's scored entries; opened from the calculator's "View" and from Bonus History. Renders dept header (status pill), employee table (SSD sub-team dot column when `dept.key==='ssd_medical_records'`), and a note that it auto-syncs to Accounting -> PayrollWizard -> Additions. Footer "Reopen for edits" only renders when `status==='ready'` AND `onReopen` is provided (History omits it). No fetching -- entries are passed in.

### `src/components/manager/HslBonusEditModal.tsx`

Full editor for any HSL period (reuses the calculator's table primitives); lets a manager re-score and re-submit a past/ready/locked week. On open, `GET /api/hsl-bonus/entries`. SSD sub-team pct/records reset to empty (not persisted) with an amber re-enter warning. Actions: **Save (back to draft)** (`POST /api/hsl-bonus/entries` then flip to `draft` so accounting never sees mid-edit state), **Save & Mark Ready**, **Delete week** (`DELETE /api/hsl-bonus/period`). `isLocked` is hardcoded `false`.

### `src/components/manager/ManagerBonusHistory.tsx`

Past-KPI-weeks browser (HSL depts only). `GET /api/hsl-bonus/period-summary?depts=<csv>` -> `SummaryRow[]`. Stat strip (Total/Locked/Ready/Drafts), dept + status filter chips, row list with relative "updated Xm ago" and `locked by <user>`. Each row has **View** (`GET /api/hsl-bonus/entries` -> read-only `HslBonusReadyPreview`) and **Delete** (`DELETE /api/hsl-bonus/period`).

### `src/components/manager/DeptBonusCalculator.tsx`

The general (non-HSL) department KPI bonus calculator; the second half of the KPI Calculator tab. **Persistence reuses the HSL endpoints** (`GET /api/hsl-bonus/entries` + `period-status`, weekly `period_start = isoWeekStart`); department-level metrics persist in a sentinel row keyed by `employee_email = '__dept_meta__'`, and each employee row stores `kpi_data = {...metrics, ...toggles, __name__}`. Wallpapers from `GET /api/manager/team-wallpaper?department=<real Department string>`.

**Formulas** (engine `lib/payroll/department-bonus.ts`, shared verbatim with PayrollWizard so manager + accountant compute identically):
- **Accounting**: per-day Mon-Fri count -- >=30 -> +450, >=22 -> +300, >=17 -> +200; summed; everyone in dept gets the same total.
- **Edit**: 50/ticket. **Devs**: 50/ticket + name-gated Site Delivery (+50) or Site Checking (+250).
- **Lead Gen** (`calcLeadGenBonus`): 1-9 appts -> 250 ea, 10+ -> 500 ea. **Callback**: 50/callback appt + the lead-gen tier on its lead-gen appts. **Discovery**: 25/prior-week unit. **Sales Assistant**: 150/sale.
- **QC**: pool = unitsSold x (150 if >=6 standard members else 125) split equally among non-Jerome members; Jerome Rosero = units x 30 + callbacks x 50.
- **HR**: pool = (billable members excluding "Teal") x 1,000 / newHires, equal share.
- **US Manager Bonus** (toggle): Leadership Excellence 3,500 + Team Performance 3,000 per person.

UI: sticky header with spring-animated grand total + headcount, `FilterPill` row, a `DeadlineBanner` (whole-days to Sunday week-end), and per-dept cards with wallpaper/mesh hero, formula chip, dept inputs, member rows (per-metric inputs + award checkboxes), and Save/Mark Ready (or Reopen when read-only) footer. `readOnly` once status != draft.

### `src/components/manager/ManagerMemberDialog.tsx`

Per-member profile + payment-history dialog (roster "View" button). Two tabs (`TabBar`): **Profile** (masked hourly/OT rates, department, role, employee ID, start date, emails, full address) and **Payment history** (`ManagerMemberHoursMini`). Rate-mask toggle in the header. No fetching of its own.

### `src/components/manager/ManagerMemberHoursMini.tsx`

Month-by-month Hubstaff hours calendar + authoritative pay/bonus summary for a single member, embedded in the member dialog's Payments tab. Data (matched by work+personal email): `GET /api/hubstaff-hours?source_files=1` then per-file `?source_file=` (merges all uploads, resolving canonical weekday columns to ISO dates); `GET /api/employee-hourly-rates`; `GET /api/manager/member-rate-history?email=` (manager-namespaced -- the generic `/api/employee-rate-history` 403s plain managers); `GET /api/manager/member-monthly-pay?email=&year=&month=` (authoritative server pay incl. 40h regular cap, OT split, weekend breakdown, PAB + Tech gates, MESA deduction). Client-side `monthPay` buckets each day's seconds by Monday-anchored week and fills a **40h regular cap in day-of-week order** (weekend hours attribute to OT after Mon-Fri fill the cap) as a fallback while `serverPay` loads. `BonusRow` shows PAB/Tech with the gate reason when unearned. `CalendarBody` colors cells by pass/weekend/future/missing with a per-day rate badge (emerald ring on a mid-cycle rate-change flip day).

### `src/components/manager/MedalRecognition.tsx`

Drag-to-award peer-recognition system for the My Team roster (context provider + palette + name badges + award dialog). Two medal types: **commend** (green) and **flag** (red). `MedalProvider` loads existing medals via `GET /api/manager/medals?emails=<csv>` and exposes drag state. Dragging a `MedalPalette` chip onto a roster row opens the award dialog; Save -> `POST /api/manager/medals` (`{employee_email, employee_name, medal_type, note, is_private}`), optimistically prepended. **Private** (manager-only) vs **Share** (employee-visible, surfaces in the employee Reports tab), defaults private. `MedalBadges` shows the most-recent badge per type next to a member's name with a click-popover.

### `src/components/manager/NewlyHiredPanel.tsx`

Orientation-attendance gate for HR pending hires routed to the manager's departments; the "Newly Hired" inner tab of My Team. `GET /api/manager/pending-hires` -> `PendingHireRow[]`. **Mark orientation attended** -> `POST /api/manager/pending-hires/{id}/orientation`; **Clear** -> `DELETE`. Purpose: HR cannot promote a hire to the master list until the manager marks orientation attended.

### `src/components/manager/ManagerTransferDialog.tsx`

Department-transfer request modal (roster "Transfer" button). Target dept list from `GET /api/employee-rate-profiles/summary` (current dept excluded). **Send to HR** -> `POST /api/department-transfers`. Amber note reminds HR to also update the master Google Sheet so the next sync preserves the new department.

---

## CEO Dashboard (`src/components/ceo/`)

A thin, self-contained role shell: a yellow/gold sidebar + four tabs, most of which reuse shared components (S-Wall, Announcements, Notifications). Its own "Overview" is a placeholder hero -- no executive analytics are wired yet. Entry is `/ceo?email=...`; auth is client-side via `/api/employee-roles`.

### `app/ceo/page.tsx`

Route entry; `<Suspense>`-wraps `<CeoApp />` (CeoApp reads `useSearchParams`). Yellow-ring spinner fallback. No data.

### `src/components/ceo/CeoApp.tsx`

Client shell -- owns active-tab state, mobile nav, auth gate, and the four tab bodies. **Email resolution** as elsewhere; **auth gate** allows only `ceo`/`admin`, else `router.replace('/employee?email=...')` (the gate fails open on fetch error). Tab bodies (all local except Notifications):
- `overview` -> `CeoOverview`: gold gradient hero with a randomized `CEO_MESSAGES` greeting, floating CSS-animated diamond glyphs, a `Crown` badge, and a dashed "Executive analytics coming soon" placeholder. No data.
- `announcements` -> `AnnouncementComposer` (`allowGeneral canPin authorLabel="CEO"`) + `AnnouncementWall` (`scope="all" isElevated`).
- `notifications` -> `NotificationsPanel` (`accent="yellow"`).
- `s-wall` -> `SWall` (`canPost sourceLabel="CEO"`).

Only direct data access is `GET /api/employee-roles?email=` (the role gate); everything else is delegated to the embedded shared components.

### `src/components/ceo/CeoSidebar.tsx`

Left nav: logo with periodic heartbeat, a **Workspace** group (Overview, Announcements, Notifications -- active = gold gradient) and a separately-styled violet `s-wall` button (label from `SWallNavLabel`). Footer: `ViewSwitcher`, theme toggle (`withViewTransition`), `EmployeeAvatar` ("CEO" subtitle), Sign Out. `useDispatchLock()` shows a pulsing red dot on Notifications when payroll processing is active -- the only live cross-role state in this otherwise static sidebar. Exports `CeoTab` (`'overview' | 'announcements' | 's-wall' | 'notifications'`).

---

## Payroll Clerk Dashboard (`src/components/payroll-clerk/`)

The **payment-dispatch** surface -- the screen the payroll clerk ("Lenny") uses to pay out a weekly Hubstaff cycle one transfer at a time. There are **two shells** rendering the same queue components:

- **`/payroll-clerk`** -> `PayrollClerkApp` (standalone, sidebar-nav-driven, leaner).
- **Accounting -> "Payment Dispatch" tab** -> `PayrollDispatch` is also mounted inside `src/App.tsx`. `PayrollDispatch` is the richer variant (card rail, hero stats, processing-lock toggle, Orphanage tab) and is the one wired into production via Accounting.

Both consume the same `useDispatchQueue` hook and `MarkPaidDialog`. **Core concept:** each owed employee is a `QueueRow` routed to a **processor** (channel / "Bank Preferred"): `hurupay | wepay | higlobe | wise | jeeves | wires`. The clerk filters by processor, sends money externally, then **Mark paid** logs a `payment_dispatches` row (status `paid | not_paid | threshold | problem`). `paid` rows drop out of the pending queue. The **Excluded** queue shows people who cannot be paid (missing bank/pay/hours); the **Orphanage** queue is a separate flow for approved charity payouts. **Sent payments** + **Reports** are history views.

### `app/payroll-clerk/page.tsx`

Route entry; `Suspense`-wraps `<PayrollClerkApp />`. Orange-ring spinner.

### `src/components/payroll-clerk/PayrollClerkApp.tsx`

Standalone shell -- sidebar + tab routing + shared `MarkPaidDialog`. Tabs: `all` + the six processor ids -> `ProcessorQueue`; `history` -> `SentPaymentsHistory`; `excluded` -> `ExcludedQueue`; `reports` -> `DispatchReports`; `notifications` (badge only). Pulls `{ rows, excluded, paid, period, loading, error, refresh }` from `useDispatchQueue()`, mirrors `fetched` into local `pending` in a `useLayoutEffect` gated by a `hydrated` flag so the table never paints stale rows. `handleConfirmPaid` optimistically removes the row, `POST /api/payment-dispatches`, then `refresh()` (re-inserts on failure). **`cycleReady` here is a demo UI toggle defaulting `true`** (with a "(Demo) Toggle cycle ready" button) -- not derived from real data, unlike PayrollDispatch. The leaner shell: no lock toggle, no Orphanage tab, no hero stats.

### `src/components/payroll-clerk/PayrollClerkSidebar.tsx`

Left nav with a **cycle-status pill** and two groups: **Queues** (All pending + one button per `PROCESSORS` entry with a `PROCESSOR_ICONS` glyph + count badge) and **History** (Sent payments, Weekly reports, Excluded, Notifications [red pulse when locked]). Footer: `ViewSwitcher currentView="accounting"` (the clerk switches under the accounting view), theme toggle, avatar, Sign Out.

### `src/components/payroll-clerk/PayrollDispatch.tsx`

The full-featured "Payment dispatch" view, mounted as the Accounting "Payment Dispatch" tab. Renders an animated hero (first name via `useSession`), a `PeriodPill`, a `ProcessingPill` + Start/Stop `ProcessingToggleButton`, a **processor card rail** (`ProcessorCard` per channel + All/History/Reports/Orphanage/Excluded cards) acting as the tab filter, three `HeroStat` cards (Pending count, Sent count, Paid USD), and a body switching between `ProcessorQueue`, `SentPaymentsHistory`, `ExcludedQueue`, `DispatchReports`, `OrphanageQueue`, and `NotificationsPanel`. **`cycleReady = Boolean(period.cycleId)`** (real, no demo toggle). **Processing lock:** `useDispatchLock()` + a `LockToggleConfirmDialog`; starting processing **disables employees' File-a-Dispute button live** (Realtime on `app_settings.payroll.dispatch_locked`). Headline stats count only `status==='paid'` rows so the number "does not lie". Heavy `motion` + `React.memo` discipline because the queue can be ~1000 rows. Lock via `GET/POST /api/payroll-dispatch-lock` (through the hook); mark-paid via `POST /api/payment-dispatches`.

### `src/components/payroll-clerk/ProcessorQueue.tsx`

The pending-payments table for a single processor (or "All pending" when `processor === null`). `React.memo`'d. Header (title, live people-count, USD/PHP/OT totals, **Export CSV**), a debounced `SearchBar`, a sticky column header (6 cols in All view -- adds a **Bank Preferred** column -- else 5), and a paginated, animated list of `QueueRowItem`s (`QueuePagination`, 25/page). `QueueRowItem` (memoized): avatar, name + mono email, `BankCell` (processor dot + label + wire `x####` hint), USD/PHP with an optional `BonusChip` (PAB vs Tech split tooltip), hours, and a **Mark paid** button. Expand reveals per-processor `detailFields` with copy-to-clipboard. Per-row `React.memo` + stable callbacks keep the ~1000-row table at ~16ms frames. CSV export is client-only (`@/lib/payroll/dispatch-client-csv`).

### `src/components/payroll-clerk/ProcessorCard.tsx`

Clickable filter card in the PayrollDispatch left rail. A `motion.button` (hover lift, tap scale) with a `ProcessorLogo` tile, an optional `AnimatedNumber` count badge, label + subtitle, and an active layout-shared glow (`layoutId="processor-card-glow"`). Presentational.

### `src/components/payroll-clerk/ProcessorLogo.tsx`

Small gradient tile showing a 1-2 letter monogram or a fallback lucide icon. Pure presentational.

### `src/components/payroll-clerk/ExcludedQueue.tsx`

The **Excluded** tab -- employees who cannot be paid this cycle because at least one of bank/pay/hours is missing. A single-select reason filter rail (`FilterPill`s: All / No bank preferred / No current pay / No hours, each with a count + accent), debounced search, and a paginated list (25/page) of rows with per-reason `ReasonChip`s. Renders the `excluded: ExcludedRow[]` prop produced by `buildQueueFromRates` in `useDispatchQueue` (a row lands here if it has no recognized processor, no current-pay amount, or no Hubstaff hours).

### `src/components/payroll-clerk/OrphanageQueue.tsx`

The **Orphanage** tab (PayrollDispatch only) -- approved orphanage **budget requests** + **gift purchases** awaiting transfer. Self-fetching. Two sections (Budget Requests teal / Gift Purchases pink), each a paginated list of `OrphanageItemCard`s with an expandable bank-details block and a **Mark paid** button. `OrphanageMarkPaidDialog` collects destination bank, **required** transaction id, bank used, sent date, note, and lets you **Log problem** or **Mark paid**. Data: `GET /api/orphanage-dispatches?pending=1`, `POST /api/orphanage-dispatches`. PHP-only (no FX). Backed by `orphanage_dispatches`.

### `src/components/payroll-clerk/SentPaymentsHistory.tsx`

The **Sent payments** tab -- confirmations logged for the *current* pay cycle (the `paid: PaymentDispatchRow[]` prop from `useDispatchQueue`, i.e. `payment_dispatches` for the current cycle). Header with client-side **Export CSV**, and a wide table: Recipient, `StatusBadge`, processor, USD, PHP, "Sent to" details, bank used, txn id, sent/arrival dates, note. Paginated 25/page.

### `src/components/payroll-clerk/DispatchReports.tsx`

The **Reports / Weekly reports** tab -- historical disbursement reports across all payroll cycles plus a paid-orphanage panel. Self-fetching; renders regardless of cycle-ready state. List view = search + an `OrphanageReportsPanel` + a paginated grid (6/page) of `ReportCard`s (period, upload, mini-stats Paid/Sent/Pending, total paid USD, "Current" badge). Detail view = back button, meta, **Export CSV** (a real server endpoint), four `DetailStat` cards, a per-processor paid breakdown, an outstanding "Not yet dispatched" panel (current cycle only), a searchable "Paid this week" recipients panel, and a full dispatch-detail table.

| Method/Endpoint | Use |
|---|---|
| `GET /api/payment-dispatches/reports` | summaries (one per cycle) |
| `GET /api/payment-dispatches/reports/{cycleId}` | full detail |
| `GET /api/payment-dispatches/reports/{cycleId}/export` | server-rendered CSV download |
| `GET /api/orphanage-dispatches?paid=1` | paid orphanage panel |

This is the historical/cross-cycle view (vs SentPaymentsHistory's current-cycle-only).

### `src/components/payroll-clerk/MarkPaidDialog.tsx`

Shared modal for logging a single employee dispatch (used by both shells). Fields: Transaction ID, Bank used, Date sent (+ optional Arrival), recipient Preferred bank / Account holder / Account number-or-wallet-id, a **SWIFT** field shown only for `wires`, a 4-way **Status** radio (`paid | not_paid | threshold | problem`), and a Note. A per-row reset effect pre-fills recipient banking via `deriveDefaults(row)` (per-processor smart defaults). **Gotcha:** per an explicit code comment, **Hurupay deliberately does NOT fall back to the work email** (the employee's Hurupay account may be a personal address) -- it is left blank for the clerk to verify. Emits a `MarkPaidPayload`; the parent does the `POST /api/payment-dispatches`.

### `src/components/payroll-clerk/QueuePagination.tsx`

Generic pagination footer used by `ProcessorQueue`, `ExcludedQueue`, `SentPaymentsHistory`, and `OrphanageQueue`. Returns `null` when `pageCount <= 1`. Configurable `label`.

### `src/components/payroll-clerk/QueueSkeleton.tsx`

Loading placeholder shown while the queue is fetching (before `hydrated`). Header + N shimmer rows whose grid mirrors `ProcessorQueue`'s layout so the swap-in is seamless.

### `src/components/payroll-clerk/AnimatedNumber.tsx`

Spring-animated numeric counter (`motion/react` `useMotionValue`/`useTransform`) used in hero/stat/badge counts. Configurable `formatter`, `stiffness`, `damping`.

### Shared dispatch data layer (load-bearing)

- **`src/components/payroll-clerk/mock-queue.ts`** -- despite the name, **real production logic**. Defines `ProcessorId`/`PROCESSORS`, `QueueRow`, `ExcludedRow`/`ExclusionReason`, `formatUSD`/`formatPHP`, `processorIdFromBankPreferred` (maps the free-text "Bank Preferred" cell / `x####` suffix to a processor), and `buildQueueFromRates(...)` which joins `employee_hourly_rates` + computed current-pay + `employee_ids` into queue/excluded rows (employee-chosen `preferred_processor` + per-processor payout fields on `employee_ids` win over legacy rates-row fields; rows dedupe by lowercased email; amount = regular + OT + PAB/Tech bonuses).
- **`useDispatchQueue.ts`** -- the queue's data hook. Parallel-fetches `GET /api/employee-hourly-rates`, `GET /api/payroll-current-pay` (per-person USD/PHP/hours/bonuses + the `period`: cycleId/start/end/source file), `GET /api/employee-ids`, then `GET /api/payment-dispatches?cycle_id=` to filter already-paid recipients out of pending/excluded. Exposes `{ rows, excluded, paid, period, fxRate, loading, error, refresh }`.
- **`src/hooks/useDispatchLock.ts`** -- drives the processing lock surfaced in every sidebar (red dot) and PayrollDispatch's toggle. Reads/writes `GET/POST /api/payroll-dispatch-lock` (the `payroll.dispatch_locked` key in `app_settings`) and subscribes to Supabase **Realtime** on that row (30s poll + focus-refetch fallback). Returns `{ state, loading, setLocked }`.

---

## Contractor Portal (`src/components/contractor/`)

A **contractor** is an external/freelance worker who logs in via the same NextAuth flow as employees but is routed to a separate, stripped-down portal at `/contractor`. RBAC treats `contractor` as a distinct `AppView`; a user holding the `contractor` role gets it, otherwise everyone defaults to `employee`. Unlike employees, contractors have **no Hubstaff hours, no leave/PAB/payroll-wizard surfaces, and no presence/S-Wall**. Their portal is three tabs (Overview, Profile, Invoices). The defining difference is the **invoice model**: contractors are not paid via the hourly pipeline -- they self-author invoices that snapshot a per-contractor "From" block + logo + currency, submit them to Accounting as `pending`, and those flow into the PayrollWizard via `GET /api/contractor/invoices?status=...`. Currency is restricted to PHP/USD (admin-set in Admin -> Roles, snapshotted onto each invoice).

### `app/contractor/page.tsx`

Route entry; `<Suspense>`-wraps `<ContractorApp />` with a centered spinner. No gating of its own.

### `src/components/contractor/ContractorApp.tsx`

Client shell -- resolves contractor identity (`?email=` -> `sessionStorage['contractor_session_email']`; neither present -> `router.replace('/login')`), owns tab state, lays out sidebar + animated main pane. On `contractorEmail` change, fetches profile photo + the full employee list to derive `contractorName` (falls back to `GET /api/employee-master-record?email=`). `googlePhotoUrl` from the NextAuth session only when the session email matches the subject email. Tabs: `overview` | `invoices` | `profile`. **Note:** gating is client-side/sessionStorage only (no server role check in this component).

| Method/Endpoint | Purpose |
|---|---|
| `GET /api/employee-profile-photo?email=` | avatar URL |
| `GET /api/employees` | match contractor -> name (full list, client-filtered) |
| `GET /api/employee-master-record?email=` | fallback name lookup |

### `src/components/contractor/ContractorSidebar.tsx`

Left nav / mobile drawer -- Simple.biz logo (heartbeat), three nav items (Overview, Profile, Invoices), dark-mode toggle, `ViewSwitcher currentView="contractor"`, an `EmployeeAvatar` chip labeled "Contractor", and Log Out (clears `SESSION_EMAIL_KEY` + the literal `'contractor_session_email'`, then `signOut({ callbackUrl: '/login' })`). Presentational.

### `src/components/contractor/ContractorOverview.tsx`

Landing dashboard -- greeting card, two `StatTile`s ("Invoices submitted" -> invoices tab; "Total billed"), a "Submit an invoice" CTA, and a "Recent invoices" card (latest 4). **Total billed is computed per-currency** (`sumByCurrency` + `formatGrouped`, e.g. `"PHP 1,200.00 + $50.00"`) -- never converts across currencies. Data: `GET /api/contractor/invoices?email=` -> `contractor_invoices` (read-only).

### `src/components/contractor/ContractorProfile.tsx`

Profile tab -- three sections (Identity / Invoice Form / Payment Gateway) with a single bottom "Save profile" that persists all at once. **Invoice Form**: logo uploader (base64 data URL, 5 MB cap), entity/company name, your name, address, country (default "Philippines"), PHP/USD currency toggle -- these prefill the sender block on every new invoice. **Payment Gateway**: processor picker (`PROCESSOR_OPTIONS`) + the shared `PayoutDetailsFields`. Data: `GET /api/contractor/profile?email=` (hydrate), `POST /api/contractor/profile` (upsert on `contractor_email`). **Field-name quirk:** the API's `alt_routing_number` column binds to the UI's `payout.altSwiftCode` in both directions. (A separate admin-only `PATCH /api/contractor/profile` sets just the currency without clobbering the contractor's own fields.)

### `src/components/contractor/ContractorInvoices.tsx`

Invoices tab -- the portal's core feature. Two sub-tabs: **New Invoice** and **History**.

- **`NewInvoiceForm`**: a receipt-styled form with logo uploader, From block, a **read-only Bill-To block hard-coded to Simple.biz / Remote/USA / USA**, invoice meta (currency read-only -- "set in Profile"), a dynamic line-items table (description/notes, qty, rate, tax %, computed amount), live Subtotal/Tax/Total, Notes, and Clear / "Send to Accounting". **Invoice number generation:** `buildInvoiceNumber(entity, issuedIso, seq)` -> `{entitySlug}-{M-D-YY}-{seq}` (e.g. `knld-5-26-26-1`); `entitySlug` keeps every other letter of the lowercased entity name. Auto-derives until the user hand-edits (`invoiceNoEdited` latch); `seq` = existing invoice count + 1. Totals: `qty*rate`, tax = `amount*taxPct/100`. Prefills From/logo/currency from the profile.
- **`InvoiceHistory`** + **`InvoiceViewDialog`**: a table of saved invoices; the eye button opens a JetBrains-Mono "receipt" rendering. **View-only -- no PDF/print/download.**

| Method/Endpoint | Backing table | Used by |
|---|---|---|
| `GET /api/contractor/invoices?email=` | `contractor_invoices` | history + prefill seq + overview |
| `GET /api/contractor/profile?email=` | `contractor_profiles` | new-invoice prefill |
| `POST /api/contractor/invoices` | `contractor_invoices` insert, **`status` forced to `pending`** | "Send to Accounting" |

**Gotcha:** `DELETE /api/contractor/invoices` always returns **403** ("Invoices sent to Accounting cannot be deleted") -- invoices are immutable to contractors once submitted; only `PATCH /api/contractor/invoices/[id]` (used by Accounting/PayrollWizard) can change status. The "Add Payment Gateway" button is a UI stub.

---

## Employee Portal -- Additional Components

The core employee components (EmployeeApp, EmployeeSidebar, EmployeeDashboard, EmployeeProfile, EmployeeSettings, EmployeeAvatar, EmployeeMyHours, MyDisputes) are documented in the **Employee Portal** section above. These are the newer tabs and cards.

### `src/components/employee/EmployeeTeam.tsx`

"My Team" tab -- roster of same-department teammates with live presence dots. Read-only department wallpaper banner, a department `<select>` (own department only), a live "N online" pill, search, and a card list. Roster = same-department profiles UNIONed with that department's assigned managers (a manager's own dept may differ from the team they oversee). Presence via `useOnlineEmails()` (Supabase Realtime). Sort: managers first, then online, then alphabetical.

| Method | Endpoint |
|---|---|
| GET | `/api/employee-rate-profiles/summary` (roster) |
| GET | `/api/department-managers/by-department?department=` (manager emails) |
| GET | `/api/manager/team-wallpaper?department=` (read-only wallpaper) |
| GET | `/api/employee-profile-photo?email=&_fmt=img` (avatar proxy) |

### `src/components/employee/EmployeeReports.tsx`

"Reports" tab -- read-only list of commendations a manager chose to **share** with the employee. Animated card list; each card shows a green flag, the quoted note, and `From {awarded_by} - {date}`. Single fetch: `GET /api/employee/commendations` (self-scoped server-side). Read-only.

### `src/components/employee/EmployeeFpu.tsx`

FPU (Financial Peace University) enrollment sign-up form. Standalone tab OR embedded inside `EmployeeMesa`'s "FPU Enrollment" sub-tab (`embedded` prop strips the page wrapper). **FPU is the only path into the MESA program.** Hardcoded `CLASS_DETAILS` (start date, 6-week duration, Thursday EST / Friday PHT), and a 4-field form (Simple.biz email, full name, department, EST shift). **Tenure gate:** requires >= 3 calendar months at Simple (`monthsBetween`, date-aware); **fails open** when `startDate` is missing so bad records do not block people. `POST /api/fpu-enroll`.

### `src/components/employee/EmployeeMesa.tsx`

"MESA" tab (Medical Emergency Savings Account). **Four sub-tabs** *(Request added 2026-06-01)*:

| Sub-tab | Content |
|---|---|
| About MESA | Program overview: why it exists, what it covers, contribution breakdown (PHP 100 employee + PHP 400 company = PHP 500/week), program rules, FPU-only enrollment path |
| FPU Enrollment | Embeds `EmployeeFpu embedded` — FPU sign-up |
| **Request** *(new)* | Self-service form to submit a MESA request; past submissions shown below the form |
| History | Projected weekly contribution ledger (`buildWeeklyLedger`) |

**Request sub-tab — `MesaRequestForm`:** A single dropdown selects the request type (Opt-in, Opt-out, Disbursement Request, Return). The relevant panel animates in via a `motion.div` with `key={requestType}` (no exit animation — old panel unmounts instantly, new one fades in once from slightly above, no cycling). Changing the option resets all sub-form state.

- **Opt-in**: enrollment confirmation checkbox + 5 agreement checkboxes + FPU completion date input.
- **Opt-out**: single removal confirmation checkbox.
- **Disbursement**: confirmation checkbox + reason dropdown (Medical Emergency / Natural Disaster / Computer Repair / Other) + explanation textarea (250-char) + PHP amount input + policy note.
- **Return**: optional notes field.

All types share pre-filled Simple.biz email (read-only), Full Name, and Department (seeded from session props). Submit -> `POST /api/mesa-requests`. Past submissions fetched on tab enter via `GET /api/mesa-requests?email=` and shown in a history table with type / reason / amount / status badge / date.

**Enrollment check:** reads `mesa_member` flag from `GET /api/employee-hourly-rates?email=` (self-lookup). **History ledger** (`buildWeeklyLedger`): Monday-anchored weeks from `start_date` → today; the in-progress week is excluded from totals. Display-only projection — no per-week rows persisted yet.

### `src/components/employee/EmployeeLeaves.tsx`

"Leaves" tab -- file leave requests and track status. Requests route to **all** the employee's department managers; **any single approval** clears the request (accounting auto-looped in). Four clickable summary tiles double as status filters, a "File a leave" card (custom portal-based `LeaveTypeSelect`, optional reason, start/end pickers), and a "My requests" list (pending rows can Cancel; cancelled/rejected can Delete). `daysBetween` inclusive.

| Method | Endpoint | Body / params |
|---|---|---|
| GET | `/api/leave-requests?employee_email=` | load |
| POST | `/api/leave-requests` | `{ employee_email, employee_name, department, start_date, end_date, leave_type, reason }` |
| PATCH | `/api/leave-requests/{id}` | `{ action: 'cancel', employee_email }` |
| DELETE | `/api/leave-requests/{id}` | `{ employee_email }` |

### `src/components/employee/EmployeePolicies.tsx`

"Company Policies" tab -- entirely static, presentational reference (three grouped sections: Work schedule & availability, Communication, Conduct & culture). Only prop is `department` (label). No state, no fetches.

### `src/components/employee/EmployeePabCalendar.tsx`

Self-contained **PAB** calendar grid for the employee -- mirrors the dashboard calendar but does its own data fetching so it can drop into other surfaces (e.g. the disputes page). Surfaces per-day Hubstaff hours against the 7h/day threshold and lets the employee click sub-7h past days to dispute. **Alias resolution:** fetches the employee row to gather work + personal emails so Hubstaff rows under either address match. **Merged Hubstaff data:** lists `source_files`, fetches each, resolves canonical weekday columns to ISO dates, unions all; per-day seconds = max across grouped duplicate columns. **Overrides:** approved disputes apply `override_hours` with **SET semantics** (replaces Hubstaff for that day); US holidays force-pass days to keep PAB eligibility. Cell states distinguish today / current-week in-progress / previous-week "Processing" (hours not yet uploaded -> sky, not red) / forgiven / pending / pass / miss. Per-day rate badges from `employee_rate_history` (emerald ring on the rate-change flip day -- mid-cycle prorating).

| Method | Endpoint | Use |
|---|---|---|
| GET | `/api/app-settings?keys=us_holidays_*` | holiday enable + list |
| GET | `/api/employees?email=` | work/personal email aliases |
| GET | `/api/employee-rate-history?email=` | per-day rate badges |
| GET | `/api/hubstaff-hours?source_files=1` then `?source_file=` | merged hours |
| GET | `/api/pab-disputes?email=&limit=200` | the employee's disputes |

### `src/components/employee/DisputeDialog.tsx`

Modal for filing (or viewing) a PAB dispute on a sub-7h day; paired with the PAB calendar's `onCellClick`. Two modes: existing dispute (read-only details incl. `override_hours` "Hours set to Nh") or new dispute (reason chips from settings + explanation textarea required only for `other`). `STATUS_STYLES` maps the full status vocabulary including the two-stage orphanage flow. Data: `GET /api/app-settings?key=pab_dispute_reason_codes`; `POST /api/pab-disputes`. **Drift note:** UI copy still mentions the dispute covering "day of or day after" (D+1), but the implicit D+1 forgiveness was removed server-side (2026-05-01), so that copy may be stale relative to the backend.

### `src/components/employee/GiftShippingCard.tsx`

Dashboard nudge + modal for the **tenure-gift shipping** flow -- every 6 months an employee hits a milestone and confirms where their gift ships; the Orphanage team reviews/approves (see `GiftTracker`). An animated inline pink card with a status badge + CTA, plus a large dialog with a celebration screen and **Form** / **Gift History** tabs. Milestone math from `@/lib/gift-milestones`. **Status model** (`GiftShippingStatus`): none / unsubmitted / pending / rejected / approved; `onStateChange` emits `{ status, milestoneMonths, needsAction }` upward so a header bell badge stays synced. Supports controlled or internal dialog state. Data: `GET /api/employee-gift-shipping?email={personalEmail}`; `PUT /api/employee-gift-shipping`. The row carries `gift_name`/`gift_price_php` once the Orphanage team approves.

### `src/components/employee/ProfileCompletionCard.tsx`

Dashboard nudge shown after sign-in when an employee still needs a profile photo and/or payout details. A single animated `<button>` (the whole card -> `onGoToProfile`) with a dynamic checklist. Renders `null` when both are done. Props `needsPhoto`, `needsBank` (driven by `isPayoutComplete`).

### `src/components/employee/PayrollLockBanner.tsx`

Global "payroll is being processed" banner at the top of the employee shell -- while locked, employee disputes are paused (the dispatch-lock pattern). Renders nothing normally; when locked, an animated rose/amber banner ("Disputes are temporarily paused", "Started by {operator} - {relative time}", progress shimmer). Re-renders every 60s to keep the relative time fresh. Driven by `state: PayrollDispatchLockState`.

### `src/components/employee/HiddenValue.tsx`

Reusable click-to-reveal mask for sensitive UI (e.g. take-home pay). **Default hidden on every mount** -- never persisted, so a coworker glancing at the screen sees `PHP .........`. Crossfades (blur+fade) between mask and revealed children, with an optional Eye/EyeOff toggle. **Uncontrolled** (owns `revealed`) or **controlled** (`revealed` prop; lets several values reveal together via one shared toggle).

### `src/components/employee/employee-payout-fields.tsx`

Shared payout/banking form building blocks + serialization helpers used in the employee Profile Payment section -- defines **how salary is routed** per processor. Exports `PayoutFields` + `emptyPayout`; `payoutDraftFromIdsRow(row)` (deserializes an `employee_ids` row -> `{ preferredProcessor, payout }`); `isPayoutComplete(row)` (validates the processor's identifying field(s) -- drives the `ProfileCompletionCard` "needs bank" nudge); `PreferredPaymentMethodRadios` (processor picker); `PayoutDetailsFields` (per-processor fields; `jeeves`/`wires` support primary + alternative PH banks via a searchable, grouped `BankSelectField` with a full PH bank list + free-text custom entry). Persists to `employee_ids`.

---

## Orphanage Module -- Budget & Gifts

Module color language: pink/rose. The dispute pieces (`OrphanageApp`, `CreateOrphanageStyleDisputeDialog`, Accounting `OrphanageVisits`) are documented above. These are the budget-request and tenure-gift surfaces. Submitted **budget requests** go to **Accounting** for approval; **tenure-gift shipping** submissions are reviewed by the **Orphanage team** (`GiftTracker`).

### `src/components/orphanage/OrphanagesPanel.tsx`

Static directory of the orphanages the team rotates through, with an editable per-orphanage "leftover budget" field. `INITIAL_ORPHANAGES` is hardcoded **mock data**; state is local-only -- **no persistence, no API calls** (a comment notes it awaits an HR decision on the backing store).

### `src/components/orphanage/OrphanageBudgetForm.tsx`

"Budget Request" tab -- single-page form to request a disbursement for an orphanage visit, with a sticky live-summary sidebar. Step 1 = 3-tile visit-type chooser (**Monthly Visit** / **Frequent Travelers** / **Special Project**); choosing one fades in a 2-column layout. The **Monthly** section computes `directGiving` (gift + lootbag + cake), `subtotal`, **gift efficiency** (`directGiving/subtotal * 100`, the % of budget reaching kids directly), and `finalAmount = max(0, subtotal - leftover)`. `LiveSummary` shows a `GiftEfficiencyBar` and an animated counting final figure. Submit: `POST /api/orphanage-budget-requests` (amounts rounded to cents; `payload` carries type-specific fields), then `onSubmitted()`. (The header "client-only" comment is stale -- it does POST.)

### `src/components/orphanage/OrphanageBudgetHistory.tsx`

"Budget History" tab -- browse past budget requests **and** gift payments with status decisions and a full audit timeline. Sticky bar with Source toggle (Budgets / Gifts), Scope toggle (My requests / All), Refresh. Expandable cards: **budget cards** show subtotal/leftover/final + decider + a collapsible bank snapshot + an `AuditTimeline`; **gift cards** show vendor/period/USD + line items. `fetchRows` is memoized on `source/scope/viewerEmail`; budgets request `with_audit=1`.

| Method | Endpoint |
|---|---|
| GET | `/api/orphanage-budget-requests?email=&with_audit=1` |
| GET | `/api/gift-payments?email=` |

Read-only (approve/reject happens on the Accounting side).

### `src/components/orphanage/GiftCatalog.tsx`

Editable catalog of giftable items, anniversary-tier mappings, and free-form suggestions (`GiftTracker` -> Catalog sub-tab). This catalog drives auto-derivation of which gift an approved tenure milestone gets. `CatalogPayload = { items, anniversaries, suggestions }`; seeds `DEFAULT_PAYLOAD` when empty. `dirty` = JSON diff. Data: `GET /api/gift-catalog`, `PUT /api/gift-catalog`. The anniversary `year` (0.5/1/1.5...) and item name are the join keys `GiftTracker.deriveGiftForMilestone` uses.

### `src/components/orphanage/GiftPayments.tsx`

Log vendor payment batches for gifts -- the actual purchase records behind the Gift History "Gifts" source (`GiftTracker` -> Payments sub-tab). Expandable payment cards with a nested Vendor profile (`banks: VendorBank[]`), an editable items table (qty x unit + shipping = grand total), and a Full payment block (txn id, dates, status `pending | sent | paid | cancelled`). Deeply nested immutable updaters; **re-fetches after save** so server ids/timestamps land. Data: `GET /api/gift-payments?email=`, `PUT /api/gift-payments`.

### `src/components/orphanage/GiftTracker.tsx`

The Gift module hub (Orphanage team). Computes every employee's 6-month tenure-gift milestones from their master-list start date, surfaces who is due soon, and is where shipping submissions are reviewed. Hosts the Catalog + Payments sub-tabs. 4-way sub-tab nav: **Roster** (stat tiles within 1 week/1 month/3 months, paginated table sorted by closest upcoming gift, per-row expand to milestone history + editable note + that employee's submissions), **Submissions** (flat list with status filter pills + inline Return / Approve&lock / Edit / Delete), **Catalog** (`GiftCatalog`), **Payments** (`GiftPayments`). **Approve = auto-derive gift, no manual picking:** `deriveGiftForMilestone(index)` maps `index*0.5` years -> an anniversary tier -> a catalog item by name; approval PATCHes status + gift fields and the result becomes a gift payment downstream.

| Method | Endpoint |
|---|---|
| GET | `/api/employees` (roster, `start_date`) |
| GET | `/api/gift-tracker-notes` |
| GET | `/api/employee-gift-shipping` (all submissions) |
| GET | `/api/gift-catalog` (gift derivation) |
| PUT | `/api/gift-tracker-notes` |
| PATCH | `/api/employee-gift-shipping/{id}/decide` (status + gift fields) |
| PATCH | `/api/employee-gift-shipping/{id}` (orphanage-side edit) |
| DELETE | `/api/employee-gift-shipping/{id}` |

The employee-facing counterpart of the shipping flow is `GiftShippingCard`.

---

## Shared / Cross-Cutting Components

These mount across multiple dashboards. (Auth/RBAC libs + `ViewSwitcher` are documented at the top under **Auth, RBAC & Role Routing**; `useDispatchLock` under the Payroll Clerk shared data layer.)

### `src/components/presence/PresenceProvider.tsx`

Broadcasts app-wide online presence for every authenticated client. Mounted once at the app root inside `NextAuthProvider`; powers the live "online" badges on the Manager "My Team" and Employee "My Team" tabs. Exports default `PresenceProvider` + the hook `useOnlineEmails(): ReadonlySet<string>`. Opens a single Supabase Realtime **presence** channel `hris-presence` keyed by the user's normalized email; on subscribe it `channel.track({ email, name, online_at })`; `sync`/`join`/`leave` events recompute the live `Set<string>`. Realtime presence only -- no REST, no DB table.

### `src/components/swall/SWall.tsx`

The company social feed ("Simple Wall"). A post stream with reactions, threaded comments, image uploads, @mentions, plus a right rail (social links, CEO announcements, collapsible company policies). Rendered as the "S-Wall" tab in Accounting, Employee, Manager, HR, CEO, and Orphanage dashboards. Props `{ viewerEmail, canPost, viewerName?, sourceLabel? }` (`sourceLabel` tags posts with the originating dashboard). A single `swall-feed` Realtime channel subscribes to postgres_changes on `swall_posts`, `swall_reactions`, `swall_comments` (count), and `announcements` (the CEO rail). Reactions use **optimistic updates** with an `ownPendingRef` to suppress the user's own Realtime echo and an `inFlightRef` to block double-clicks. Composer supports drag/drop + paste image upload (max 10) and a keyboard-navigable @mention dropdown. Emoji via `emoji-mart`.

Data: `GET /api/swall/posts?viewer=`, `POST /api/swall/posts`, `DELETE /api/swall/posts/{id}`, `POST /api/swall/reactions`, `GET/POST /api/swall/comments`, `DELETE /api/swall/comments/{id}`, `POST /api/swall/upload`, `GET /api/announcements?scope=general`, `GET /api/employee-rate-profiles/summary` (mentions), `GET /api/employee-profile-photo` (avatars). Tables: `swall_posts`, `swall_reactions`, `swall_comments`, `announcements`. Exports `SWallNavLabel` for the animated nav label.

### `src/components/notifications/NotificationsPanel.tsx`

Per-employee notifications feed (rate changes, promotions) plus a live "Payroll Processing Started" lock banner. Used as the "Notifications" tab across Accounting, Employee, Manager, HR, CEO, Orphanage, and PayrollDispatch. Props `{ viewerEmail?, accent? }`. Subscribes to a per-user channel `employee-notifications-${email}` on `employee_notifications` filtered `recipient_email=eq.<email>`. Auto-marks unread as read 2s after display; optimistic delete. Pulls dispatch-lock state via `useDispatchLock()` -- when locked it renders an "Active" banner listing paused actions. Data: `GET /api/employee-notifications?email=`, `PATCH` (mark read), `DELETE ?id=`, plus `GET/POST /api/payroll-dispatch-lock` via the hook.

### `src/components/announcements/AnnouncementWall.tsx`

Scoped, real-time announcement feed (pinned-first, then newest). Props `{ scope: 'all' | 'general' | string[], viewerEmail, isElevated?, className? }` -- `scope` controls both the fetch query and the Realtime visibility filter (`'all'` = admin/CEO, `'general'` = company-wide, `string[]` = general + listed departments). `scopeKeyOf()` produces a stable content hash so effects do not re-run on every parent re-render (fixed a ~30s skeleton flash). Channel `announcements-wall` listens to postgres_changes on `announcements`, applying the scope filter client-side and keeping pinned ordering. Delete (own or elevated) + pin-toggle (elevated only). Data: `GET /api/announcements?scope=/department=`, `DELETE /api/announcements/{id}`, `PATCH /api/announcements/{id}` (pin).

### `src/components/announcements/AnnouncementComposer.tsx`

Compose/post announcements; pairs with `AnnouncementWall`. Props `{ authorEmail, allowGeneral, departments[], canPin?, authorLabel?, className? }`. Tabs = (general if allowed) + each manageable department; renders `null` if no tabs. Collapsed "Share something..." trigger expands to a title+body form (`TITLE_MAX=120`, `BODY_MAX=2000`). `canPin` exposes a Pin-to-top checkbox. Data: `POST /api/announcements`. No Realtime here -- the paired Wall picks the new row up live.

### `src/components/audit/AuditLogPanel.tsx`

Admin/accounting activity log viewer (also embedded in System Settings). Loads up to 500 rows; client-side category filtering (12 `CATEGORIES`), free-text search across label/action/user/role and any value in `details`, sortable, paginated. The big `formatActionLabel()` switch turns ~60 raw `audit_log.action` codes (e.g. `rbac.role.granted`, `payment.dispatched`, `csv.rates.sync`, `hr.employee.offboarded`, `pab_dispute.*`, `auth.force_logout`) into human sentences. Exports `formatAbsoluteTime`, `formatRelativeTime`, `formatActionLabel`. Includes a confirm-guarded "Clear Log". Data: `GET /api/audit-log?limit=`, `DELETE /api/audit-log`. No Realtime (manual Refresh).

### `src/components/AppFooter.tsx`

Trivial footer -- "Developed by AI/API Team / Simple.biz (c) {year}". No state/props/data. Used by every dashboard shell.

### `src/components/SystemSettings.tsx`

The Accounting "Settings" tab -- payroll rules, per-department overtime toggles, US-holiday PAB forgiveness, and the embedded audit log. Left rail toggles payroll rules (currently `tech_bonus_enabled`) and switches a right-hand tab (`ot | holidays | audit`). **OT panel:** a `Suspend All OT` global switch (`ot_global_suspended`) overrides per-department `ot_dept_<key>` toggles for the 12 `DEPARTMENTS`. **Holidays panel:** master switch + an editable list (add/remove/toggle, "Seed {year}" federal holidays). Every change goes through `persist()`/`persistHolidayList()` (save the setting + fire-and-forget audit write) with optimistic per-key `SaveState` + rollback. `rightTab === 'audit'` renders `AuditLogPanel`. Data: `GET/POST /api/app-settings`, `POST /api/audit-log`. **Gotcha:** the actor is still hardcoded `CURRENT_USER = { name: 'Fran M', role: 'Senior Admin' }` here (RBAC actor not yet wired into this panel); the "Access Control" section is a placeholder.

---

## `components/ui/` — shadcn Primitives

These components are generated by shadcn and should not be edited directly. They provide accessible HTML foundations:

| Component | Usage in app |
|---|---|
| `badge` | Department labels, status indicators, step labels |
| `button` | All interactive buttons |
| `card` | Dashboard stat cards, modal inner panels |
| `checkbox` | Bonus toggle options (some depts) |
| `dialog` | View Profile, Add Employee, Delete Confirm, CSV upload approval |
| `input` | Search bars, metric inputs, rate editor |
| `label` | Form labels |
| `scroll-area` | Tall table containers |
| `select` | Department filter dropdown |
| `separator` | Visual dividers |
| `sonner` | Toast notification queue (Toaster component) |
| `switch` | Dark mode toggle, Hogan cycle toggle, per-employee bonus toggles |
| `table` | Employee table, calc table, bonus table, pre-flight table |
| `tabs` | Department tabs in Step 3 |
