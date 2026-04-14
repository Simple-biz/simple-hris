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
│   └── api/                     # 9 API route handlers (server-side only)
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
│   ├── components/
│   │   ├── Sidebar.tsx          # Navigation + user info + theme toggle
│   │   ├── Overview.tsx         # Dashboard stats + employee table
│   │   ├── PayrollWizard.tsx    # 5-step payroll workflow (2,987 lines)
│   │   ├── Rates.tsx            # Rate profiles + add/delete/edit
│   │   └── ThemeProvider.tsx    # next-themes wrapper
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

`app/layout.tsx` loads the fonts (Inter, JetBrains Mono via Google Fonts), wraps the app in `<ThemeProvider>`, and sets metadata. `app/page.tsx` renders `<AppShell />`.

`src/App.tsx` owns a single `activeTab` state string. The sidebar sets it; the main content area renders the corresponding view. There is **no URL-based routing** for the admin side — this is intentional for a single-user internal tool where deep-linking is unnecessary.

```
Admin activeTab values (src/App.tsx):
  "overview"       → <Overview />
  "rates"          → <Rates />
  "payroll-wizard" → <PayrollWizard />
  "hogan-suite"    → placeholder card
  "disputes"       → placeholder card
  "settings"       → placeholder card
```

### Employee Portal

The employee-facing portal lives at `/employee?email=...` (`app/employee/page.tsx` → `EmployeeApp.tsx`). It uses URL-based email identification and has its own tab-based navigation:

```
Employee activeTab values (src/components/employee/EmployeeApp.tsx):
  "dashboard"  → <EmployeeDashboard />   — Hours, pay, PAB calendar
  "profile"    → <EmployeeProfile />     — Directory info, bank details
  "hours"      → placeholder
  "disputes"   → placeholder
  "settings"   → <EmployeeSettings />   — Bank info editing
```

Key differences from the admin shell:
- **PAB Calendar**: Full-month calendar grid showing Mon–Fri pass/fail per day, with skeleton loading and staggered animations
- **All Time mode**: File selector includes "All Time" option that aggregates pay across all source files
- **Canonical column resolution**: Weekly source files with `monday`/`tuesday` columns are resolved to ISO dates during merge
- **Profile hero**: Large avatar with hover camera overlay, department/job/ID badges
- **Bank info**: Displayed in profile, editable via Settings tab redirect

---

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

**8. No authentication (planned)**
The admin app currently has no session gate — the user identity is hardcoded as `"Fran M / Senior Admin"`. A full RBAC implementation plan with 6 roles, API guards, RLS policies, and audit logging is documented in `Documentation/IMPLEMENTATION_PLAN_RBAC.md`.

**9. Employee / Accounting login (`/login`)**
A unified login page at `/login` authenticates users via bcrypt-hashed passwords stored in `employee_hourly_rates`. The form has an **Employee / Accounting** role toggle; on success the verified work email is written to `sessionStorage` (`employee_session_email`, `employee_session_role`) and the user is routed to `/employee` (Employee) or `/` (Accounting). The admin dashboard gate is currently disabled pending full wiring; the login form and APIs are live.

- **`POST /api/employee-login`** — calls Supabase RPC `verify_employee_password(p_email, p_password)` which returns `password_hash = crypt(p_password, password_hash)`. Successes and failures are written to `audit_log` (`employee.login.success` / `employee.login.failed`) with the submitted work email in `details`.
- **`POST /api/employee-forgot-password`** — verifies identity via RPC `verify_employee_identity(p_email, p_start_mmddyy)` (work email + `MMDDYY` of start date). On match, writes `employee.password_reset.requested` to `audit_log` for the accounting team to action out-of-band. No password is ever returned.
- **Temp password convention**: `MMDDYY` of the employee's start date (e.g. June 5 2026 → `060526`). Hashes are generated via pgcrypto `crypt(pwd, gen_salt('bf'))` during a one-time backfill and on new-employee creation (planned).
- **Password columns** on `employee_hourly_rates`: `password_hash`, `previous_password_hash`, `password_updated_at`. Plaintext is never stored.
