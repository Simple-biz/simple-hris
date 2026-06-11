# RBAC & Feature Permissions

How access is decided across the eight role dashboards. Two layers stack:

1. **Role grants** (`employee_roles`) -- gate access to a *dashboard* (the whole view).
2. **Feature permissions** (`employee_feature_permissions`) -- gate which *tabs*
   within that dashboard a user can see and edit. This is the single source of
   truth for per-tab visibility, provisioned entirely from the **Admin Dashboard**.

> History: feature permissions started as an Accounting-only overlay. As of the
> 2026-06 overhaul, enforcement spans every role view (HR, Manager, CEO,
> Contractor, Orphanage, Accounting) and the API routes behind them. The Admin
> "Roles and Permissions" screen is now the one place that decides what each
> person sees.

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
| `work_email` | Canonical user identity |
| `view_key` | Which dashboard (`accounting`, `hr`, `manager`, `orphanage`, `ceo`, `contractor`) |
| `feature` | Tab id within that view |
| `access` | `hidden` \| `view` \| `edit` |
| `granted_by`, `granted_at`, `revoked_at` | Audit columns; active row == `revoked_at IS NULL` |

The feature catalog (which tabs exist per view) lives in
`src/lib/rbac/feature-permissions.ts`. **Adding a tab?** Append it there and the
AdminRoles grid + enforcement pick it up automatically.

---

## 2. Provisioning from the Admin Dashboard

`src/components/admin/AdminRoles.tsx` is the control surface:

- Pick a person from the left pane.
- For each granted role, a **Hidden / View / Edit grid** renders one row per tab
  in that view (`FeaturePermissionGrid`). Default shown is "Hidden by default --
  pick a level per tab, or use the bulk actions".
- **Bulk actions** set every tab in a view to one level at once.
- Each click upserts via `POST /api/employee-feature-permissions`; the change is
  audit-logged (`feature_permission.grant` / `.revoke`).

Assignable roles today: `admin`, `ceo`, `hr_coordinator`, `finance`,
`orphanage_manager`, `contractor`, `manager`. Legacy roles (`viewer`,
`payroll_coordinator`, `payroll_manager`) still render for existing assignments
but are no longer offered for new grants.

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
(not `edit`) it shows an amber "View only" banner and applies the `inert`
attribute to freeze interaction.

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
  (`announcements`, `notifications`, `s_wall`); edit in *any* of the caller's
  mapped views authorizes.

`admin` bypasses the check. Standard route pattern:

```ts
const authz = await requireFeatureEdit('hr', 'offboarding')
if (!authz.ok) return deniedResponse(authz)
```

Wired into mutation routes including `app/api/manager/medals`,
`app/api/manager/member-notes`, `app/api/hsl-bonus/*`, `app/api/hr/offboard`,
`app/api/hr/reonboard`, `app/api/orphanages`, `app/api/orphanage-budget-requests`,
`app/api/payment-dispatches`, `app/api/payroll-dispatch-lock`, and more. GET
endpoints stay lighter; POST/PATCH/DELETE require the `edit` grant.

---

## 5. Force-logout / session reset

Because roles are stamped into the JWT at sign-in, changing a role or permission
won't take effect until the user gets a fresh token. AdminRoles handles this:

- **Revoking** a role fires a fire-and-forget `POST /api/auth/force-logout` for
  that user automatically.
- **Granting** a role offers a manual **"Reset session"** button so the admin
  chooses when to refresh.

`POST /api/auth/force-logout` calls `bumpForceLogoutFor(email)`
(`src/lib/auth/force-logout.ts`), which writes an ISO timestamp into the
`app_settings.auth.force_logout_map` JSON map (entries older than 30 days are
pruned).

`middleware.ts` caches the map (refreshed every ~30s) and, on every request,
compares the JWT's `iat` against the user's cutoff. If the token predates the
cutoff it clears the NextAuth session cookies and redirects to `/login`, forcing
re-auth and a fresh token with the new roles/permissions. The NextAuth `jwt`
callback applies the same check at token refresh.

> This invalidates the *app's* JWT, not the upstream Google/SSO session. After
> re-auth the user mints a fresh JWT reflecting the new grants. If a user appears
> "not logged out" on a live call, confirm the Vercel deploy carrying the change
> has shipped and that their `iat` actually predates the cutoff.

See also: `docs/reference/system-architecture.md` decision #8;
`docs/implementation-plans/implementation-plan-rbac.md` for the original plan.
