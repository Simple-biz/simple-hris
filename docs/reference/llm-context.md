# Project Context for LLMs

Simple HRIS is a **payroll processing tool** for a Philippines-based outsourcing company. Its primary workflow (called the "Friday Path") takes a weekly Hubstaff hours CSV export, computes base pay with overtime, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger.

Read the documents in this folder **before** making changes to the codebase. They capture business rules and architectural decisions that are not obvious from the code alone.

---

## Documentation Index

| File | What it covers |
|---|---|
| [SYSTEM_ARCHITECTURE.md](./system-architecture.md) | Tech stack, repository structure, routing model (admin + employee portal), Supabase client strategy, design system, environment variables, key architectural decisions |
| [DATA_SOURCES.md](./data-sources.md) | All Supabase tables (schema + queries), all API routes, direct pg Pool usage, data flow diagram, CSV upload dedup, email normalization, **PAB canonical column resolution**, **All Time accumulation** |
| [COMPONENTS.md](./components.md) | Every UI component across all **eight role dashboards** -- Accounting (App, Sidebar, Overview, Rates, PayrollWizard, Disputes), Admin, Employee, Manager, HR, CEO, Orphanage, Contractor, Payroll Clerk -- plus the **Dashboard Map**, **Auth/RBAC/Role-routing** glue, shared components (S-Wall, Announcements, Notifications, Presence, Audit), the **PAB helper module**, and shadcn primitives |
| [BUSINESS_LOGIC.md](./business-logic.md) | All business rules: payroll formulas, overtime threshold, **PAB month boundaries** (week ownership by Monday), **PAB calendar grid**, **canonical column resolution**, **All Time mode**, department auto-assignment, per-department bonus schedules, CSV upload rules, data integrity policies |
| [API_REFERENCE.md](./api-reference.md) | Complete REST API documentation: all 14 endpoints with methods, request/response shapes, validation, tables, service role requirements, **planned payroll automation endpoints** (finalize, paystub, dispatch) |
| [IMPLEMENTATION_PLAN_RBAC.md](../implementation-plans/implementation-plan-rbac.md) | Planned RBAC system: 6 roles, full permission matrix, Supabase Auth integration, API route guards, UI gating, RLS policies, audit logging, 5-phase implementation plan |

---

## Quick Facts

- **Currency**: Philippine Peso (₱), `en-PH` locale
- **Overtime threshold**: 40 hours/week
- **Hours arithmetic**: Integer seconds (avoids float errors)
- **Employee identity key**: Email address (normalized: trimmed + lowercased)
- **Employee IDs (YYMM-NNNN)**: Derived display-only, never persisted
- **Dual-table writes**: Add/delete employee always touches both `employee_hourly_rates` and `global_master_list`
- **Column names have spaces**: PostgREST quoted identifiers (`"Work Email"`, `"Total worked"`, etc.)
- **Date columns can mismatch**: DB may have ISO (`"2026-03-24"`) while CSV has `"Mon 3/24"`. The upload code does date-aware mapping; the client also re-parses the CSV as a fallback.
- **PAB month boundaries**: A week belongs to the month containing its Monday. Start = first Mon on/after 1st; End = Fri of last week whose Mon is in the month (may spill into next month).
- **PAB canonical column resolution**: Supabase stores `monday`/`tuesday` columns; the merge logic resolves them to ISO dates using source filenames (`resolveCanonicalColumnsToIso()`).
- **Employee Dashboard "All Time"**: Aggregates pay across all source files with per-file regular/OT split (each file split at 40h, then summed). PAB shows eligible months × ₱5,000.
- **PA detection requires daily data**: If daily columns are null in Supabase (column-name mismatch from old upload), a warning banner in Step 3 tells the user to re-upload.
- **Step 5 (HSL Payroll)**: Dedicated HSL step — Initial Pay + KPI Bonus (from HSL Bonus Calculator) + PAB (₱5,000 if eligible, Mon–Sun week logic) + Tech Bonus (₱1,850 if eligible); both PAB and Tech Bonus are included in Total Pay per row and footer total
- **Step 6 (Dispatch)**: Currently a placeholder — no payment API is called
- **Hogan Cycle toggle**: Flag used by HSL PAB period logic (`hslAdjustedPabEnd`); full date-range filtering still pending
- **Lead Gen department**: No bonuses, explicitly excluded by policy
- **Auth + RBAC** *(implemented; overhauled 2026-06-18)*: NextAuth Google SSO restricted to the `simple.biz` Workspace; JWT stamped with roles from `employee_roles`. `middleware.ts` gates every page route + enforces `?email=` ownership. Two authz layers: **dashboard-only role grants** (a role just unlocks a whole dashboard) + a Hidden/View/Edit per-tab overlay (`employee_feature_permissions`) that now spans **every** role dashboard **and is enforced on all write APIs** (view-only users are blocked from POST/PATCH/DELETE via `requireFeatureEdit`); `admin` bypasses. Assigning a role auto-provisions sensible tab permissions. Role/permission changes trigger a force-logout map (+ live "reset session" via `SessionInvalidationWatcher`) that invalidates stale JWTs. See [rbac-feature-permissions.md](../features/rbac-feature-permissions.md).
- **Eight role dashboards**: Accounting (`/`), Admin (`/admin`), Employee (`/employee`), Manager (`/manager`), HR (`/hr`), CEO (`/ceo`), Orphanage (`/orphanage`), Contractor (`/contractor`); Payroll Clerk dispatch is at `/payroll-clerk` and also the Accounting Payment Dispatch tab. Users land on their highest-priority view and hop between entitled views via the sidebar ViewSwitcher (`src/lib/rbac/views.ts`).
- **Employee Portal**: Accessible at `/employee?email=...` — provides Dashboard (hours/pay/PAB), Profile (with bank info), and Settings (bank info editing).
- **System Overview CSV selector**: Dropdown to view stats for a specific source file or "All Time" (aggregated). Defaults to latest file.
- **Bonus & Status panel**: Real-time PAB eligibility metrics (eligible/not eligible counts + progress bar), Technology Bonus status; dispute counts still summarized at a high level (detailed flow is `pab_day_disputes` / [BUSINESS_LOGIC.md](./business-logic.md#pab-day-dispute-system)).
- **Rates avatars**: Employee table and profile modal show avatars (photo/Gravatar/initials). Photo URL fields are hidden from the field list.
- **CEO Assistant** *(2026-06)*: Floating `/chatbubble.png` chat widget on the CEO dashboard (`CeoChatBubble.tsx`) → `POST /api/ceo/chat` (Claude **Sonnet**, streaming) with read-only payroll tools over `disbursement_records`; `ceo`/`admin` gated, audit-logged. See [ceo-assistant.md](../features/ceo-assistant.md).
- **Admin API keys** *(2026-06)*: Admin "API tokens" tab manages the Anthropic key in `app_settings` key `secret.anthropic_api_key` (DB value overrides env; resolver `src/lib/anthropic/api-key.ts`; never returned in full). Routes gated by `requireAdminSession` (admin-only, stricter than "elevated"); `secret.*` is an admin-only tier in `/api/app-settings`. See [admin-api-keys.md](../features/admin-api-keys.md).
- **Onboarding Pay Plans** *(2026-06, migration #80 PENDING)*: HR uploads one pay-plan PDF per (Department, Country) into `hr-onboarding-files` at `pay-plans/<id>.pdf`; the matched plan is delivered on the onboarding **invite** email (`onboarding_send`), keyed by `invite_department` + `invite_country`. Earlier submission-time webhook removed. See [onboarding-pay-plans.md](../features/onboarding-pay-plans.md).
- **Onboarding Gmail Surname** *(2026-06, migration #81 PENDING)*: read-only minimal last-name slice making `<first><slice>@simple.biz` unique against the live roster (`POST /api/onboarding/[token]/gmail-surname`); sent to the workspace-account webhook as the surname in place of the legal name, for privacy. See [onboarding-gmail-surname.md](../features/onboarding-gmail-surname.md).
- **US Team department** *(2026-06-18, migration PENDING)*: all US-based staff (`employee_id LIKE 'US-%'`) consolidate under the label **"US Team"** (internal key unchanged: `us_manager_bonus`, USD-anchored, excluded from PAB/Tech), replacing the old split across US Manager Bonus / Hogan Smith Law / HR. See [business-logic.md](./business-logic.md#us-team-department-consolidation-added-2026-06-18).

---

## Key Files

| Path | Purpose |
|---|---|
| `src/App.tsx` | Root SPA shell, `activeTab` state |
| `src/components/PayrollWizard.tsx` | Core feature, multi-step wizard (Upload → Calc → Additions → Validation → HSL Payroll → Contractors → Dispatch) with PAB detection and HSL-specific pay step |
| `src/components/Rates.tsx` | Profile viewer + CRUD |
| `src/components/Overview.tsx` | Admin dashboard |
| `src/components/employee/EmployeeApp.tsx` | Employee portal shell, tab routing |
| `src/components/employee/EmployeeDashboard.tsx` | Employee hours/pay/PAB dashboard with calendar |
| `src/components/employee/EmployeeProfile.tsx` | Employee profile with bank info |
| `src/components/employee/EmployeeSettings.tsx` | Bank info + personal email editing |
| `src/components/employee/EmployeeAvatar.tsx` | Photo → Gravatar → initials fallback |
| `src/lib/hubstaff/calendar-column-dedupe.ts` | PAB date logic, calendar grid builder, canonical column resolution |
| `src/lib/supabase/employee-rate-profiles.ts` | Multi-table profile merge engine |
| `src/lib/supabase/employees.ts` | Master list query + employee ID generation |
| `src/lib/supabase/employee-ids.ts` | Bank info from `employee_ids` table |
| `src/lib/supabase/hubstaff-hours-db.ts` | CSV upload + full table replace |
| `src/lib/payroll/compare-to-master.ts` | Coverage stats |
| `src/types.ts` | Shared TypeScript types |
| `src/index.css` | Design tokens, color variables, global styles, PAB animations |
| `.env.example` | All environment variables documented |
