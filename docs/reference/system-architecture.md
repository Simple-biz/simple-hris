# Simple HRIS: System Architecture

> **Last verified 2026-08-10** against `main`. Symbol and file names are the durable references; the
> occasional `file:line` is a convenience for the very large files (`PayrollWizard.tsx`, `index.css`)
> and will drift. Behavior that used to be true but no longer is lives in
> [Retired & Superseded Behavior](#retired--superseded-behavior) rather than being deleted — check
> there before concluding something was never implemented.

## Overview

Simple HRIS is a payroll-focused Human Resource Information System built for a Philippines-based outsourcing company. Its primary job is the weekly payroll processing cycle that takes a Hubstaff hours export, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger — then routes that ledger to six payout processors and emails every payslip.

Two things about the shape of the system are easy to miss and change how you reason about it:

- **Google Sheets is the upstream system of record for the roster**, not Postgres. See [Upstream Systems of Record](#upstream-systems-of-record).
- **Every outbound side effect leaves via n8n**, not from this app. See [Outbound Automation](#outbound-automation-n8n).

The stack is a **Next.js App Router shell** hosting a client-side SPA inside `src/`. All interactive UI is `"use client"` React, but Next.js does more than serve API routes — see decision 1.

---

## Technology Stack

| Layer | Technology | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) | API routes + async server layouts (the real auth gate) |
| UI Runtime | React 19, `"use client"` | Full SPA feel inside Next.js |
| Language | TypeScript 5.8 (`strict: false`, **but `strictNullChecks: true`**) | Null-safety enforced (`tsc --noEmit` is the lint step); the rest of `strict` deliberately relaxed |
| Styling | Tailwind CSS v4 | Utility-first, co-located with markup |
| Component primitives | shadcn (`base-nova` style) on `@base-ui/react` | Accessible unstyled primitives, skinned to match brand |
| Animations | `motion/react` (Framer Motion 12) | Tab pills, cross-fades, row stagger — ~105 components |
| Auth | `next-auth` 4 (Google SSO, JWT sessions) | The entire auth layer — see decision 10 |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` | Managed Postgres with RLS, anon + service-role keys |
| Direct Postgres | `pg` Pool | Table discovery, daily report import (schema creation) |
| Outbound automation | n8n webhooks, slug-resolved from `app_settings.webhooks.config` | Email, Google Workspace + CallTools provisioning, Hubstaff invites, offboarding teardown, alerts |
| AI assistants | `@anthropic-ai/sdk` | Penny AI on the CEO + Admin dashboards |
| PDF generation | `pdf-lib` + `@pdf-lib/fontkit` | COE, paystubs, contract packets |
| Spreadsheet export | `xlsx` | Reports / export tabs |
| CSV parsing | `csv-parse/sync` | RFC-compliant, handles quoted commas |
| Toast notifications | `sonner` | Simple toast queue |
| Theme | `next-themes` (patched) | Manual dark/light toggle **defaulting to light** — `enableSystem={false}`, so the OS preference is deliberately ignored; storage key `simple-hris-ui-v4`; the injected-script hydration warning is fixed by `patches/next-themes+0.4.6.patch` (`postinstall: patch-package`) |
| Icons | `lucide-react` | Consistent icon library |
| Fonts | Inter (body), JetBrains Mono (numbers/emails) | Readable data-dense UI. Loaded by `@import` at the top of `src/index.css`, **not** via `next/font` in `app/layout.tsx` |

Single-consumer libraries also in the tree: `rrweb` (Admin cobrowse mirror), `@dnd-kit` (tickets Kanban), `@xyflow/react` (`SystemDiagnostics`), `emoji-mart` (S-Wall).

**Drop candidates:** `@fontsource-variable/geist`, `express` / `@types/express` and `@google/genai` are installed but referenced nowhere under `src/`, `app/` or `components/`.

---

## Repository Structure

```
simple-hris/
├── app/                         # Next.js App Router — one route segment per dashboard + all API routes
│   ├── layout.tsx               # ThemeProvider + NextAuthProvider, global meta/viewport (no font loading)
│   ├── page.tsx                 # Client redirect stub → /employee
│   ├── login/ auth-callback/    # Google SSO entry + NextAuth callback landing
│   ├── accounting/ admin/ ceo/ contractor/ employee/ hr/ manager/
│   │   orphanage/ payroll-clerk/ qc/ tickets/    # one route segment per dashboard
│   ├── onboarding/ update-bank-info/            # public (unauthenticated) forms
│   └── api/                     # 89 route groups / 261 route.ts handlers (server-side only)
│       #   Original CRUD core: employees, employee-hourly-rates, employee-ids,
│       #     employee-rate-profiles, hubstaff-hours, add/delete-employee,
│       #     update-employee-rates, import-daily-report
│       #   Per-dashboard: accounting/ admin/ ceo/ contractor/ employee/ hr/ manager/
│       #     orphanage-*/ payroll*/ people/ qc/ roster/ tickets/
│       #   Auth + RBAC: auth/ employee-roles/ employee-feature-permissions/ employee-login/
│       #   Domain: mesa-*/ gift-*/ bonus-catalog*/ payment-*/ pab-*/ leave-requests/
│       #     department-transfers/ offboarding-queue/ onboarding/ screening/ cron/
│       # Full inventory: docs/reference/api-reference.md
│
├── components/ui/               # 18 files — shadcn/base-ui primitives (do not edit directly)
│   └── badge, button, card, checkbox, date-picker, dialog, input, label,
│       scroll-area, select, separator, skeleton, sonner, switch, table, tabs
│       + local additions: confetti-burst, smooth-select
│
├── src/                         # All application logic
│   ├── App.tsx                  # Root "use client" Accounting SPA shell
│   ├── types.ts                 # Shared TypeScript types
│   ├── constants.ts             # Mock seed data (MOCK_USERS, MOCK_TIME_RECORDS, MOCK_PAYMENTS) —
│   │                            #   still used as PayrollWizard initial state, not dead fixtures
│   ├── index.css                # Global styles, Tailwind theme variables, font @import
│   ├── hooks/                   # 23 shared hooks (+1 test) — usePagesVisibility, useDispatchLock,
│   │                            #   useWizardDispatchLock, useLiveRefresh, useResilientResource, …
│   │                            #   NB: useDispatchQueue is NOT here — see components/payroll-clerk/
│   ├── data/                    # Static JSON lookups (mesa-email-aliases.json)
│   ├── components/              # 27 subfolders, organized by dashboard + shared layer
│   │   ├── *.tsx (top level)    # Sidebar, Overview, PayrollWizard, AppFooter,
│   │   │                        #   ConnectionStatusBanner, LeaveRequestsPanel,
│   │   │                        #   SystemSettings, SystemDiagnostics, ThemeProvider
│   │   ├── accounting/ admin/ ceo/ contractor/ employee/ hr/ manager/
│   │   │   orphanage/ payroll-clerk/ qc/ people/ team/ tickets/   # per-dashboard
│   │   ├── payroll/ payroll-live/ paystub/ transfers/ onboarding/ # domain slices
│   │   └── common/ collab/ announcements/ swall/ notifications/
│   │       presence/ audit/ rbac/ auth/                           # shared layer
│   │                            # see docs/reference/components.md for the full per-dashboard reference
│   └── lib/                     # 64 top-level entries / 379 files
│       ├── utils.ts             # cn() — clsx + tailwind-merge
│       ├── hash.ts  date-only.ts  csv/  email/  name/  text/  images/  pdf/
│       ├── auth/ rbac/          # route-access.ts, views.ts, feature-permissions.ts
│       ├── payroll/ payroll-wizard/ rates/ payment-catalog/ fx/ hubstaff/
│       ├── mesa/ hsl-bonus/ pab-disputes/ transfers/ roster/ people/ departments/
│       ├── <one dir per dashboard>   # accounting/ admin/ ceo/ contractor/ employee/ hr/
│       │                             #   manager/ orphanage/ qc/
│       ├── google-sheets/ google-workspace/ monday/ anthropic/ webhooks/ notifications/
│       └── supabase/            # 70 files — one module per table/domain, plus
│                                #   client.ts / browser.ts / server.ts and
│                                #   select-all-paged.ts (PostgREST 1000-row cap)
│
├── proxy.ts                     # Edge gate (Next 16's middleware.ts rename) — see Routing
├── pages/api/auth/[...nextauth].ts   # NextAuth handler (the only Pages-Router file in the repo)
├── docs/                        # This folder — reference/, features/, audits/,
│                                #   implementation-plans/, meetings/, notes/, design/
├── references/                  # Non-code source material and DB scripts
│   ├── sql/{alter,create,fix,migrate,seed}/   # all hand-run SQL — there is no migration framework
│   ├── n8n/                     # exported n8n workflow JSON (16 files)
│   ├── docs/                    # source PDFs / XLSX / pay-plan references
│   └── data/ sound-tester/ webhook-testers/
├── scripts/                     # 104 one-off + operational Node/tsx scripts
│   └── check-supabase.mjs       #   e.g. dev connectivity diagnostic
├── patches/                     # next-themes SSR hydration fix
├── public/                      # Static assets
├── components.json              # shadcn config (base-nova / neutral)
├── next.config.ts  vercel.json  tsconfig.json
└── .env.example                 # Most environment variables documented — see Environment Variables
```

**Schema changes are manual.** There is no migration framework, no numbered-migration runner and no `supabase/migrations` directory. DDL lives as loose SQL under `references/sql/{create,alter,migrate,fix,seed}/` and is applied by hand or by a `scripts/apply-*.mjs` helper; individual feature docs track each one as PENDING until it has actually been run. `scripts/` is a 104-file ops surface (`apply-*` migration appliers, `audit-*` diagnostics, `backfill-*`, `cleanup-*`, one-off data surgery, PDF asset builders) and it runs against `.env.local`, which carries the **production** service-role key. Read a script before you run it.

---

## Application Shell & Routing

`app/layout.tsx` server-resolves the NextAuth session and wraps the app in `<NextAuthProvider>` (which nests NextAuth `SessionProvider` plus `SessionInvalidationWatcher`, `GlobalPingListener`, `ImpersonationBanner`, `PresenceProvider`, `CobrowseChatProvider` and `CobrowseProvider` — `src/components/auth/NextAuthProvider.tsx`) and `<ThemeProvider>`, mounts `<CarlaSongToast />` and the sonner `<Toaster position="top-right" richColors closeButton />`, imports `src/index.css`, and exports `metadata` + `viewport`. Fonts are **not** loaded here — `src/index.css:1` `@import`s Inter + JetBrains Mono from Google Fonts and binds them to `--font-sans` / `--font-mono`.

The app is no longer a single-operator tool. It is **ten ViewSwitcher views** (`VIEW_ROUTES`, `src/lib/rbac/views.ts`) plus one route-only shell (`/payroll-clerk`) — **eleven session-gated route segments** in all, of which `/tickets` is a shared board rather than a dashboard. Nine of the eleven are additionally **role**-gated (`ROUTE_REQUIRED_ROLES`, `src/lib/auth/route-access.ts`); `/employee` and `/contractor` are deliberately absent from that map because they are personal portals scoped to the session owner server-side, so any authenticated user may open them. Each is served by its own Next.js route segment and gated by a NextAuth (Google SSO) session.

The edge gate is **`proxy.ts`** at the repo root (this is the Next.js 16 rename of the old `middleware.ts` — an empty `middleware-manifest.json` is a red herring, `proxy.ts` is what actually runs). It requires a valid JWT on every non-public route and delegates the access *decision* to the pure, unit-tested `evaluateRouteAccess()` in `src/lib/auth/route-access.ts` (enforces `?email=` ownership, bounces contractor-only users off employee routes). Crucially, for `/api/*` requests it returns a **JSON 401** (`{ error, code: 'auth_required' | 'session_revoked' }`) rather than a 307 to the HTML `/login` page — a redirected XHR would otherwise resolve to `200` with `<!DOCTYPE html>…` and make `res.json()` throw "Unexpected token '<'", leaving tabs stuck loading. Only real page navigations get the visible redirect to `/login`.

After login, `app/login/page.tsx` resolves the user's roles via `GET /api/employee-roles` and lands *everyone* on `/employee` — `views.includes('employee') ? 'employee' : defaultViewFor(views)`, mirrored in the impersonation path. A safe `?callbackUrl=` wins over that default, so a user the proxy bounced out of a deep link returns to the page they wanted rather than the portal. Only accounts that never get the employee view at all (non-admin `contractor` holders) fall through to their highest-priority view; a hung role lookup also falls back to `/employee`. Every other dashboard is reached from the in-sidebar **ViewSwitcher**. `/` is a client redirect stub that sends every authenticated user to `/employee` (`app/page.tsx`). The mapping lives in `src/lib/rbac/views.ts`. See [components.md](./components.md) → "Dashboard Map" and "Auth, RBAC & Role Routing" for per-dashboard details.

| View | Route | Top component | Granting role(s) |
|---|---|---|---|
| Accounting | `/accounting` | `src/App.tsx` (`AppShell`) | `accounting` |
| Admin | `/admin` | `app/admin/page.tsx` | `admin` |
| Employee | `/employee` | `EmployeeApp` | any authenticated user — the route is not role-gated. Two rules narrow it: the ViewSwitcher hides Employee from any non-admin holding `contractor`, and `evaluateRouteAccess` redirects contractor-**only** accounts to `/contractor` |
| Manager | `/manager` | `ManagerApp` | `manager` |
| HR | `/hr` | `HrApp` | `hr_coordinator` |
| CEO | `/ceo` | `CeoApp` | `ceo` |
| Orphanage | `/orphanage` | `OrphanageApp` | `orphanage_manager` |
| Contractor | `/contractor` | `ContractorApp` | `contractor` — grants the *view*; like `/employee` the route itself is not role-gated (personal portal scoped to the session owner) |
| QC | `/qc` | `QCApp` | `qc` |
| Tickets | `/tickets` | `TicketsBoard` | `tickets` — dedicated role only; **dashboard roles do not confer it** |
| Payroll Clerk | `/payroll-clerk` | `PayrollClerkApp` | `accounting` — a real route, but not a ViewSwitcher view |

`admin` is keys-to-the-castle: it grants every view (`views.ts`) and is accepted on every role-gated route (`route-access.ts`), so it is implicit in every row above — the roles listed are the *non-admin* grants.

Non-dashboard routes: `/login`, `/auth-callback`, `/onboarding/[token]` (hire flow) and `/update-bank-info` (OTP) — see [Two Perimeters](#two-perimeters-the-public-surface).

Each dashboard is still an `activeTab`-driven SPA internally (the sidebar sets a tab string; the main area renders the matching view; no per-tab URL routing) — but the **dashboard itself is a real route**, and tabs are gated by roles plus a per-feature-permission overlay (`src/lib/rbac/feature-permissions.ts`). As of the 2026-06 overhaul that overlay is enforced across **every** role view — Accounting, HR, Manager, CEO, Contractor, Orphanage, QC and Tickets (the `FeatureViewKey` union) — and the API routes behind them, provisioned from the Admin Dashboard. The Employee portal is the exception: it is gated by the separate admin-controlled Pages-visibility overlay (`src/lib/pages/visibility.ts`), not by feature permissions. See [features/rbac-feature-permissions.md](../features/rbac-feature-permissions.md). Every shell resolves its viewer from `?email=` (validated, normalized, cached in `sessionStorage[SESSION_EMAIL_KEY]`).

### Tabs per shell

The **Accounting** shell (`src/App.tsx`) tabs are `overview`, `people`, `payroll-wizard`, `bonus-catalog` ("Payment Catalog"), `payment-dispatch`, `disputes` ("Issues"), `transfers`, `mesa`, `documents`, `announcements`, `notifications`, `s-wall`, `settings` — source of truth `ACCOUNTING_TAB_IDS` in `src/lib/rbac/accounting-tabs.ts`.

The **Employee** portal (`/employee?email=...`) tabs are `dashboard` (hours/pay/PAB calendar), `profile`, `hours` (My Hours calendar), `kpi` (KPI Results), `leaves`, `mesa`, `team`, `notifications` and `s-wall` (`EmployeeSidebar.tsx` navItems + `EmployeeApp.tsx` render switch, mirrored in `src/lib/pages/visibility.ts`).

`/payroll-clerk` mounts its own shell, `PayrollClerkApp`; the Accounting "Payment Dispatch" tab mounts the separate `PayrollDispatch` component (`src/App.tsx` — its only import site in the repo). They are **parallel surfaces** that share the leaf components under `src/components/payroll-clerk/` (`ProcessorQueue`, `ExcludedQueue`, `DispatchLoader`, `DispatchReports`, `MarkPaidDialog`, `UrgentPaymentsQueue`, `useDispatchQueue`), so a change to one shell does **not** change the other — only a change to a shared leaf hits both.

### Authorization is three layers

A new route must wire all three. `SECURITY_AUDIT.md` lists 26 Critical findings, **23 of which are "route.ts has no authentication"** — i.e. the failure mode of not knowing this layer exists. (The other three are plaintext production secrets, the app-wide service-role/RLS bypass, and a client-side `setAuthChecked(true)`-in-a-catch bug.)

1. **Edge** — `proxy.ts` → `evaluateRouteAccess()`.
2. **Server page guard** — every role-gated dashboard's `app/<dash>/layout.tsx` is an async server component that `await requirePageRoles(requiredRolesFor(path))` and server-`redirect()`s before the shell renders (`src/lib/auth/require-page-roles.ts`, called from **9** layouts — one per role-gated route; `app/employee` and `app/contractor` have no `layout.tsx` at all, by the same personal-portal logic).
3. **Per-handler API gate** — `requireAdminSession()` / `requireElevatedSession()` / `authorizeEmailAccess(email)` from `src/lib/auth/`, or `requireFeatureAccess()` / `requireFeatureEdit()` from `src/lib/auth/authorize-feature.ts`.

Never gate a privileged surface from inside a `'use client'` component: it reads its own `?email=` and is not a protection. See [features/route-authorization.md](../features/route-authorization.md) and [SECURITY_AUDIT.md](../../SECURITY_AUDIT.md).

### Two perimeters: the public surface

Besides the JWT-gated HRIS there is a public, tokenized surface that never sees a NextAuth session:

- `/onboarding/[token]` + `/api/onboarding/*` — a new hire's invite token is the only credential.
- `/update-bank-info` + `/api/bank-update/*` — email OTP.

Both are protected in `proxy.ts` by an in-memory sliding-window rate limiter that returns **429**, not by `getToken()`. `PUBLIC_PATHS` is `['/login', '/update-bank-info']` and `PUBLIC_PREFIXES` is `['/api/auth/']`. When `BANK_UPDATE_PUBLIC_HOST` is set, requests on that hostname are hard-isolated: only the bank-update page and its API are served, every other API 404s and every other page redirects to the form, so `/login` and the dashboards never appear on the public domain.

---

## Supabase Client Strategy

Three Supabase clients are used throughout:

| Client | Key Used | Purpose | Where Created |
|---|---|---|---|
| Browser anon client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client-side reads **and all Realtime** (RLS applies). Singleton, so one websocket is shared across every subscription; `realtime.params.eventsPerSecond: 100` because the cobrowse rrweb snapshot burst and live cursors overflow the default 5/sec token bucket and get dropped | `src/lib/supabase/browser.ts` |
| Server anon client | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | API route reads | `src/lib/supabase/server.ts` |
| Server service-role client | `SUPABASE_SERVICE_ROLE_KEY` | Writes + RLS-bypass reads | `src/lib/supabase/server.ts` |

`src/lib/supabase/client.ts` is a legacy duplicate of the browser factory with **zero importers** — ignore it (drop candidate); nothing should reference it.

A fourth factory, `getSecondaryServiceClient()` (`src/lib/supabase/secondary.ts`), points at a **separate** Supabase project via `SECONDARY_SUPABASE_URL` + `SECONDARY_SUPABASE_SERVICE_ROLE_KEY` and — unlike the three above — **throws** `Missing SECONDARY_SUPABASE env vars` instead of returning `null`. It has a single consumer, `app/api/secondary/hubstaff-projects/route.ts` (the Hubstaff project picker in HR onboarding).

**The service key is effectively mandatory, including in dev.** Most API routes create the service-role client directly. Of the ~182 files that call `createSupabaseServiceRoleClient()`, only 78 pair it with an anon fallback (77 as `createSupabaseServiceRoleClient() ?? createSupabaseServerClient()` on one line, plus a two-step `service ?? anon` in `data-tables-status.ts`). The other **104** have no fallback (50 under `app/api/`, 54 `src/lib/**` modules): when `SUPABASE_SERVICE_ROLE_KEY` is absent they fail closed — some loudly (`app/api/departments/route.ts` returns 500 `{ error: 'Supabase not configured' }`), some **silently** (`app/api/announcements/route.ts` resolves the caller's roles to `[]`, which reads as "no permission" rather than "misconfigured"). The app does not degrade gracefully without it.

Both server clients are built with a `resilientFetch` wrapper (`makeResilientFetch`, `src/lib/supabase/server.ts`): each attempt gets an `AbortController` timeout (`SUPABASE_FETCH_TIMEOUT_MS`, default 7s) and up to `SUPABASE_FETCH_RETRIES` (default 2) jittered-backoff retries (capped at 1s) inside a hard `SUPABASE_FETCH_DEADLINE_MS` (default 9s). Only 429 and 502/503/504/520-524 retry — 4xx and PostgREST 500s surface immediately, so a real query error or statement timeout isn't amplified against an already-struggling database. The browser client is deliberately not wrapped.

---

## Upstream Systems of Record

**Google Sheets is the upstream system of record for the roster.** `global_master_list`, `employee_hourly_rates`, the HSL roster and the screening pipeline are each mirrored *from* a Google Sheet by a cron (`app/api/cron/sync-*-from-sheet`), using a service-account credential (`GOOGLE_SHEETS_SERVICE_ACCOUNT_*`).

Several flows also write **back** to the sheet — `src/lib/google-sheets/` holds 17 modules including `append-master-sheet.ts`, `update-master-sheet-row.ts`, `update-master-sheet-department.ts`, `update-master-sheet-start-date.ts`, `update-rates-sheet.ts` and `delete-master-sheet-rows.ts`, called from HR offboard/reonboard, bulk-promote, department transfers and the People profile editor.

**Consequence:** a department, rate or start date fixed *only* in Postgres will be clobbered by the next sync. Fix the sheet cell and the DB row together. See [features/csv-imports.md](../features/csv-imports.md) and [features/department-transfers.md](../features/department-transfers.md).

**The offboarded log is the exception, and the direction is now reversed.** It used to be mirrored from the Offboarded tab like the others; that intake was **retired 2026-08-07** (`28cb65d`) and `app/api/cron/sync-offboarded-from-sheet` is now a 410 tombstone. `offboarded_sheet` is an HRIS-owned ledger written by `/api/hr/offboard` — writes *to* the Offboarded tab are unaffected, but nothing reads back from it. Do not "fix" a leaver by editing the sheet.

---

## Scheduled Jobs

`app/api/cron/*` holds eight route folders but **seven live jobs**: four Google-Sheet mirrors (`sync-master-from-sheet`, `sync-rates-from-sheet`, `sync-hsl-from-sheet`, `sync-screening-from-sheet`), the weekly Hubstaff sync (`sync-hubstaff-week`), `apply-scheduled-transfers` and `process-scheduled-deletions`. The eighth, `sync-offboarded-from-sheet`, is kept only as a **410 tombstone** (retired 2026-08-07) — it is the one folder that does not import `cron-auth`, because it does nothing.

The seven live jobs carry no session — `proxy.ts` admits them only on `Authorization: Bearer $CRON_SECRET` (**fail-closed if the var is unset**) and each handler re-verifies via `src/lib/auth/cron-auth.ts`.

`vercel.json` schedules only the two deletion/transfer jobs. The sheet + Hubstaff syncs are fired by **n8n Schedule Triggers on purpose** (DST-aware), so a job missing from `vercel.json` is not dead — check n8n. The weekly Hubstaff job runs the wizard's whole ingest pipeline (`src/lib/hubstaff/run-weekly-sync.ts`: hours batch, `payroll.available` notify, MESA deposits). See [features/hubstaff-weekly-auto-sync.md](../features/hubstaff-weekly-auto-sync.md).

---

## Outbound Automation (n8n)

**The app never sends email or provisions accounts itself.** It POSTs a payload to an n8n webhook looked up by stable slug via `resolveWebhookUrl(slug)` (`src/lib/webhooks/resolve-webhook.ts`), so URLs rotate from the Admin → Webhooks tab with no redeploy. Resolution order is: active config entry (`app_settings` key `webhooks.config`) → legacy bare-URL key → env var → hardcoded default.

The **18** live slugs are registered in `src/components/admin/AdminWebhooks.tsx` (`KNOWN_SLUGS`): `paystub_dispatch`, `create_workspace_account`, `verify_workspace_account`, `hubstaff_invite_user`, `onboarding_send`, `offboarding_deactivate`, `offboarding_delete`, `manager_suspend`, `manager_reactivate`, `new_hire_checklist_lock`, `manager_offboard_notify`, `call_tools_creation`, `bank_info_notify`, `urgent_payment_notify`, `ticket_created`, `ticket_done`, `ticket_assigned`, `payment_cycle_complete`.

`manager_suspend` / `manager_reactivate` back the Manager → My Team Suspend and Reactivation buttons (`src/lib/hr/offboard-webhooks.ts` exports the slug constants; `app/api/manager/temp-pause/route.ts` fires them).

Matching workflow JSONs live in `references/n8n/` (16 files) and **must be imported into n8n before a new slug does anything** — a slug with no imported workflow fails silently from the app's point of view.

---

## Reliability & Outage Resilience

A recurring design theme is that the app must stay **navigable and readable when Supabase is unreachable**, rather than collapsing into infinite skeletons or a blank screen. Several independent layers cooperate:

**1. Navigation survives a Supabase outage (JWT + localStorage).**
The ViewSwitcher and per-role tabs resolve from Supabase (`/api/employee-roles`, `/api/employee-feature-permissions`), so a naive implementation would lose all navigation during an outage. Two fallbacks prevent that:

- **JWT roles.** Roles ride in the NextAuth session token, so `useAvailableViews()` (`src/lib/rbac/views.ts`) is *offline-first*: it seeds the switcher from the session's own `roles` claim before any fetch, and keeps them if the fetch fails. `ViewSwitcher` passes these `selfRoles` **only** when the switcher is showing the session owner's own views (never when an admin browses `?email=someone-else`, whose roles differ).
- **Last-known-good cache.** `src/lib/rbac/rbac-cache.ts` persists the last successful `{ roles, perms }` resolution to `localStorage` (key `rbac.cache.v1:<email>`, per normalized email) via `writeRbacCache`, read back by `readCachedRoles` / `readCachedPerms`. This is **UX resilience only, never a security boundary** — every mutating API re-authorizes server-side off the JWT, so a tampered cache grants no real access (worst case: a tab renders but its reads/writes 401/500 while Supabase is down).

**2. Dead sessions self-heal (JSON 401 + `SessionInvalidationWatcher`).**
Because `proxy.ts` hands `/api/*` a JSON 401 instead of an HTML redirect (see routing section), the client can act on it. `SessionInvalidationWatcher` (`src/components/auth/SessionInvalidationWatcher.tsx`, mounted once at the app root) monkey-patches `window.fetch` to notice any same-origin `/api/*` 401 and re-validate via `/api/auth/session-status`. It **fails open** — it only signs the user out (and clears `SESSION_EMAIL_KEY`, bounces to `/login`) when session-status *confirms* the session is really gone, so a stray 401 won't yank a live user. It also listens for `auth.force_logout_map` changes over Realtime, backed by a 45s poll + focus check.

**3. Show real UI, not a skeleton, when the DB is down (`useResilientResource`).**
`src/hooks/useResilientResource.ts` (a pure, unit-tested reducer wrapped in a thin hook) guarantees: a skeleton **only** on a cold start (no data yet); on a *failed refresh* the last-known data is retained and flagged `stale` (screen stays populated + read-only); a cold-start failure resolves to `error` (caller renders an empty state + Retry) instead of a spinner that never ends. Its companion `ConnectionStatusBanner` (`src/components/ConnectionStatusBanner.tsx`) renders nothing while healthy, an amber "showing data from HH:MM — reconnecting…" bar when `stale`, and a red error + Retry bar on hard `error`.

> **Adoption status:** wired into exactly one surface — the Employee dashboard (`src/components/employee/EmployeeDashboard.tsx`, reached via `EmployeeApp`), which derives the status by hand from `essentialsError` + `lastLoadedAt` and imports only the `ResourceStatus` type plus the banner. The `useResilientResource` hook itself has **no callers yet** — treat it as available infrastructure, not an installed pattern. `App.tsx`, `HrApp`, `CeoApp`, `ManagerApp` and `AdminGlobalMasterList` render no stale/error banner; they get their resilience from layer 4 instead.

**4. Realtime degrades to polling; browser clients use RLS-independent primitives.**
The core status/lock subscriptions assume Realtime may silently break (missing publication, RLS, timeout) and pair themselves with a poll + focus reconcile. On `CHANNEL_ERROR` / `TIMED_OUT` the hook logs and leans on the poll: `useDispatchLock`, `useWizardDispatchLock` and `usePagesVisibility` fall back to a **30s** poll, `usePaymentsLive` to **20s**, `SessionInvalidationWatcher` to **45s**.

This is a convention, not a guarantee — the six hooks with a `CHANNEL_ERROR`/`TIMED_OUT` handler (`useDispatchLock`, `useWizardDispatchLock`, `useLiveRefresh`, `usePagesVisibility`, `usePaymentsLive`, `PeopleBankChanges`) implement the full poll+focus fallback, while feed surfaces (`SWall`, `AnnouncementWall`, `NotificationsPanel`, `HrOnboarding`) subscribe bare and go silently stale if Realtime drops. **New subscriptions should go through the shared `useLiveRefresh`** (`src/hooks/useLiveRefresh.ts`) rather than hand-rolling: it bundles the `postgres_changes` subscription, a default 30s poll, a focus/visibility refresh, event debouncing, and an `onStatusChange('live'|'degraded')` callback for an honest live-vs-polling indicator.

Separately, the Supabase **anon** role — which is what every browser client uses, since auth is NextAuth rather than Supabase Auth — cannot receive `postgres_changes` under RLS. Features that must reach those clients use RLS-independent Realtime primitives instead: **Broadcast** for the app-wide `hris-ping` nudge (`GlobalPingListener.tsx`) and for the CEO card's live payment counts on `payments-live` (`usePaymentsLive.ts` spells out the rationale), and Realtime **Presence** for `hris-presence` (`PresenceProvider.tsx` — `channel.track()` + presence sync/join/leave, a *different* primitive from Broadcast).

**5. Every server query is bounded (`resilientFetch`).**
See [Supabase Client Strategy](#supabase-client-strategy): per-attempt timeout, bounded retries on transport/5xx only, hard total deadline. This is why a Supabase brown-out surfaces as a fast error the UI can render rather than a hung request.

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
| `--background` | White (`0 0% 100%`) | `222 35% 7%` (≈`#0c0f18`, very dark navy) | Page background |
| `--card` | White | **Same as `--background`** (`222 35% 7%`) | Card surfaces |
| Indigo | `indigo-600` (hardcoded) | Same | PayrollWizard-specific accent |
| `.tickets-theme` | — | near-black + signal-red (`--background: 0 0% 4%`, `--primary: 0 74% 48%`) | `/tickets` board and its portaled dialogs/selects |

Three things the table can't convey:

- **Cards are not lifted in dark mode.** `--card` is byte-identical to `--background`; separation comes from `--border` (`217 33% 17%`) or explicit per-component utilities like `dark:bg-zinc-900/30`.
- **`body` hardcodes `dark:bg-[#0d1117]`** (`index.css:571`), which differs slightly from the `--background` token. Match the token, not the body hex.
- **`.tickets-theme` is a third complete palette** (`index.css:468-488`) overriding every semantic token in *both* global themes. Portaled surfaces must carry `tickets-theme dark` together or they render with the app palette.

**Sidebar gradient — utility classes, not a token, and not shared.** There is no `--sidebar` custom property; each rail hardcodes its own gradient, so changing "the sidebar look" means editing every rail. Only three follow the canonical orange-on-navy shape: Accounting (`src/components/Sidebar.tsx`) and Employee (`employee/EmployeeSidebar.tsx`) use `bg-gradient-to-b from-white to-orange-50/40 dark:from-[#0d1117] dark:to-[#0f1729]`, and Contractor is the same shape in blue (`from-white to-blue-50/40`). The HR, Manager, CEO and QC rails use a three-stop `via-<hue>` gradient that goes to **pure black** in dark mode (`dark:from-black … dark:to-black`), and Admin and Payroll Clerk differ again. So the "deep navy rather than pure black, to reduce eye strain on long payroll sessions" intent holds for the payroll-facing rails only — it is not a property of the sidebar system.

### Typography

- **Inter**: All UI text (labels, table content, descriptions). Clean, high-legibility at data-dense sizes.
- **JetBrains Mono**: Employee IDs, email addresses, currency values, hour counts. Monospace for scannable column alignment.

### Scrollbars

Custom-styled in `src/index.css`: 6px width, orange thumb on light mode, blue on dark. Applied globally to maintain visual consistency in tall table views.

### Animation Principles

A global `*, *::before, *::after` rule (`src/index.css:806-812`) transitions only the **seven theme-swap properties** — `background-color, color, border-color, box-shadow, fill, stroke, filter` — at `260ms ease`. Anything else (transform, opacity, width) must opt in per-component. Reduced motion is handled by an *override*, not a gate: `@media (prefers-reduced-motion: reduce)` sets `transition: none !important` on the same selector (`index.css:814-820`).

> **Gotcha:** that rule is **unlayered**, so it wins over Tailwind v4's layered `transition-*` utilities. If a duration utility seems ignored, this is why — the sidebar rail works around it with `!important` (`index.css:24-29`).

Framer Motion (`motion/react`) is used across ~105 components. The three canonical patterns:

1. **Shared-`layoutId` tab pill / underline** — a pill that smoothly slides between items (~38 distinct literal ids, 46 counting template-literal id families, across ~55 call sites: `accounting-documents-tab-pill`, `catalogTabPill`, `mesa-subtab-pill`, `profile-tab-underline`, …).
2. **`AnimatePresence` cross-fades** for tab and step content — e.g. the wizard keys on `currentStep` with `mode="wait"` and cross-fades opacity only at `duration: 0.2` (`PayrollWizard.tsx:17122-17133`); there is no horizontal slide and no direction key.
3. **Clamped per-index row stagger** on lists — `delay: Math.min(index * 0.04, 0.28)` (`AnnouncementWall.tsx`); per-surface factors run 0.012–0.06 with caps of 0.14–0.42. The house value documented in [design/ui-standards.md](../design/ui-standards.md) is `Math.min(index * 0.06, 0.42)`.

Dialogs open on `cubic-bezier(0.22, 1, 0.36, 1)` over 320ms with fade + `zoom-in-0.94` + `slide-in-from-bottom-6`, and close faster and flatter on `ease-in` over 180ms (`components/ui/dialog.tsx`); the overlay fades `280ms ease-out` in / `180ms ease-in` out. In TSX the same curve is written as the Framer array `ease: [0.22, 1, 0.36, 1]`.

### Component Primitives

All interactive primitives (Button, Input, Select, Dialog, Tabs, etc.) are shadcn components sourced from `@base-ui/react`. They provide accessible, unstyled HTML with ARIA attributes; the shadcn layer applies the Tailwind design tokens on top. The config in `components.json` uses the `base-nova` style variant with `baseColor: neutral`.

---

## Environment Variables

`.env.example` documents most variables but is **not** exhaustive — several are read by code and absent from the example file entirely (flagged below). For the authoritative set, combine `grep -rhoE 'process\.env\.[A-Za-z_]+' src app proxy.ts | sort -u` **with** `grep -rn 'envVars:' src`, because the n8n webhook URLs are resolved dynamically through `process.env[name]` in `src/lib/webhooks/resolve-webhook.ts` and are invisible to the first grep.

```
# Required for auth — nobody can sign in without these
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
NEXTAUTH_SECRET=
NEXTAUTH_URL=

# Required for all reads
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE=global_master_list
NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE=employee_hourly_rates
NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE=hubstaff_hours

# Effectively required for everything else — 104 server modules (50 API routes + 54 lib modules) hard-fail without it
SUPABASE_SERVICE_ROLE_KEY=

# Sheet sync + crons
GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY=
GOOGLE_SHEETS_MASTER_SHEET_ID=      # + _TAB_NAME
GOOGLE_SHEETS_RATES_SHEET_ID=       # + _RATES_TAB_NAME      (not in .env.example)
GOOGLE_SHEETS_HSL_SHEET_ID=         # + _HSL_TAB_NAME        (not in .env.example)
GOOGLE_SHEETS_SCREENING_SHEET_ID=   # + _TAB_NAME
GOOGLE_SHEETS_OFFBOARDED_TAB_NAME=  #                        (not in .env.example)
CRON_SECRET=                        # unset = every cron 401s (fail-closed, not open-by-default)
                                    #                        (not in .env.example)

# Integrations
ANTHROPIC_API_KEY=                  # Penny AI
HUBSTAFF_PAT=
HUBSTAFF_ORG_ID=
GOOGLE_WORKSPACE_ADMIN_EMAIL=       # + _CUSTOMER_ID / _PRODUCT_ID
MONDAY=
SECONDARY_SUPABASE_URL=             # separate Supabase project  (not in .env.example)
SECONDARY_SUPABASE_SERVICE_ROLE_KEY=#                            (not in .env.example)
N8N_*_WEBHOOK_URL= / N8N_*_SECRET=  # 22 fallbacks (19 URL + 3 secret); an Admin → Webhooks slug WINS
                                    #   over these. NB: five are assigned via `envVars = [...]` inside
                                    #   a branch in src/lib/hr/offboard-webhooks.ts, so the grep recipe
                                    #   above undercounts them
N8N_ORIENTATION_ZOOM_LINK=          #                            (not in .env.example)
N8N_BANK_INFO_NOTIFY_SECRET=        #                            (not in .env.example)

# Direct Postgres — daily report import + table discovery
DATABASE_URL=

# Optional overrides / tuning
NEXT_PUBLIC_SUPABASE_LEAVE_REQUESTS_TABLE=   # defaults to leave_requests  (not in .env.example)
SUPABASE_PROFILE_TABLES=                     # extra tables merged into profiles
SUPABASE_PROFILE_TABLES_EXCLUDE=
SUPABASE_FETCH_TIMEOUT_MS=  SUPABASE_FETCH_RETRIES=  SUPABASE_FETCH_DEADLINE_MS=
SUPER_ADMIN_PASSWORD=       SUPER_ADMIN_IMPERSONATION=   # see decision 10
BANK_UPDATE_NOTIFY_EMAIL=                    #                            (not in .env.example)
BANK_UPDATE_PUBLIC_HOST=                     # read by proxy.ts           (not in .env.example)
```

**Dead entries:** `GEMINI_API_KEY` and `APP_URL` sit in `.env.example` but are read nowhere in the codebase (AI Studio leftovers).

---

## Key Architectural Decisions

**1. Client-side SPA inside Next.js — but the server does real work**
The app behaves like a SPA (tab-based nav, no page reloads) and all interactive UI is `"use client"` — there are **no Server Actions** anywhere in the tree. But Next.js is used for more than API routes:

- API routes hold the service-role Supabase access that must never reach the browser.
- The async root layout (`app/layout.tsx`) reads the NextAuth session server-side.
- Each privileged route's `layout.tsx` is an async server component that `await requirePageRoles(...)` and server-`redirect()`s — the real authorization gate, defense-in-depth behind `proxy.ts`.
- `/accounting` additionally SSR-prefetches its seed data (`prefetchAccountingData()` in `src/lib/accounting/prefetch.ts`) below a `<Suspense>` boundary and streams it into `<AppShell initialData=... />`.
- Per-route `loading.tsx` files provide the streamed skeletons.

**2. Column names with spaces**
The Supabase tables use human-readable column names with spaces (`"Work Email"`, `"Total worked"`, `"Regular Rate"`). All queries quote these names via PostgREST. Lib functions build normalized key indexes (`normFieldKey()`) to handle both space and underscore variants during merges.

**3. PostgREST caps every read at 1,000 rows**
`db.max-rows=1000` is set on this project, and it truncates **silently** — no error, and an explicit `.range(0, 99999)` does not defeat it. The active roster passed 1,000 people in July 2026, so *any* "read the whole table/view" call must go through `selectAllPaged()` (`src/lib/supabase/select-all-paged.ts`): build the query inside the closure, apply the handed `.range(from, to)`, and add a stable `.order()` so pages don't shear. The 2026-07-30 audit found 16 un-paged readers silently dropping the roster's tail — missing payroll notifications, truncated team rosters, wrong HSL week models, understated outstanding-pay reports, and a work-email suggester that could re-mint taken addresses. See [audits/audit-2026-07-30-session-log.md](../audits/audit-2026-07-30-session-log.md).

**4. Integer seconds for hours arithmetic**
All Hubstaff hour values are converted to integer seconds before any arithmetic. This eliminates floating-point errors in overtime calculation (e.g. `7:59:59` vs `8:00:00`). The display layer divides back to decimals.

**5. Employee IDs are persisted** *(were once derived — see [Retired](#retired--superseded-behavior))*
`YYMM-NNNN` employee IDs live in `global_master_list.employee_id` (added by `references/sql/alter/add_employee_id_to_global_master_list.sql`) and are mirrored as the key of the `employee_ids` payout table. `generateEmployeeIds()` (`src/lib/supabase/employees.ts`) is now an *assigner*, not a generator: persisted IDs are never rewritten; only rows lacking one are numbered, sorted by first name into the next free serial within their YYMM bucket. IDs are stamped to the DB by `backfillEmployeeIds()` after every master-list upload, after every HR promote/bulk-promote, and by the one-shot `POST /api/admin/backfill-employee-ids`.

Not all IDs match `YYMM-NNNN`: `SELF-<hex>` (promote fallback) and `US-%` (US non-sheet staff) prefixes exist, and `employee_id` **is** used as a real key (bank-detail writes in `app/api/people/[email]/banking/route.ts`, the `US-%` filter in `global-master-list-db.ts`). Work Email remains the canonical *join* identity across tables.

**6. Rates resolve through the Payment Catalog at compute time**
`src/lib/payroll/resolve-rate.ts` overlays `payment_catalog_pay_structures` on top of the stored rate with the priority **individual employee structure → sheet rate (`employee_rate_history` / `employee_hourly_rates`) → department base**. Nothing is written back — the overlay is applied per computation, and only for the live/future cycle so historical replays still resolve from dated history. A structure carries its own currency; a USD rate is converted to PHP-equivalent here.

**Reading `employee_hourly_rates` directly will give you the wrong number for anyone with a catalog entry.** Supporting modules: `src/lib/payment-catalog/` (`pay-structure.ts`, `person-comp.ts`, `system-bonus.ts`), `src/lib/supabase/pay-structures-db.ts`, `app/api/payment-catalog/pay-structures/`. See [features/bonus-catalog.md](../features/bonus-catalog.md) and [features/payment-catalog-departments.md](../features/payment-catalog-departments.md).

**7. Dual-table employee insert/delete**
`POST /api/add-employee` / `DELETE /api/delete-employee` modify both `employee_hourly_rates` and `global_master_list` in one call (add-employee also stamps `first_seen_upload_id` / `last_seen_upload_id` from `master_list_uploads`; both write `audit_log`). There is no foreign key between the two tables — the application layer keeps them in sync. The only FK onto either is `hr_pending_employees.promoted_to_master_id → global_master_list(id) ON DELETE SET NULL`.

> **Note:** those two routes now have **no callers in the app**. The live add path is HR onboarding → `promoteHrPendingEmployee()` (`src/lib/supabase/hr-pending-employees.ts`), which touches `global_master_list`, `employee_ids`, `employee_hourly_rates` and the `hr_pending_employees` status row (the flip is gated on the Google Sheet append), then runs `backfillEmployeeIds()`.

**8. Date-aware CSV column mapping**
Hubstaff CSVs use day-name date headers (`"Mon 3/24"`) while the Supabase table may carry ISO column names (`"2026-03-24"`) *or* stable weekday columns (`monday`…`sunday`). `replaceHubstaffHoursFromCsvText()` delegates to `resolveColumnMapping()` (`src/lib/supabase/hubstaff-hours-db.ts`), which runs **three** passes:

1. Exact case-insensitive header match.
2. Date-aware match — `csvColToIsoDate()` parses both formats to ISO and pairs them by calendar date.
3. Weekday match — `dbColumnToWeekdayKey()` + `isoDateToWeekdayKey()` map `monday`…`sunday` DB columns onto whichever CSV date column falls on that weekday.

If the OpenAPI column spec is unavailable it falls back to inserting under the raw CSV headers. Without passes 2–3, daily hour values end up `null` in Supabase.

**9. Client-side CSV re-parse backs Perfect Attendance**
After a Hubstaff CSV is ingested (upload or live API sync), `finalizeHubstaffIngest()` (`src/components/PayrollWizard.tsx:8811`) re-parses the CSV text client-side with `parseCsv()` and persists the Mon–Fri daily breakdown to `app_settings` under key `hubstaff_daily_breakdown`. It then calls `loadHubstaffPreview()`, which re-fetches `GET /api/hubstaff-hours` and — only if the returned weekday columns are all null — merges that saved breakdown over the Supabase rows. So Perfect Attendance always has real daily values even when the Supabase date columns don't match; `app_settings` is the **fallback**, not a replacement for the fetch.

`hubstaffDisplayColumns` / `hubstaffDisplayRows` are set exclusively from fetch responses. PAB itself reads `hubstaffColsForPab` / `hubstaffRowsForPab`, which merge every uploaded source file (`pabAllColumns` / `pabAllRows`) and only fall back to the display state when no `source_file`-tracked uploads exist. The `dailyDataMissing` flag fires when weekday columns exist but every value is empty, and renders a warning banner.

PA/PAB lives on **Step 5 (Additions)**. The 9-step wizard order is: 1 Initialize Payroll Data, 2 Initial Calculation, 3 Orphanage, 4 HSL, 5 Additions, 6 Contractors, 7 Validation, 8 Dispatch, 9 Reports.

**10. NextAuth (Google SSO) + role-based access control**
Authentication is Google SSO restricted to the `simple.biz` Workspace, via NextAuth with JWT sessions (`src/lib/auth/auth-options.ts`).

> **A second sign-in path exists and is enabled by default:** a **super-admin impersonation** `CredentialsProvider` that signs you in *as* any `@simple.biz` email given a shared password (`SUPER_ADMIN_PASSWORD`, **default `'super-admin'`**). It bypasses Google entirely, inherits the target's roles, stamps `token.impersonated`, and is audit-logged as `auth.impersonation.signin`. Disable with `SUPER_ADMIN_IMPERSONATION=off`.

Authorization has two layers: **role grants** (`employee_roles`, managed in Admin → Roles) gate which *dashboard* a user can open, and a **per-feature-permission overlay** (`employee_feature_permissions`, Hidden/View/Edit per tab) decides which *tabs* they see and can edit. As of 2026-06 the overlay is the single source of truth for per-tab access — enforced across all role views (Accounting, HR, Manager, CEO, Contractor, Orphanage, QC, and the standalone Tickets board) and the API routes behind them via `src/lib/auth/authorize-feature.ts`, provisioned entirely from the Admin "Roles and Permissions" screen. `tickets` has no tab list — the feature key is checked directly at the API layer (`view-tabs.ts`).

`admin` bypasses the overlay so you can't lock yourself out. Tabs default to hidden (a missing row = `hidden`), and `overview` is a read-only **fallback** landing: it shows only when the overlay grants the user no other tab, so a dashboard is never blank; once any other tab is granted, `overview` obeys the overlay like everything else and an admin **can** hide it (`view-tabs.ts`). Assigning a dashboard role auto-provisions all its tabs to `edit`.

Roles are stamped into the JWT at sign-in and then **re-resolved from `employee_roles` at most once every 60s inside the jwt callback** (a Supabase outage keeps the existing roles rather than blanking them). On top of that a **force-logout map** (`app_settings.auth.force_logout_map`, `src/lib/auth/force-logout.ts`) invalidates stale tokens immediately — fired automatically on role **grant** *and* **revoke** (`/api/employee-roles` POST/DELETE) and on any per-feature permission change (`/api/employee-feature-permissions`) — plus a manual "Reset session" button in `AdminRoles`. Grants/revokes are audit-logged. Full detail in [features/rbac-feature-permissions.md](../features/rbac-feature-permissions.md); the original plan is [implementation-plans/implementation-plan-rbac.md](../implementation-plans/implementation-plan-rbac.md) (was `IMPLEMENTATION_PLAN_RBAC.md` at the repo root before the 2026-05-05 docs reorg).

**11. Flat analytic table for weekly reports (`disbursement_records`)** *(added 2026-04-28)*
The Reports tab in Payment Dispatch reads from a flat `public.disbursement_records` table — one row per (Hubstaff cycle, employee). It's seeded from the existing tables (`hubstaff_hours` × `employee_hourly_rates` × `payment_dispatches`) by `references/sql/seed/seed_disbursement_records.sql`, and the two triggers on `payment_dispatches` (`payment_dispatches_sync_disbursement` for INSERT/UPDATE, `payment_dispatches_unsync_disbursement` for DELETE) are installed by `references/sql/seed/seed_disbursement_records_sync.sql` — they keep the flat table live without the API doing the join itself.

**Why:** the original report endpoint joined three tables + ran `computeCurrentPay()` on every render — fine for 7 cycles, painful at a year of pulls. The flat table makes a weekly rollup a single grouped scan.

It is no longer read by that one tab alone: the Accounting **Pay Cycle Reports** surface (Documents tab → `PayCycleReports.tsx`, `src/lib/accounting/pay-cycle-reports.ts`) builds on the same `listDisbursementReports()` but **also** queries `payment_dispatches` directly for its publish gate, because contractor invoices never produce a `disbursement_records` row. CEO Financial Reports and Penny AI read it too (`src/lib/ceo/financial-reports.ts`, `src/lib/anthropic/ceo-tools.ts`). See [payment-dispatch.md §6.5](../features/payment-dispatch.md) and [data-sources.md §5](./data-sources.md).

**12. Payout rails and currency**
The ledger is not the end of the run. Payment Dispatch routes each payee to one of six processors (`src/lib/employee-payment-processors.ts` — hurupay, wepay, higlobe, wise, jeeves, wires; some retired for *new* selections via `RETIRED_PROCESSOR_IDS`, with a separate employee-facing picker set), with the send-from rail resolved by a documented precedence chain topped by `employee_ids.bank_preferred`.

The queue is globally lockable (`/api/payroll-dispatch-lock`, `useDispatchLock`) so two clerks can't double-pay. All pay math accumulates in PHP, but rates and payouts can be USD or COP: `src/lib/fx/currency-fx.ts` anchors on USD with `usd_to_php_rate` / `usd_to_cop_rate` in `app_settings` and derives PHP↔COP *through* USD rather than storing it. Paystub delivery is `src/lib/payroll/paystub-dispatch.ts` + `app/api/dispatch-paystubs/`. See [features/bank-preferred-routing.md](../features/bank-preferred-routing.md) and [features/cop-country-payees.md](../features/cop-country-payees.md).

**13. Login (`/login`) — Google SSO primary**
The primary sign-in is Google SSO (see decision 10). After NextAuth resolves the session, `app/login/page.tsx` fetches the user's roles (`GET /api/employee-roles`) and lands everyone on `/employee` (see the routing section).

A **legacy email + password path** still exists at the API layer (`POST /api/employee-login` → RPC `verify_employee_password`; forgot-password `POST /api/employee-forgot-password` → RPC `verify_employee_identity`; password = `MMDDYY` of start date), but its only client — `src/components/employee/EmployeeLogin.tsx` — is **dead code: nothing imports it** and `/login` never renders it. The second sign-in path actually wired into `/login` is super-admin impersonation (decision 10). Treat the legacy routes as an unauthenticated-by-UI surface and delete or re-wire them deliberately.

Password columns on `employee_hourly_rates`: `password_hash`, `previous_password_hash`, `password_updated_at` (pgcrypto bcrypt; plaintext never stored). **Provenance caveat:** these columns and the two RPCs exist only in the live database — there is no migration under `references/sql/` and no code reads the columns, so this is unreproducible from the repo. Either check the definitions in as SQL or mark the whole legacy path retired. Login successes/failures are written to `audit_log`.

**14. One notification table, one audit spine**
All in-app notifications are rows in `employee_notifications`, keyed only by recipient email. `src/lib/notifications/notification-views.ts` maps each `type` (36 of them: `onboarding.submitted`, `transfer.*`, `offboarding.*`, `resignation.*`, `rate.change`, `dispute.*`, `time_adjustment.*`, `bank_info.requested`, `people.banking.*`, `payroll.processing_*`, …) to the dashboard(s) it is actionable from, and **that map is what drives the per-view unread badges in ViewSwitcher** — add a new type there or its count surfaces nowhere. Delivery surfaces: `src/components/notifications/`, `useEmployeeNotificationsUnread`, `useNotificationCountsByView`, `useNotificationChime`.

Separately, privileged mutations write a typed `audit_log` row through `insertAuditLog()` (`src/lib/supabase/audit-log.ts`, 67 declared `AuditAction`s). **Extend the union rather than logging a free-form string** — the Admin audit viewer and the Penny AI tools read it by exact action.

**15. Admin dashboard: Global Master List; app-wide presence + live Ping**
The Admin sidebar's old **Employees** tab is gone — replaced by a **Global Master List** tab (`src/components/admin/AdminGlobalMasterList.tsx`; `systemNav` id `global-master-list`). Presence was widened from a simple online roster into a per-person location feed: `PresenceProvider` (`src/components/presence/PresenceProvider.tsx`) broadcasts each client's `path` (which dashboard), `tab` (which in-dashboard tab) and `active` (whether the HRIS tab is focused — away vs present) on the app-wide `hris-presence` Realtime **Presence** channel. Dashboard shells publish their current tab label via `usePublishPresenceTab(label)`; viewers read the full roster via `usePresenceDetails()`, so the Global Master List can show e.g. "HR Dashboard · Onboarding" next to an online person.

Presence is not purely ephemeral: each client also heartbeats every 60s to `POST /api/presence/heartbeat`, which upserts `last_seen_at` into `user_presence` so offline teammates can still show "Last seen 5m ago".

**Ping, by contrast, is live-only** (`GlobalPingListener` / `useAdminPingSender`): a directed nudge over the app-wide `hris-ping` **Broadcast** channel that lands wherever the recipient currently is — nothing is persisted, so if they're offline the ping is simply never received (no history, no catch-up, no DB row).

**16. Pages visibility / "under construction" (`usePagesVisibility`)**
Admins control per-tab visibility from the Admin **Pages** tab (`AdminPages`), stored as a single `pages.visibility` row in `app_settings`. Each `(dashboard, tab)` is `visible`, `construction` (under construction), or `hidden`. `src/hooks/usePagesVisibility.ts` subscribes to that row over Realtime (with the standard 30s-poll + focus fallback) and exposes two resolvers: `visibilityOf()` — the **effective** gate used for nav, where **admins bypass `construction` and see the real page** (so they can preview what's being built; `hidden` still hides for everyone) — and `rawVisibilityOf()`, the true stored state. Shells use the raw state to still surface a `ConstructionBanner` (`src/components/common/ConstructionBanner.tsx`) atop the bypassed page, reminding the admin it isn't live for others yet. The hook is **fail-open**: until a load succeeds it leaves gating off rather than acting on an empty config that would treat hidden pages as visible.

**17. Unified collapsible sidebar shell**
Every dashboard rail **except Orphanage's** — Accounting `Sidebar`, `HrSidebar`, `EmployeeSidebar`, `AdminSidebar`, `ManagerSidebar`, `CeoSidebar`, `ContractorSidebar`, `QCSidebar`, `PayrollClerkSidebar`, and the standalone `/tickets` board's `TicketsSidebar` — renders through the shared `CollapsibleSidebarShell` (`src/components/common/CollapsibleSidebarShell.tsx`), giving them matching width and collapse behavior. The animation only changes the rail's `width` while a fixed-width inner panel is clipped, so nothing re-flows: icons stay pinned at the left edge and labels fade via opacity (collapse is desktop-only; on mobile the rail is a full-width drawer). Notification badges and icons are retained, with `SidebarCollapsedDot` standing in for right-aligned count badges the 64px collapsed rail would clip.

The **ViewSwitcher + theme toggle live inside the sidebar's scroll area** (a single `ScrollArea`), so on short viewports the switch-view control is reachable by scrolling; brand header and Sign Out stay anchored top/bottom. **Exceptions:** `ContractorSidebar` and `TicketsSidebar` keep the ViewSwitcher + theme toggle in the anchored `mt-auto` footer *below* the ScrollArea.

**The Orphanage dashboard is the holdout.** There is no `OrphanageSidebar` file at all — `OrphanageApp.tsx` hand-rolls a fixed 220px `<aside>` with its own nav, so it does not collapse and does not inherit the shared width, badge or `SidebarCollapsedDot` behavior. Anything you change in `CollapsibleSidebarShell` will not reach it.

---

## Retired & Superseded Behavior

Recorded so that a reader who finds a stale reference elsewhere — in an older doc, a comment, a
memory note, or a half-finished branch — can tell "removed on purpose" from "never built".

| Was | Now | Changed |
|---|---|---|
| `Documentation/` folder held all docs (`SYSTEM_ARCHITECTURE.md`, `API_REFERENCE.md`, `COMPONENTS.md`, `DATA_SOURCES.md`) | `docs/` with `reference/`, `features/`, `audits/`, … ; filenames lowercased-kebab | deleted 2026-05-05 (`377c255`) |
| Accounting **`rates` tab** + `src/components/Rates.tsx` | Folded into the **`people`** tab | deleted 2026-06-22 (`63add1b`) |
| Profile-modal field stagger `delay: Math.min(i * 0.01, 0.28)` | Generic clamped row stagger (~`index * 0.04`, cap 0.28) on list surfaces | removed with `Rates.tsx`, `63add1b` |
| Wizard step transition: `motion.div` `x: ±20` slide + `AnimatePresence` **direction key** | Opacity-only cross-fade, `mode="wait"` keyed on `currentStep`, `duration: 0.2` | — |
| Employee IDs **derived at render** by `generateEmployeeIds()`, display-only, reshuffling on roster change | Persisted in `global_master_list.employee_id`; the function is now an *assigner* that never rewrites an existing ID (decision 5) | `references/sql/alter/add_employee_id_to_global_master_list.sql` |
| `/` redirected accounting users to `/accounting`; post-login sent everyone to their **highest-priority** dashboard | `/` and post-login both land on **`/employee`**; other dashboards are reached via the ViewSwitcher | — |
| Roles frozen in the JWT at sign-in | Re-resolved from `employee_roles` at most once per 60s in the jwt callback | — |
| `overview` was **always** a visible read-only landing tab | A **fallback** shown only when the overlay grants nothing else; admins can hide it | — |
| Roles `finance`, `payroll_coordinator`, `payroll_manager`, `viewer` | `finance` renamed **`accounting`**; the other three removed from the `Role` union entirely | `views.ts` header notes |
| `hr_coordinator` also unlocked the Accounting dashboard | Decoupled — `ACCOUNTING_ROLES` is `['accounting']` | 2026-06-22 |
| Employee portal **`disputes`** tab | Retired (commented out in both sidebar and renderer); manager-side dispute surfaces remain | — |
| Employee-facing login form `EmployeeLogin.tsx` (email + `MMDDYY` password) | **Dead code — no importers.** The API routes + RPCs still exist; `/login` is Google SSO (+ impersonation) only (decision 13) | — |
| `POST /api/add-employee` / `DELETE /api/delete-employee` as the add/remove path | Still present and functional but **no callers**; live path is HR onboarding → `promoteHrPendingEmployee()` | — |
| `src/lib/supabase/client.ts` as the browser client | `src/lib/supabase/browser.ts` (singleton, realtime-tuned). The old file has zero importers | — |
| `buildHubstaffDataFromParsedGrid()` fed wizard display state from the client-side re-parse | Display state comes only from `GET /api/hubstaff-hours`; the re-parse persists a fallback breakdown to `app_settings`. The function is **dead code** | — |
| Two-pass Hubstaff column mapping, inline in `replaceHubstaffHoursFromCsvText()` | **Three** passes, extracted to `resolveColumnMapping()` (decision 8) | — |
| Perfect Attendance detection on **Step 3** | Step **5 (Additions)**; step 3 is now Orphanage | — |
| `references/seed_disbursement_records.sql` (flat path) | `references/sql/seed/seed_disbursement_records.sql` + `…_sync.sql` after the `references/` reorg | — |
| The **offboarded log was mirrored FROM** the Google Sheet's Offboarded tab by `sync-offboarded-from-sheet` | Intake retired; `offboarded_sheet` is an HRIS-owned ledger written by `/api/hr/offboard`. The cron route survives as a **410 tombstone**; writes *to* the sheet are unaffected | retired 2026-08-07 (`28cb65d`) |
| `IMPLEMENTATION_PLAN_RBAC.md` (original RBAC plan at repo root) | **Moved and renamed**, not deleted: [implementation-plans/implementation-plan-rbac.md](../implementation-plans/implementation-plan-rbac.md). Surviving detail doc is [features/rbac-feature-permissions.md](../features/rbac-feature-permissions.md) | moved 2026-05-05 (`377c255`) |
| `next-themes` configured to respect the OS preference | `enableSystem={false}`, `defaultTheme="light"`, manual toggle only; no `prefers-color-scheme` rule anywhere | — |
| Global `*` transition described as "all CSS properties", gated by `prefers-reduced-motion: no-preference` | Seven named theme-swap properties; reduced motion is a `reduce` **override** with `transition: none !important` | — |
| Payout processors freely selectable | Some are in `RETIRED_PROCESSOR_IDS` — hidden from *new* selections while existing assignments still resolve | — |

Two things referenced by older docs **never existed in this repo**: `references/gen_dept_seed.js` (no commit ever added it) and the Employee portal `policies` / `settings` tabs.

---

## Related Reference Docs

- [api-reference.md](./api-reference.md) — full inventory of the 261 API handlers
- [components.md](./components.md) — per-dashboard component reference, Dashboard Map
- [data-sources.md](./data-sources.md) — table-by-table schema and provenance
- [business-logic.md](./business-logic.md) — pay computation rules
- [managers-logic.md](./managers-logic.md) — manager-scoped visibility rules
- [../features/](../features/) — 46 per-feature docs
- [../../SECURITY_AUDIT.md](../../SECURITY_AUDIT.md) — outstanding unauthenticated-route findings
