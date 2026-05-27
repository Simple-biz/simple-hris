# Simple HRIS: System Architecture

## Overview

Simple HRIS is a payroll-focused Human Resource Information System built for a Philippines-based outsourcing company. Its primary job is the **"Friday Path"** — the weekly payroll processing cycle that takes a Hubstaff hours export, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger.

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

The app is no longer a single-operator tool. It is **eight role dashboards**, each served by its own Next.js route segment and gated by a NextAuth (Google SSO) session. `middleware.ts` requires a valid JWT on every page route, enforces `?email=` ownership, and bounces contractor-only users off employee routes. After login, `app/login/page.tsx` resolves the user's roles and routes them to the highest-priority dashboard they are entitled to; the in-sidebar **ViewSwitcher** lets multi-role users hop between dashboards. The mapping lives in `src/lib/rbac/views.ts`. See COMPONENTS.md -> "Dashboard Map" and "Auth, RBAC & Role Routing" for the per-dashboard details.

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

Each dashboard is still an `activeTab`-driven SPA internally (the sidebar sets a tab string; the main area renders the matching view; no per-tab URL routing) -- but the **dashboard itself is now a real route**, and tabs are gated by roles plus the per-feature-permission overlay (`src/lib/rbac/feature-permissions.ts`, enforced today on the Accounting view via `src/lib/rbac/accounting-tabs.ts`). Every shell resolves its viewer from `?email=` (validated, normalized, cached in `sessionStorage[SESSION_EMAIL_KEY]`).

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
Authentication is Google SSO restricted to the `simple.biz` Workspace, via NextAuth with JWT sessions (`src/lib/auth/auth-options.ts`). On sign-in the JWT is stamped with the user's active roles (from `employee_roles`); `middleware.ts` gates every page route and enforces `?email=` ownership. Authorization has two layers: **role grants** (`employee_roles`, managed in Admin -> Roles) decide which dashboards/tabs a user sees, and a **per-feature-permission overlay** (`employee_feature_permissions`, Hidden/View/Edit per tab) further restricts them (wired today on the Accounting view). `admin` bypasses the overlay. Because roles are baked into the JWT at sign-in, a **force-logout map** (`app_settings.auth.force_logout_map`) invalidates stale tokens immediately on role revoke / permission change. Grants/revokes are audit-logged. (The original plan is in `IMPLEMENTATION_PLAN_RBAC.md`; a couple of spots like the System Settings panel still show a hardcoded actor -- see COMPONENTS.md.)

**9. Flat analytic table for weekly reports (`disbursement_records`)** *(added 2026-04-28)*
The Reports tab in Payment Dispatch reads from a flat `public.disbursement_records` table — one row per (Hubstaff cycle, employee). It's seeded from the existing tables (`hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches`) by `references/seed_disbursement_records.sql`. Two triggers on `payment_dispatches` (`*_sync_disbursement` for INSERT/UPDATE, `*_unsync_disbursement` for DELETE) keep the flat table live without the API doing the join itself. **Why:** the original report endpoint joined three tables + ran `computeCurrentPay()` on every render — fine for 7 cycles, painful at a year of pulls. The flat table makes a weekly rollup a single grouped scan. See [PAYMENT_DISPATCH.md §6.5](../features/payment-dispatch.md) and [DATA_SOURCES.md §5](./data-sources.md) for the full schema.

**10. Login (`/login`) -- Google SSO primary, legacy password fallback**
The primary sign-in is Google SSO (see decision 8). After NextAuth resolves the session, `app/login/page.tsx` fetches the user's roles (`GET /api/employee-roles`) and redirects to the highest-priority dashboard via `viewsForRoles` / `VIEW_ROUTES`. A **legacy email + password path** also exists (`EmployeeLogin` -> `POST /api/employee-login`, password = `MMDDYY` of start date, verified via Supabase RPC `verify_employee_password`; forgot-password via `verify_employee_identity` + `POST /api/employee-forgot-password`). Password columns on `employee_hourly_rates`: `password_hash`, `previous_password_hash`, `password_updated_at` (pgcrypto bcrypt; plaintext never stored). Login successes/failures are written to `audit_log`.
