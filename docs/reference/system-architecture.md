# Simple HRIS: System Architecture

## Overview

Simple HRIS is a payroll-focused Human Resource Information System built for a Philippines-based outsourcing company. Its primary job is the weekly payroll processing cycle that takes a Hubstaff hours export, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger.

The stack is a **Next.js App Router shell** that hosts a client-side SPA inside `src/`. Next.js is used for its API routes only — all UI logic is `"use client"` React.

---

## Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | API routes + React Server Components shell |
| UI Runtime | React 19, `"use client"` | Full SPA feel inside Next.js |
| Language | TypeScript 5.8 (`strict: false`) | Type safety without over-engineering |
| Styling | Tailwind CSS v4 | Utility-first, co-located with markup |
| Component primitives | shadcn (`base-nova` style) on `@base-ui/react` | Accessible unstyled primitives, skinned to match brand |
| Animations | `motion/react` (Framer Motion 12) | Step transitions, modal field stagger, active-pill indicator |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` | Managed Postgres with RLS, anon + service-role keys |
| Direct Postgres | `pg` Pool | Table discovery, daily report import (schema creation) |
| CSV parsing | `csv-parse/sync` | RFC-compliant, handles quoted commas |
| Toast notifications | `sonner` | Simple toast queue |
| Theme | `next-themes` (patched) | OS-respecting dark/light toggle, SSR hydration fixed |
| Icons | `lucide-react` | Consistent icon library |
| Fonts | Inter (body), JetBrains Mono (numbers/emails) | Readable data-dense UI |

---

## Repository Structure

```
simple-hris/
├── app/                         # Next.js App Router (shell only)
│   ├── layout.tsx               # ThemeProvider, font loading, global meta
│   ├── page.tsx                 # Renders <AppShell /> from src/App.tsx
│   └── api/                     # many API route handlers (server-side only); see API_REFERENCE.md
│       ├── employees/           # GET  — master list
│       ├── employee-hourly-rates/     # GET  — rates table
│       ├── employee-rate-profiles/    # GET  — merged multi-table profile
│       ├── employee-ids/        # GET  — explicit employee_ids table
│       ├── hubstaff-hours/      # GET + POST — preview + CSV replace
│       ├── add-employee/        # POST — dual insert
│       ├── delete-employee/     # DELETE — dual delete
│       ├── update-employee-rates/     # POST — rate update
│       └── import-daily-report/ # POST — pg-direct schema/table creation
│
├── components/ui/               # shadcn primitives (do not edit directly)
│   └── badge, button, card, checkbox, dialog, input, label,
│       scroll-area, select, separator, sonner, switch, table, tabs
│
├── src/                         # All application logic
│   ├── App.tsx                  # Root "use client" SPA shell
│   ├── types.ts                 # Shared TypeScript types
│   ├── constants.ts             # Mock data (MOCK_USERS, MOCK_TIME_RECORDS)
│   ├── index.css                # Global styles, Tailwind theme variables
│   ├── components/              # organized by dashboard + shared layer
│   │   ├── (Accounting)         # App.tsx, Sidebar, Overview, Rates, PayrollWizard
│   │   ├── admin/ employee/ manager/ hr/ ceo/ contractor/ orphanage/ payroll-clerk/
│   │   ├── announcements/ swall/ notifications/ presence/ audit/ rbac/ auth/
│   │   └── ThemeProvider.tsx    # see COMPONENTS.md for the full per-dashboard reference
│   └── lib/
│       ├── utils.ts             # cn() — clsx + tailwind-merge
│       ├── hash.ts              # SHA-256 CSV dedup
│       ├── csv/parse-csv.ts     # CSV parser wrapper
│       ├── email/norm-email.ts  # Email normalizer
│       ├── payroll/compare-to-master.ts
│       └── supabase/            # All DB access (8 files)
│
├── Documentation/               # This folder
├── references/                  # Seed scripts (gen_dept_seed.js, SQL files)
├── patches/                     # next-themes SSR hydration fix
├── scripts/check-supabase.mjs   # Dev diagnostic
└── .env.example                 # All environment variables documented
```

---

## Application Shell & Routing

`app/layout.tsx` loads the fonts (Inter, JetBrains Mono via Google Fonts), wraps the app in `<NextAuthProvider>` (which nests NextAuth `SessionProvider` + `PresenceProvider`) and `<ThemeProvider>`, and sets metadata.

The app is no longer a single-operator tool. It is **eight role dashboards**, each served by its own Next.js route segment and gated by a NextAuth (Google SSO) session. The edge gate is **`proxy.ts`** at the repo root (this is the Next.js 16 rename of the old `middleware.ts` — an empty `middleware-manifest.json` is a red herring, `proxy.ts` is what actually runs). It requires a valid JWT on every non-public route and delegates the access *decision* to the pure, unit-tested `evaluateRouteAccess()` in `src/lib/auth/route-access.ts` (enforces `?email=` ownership, bounces contractor-only users off employee routes). Crucially, for `/api/*` requests it returns a **JSON 401** (`{ error, code: 'auth_required' | 'session_revoked' }`) rather than a 307 to the HTML `/login` page — a redirected XHR would otherwise resolve to `200` with `<!DOCTYPE html>…` and make `res.json()` throw "Unexpected token '<'", leaving tabs stuck loading. Only real page navigations get the visible redirect to `/login`. After login, `app/login/page.tsx` resolves the user's roles and routes them to the highest-priority dashboard they are entitled to; the in-sidebar **ViewSwitcher** lets multi-role users hop between dashboards. The mapping lives in `src/lib/rbac/views.ts`. See COMPONENTS.md -> "Dashboard Map" and "Auth, RBAC & Role Routing" for the per-dashboard details.

| View | Route | Top component | Granting role(s) |
|---|---|---|---|
| Accounting | `/` -> `/accounting` | `src/App.tsx` (`AppShell`) | `payroll_coordinator`, `payroll_manager`, `finance`, `hr_coordinator`, `viewer` |
| Admin | `/admin` | `app/admin/page.tsx` | `admin` |
| Employee | `/employee` | `EmployeeApp` | everyone except pure contractors |
| Manager | `/manager` | `ManagerApp` | `manager` |
| HR | `/hr` | `HrApp` | `admin`, `hr_coordinator` |
| CEO | `/ceo` | `CeoApp` | `ceo` |
| Orphanage | `/orphanage` | `OrphanageApp` | `orphanage_manager` |
| Contractor | `/contractor` | `ContractorApp` | `contractor` |

Each dashboard is still an `activeTab`-driven SPA internally (the sidebar sets a tab string; the main area renders the matching view; no per-tab URL routing) -- but the **dashboard itself is now a real route**, and tabs are gated by roles plus a per-feature-permission overlay (`src/lib/rbac/feature-permissions.ts`). As of the 2026-06 overhaul that overlay is enforced across **every** role view (Accounting, HR, Manager, CEO, Contractor, Orphanage) and the API routes behind them -- provisioned from the Admin Dashboard. See [features/rbac-feature-permissions.md](../features/rbac-feature-permissions.md). Every shell resolves its viewer from `?email=` (validated, normalized, cached in `sessionStorage[SESSION_EMAIL_KEY]`).

The **Accounting** shell (`src/App.tsx`) tabs are: `overview`, `rates`, `payroll-wizard`, `payment-dispatch`, `disputes`, `notifications`, `settings`, `announcements`, `s-wall`. The **Employee** portal (`/employee?email=...`) tabs include `dashboard` (hours/pay/PAB calendar), `profile`, `hours` (My Hours calendar), `disputes`, `leaves`, `team`, `mesa`, `reports`, `policies`, and `settings`. The **Payroll Clerk** dispatch view (`PayrollDispatch`) is mounted both at `/payroll-clerk` and as the Accounting "Payment Dispatch" tab.

## Supabase Client Strategy

Two separate Supabase clients are used throughout:

| Client | Key Used | Purpose | Where Created |
|---|---|---|---|
| Browser anon client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client-side reads (RLS applies) | `src/lib/supabase/client.ts` |
| Server anon client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | API route reads | `src/lib/supabase/server.ts` |
| Server service-role client | `SUPABASE_SERVICE_ROLE_KEY` | Writes + RLS-bypass reads | `src/lib/supabase/server.ts` |

API routes always try the **service-role client first**, falling back to anon if the env var is absent. This means the app degrades gracefully in dev without the service key, but some features (CSV upload, full column preview) require it.

---

## Reliability & Outage Resilience

A recurring design theme is that the app must stay **navigable and readable when Supabase is unreachable**, rather than collapsing into infinite skeletons or a blank screen. Several independent layers cooperate:

**1. Navigation survives a Supabase outage (JWT + localStorage).**
The ViewSwitcher and per-role tabs resolve from Supabase (`/api/employee-roles`, `/api/employee-feature-permissions`), so a naive implementation would lose all navigation during an outage. Two fallbacks prevent that:

- **JWT roles.** Roles are baked into the NextAuth session token at sign-in, so `useAvailableViews()` (`src/lib/rbac/views.ts`) is *offline-first*: it seeds the switcher from the session's own `roles` claim before any fetch, and keeps them if the fetch fails. `ViewSwitcher` passes these `selfRoles` **only** when the switcher is showing the session owner's own views (never when an admin browses `?email=someone-else`, whose roles differ).
- **Last-known-good cache.** `src/lib/rbac/rbac-cache.ts` persists the last successful `{ roles, perms }` resolution to `localStorage` (key `rbac.cache.v1:<email>`, per normalized email) via `writeRbacCache`, read back by `readCachedRoles` / `readCachedPerms`. This is **UX resilience only, never a security boundary** — every mutating API re-authorizes server-side off the JWT, so a tampered cache grants no real access (worst case: a tab renders but its reads/writes 401/500 while Supabase is down).

**2. Dead sessions self-heal (JSON 401 + `SessionInvalidationWatcher`).**
Because `proxy.ts` hands `/api/*` a JSON 401 instead of an HTML redirect (see routing section), the client can act on it. `SessionInvalidationWatcher` (`src/components/auth/SessionInvalidationWatcher.tsx`, mounted once at the app root) monkey-patches `window.fetch` to notice any same-origin `/api/*` 401 and re-validate via `/api/auth/session-status`. It **fails open** — it only signs the user out (and clears `SESSION_EMAIL_KEY`, bounces to `/login`) when session-status *confirms* the session is really gone, so a stray 401 won't yank a live user. It also listens for `auth.force_logout_map` changes over Realtime, backed by a 45s poll + focus check.

**3. Show real UI, not a skeleton, when the DB is down (`useResilientResource`).**
`src/hooks/useResilientResource.ts` (a pure, unit-tested reducer wrapped in a thin hook) guarantees: a skeleton **only** on a cold start (no data yet); on a *failed refresh* the last-known data is retained and flagged `stale` (screen stays populated + read-only); a cold-start failure resolves to `error` (caller renders an empty state + Retry) instead of a spinner that never ends. Its companion `ConnectionStatusBanner` (`src/components/ConnectionStatusBanner.tsx`) renders nothing while healthy, an amber "showing data from HH:MM — reconnecting…" bar when `stale`, and a red error + Retry bar on hard `error`. Consumed across the dashboard shells (`App.tsx`, `HrApp`, `CeoApp`, `ManagerApp`, `EmployeeApp`, Admin Global Master List, etc.).

**4. Realtime degrades to polling; anon clients use Broadcast.**
Every Realtime subscription assumes it may silently break (missing publication, RLS, timeout) and pairs itself with a poll + focus reconcile. On `CHANNEL_ERROR` / `TIMED_OUT` the hook logs and leans on the poll: `useDispatchLock` and `usePagesVisibility` fall back to a **30s** poll, `SessionInvalidationWatcher` to **45s**. Separately, anonymous/unauthenticated clients cannot receive `postgres_changes` (blocked by RLS), so features that must reach them use Supabase **Broadcast** channels instead — e.g. the app-wide `hris-ping` and `hris-presence` channels.

---

## Path Aliases

Defined in `tsconfig.json`:

```json
"@/*"              → "./src/*"
"@/components/ui/*" → "./components/ui/*"
```

So `@/components/PayrollWizard` resolves to `src/components/PayrollWizard.tsx`, and `@/components/ui/button` resolves to `components/ui/button.tsx`.

---

## Design System

### Color Palette

The app uses CSS custom properties for all colors, defined in `src/index.css`. Tailwind classes like `bg-primary` resolve through this layer.

| Token | Light Mode | Dark Mode | Semantic Use |
|---|---|---|---|
| `--primary` | Orange-500 (`22 95% 52%`) | Orange-400 (`25 94% 60%`) | Buttons, active states, highlights |
| `--secondary` | Blue-600 (`221 83% 53%`) | Blue-400 (`213 94% 68%`) | Secondary actions, accents |
| `--background` | White | `#0d1117` (very dark navy) | Page background |
| `--card` | White | Slightly lighter navy | Card surfaces |
| `--sidebar` | `white → orange-50/40` gradient | `#0d1117 → #0f1729` gradient | Sidebar background |
| Indigo | `indigo-600` (hardcoded) | Same | PayrollWizard-specific accent |

The sidebar gradient (`from-white to-orange-50/40`) creates a warm, soft brand feel. The dark mode uses deep navy rather than pure black to reduce eye strain on long payroll sessions.

### Typography

- **Inter**: All UI text (labels, table content, descriptions). Clean, high-legibility at data-dense sizes.
- **JetBrains Mono**: Employee IDs, email addresses, currency values, hour counts. Monospace for scannable column alignment.

### Scrollbars

Custom-styled in `src/index.css`: 6px width, orange thumb on light mode, blue on dark. Applied globally to maintain visual consistency in tall table views.

### Animation Principles

All CSS properties have a `260ms ease` transition applied globally (via `* { transition: ... }`), gated by `@media (prefers-reduced-motion: no-preference)` for accessibility.

Framer Motion is used for three specific interactions:

1. **Wizard step transitions** — `motion.div` with `x: ±20` slide + opacity fade, driven by `AnimatePresence` with a direction key.
2. **Active step indicator** — `layoutId="active-indicator"` pill that smoothly slides between step items in the left sidebar.
3. **Profile modal fields** — Staggered `delay: i * 0.01` (capped at 0.28s) as field rows mount, giving a cascading "loaded" feel.

Dialog animations use a `cubic-bezier([0.22, 1, 0.36, 1])` spring curve for a snappy, physical open/close.

### Component Primitives

All interactive primitives (Button, Input, Select, Dialog, Tabs, etc.) are shadcn components sourced from `@base-ui/react`. They provide accessible, unstyled HTML with ARIA attributes; the shadcn layer applies the Tailwind design tokens on top. The config in `components.json` uses the `base-nova` style variant with `baseColor: neutral`.

---

## Environment Variables

All variables are documented in `.env.example`. Required vs optional:

```
# Required for all reads
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE=global_master_list
NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE=employee_hourly_rates
NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE=hubstaff_hours

# Required for writes + full CSV preview
SUPABASE_SERVICE_ROLE_KEY=

# Required for daily report import + table discovery
DATABASE_URL=

# Optional: comma-separated list of extra tables to merge into profiles
SUPABASE_PROFILE_TABLES=
```

---

## Key Architectural Decisions

**1. Client-side SPA inside Next.js**
The app behaves like a SPA (tab-based nav, no page reloads) but uses Next.js strictly for its API routes, which handle server-side Supabase access with the service role key (which must never reach the browser).

**2. Column names with spaces**
The Supabase tables use human-readable column names with spaces (`"Work Email"`, `"Total worked"`, `"Regular Rate"`). All queries quote these names via PostgREST. Lib functions build normalized key indexes (`normFieldKey()`) to handle both space and underscore variants during merges.

**3. Integer seconds for hours arithmetic**
All Hubstaff hour values are converted to integer seconds before any arithmetic. This eliminates floating-point errors in overtime calculation (e.g., `7:59:59` vs `8:00:00`). The display layer divides back to decimals.

**4. Employee IDs are derived, not stored**
The `YYMM-NNNN` employee IDs shown in the UI are generated dynamically in `generateEmployeeIds()` by sorting employees by start date group then alphabetically by first name. They are display-only — the actual canonical employee identity is the email address.

**5. Dual-table employee insert/delete**
When adding or removing an employee, both `employee_hourly_rates` and `global_master_list` are modified in the same API call. There is no foreign key constraint between them — the application layer is responsible for keeping them in sync.

**6. Date-aware CSV column mapping**
Hubstaff CSVs use day-name date headers (`"Mon 3/24"`) while the Supabase table may have ISO column names (`"2026-03-24"`). The upload function `replaceHubstaffHoursFromCsvText()` runs two column-mapping passes: exact case-insensitive match first, then `csvColToIsoDate()` parses both formats to ISO strings and matches by calendar date. Without this, daily hour values end up as `null` in Supabase.

**7. Client-side CSV re-parse for PA detection**
After uploading a CSV, the component re-parses the CSV text client-side (`parseCsv()`) and uses it to set `hubstaffDisplayColumns` / `hubstaffDisplayRows` directly — rather than re-fetching from Supabase. This guarantees Perfect Attendance detection in Step 3 always has real daily values, even if the Supabase date columns don't match. The `dailyDataMissing` flag detects the case where Supabase daily columns are all null and shows a warning banner.

**8. NextAuth (Google SSO) + role-based access control** *(implemented)*
Authentication is Google SSO restricted to the `simple.biz` Workspace, via NextAuth with JWT sessions (`src/lib/auth/auth-options.ts`). On sign-in the JWT is stamped with the user's active roles (from `employee_roles`); the edge gate `proxy.ts` (Next 16's `middleware.ts` rename) gates every route and enforces `?email=` ownership. Authorization has two layers: **role grants** (`employee_roles`, managed in Admin -> Roles) gate which *dashboard* a user can open, and a **per-feature-permission overlay** (`employee_feature_permissions`, Hidden/View/Edit per tab) decides which *tabs* they see and can edit. As of 2026-06 the overlay is the single source of truth for per-tab access -- enforced across all role views (Accounting, HR, Manager, CEO, Contractor, Orphanage) and the API routes behind them via `src/lib/auth/authorize-feature.ts`, and provisioned entirely from the Admin "Roles and Permissions" screen. `admin` bypasses the overlay so you can't lock yourself out; tabs default to hidden and `overview` is always a read-only landing. Because roles are baked into the JWT at sign-in, a **force-logout map** (`app_settings.auth.force_logout_map`) invalidates stale tokens immediately on role revoke / permission change -- automatic on revoke, plus a manual "Reset session" button in AdminRoles. Grants/revokes are audit-logged. Full detail in [features/rbac-feature-permissions.md](../features/rbac-feature-permissions.md). (The original plan is in `IMPLEMENTATION_PLAN_RBAC.md`.)

**9. Flat analytic table for weekly reports (`disbursement_records`)** *(added 2026-04-28)*
The Reports tab in Payment Dispatch reads from a flat `public.disbursement_records` table — one row per (Hubstaff cycle, employee). It's seeded from the existing tables (`hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches`) by `references/seed_disbursement_records.sql`. Two triggers on `payment_dispatches` (`*_sync_disbursement` for INSERT/UPDATE, `*_unsync_disbursement` for DELETE) keep the flat table live without the API doing the join itself. **Why:** the original report endpoint joined three tables + ran `computeCurrentPay()` on every render — fine for 7 cycles, painful at a year of pulls. The flat table makes a weekly rollup a single grouped scan. See [PAYMENT_DISPATCH.md §6.5](../features/payment-dispatch.md) and [DATA_SOURCES.md §5](./data-sources.md) for the full schema.

**10. Login (`/login`) -- Google SSO primary, legacy password fallback**
The primary sign-in is Google SSO (see decision 8). After NextAuth resolves the session, `app/login/page.tsx` fetches the user's roles (`GET /api/employee-roles`) and redirects to the highest-priority dashboard via `viewsForRoles` / `VIEW_ROUTES`. A **legacy email + password path** also exists (`EmployeeLogin` -> `POST /api/employee-login`, password = `MMDDYY` of start date, verified via Supabase RPC `verify_employee_password`; forgot-password via `verify_employee_identity` + `POST /api/employee-forgot-password`). Password columns on `employee_hourly_rates`: `password_hash`, `previous_password_hash`, `password_updated_at` (pgcrypto bcrypt; plaintext never stored). Login successes/failures are written to `audit_log`.

**11. Admin dashboard: Global Master List replaces "Employees"; app-wide presence + live Ping**
The Admin sidebar's old **Employees** tab is gone — replaced by a **Global Master List** tab (`src/components/admin/AdminGlobalMasterList.tsx`; `systemNav` id `global-master-list` in `AdminSidebar.tsx`). Presence was also widened from a simple online roster into a per-person location feed: `PresenceProvider` (`src/components/presence/PresenceProvider.tsx`) now broadcasts each client's `path` (which dashboard) **and** `tab` (which in-dashboard tab) on the app-wide `hris-presence` Realtime channel. Dashboard shells publish their current tab label via `usePublishPresenceTab(label)`; viewers read the full roster (name + route + tab) via `usePresenceDetails()`, so the Global Master List can show e.g. "HR Dashboard · Onboarding" next to an online person. **Ping is live-only** (`GlobalPingListener` / `useAdminPingSender`, `src/components/presence/GlobalPingListener.tsx`): a directed nudge over the app-wide `hris-ping` **Broadcast** channel that lands wherever the recipient currently is — nothing is persisted, so if they're offline the ping is simply never received (no history, no catch-up, no DB row).

**12. Pages visibility / "under construction" (`usePagesVisibility`)**
Admins control per-tab visibility from the Admin **Pages** tab (`AdminPages`), stored as a single `pages.visibility` row in `app_settings`. Each `(dashboard, tab)` is `visible`, `construction` (under construction), or `hidden`. `src/hooks/usePagesVisibility.ts` subscribes to that row over Realtime (with the standard 30s-poll + focus fallback) and exposes two resolvers: `visibilityOf()` — the **effective** gate used for nav, where **admins bypass `construction` and see the real page** (so they can preview/verify what's being built; `hidden` still hides for everyone) — and `rawVisibilityOf()`, the true stored state. Shells use the raw state to still surface a `ConstructionBanner` (`src/components/common/ConstructionBanner.tsx`) atop the bypassed page, reminding the admin it isn't live for others yet. The hook is **fail-open**: until a load succeeds it leaves gating off rather than acting on an empty config that would treat hidden pages as visible.

**13. Unified collapsible sidebar shell**
Every dashboard rail (Accounting `Sidebar`, `HrSidebar`, `EmployeeSidebar`, `AdminSidebar`, `ManagerSidebar`, `CeoSidebar`, `ContractorSidebar`, `QCSidebar`, `PayrollClerkSidebar`) now renders through the shared `CollapsibleSidebarShell` (`src/components/common/CollapsibleSidebarShell.tsx`), giving them matching width and collapse behavior. The animation only changes the rail's `width` while a fixed-width inner panel is clipped, so nothing re-flows: icons stay pinned at the left edge and labels fade via opacity (collapse is desktop-only; on mobile the rail is a full-width drawer). Notification badges and icons are retained, with `SidebarCollapsedDot` standing in for right-aligned count badges the 64px collapsed rail would clip. The **ViewSwitcher + theme toggle live inside the sidebar's scroll area** (a single `ScrollArea`), so on short viewports the switch-view control is reachable by scrolling; brand header and Sign Out stay anchored top/bottom.
