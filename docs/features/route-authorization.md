# Route Authorization (who may open which dashboard)

*Added 2026-06-23. Covers the server-side access control for page routes
(`/admin`, `/accounting`, …) and the admin API namespace.*

## The incident this fixes

A normal employee with **no roles** (`alessandrob@simple.biz`) was able to open
the **Admin console** simply by typing `/admin` in the address bar.

Root cause: the edge gate (`proxy.ts`, formerly `middleware.ts`) only
**authenticated** the request — "do you hold a valid `@simple.biz` Google
session?" — and then let *every* signed-in user through to *every* page route. It
never **authorized** by role. The admin page itself (`app/admin/page.tsx`) is a
`'use client'` component that reads its "admin email" from `?email=`/`sessionStorage`
and does **no** role check, so the whole shell rendered for anyone.

The fix adds role-based **authorization** as a first-class, centralized,
server-side layer. **Never gate a privileged route from inside the client page
component — that is not a real protection.**

---

## The three layers (defense in depth)

| Layer | File | Runs | Protects |
|---|---|---|---|
| 1. Edge proxy (primary) | `proxy.ts` → `evaluateRouteAccess()` | Every non-static request, before the page/API runs | All page routes + `/api/admin/*` |
| 2. Server page guard | `app/<dashboard>/layout.tsx` → `requirePageRoles()` | On the server, before the dashboard shell renders | Each privileged dashboard tree (belt-and-suspenders if the proxy matcher is ever changed) |
| 3. API handler gates | each route's `requireAdminSession()` / `requireElevatedSession()` / `authorizeEmailAccess()` | Inside every API route | The data itself — independent of the UI |

The single source of truth for layers 1 & 2 is
**`src/lib/auth/route-access.ts`**.

### Layer 1 — edge proxy

`proxy.ts` authenticates (valid JWT, not force-logged-out), then hands the
**decision** to the pure function `evaluateRouteAccess({ pathname, roles,
sessionEmail, elevated, requestedEmail })`. It returns one of:

- `{ action: 'allow' }`
- `{ action: 'forbid' }` → proxy returns **403 JSON** (used for `/api/admin/*`)
- `{ action: 'redirect', pathname, … }` → proxy returns a **302** to a safe page

Unauthenticated users never reach `evaluateRouteAccess` — the proxy redirects
them to `/login?callbackUrl=…` first (this branch is unchanged).

### Layer 2 — server page guard

**Every** privileged dashboard has an `app/<dashboard>/layout.tsx` that calls
`requirePageRoles(requiredRolesFor('/<dashboard>') ?? ['admin'])` on the server
(`/admin`, `/ceo`, `/accounting`, `/payroll-clerk`, `/hr`, `/orphanage`,
`/manager`). Because a layout wraps every nested route, this covers `/admin`,
`/admin/`, and any future `/admin/*` sub-route. A user without the role is
`redirect()`-ed before the client shell (and its mount-time data fetches) ever
renders. The roles come from `requiredRolesFor()` so the guard and the proxy never
drift from the single source of truth.

> The `/accounting` page also reads the session, but only to *prefetch* data — it
> does not redirect. The layout guard is the actual server gate there.

### Layer 3 — API gates

Page access ≠ data access. Every admin/elevated API enforces its own check so the
data is safe even if a UI gate is bypassed (see `src/lib/auth/authorize-email.ts`):

- `requireAdminSession()` — `admin` only (e.g. `/api/admin/*`, role grant/revoke).
- `requireElevatedSession()` — `admin | accounting | hr_coordinator`.
- `requireRateVisibilitySession()` — `admin | accounting | ceo` (raw pay rates).
- `authorizeEmailAccess(email)` — self-or-elevated for per-employee endpoints.

---

## The route → role map

From `src/lib/auth/route-access.ts` (`ROUTE_REQUIRED_ROLES`):

| Route prefix (+ all sub-routes) | Roles that may open it |
|---|---|
| `/admin` | `admin` |
| `/ceo` | `ceo`, `admin` |
| `/accounting` | `accounting`, `admin` |
| `/payroll-clerk` | `accounting`, `admin` |
| `/hr` | `hr_coordinator`, `admin` |
| `/orphanage` | `orphanage_manager`, `admin` |
| `/manager` | `manager`, `admin` |

`admin` is accepted on every privileged route on purpose ("keys to the castle",
mirroring `viewsForRoles()` in `src/lib/rbac/views.ts`).

**Open to any authenticated user** (deliberately *not* in the map): `/`,
`/auth-callback` (dispatchers); `/employee`, `/contractor` (personal portals,
scoped to the session owner); `/login`, `/onboarding/*` (public).

> **Note on `/payroll-clerk`:** gated to `accounting`/`admin` because it is a
> money-dispatch surface. If a payment processor operates it without the
> `accounting` role, give them that role (or add a dedicated role to the map) —
> do **not** widen it to all employees.

---

## How to add a new privileged dashboard

1. Add one line to `ROUTE_REQUIRED_ROLES` in `src/lib/auth/route-access.ts`:
   ```ts
   { prefix: '/reports', roles: ['accounting', 'admin'] },
   ```
2. Add a server guard layout (every privileged dashboard has one — match them):
   ```tsx
   // app/reports/layout.tsx
   import { requirePageRoles } from '@/lib/auth/require-page-roles';
   import { requiredRolesFor } from '@/lib/auth/route-access';
   export default async function Layout({ children }) {
     await requirePageRoles(requiredRolesFor('/reports') ?? ['admin']);
     return <>{children}</>;
   }
   ```
3. Make sure the dashboard's API routes enforce their own gate (Layer 3).
4. Add a case to `src/lib/auth/route-access.test.ts` and run `npm run test:authz`.

---

## Tests

`src/lib/auth/route-access.test.ts` (Node built-in test runner, run with `tsx` —
no extra deps):

```bash
npm run test:authz      # just the authorization matrix
npm test                # all *.test.ts
```

Covers: roleless user blocked from `/admin`; admin allowed; every route variant
(`/admin`, `/admin/`, `/admin/users`, `/admin/settings`, nested); each dashboard
requires its own role; an accounting user cannot reach `/admin`; non-admin
`/api/admin/*` → 403; admin `/api/admin/*` → allow; open routes stay open;
contractor + `?email=` ownership behavior preserved.

---

## Manual verification

1. **Roleless user → `/admin`:** sign in as an employee with no roles. Visit
   `/admin`, `/admin/users`, `/admin?tab=roles`. Expect a redirect to `/employee`;
   the admin shell must not flash or render.
2. **Authenticated non-admin API:** while signed in as that user, run in the
   browser console:
   ```js
   await fetch('/api/admin/diagnostics').then(r => r.status) // → 403
   ```
3. **Admin user → `/admin`:** sign in as an `admin`. `/admin` and every tab load
   normally (no regression).
4. **Other dashboards:** an `accounting` user reaches `/accounting` but is
   redirected away from `/admin` and `/hr`.
5. **Unauthenticated:** in a logged-out/incognito window, visit `/admin`. Expect a
   redirect to `/login?callbackUrl=%2Fadmin`.

---

## Related

- `src/lib/auth/authorize-email.ts` — the API-side gates (Layer 3).
- `src/lib/auth/elevated-roles.ts` — role sets (`ELEVATED_ROLES`, `RATE_VISIBLE_ROLES`).
- `src/lib/rbac/views.ts` — client-side view switcher (UX only; **not** a security boundary).
- `SECURITY_AUDIT.md` finding #25 — the related *client-side* dashboard authz bug.
