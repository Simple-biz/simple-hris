# Repository Analysis — Simple HRIS

## Project Overview

**Name:** Simple HRIS  
**Type:** Full-stack HR Information System  
**Purpose:** Payroll, time-tracking, onboarding, bonus programs, gift tracking, and orphanage program management for Simple.biz (a Philippines-based remote-services company with US management).

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.0.1 (App Router + Pages Router hybrid) |
| Runtime | React 19.0.0 |
| Language | TypeScript 5.8.2 |
| Styling | TailwindCSS 4.1.14 + shadcn/ui |
| Database | Supabase (PostgreSQL via `@supabase/supabase-js` 2.101.1) |
| Auth | NextAuth 4.24.14 (Google OAuth) |
| Animation | Motion 12.23.24 |
| Data import | csv-parse, XLSX |
| AI features | Google Generative AI (@google/genai) |
| Graphs | XYFlow (@xyflow/react) |
| Deployment | Vercel (region: sin1 for Supabase proximity) |

---

## Database Provider

**Supabase** (PostgreSQL) with:
- Row Level Security (RLS) enabled on social/announcement tables
- Realtime subscriptions on swall tables, announcements, employee_rate_history, app_settings
- Service role key for server-side operations
- Anon key for client-side reads

---

## ORM / Query Method

**No ORM** — raw Supabase JS client with typed queries. The app uses:
- `supabase.from('table').select(...)` for reads
- `supabase.from('table').insert/update/upsert(...)` for writes
- Direct `pg` driver for some migration scripts
- TypeScript interfaces in `src/types.ts` for type safety

---

## API Architecture

- **115 API route files** under `app/api/`
- Next.js App Router format (`route.ts` with exported `GET`, `POST`, `PUT`, `DELETE`, `PATCH`)
- Authentication enforced via `middleware.ts` (NextAuth session checks)
- Role-based access control (RBAC) via `src/lib/rbac/`
- Feature-level permissions via `employee_feature_permissions` table

---

## HRIS Modules Identified

### 1. Employee Directory
- **Table:** `global_master_list`
- **Routes:** `/api/employees`, `/api/employee-master-record`, `/api/add-employee`, `/api/delete-employee`, `/api/suspend-employee`
- **Features:** CSV/Google Sheets import, department filtering, profile photos, alternate work emails, off-boarding flags

### 2. Payroll & Compensation
- **Tables:** `employee_hourly_rates`, `employee_rate_history`, `hubstaff_hours`, `hubstaff_uploads`, `payment_dispatches`, `disbursement_records`
- **Routes:** `/api/payroll-wizard/*`, `/api/payroll-current-pay`, `/api/payment-dispatches/*`, `/api/hubstaff-hours`, `/api/employee-hourly-rates*`
- **Features:** Hubstaff CSV import, rate history with mid-cycle prorating, dispatch logging, FX (USD↔PHP), Reports tab, dispatch lock (Realtime)

### 3. HSL Bonus Program (Hogan Smith Law)
- **Tables:** `hsl_team_members`, `hsl_agent_uploads`, `hsl_bonus_period_status`
- **Routes:** `/api/hsl-bonus/*`
- **Features:** 13 department KPI configurations, weekly/monthly periods, sub-team scoring (BLUE/GREEN/YELLOW/ORANGE/PURPLE/RED), tiered/per-unit/flat/team-split bonus rules

### 4. PAB Disputes (Payroll Accuracy Board)
- **Table:** `pab_disputes` (+ orphanage dispute overlay)
- **Routes:** `/api/pab-disputes/*`
- **Features:** Employee-filed disputes, manager-submitted orphanage disputes (two-stage Alyson→Carla approval), calendar date picker with existing-dispute overlay

### 5. Onboarding & HR Pipeline
- **Tables:** `hr_pending_employees`, `hr_onboarding_submissions`
- **Routes:** `/api/hr/pending-employees/*`, `/api/hr/onboarding-submissions/*`, `/api/onboarding/[token]/*`
- **Features:** Token-based public form, W-8BEN upload, payment method selection, workspace webhook (n8n), promote-to-active pipeline

### 6. Employee Self-Service Portal
- **Tables:** `employee_ids`, `employee_skill_sets`, `employee_notifications`, `fpu_enrollments`
- **Routes:** `/api/employee/*`, `/api/employee-ids`, `/api/employee-skill-sets`
- **Features:** Bank detail self-update, profile/skills, rate change notifications, FPU enrollment, paystub viewing

### 7. Contractor Management
- **Tables:** `contractor_profiles`, `contractor_invoices`
- **Routes:** `/api/contractor/*`
- **Features:** Multi-processor payment profiles (Hurupay/WePay/HiGlobe/Wise/Wire), invoice generation

### 8. Leave Management
- **Table:** `leave_requests`
- **Routes:** `/api/leave-requests/*`
- **Features:** Leave requests, manager approval, department-scoped manager visibility

### 9. Gift & Anniversary Program
- **Tables:** `gift_catalog`, `gift_payments`, `employee_gift_shipping_details`, `gift_tracker_notes`
- **Routes:** `/api/gift-catalog`, `/api/gift-payments`, `/api/employee-gift-shipping/*`, `/api/gift-tracker-notes`
- **Features:** Milestone tracking, shipping detail collection, batch payment records

### 10. Orphanage Program
- **Tables:** `orphanage_budget_requests`, `orphanage_dispatches`, PAB dispute overlay
- **Routes:** `/api/orphanage-budget-requests/*`, `/api/orphanage-dispatches`, `/api/orphanage-disputes/*`
- **Features:** Budget request submission, approval workflow, bank payment dispatch, visit disputes

### 11. S-Wall (Social Feed)
- **Tables:** `swall_posts`, `swall_reactions`, `swall_comments`
- **Routes:** `/api/swall/*`
- **Features:** Posts, emoji reactions (6 types), comments, Realtime updates, image uploads

### 12. Announcements
- **Table:** `announcements`
- **Routes:** `/api/announcements/*`
- **Features:** General + department-scoped announcements, pinning, Realtime, CEO role

### 13. Roles & Permissions
- **Tables:** `employee_roles`, `employee_feature_permissions`
- **Routes:** `/api/employee-roles`, `/api/employee-feature-permissions`
- **Roles:** viewer, hr_coordinator, payroll_coordinator, payroll_manager, finance, admin, manager, orphanage_manager, ceo
- **Features:** Fine-grained tab-level access overlay, force-logout on revoke

### 14. Department Management
- **Tables:** `department_managers`, `department_transfer_requests`
- **Routes:** `/api/department-managers/*`, `/api/department-transfers/*`, `/api/departments`
- **Features:** Manager-to-department assignment, transfer request workflow

### 15. Presence / My Team
- **Table:** `user_presence`, `manager_team_wallpapers`, `employee_skill_sets`
- **Routes:** `/api/presence/*`, `/api/manager/*`
- **Features:** Live online badge (Supabase Realtime), team wallpaper, member notes, medals/commendations

### 16. Offboarding
- **Tables:** `offboarded_sheet`, `global_master_list` (off_boarded_* columns)
- **Routes:** `/api/hr/offboard`, `/api/hr/offboard-history`
- **Features:** Google Sheets sync match by Personal Email, date-stamped, reonboard capability

---

## External Integrations

| Integration | Purpose |
|-------------|---------|
| Google OAuth | Authentication (NextAuth) |
| Google Sheets | Master list sync, rates sync, HSL agent sync, offboarded sync |
| Google Cloud (Service Account) | Sheets API service account |
| Hubstaff | Time-tracking CSV export → import |
| n8n Webhook | Workspace account creation for new hires |
| Hurupay / WePay / HiGlobe / Wise / Wire | Payment processors |
| Vercel | Hosting + cron jobs |
| Gemini AI | AI features (rate not confirmed) |

---

## Frontend Pages

| Route | Role | Description |
|-------|------|-------------|
| `/` | All | Home / landing |
| `/login` | Public | Google OAuth sign-in |
| `/employee` | Employee | Self-service portal |
| `/manager` | Manager | Team management |
| `/hr` | HR Coordinator | Hiring pipeline, master list |
| `/accounting` | Finance/Payroll | Payroll wizard, dispatch, reports |
| `/admin` | Admin | User roles, settings |
| `/ceo` | CEO | Overview dashboard |
| `/orphanage` | Orphanage Manager | Budget, visits, dispatches |
| `/contractor` | Contractor | Profile, invoices |
| `/payroll-clerk` | Payroll Coordinator | Payroll processing |
| `/onboarding/[token]` | Public | New hire form (tokenized) |
| `/auth-callback` | System | OAuth redirect handler |

---

## Seed & Migration Files

| Count | Type |
|-------|------|
| 77 | SQL migration/seed files in `references/` |
| ~789 | Employee records in `seed_global_master_list.sql` |
| ~431 | Rate records in `seed_employee_hourly_rates.sql` |
| ~1025 | Address records in `seed_global_master_list_addresses.sql` |
| ~12 | US employee records in `seed_us_global_master_list.sql` |
| ~80 | HSL team members in `seed_hsl_team_members.sql` |

---

## Environment Variables Required

```
GEMINI_API_KEY
APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_SUPABASE_EMPLOYEES_TABLE
NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE
NEXT_PUBLIC_SUPABASE_EMPLOYEE_HOURLY_RATES_TABLE
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
NEXTAUTH_SECRET
NEXTAUTH_URL
```
