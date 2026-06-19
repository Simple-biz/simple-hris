# RBAC & Feature Permissions

How access is decided across the role dashboards. Two layers stack:

1. **Role grants** (`employee_roles`) -- a role does ONE thing now: unlock a whole
   *dashboard* (the view). Roles carry no per-feature meaning of their own.
2. **Feature permissions** (`employee_feature_permissions`) -- the ABAC overlay
   that decides which *tabs* within that dashboard a user can see and edit
   (Hidden / View / Edit). This is the single source of truth for per-tab access,
   provisioned entirely from the **Admin Dashboard**.

> **2026-06-18 overhaul (roles = dashboard access only).** The named *functional*
> roles were retired: `payroll_coordinator`, `payroll_manager`, and `viewer` are
> no longer assignable, and `finance` was **renamed to `accounting`**. A role now
> just opens its dashboard; what you can do *inside* it is decided entirely by the
> feature-permission overlay. Assigning a role **auto-provisions** sensible tab
> permissions (every tab to `edit`); revoking it tears them back down. Enforcement
> spans every role view (HR, Manager, CEO, Contractor, Orphanage, Accounting) and
> the **write** API routes behind them -- view-only users are blocked from
> POST/PATCH/DELETE. See `references/sql/migrate/2026-06-18_roles_dashboard_only.sql`
> (PENDING -- not yet confirmed run; deploy code first, then run).

---

## 1. The permission model

Three access levels per (user, view, feature):

| Level | Meaning |
|---|---|
| `hidden` | Tab not shown at all. **This is the default** -- no row == hidden. |
| `view` | Tab visible but read-only (locked via `ReadOnlyTab`). |
| `edit` | Full access; mutations allowed. |

Stored in the `employee_feature_permissions` table (not in the JWT, not in
app_settings):

| Column | Notes |
|---|---|
| `work_email` | Canonical user identity (lowercased) |
| `view_key` | Which dashboard (`accounting`, `hr`, `manager`, `orphanage`, `ceo`, `contractor`) |
| `feature` | Tab feature key within that view (tab id with dashes → underscores; see `tabFeatureKey`) |
| `access` | `hidden` \| `view` \| `edit` |
| `granted_by`, `granted_at`, `revoked_at` | Audit columns; active row == `revoked_at IS NULL` |

The feature catalog (which tabs exist per view) lives in
`src/lib/rbac/feature-permissions.ts` (`FEATURE_CATALOG`). **Adding a tab?**
Append it there and the AdminRoles grid + enforcement pick it up automatically.
`ROLE_TO_FEATURE_VIEW` maps each assignable role to the view its catalog lives
under (`admin` deliberately has no entry -- it bypasses gating everywhere).

> Note: `src/lib/rbac/view-tabs.ts` keeps a parallel `VIEW_TAB_IDS` ordering used
> by the sidebars. The two lists can drift -- e.g. the accounting catalog has a
> `bonus_catalog` (Payment Catalog) feature that isn't in `VIEW_TAB_IDS`. Keep
> them in sync when adding/removing a tab.

---

## 2. Provisioning from the Admin Dashboard

`src/components/admin/AdminRoles.tsx` is the control surface:

- Pick a person from the left pane (or **Add by email** to manage an off-roster
  address -- service accounts, contractors, founders).
- Assign / revoke a role (`POST` / `DELETE /api/employee-roles`). **Granting and
  revoking are admin-only** -- the route rejects non-admin callers (the keystone
  anti-escalation guard).
- For each *granted* role with a feature catalog, a **Hidden / View / Edit grid**
  renders one row per tab (`FeaturePermissionGrid`). Admin shows no grid (it
  bypasses gating). The grid pre-fills from `provisionDashboardTabs` having set
  every tab to `edit` at grant time; the admin then dials individual tabs down to
  `view` or `hidden`.
- **Bulk actions** ("All: Edit / All: View / Hide all") set every tab in a view at
  once -- essential under hidden-until-granted.
- Each click upserts via `POST /api/employee-feature-permissions`.
- For a `manager` role: a **Departments managed** picker writes `department_managers`
  rows (controls team roster + leave approval). If the **HSL** parent department is
  assigned, an **HSL sub-departments** section appears, writing granular
  `hsl:<key>` grants (`hslAccessKey`) -- these gate the HSL KPI Calculator (see §6).
- For a `contractor` role: an **Invoicing currency** toggle (PHP/USD) presets the
  contractor's invoices.

**Assignable roles today** (one role = one dashboard):
`admin`, `ceo`, `hr_coordinator` (HR dashboard), `accounting`, `orphanage_manager`,
`contractor`, `manager`. The route's `VALID_ROLES` rejects anything else.

| Role | Dashboard unlocked |
|---|---|
| `admin` | **All** management dashboards (bypasses every gate); not the contractor view |
| `ceo` | CEO |
| `hr_coordinator` | HR **and** Accounting (kept its legacy accounting access) |
| `accounting` | Accounting (renamed from `finance`) |
| `manager` | Manager |
| `orphanage_manager` | Orphanage |
| `contractor` | Contractor (external identity; replaces the employee portal) |

View resolution lives in `src/lib/rbac/views.ts` (`viewsForRoles`): `ACCOUNTING_ROLES`
= `accounting` + `hr_coordinator`; `admin` returns every view except `contractor`.
The **retired** roles (`viewer`, `payroll_coordinator`, `payroll_manager`, `finance`)
are kept in the DB CHECK constraint only so soft-deleted history rows stay valid;
they cannot be assigned. Their old powers (dispute approve/delete, dispatch lock,
leave delete) folded into `accounting`.

---

## 3. How tabs are hidden / shown / locked

Client side, `src/hooks/useFeaturePermissions.ts` fetches the user's roles +
feature permissions and exposes:

- `allowedTabs(view)` -- visible tab ids (`view` or `edit`).
- `canAccessTab(view, tabId)`
- `canEditTab(view, tabId)` -- true only at `edit`.

Each role app (`HrApp`, `ManagerApp`, `CeoApp`, `ContractorApp`, `OrphanageApp`,
and the Accounting `AppShell`) passes `allowedTabs` to its sidebar so hidden tabs
never render, and auto-redirects if the active tab becomes disallowed.

`src/lib/rbac/view-tabs.ts` is the resolver:

- `allowedTabsForUser()` -- hidden-until-granted; `overview` is always visible as
  a read-only landing so a dashboard is never blank.
- `canEditTab()` -- edit-only.
- The `admin` role is in `BYPASS_PERMS_ROLES`: it bypasses all gating so you can't
  lock yourself out.

`src/components/rbac/ReadOnlyTab.tsx` wraps tab content; when the user has `view`
(not `edit`) it shows an amber "View only" banner and freezes interaction with a
capture-phase listener on the wrapper that swallows every *mutating* event
(`click`, `keydown`, `input`, `paste`, `submit`, drag/drop, etc.) before it
reaches a child handler. It deliberately does **not** use the `inert` attribute
(`inert` is all-or-nothing on a subtree and can't be re-enabled on a descendant).
A carve-out keeps search/filter fields live (`data-readonly-allow`,
`input[type="search"]`, `[role="searchbox"]`, plus a placeholder/aria-label
search heuristic); scrolling and read-only gestures are never blocked.

> `src/lib/rbac/accounting-tabs.ts` still exports `allowedAccountingTabsForRoles()`
> but it is **deprecated** -- kept only so older callers don't break. Real gating
> is `allowedAccountingTabsForUser()` (the feature-permission overlay). The
> accounting dashboard no longer restricts tabs by role.

---

## 4. API enforcement

`src/lib/auth/authorize-feature.ts` provides the server guards:

- `requireFeatureAccess(view, feature, level='edit')` -- checks the session, loads
  the caller's feature permissions, returns `{ ok, status, message, sessionEmail, roles }`.
- `requireFeatureEdit(view, feature)` -- convenience wrapper for `edit`.
- `requireFeatureEditAnyView(feature)` -- for cross-view features
  (`announcements`, `s_wall`, `mesa`, `leaves`); edit in *any* of the caller's
  mapped views authorizes.

`admin` bypasses the check. A missing grant is **default-deny** (403); `view` is
read-only and only authorizes `requireFeatureAccess(..., 'view')`. Standard route
pattern:

```ts
const authz = await requireFeatureEdit('hr', 'offboarding')
if (!authz.ok) return deniedResponse(authz)
```

As of the 2026-06-18 overhaul this is wired into **~74 write routes** across all
views (every `app/api/.../route.ts` that mutates) -- e.g. `app/api/manager/medals`,
`app/api/manager/member-notes`, `app/api/hsl-bonus/*`, `app/api/hr/offboard`,
`app/api/hr/reonboard`, `app/api/hr/pending-employees/*`, `app/api/hr/pay-plans`,
`app/api/orphanages`, `app/api/orphanage-budget-requests`, `app/api/payment-dispatches`,
`app/api/payroll-dispatch-lock`, `app/api/bonus-catalog*`, `app/api/announcements`,
`app/api/swall/*`, `app/api/leave-requests/[id]`, `app/api/time-adjustments/[id]`,
and more. GET endpoints stay lighter (and rely on the dashboard role / `requireElevatedSession`);
**POST/PATCH/DELETE require the `edit` grant**, so a `view`-only user sees a tab but
is blocked server-side from mutating it.

> `app/api/employee-roles` itself is the exception: granting/revoking a role is
> hard-gated to `admin` (not feature-permission driven), and it also runs
> `provisionDashboardTabs` / `deprovisionDashboardTabs` to (de)provision the tab
> overlay, plus a `manager`-revoke cascade into `department_managers`
> (`revokeAllForManager`).

---

## 5. Force-logout / session reset

Because roles are stamped into the JWT at sign-in, changing a role or permission
won't take effect until the user gets a fresh token. AdminRoles handles this:

- **Revoking** a role fires a fire-and-forget `POST /api/auth/force-logout` for
  that user automatically.
- **Granting** a role (or changing a feature permission) offers a manual
  **"Reset session"** button so the admin chooses when to refresh.

`POST /api/auth/force-logout` calls `bumpForceLogoutFor(email)`
(`src/lib/auth/force-logout.ts`), which writes an ISO timestamp into the
`app_settings.auth.force_logout_map` JSON map (entries older than 30 days are
pruned). Resetting your own account is a no-op (`skipped: 'self'`).

**Live yank (no navigation required).** `src/components/auth/SessionInvalidationWatcher.tsx`
is mounted once at the app root inside the NextAuth provider. It subscribes via
Supabase Realtime to changes on `app_settings` where `key=auth.force_logout_map`;
the instant the map changes it calls `GET /api/auth/session-status`, which reads
the map **uncached** and compares the caller's JWT `iat` against their cutoff. If
`valid:false`, the watcher clears `sessionStorage` and `signOut({ callbackUrl: '/login' })`
on the spot. A 45s poll + a window-focus / visibility re-check back it up if
Realtime is down. The endpoint **fails open** (never yanks on a transient lookup
error), and a sign-out guard ref de-dupes the realtime/poll/focus burst.

`middleware.ts` applies the same `iat`-vs-cutoff check on every request (map cached
~30s), clearing the NextAuth cookies and redirecting to `/login` for any navigation
that slips past the live watcher; the NextAuth `jwt` callback re-checks at token
refresh.

> This invalidates the *app's* JWT, not the upstream Google/SSO session. After
> re-auth the user mints a fresh JWT reflecting the new grants. If a user appears
> "not logged out" on a live call, confirm the Vercel deploy carrying the change
> has shipped and that their `iat` actually predates the cutoff.

---

## 6. KPI Calculator gating (Manager dashboard)

The Manager **HSL Bonus** tab hosts two KPI calculators, gated by
`department_managers` scope rather than the feature overlay alone:

- **Elevated scope** (`teamGate.kind === 'elevated'`, i.e. an elevated role and no
  specific department assignments -- `app/api/manager/department-members`) unlocks
  the **Departments** calculator across all departments.
- **HSL Branches** calculator is stricter: as of 2026-06-18 it requires an
  **explicit `hsl:<branch>` assignment** in `department_managers`. Being
  elevated/admin alone no longer reveals it -- `ManagerApp` passes `isElevated=false`
  into `canAccessHslDept` for the HSL visibility check, so only an assigned HSL
  branch makes the calculator appear. The branch picks also scope which sub-teams
  the calculator shows (`src/lib/hsl-bonus/schema.ts → canAccessHslDept`,
  `hslAccessKey`).
- A manager with neither sees an empty-state ("No bonus departments assigned to
  you"); a manager with both gets a calculator switcher.

See also: `docs/reference/system-architecture.md` decision #8;
`docs/implementation-plans/implementation-plan-rbac.md` for the original plan.
