# Implementation Plan: Role-Based Access Control (RBAC)

> **Goal**: Introduce authentication, roles, and granular permissions so that every action in Simple HRIS — viewing rates, editing profiles, uploading Hubstaff CSVs, changing the exchange rate, dispatching payroll — is gated by a user's assigned role.

---

## 1. Current State (No Auth)

| Area | Status |
|---|---|
| Authentication | None. No login screen, no sessions, no middleware. |
| User identity | Hardcoded `"Fran M / Senior Admin"` in `src/components/Sidebar.tsx:96-100` and `src/constants.ts:6`. |
| API route protection | Zero. All 12 routes are publicly accessible. |
| Supabase RLS | Bypassed — the app uses the **service role key** for most writes. Anon key is used for reads but no RLS policies are configured for row-level filtering by user. |
| Audit trail | None. No record of who did what. |

---

## 2. Proposed Role Hierarchy

Six roles, ordered from most restricted to most privileged:

| Role | Who | Primary Purpose |
|---|---|---|
| **Viewer** | New hires, trainees | Read-only access to the Overview dashboard and employee directory. Cannot see pay rates, bank info, or payroll figures. |
| **HR Coordinator** | HR team members | Add and edit employee profiles (name, department, emails, start date). Cannot touch rates, payroll, or settings. |
| **Payroll Coordinator** | Payroll processors | Upload Hubstaff CSVs, run the PayrollWizard through Step 4 (pre-flight). Cannot dispatch, delete employees, or change rates. |
| **Payroll Manager** | Payroll leads | Everything a Coordinator can do, plus: edit hourly rates, apply/modify bonuses, change the USD-to-PHP exchange rate, dispatch payroll (Step 5). |
| **Finance** | Finance / accounting | View all rates and payroll totals. Update the exchange rate. Cannot add/delete employees or upload hours. |
| **Admin** | System administrators | Full access: all of the above, plus delete employees, import daily reports, manage user accounts and role assignments, access System Settings. |

### Permission Matrix

Each cell: **C** = Create, **R** = Read, **U** = Update, **D** = Delete, **X** = Execute (trigger action), **--** = no access, **$** = sensitive financial data.

| Resource / Action | Viewer | HR Coord | Payroll Coord | Payroll Mgr | Finance | Admin |
|---|---|---|---|---|---|---|
| **Overview dashboard** | R | R | R | R | R | R |
| **Employee directory** (names, dept, emails, start date) | R | R | R | R | R | R |
| **Employee profiles** (add / edit name, dept, email, date) | -- | C R U | R | R | R | C R U D |
| **Employee delete** | -- | -- | -- | -- | -- | D |
| **Hourly rates** (regular + OT) | -- | -- | R | R U$ | R$ | R U$ |
| **Rate profiles** (merged multi-table view) | -- | R | R | R$ | R$ | R$ |
| **Bank info & addresses** | -- | -- | -- | R$ | R$ | R$ |
| **Hubstaff CSV upload** (Step 1) | -- | -- | X | X | -- | X |
| **Replace / re-upload hours** | -- | -- | X | X | -- | X |
| **Initial calculation** (Step 2) | -- | -- | R | R | R | R |
| **Department bonuses** (Step 3 — assign, toggle, input metrics) | -- | -- | R | R U X | R | R U X |
| **Pre-flight validation** (Step 4) | -- | -- | R | R | R | R |
| **Dispatch payroll** (Step 5) | -- | -- | -- | X | -- | X |
| **USD-to-PHP exchange rate** | -- | -- | -- | U | U | U |
| **Import daily report** | -- | -- | -- | -- | -- | X |
| **Hogan cycle toggle** | -- | -- | X | X | -- | X |
| **System Settings page** | -- | -- | -- | -- | -- | R U |
| **User management** (invite, assign roles) | -- | -- | -- | -- | -- | C R U D |
| **Audit log** | -- | -- | -- | R | R | R |

---

## 3. Supabase Tables to Add

### 3.1 `auth.users` (built-in)

Supabase Auth handles sign-up, login, password reset, and JWT issuance out of the box. No custom table needed for credentials.

### 3.2 `public.user_profiles`

Extends the Supabase auth user with HRIS-specific fields.

```sql
CREATE TABLE public.user_profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer'
              CHECK (role IN ('viewer','hr_coordinator','payroll_coordinator','payroll_manager','finance','admin')),
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, full_name, role)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), 'viewer');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- RLS: users can read their own profile; admins can read/update any profile
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON public.user_profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Admins can read all profiles"
  ON public.user_profiles FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can update any profile"
  ON public.user_profiles FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'admin')
  );
```

### 3.3 `public.audit_log`

Immutable append-only log of every mutation.

```sql
CREATE TABLE public.audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id),
  user_email  TEXT,
  user_role   TEXT,
  action      TEXT NOT NULL,       -- e.g. 'employee.create', 'rates.update', 'hubstaff.upload'
  resource    TEXT,                 -- e.g. 'employee_hourly_rates'
  resource_id TEXT,                 -- e.g. the employee email or row ID
  details     JSONB,               -- before/after snapshot or metadata
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS: only admins, payroll managers, and finance can read
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Privileged roles can read audit log"
  ON public.audit_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
        AND role IN ('admin', 'payroll_manager', 'finance')
    )
  );

-- Insert via service role only (from API routes)
CREATE POLICY "Service role can insert"
  ON public.audit_log FOR INSERT
  WITH CHECK (true);  -- guarded at API layer; service role bypasses RLS
```

---

## 4. Authentication Flow

### 4.1 Supabase Auth Integration

Use `@supabase/auth-helpers-nextjs` for cookie-based session management.

**New files to create:**

| File | Purpose |
|---|---|
| `src/lib/supabase/middleware.ts` | Next.js middleware — refreshes the session cookie on every request |
| `app/login/page.tsx` | Login page with email/password form |
| `src/lib/auth/get-user.ts` | Server helper: reads session → returns `{ user, profile, role }` |
| `src/lib/auth/require-role.ts` | Server helper: throws 403 if the user's role is insufficient |
| `src/hooks/useCurrentUser.ts` | Client hook: provides `{ user, profile, role, loading }` from Supabase auth state |

### 4.2 Login Page (`app/login/page.tsx`)

- Email + password form (Supabase `signInWithPassword`)
- Optional "Forgot password" link (Supabase `resetPasswordForEmail`)
- Redirect to `/` on success
- No self-registration — Admin creates accounts via the User Management page

### 4.3 Middleware (`middleware.ts` at project root)

```
matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|login).*)"]
```

- Refreshes the Supabase session cookie
- If no session, redirect to `/login`
- If session exists, allow the request to proceed
- API routes (`/api/*`) return 401 JSON instead of redirecting

### 4.4 Replace Hardcoded User

| Current | Replacement |
|---|---|
| `Sidebar.tsx:96-100` — `"Fran M"`, `"Senior Admin"`, `"FM"` avatar | Read from `useCurrentUser()` hook: `profile.full_name`, `profile.role`, initials derived from name |
| `src/constants.ts:6` — `MOCK_USERS` array | Remove or gate behind `NODE_ENV === 'development'` |
| `PayrollWizard.tsx:3097` — toast `"Opening secure preview for Fran M..."` | Use `profile.full_name` from context |
| Sign Out button (Sidebar, no handler) | Call `supabase.auth.signOut()` → redirect to `/login` |

---

## 5. API Route Protection

Every API route gets a permission guard. Two server-side helpers make this consistent:

### `src/lib/auth/get-user.ts`

```typescript
// Returns the authenticated user + profile, or null
export async function getAuthUser(req: Request): Promise<{
  user: User;
  profile: UserProfile;
} | null>
```

### `src/lib/auth/require-role.ts`

```typescript
// Throws NextResponse(403) if the user doesn't have one of the allowed roles
export async function requireRole(
  req: Request,
  ...allowedRoles: Role[]
): Promise<{ user: User; profile: UserProfile }>
```

### Per-Route Permissions

| Route | Method | Minimum Role | Notes |
|---|---|---|---|
| `/api/employees` | GET | `viewer` | All roles can see the directory |
| `/api/employee-hourly-rates` | GET | `payroll_coordinator` | Rates are sensitive — viewers and HR cannot see |
| `/api/employee-rate-profiles` | GET | `hr_coordinator` | HR can see profiles (no rates); payroll+ sees rates too |
| `/api/employee-ids` | GET | `viewer` | ID mappings are non-sensitive |
| `/api/hubstaff-hours` | GET | `payroll_coordinator` | Hours data |
| `/api/hubstaff-hours` | POST | `payroll_coordinator` | Upload/replace hours |
| `/api/add-employee` | POST | `hr_coordinator` | HR can add employees |
| `/api/delete-employee` | DELETE | `admin` | Only admins can permanently delete |
| `/api/update-employee-rates` | POST | `payroll_manager` | Only payroll managers+ can touch rates |
| `/api/update-employee-profile` | POST | `hr_coordinator` | HR can edit profile fields (not rates) |
| `/api/app-settings` | GET | `payroll_coordinator` | Read exchange rate for display |
| `/api/app-settings` | POST | `payroll_manager` | Only payroll managers+ can change the rate |
| `/api/import-daily-report` | POST | `admin` | DDL operation — admin only |

### Audit Logging

Every mutation route (POST, DELETE) writes to `public.audit_log` after a successful operation:

```typescript
await auditLog({
  userId: user.id,
  userEmail: user.email,
  userRole: profile.role,
  action: 'rates.update',
  resource: 'employee_hourly_rates',
  resourceId: workEmail,
  details: { before: { regularRate: oldRate }, after: { regularRate: newRate } },
});
```

---

## 6. Client-Side Permission Gating

### 6.1 `useCurrentUser` Hook

Provides `{ user, profile, role, loading, can }` to all components.

```typescript
const { user, profile, role, can } = useCurrentUser();

// Helper: checks if the current user's role is in the allowed list
can('payroll_manager', 'admin')  // → boolean
```

### 6.2 UI Element Gating

Elements are hidden or disabled based on role. Examples:

| Component | Element | Gate |
|---|---|---|
| `Sidebar.tsx` | "Payroll Wizard" nav item | `can('payroll_coordinator', 'payroll_manager', 'admin')` |
| `Sidebar.tsx` | "System Settings" nav item | `can('admin')` |
| `Rates.tsx` | "Add New Employee" button | `can('hr_coordinator', 'admin')` |
| `Rates.tsx` | Delete (trash) icon per row | `can('admin')` |
| `Rates.tsx` | Quick Rate Editor "Edit" button | `can('payroll_manager', 'admin')` |
| `Rates.tsx` | Rate columns (Regular Rate, OT Rate) | `can('payroll_coordinator', 'payroll_manager', 'finance', 'admin')` — viewers and HR see `"--"` |
| `Overview.tsx` | "Total Payout" stat card | `can('payroll_coordinator', 'payroll_manager', 'finance', 'admin')` — viewers see `"Restricted"` |
| `PayrollWizard.tsx` | Step 1 upload button | `can('payroll_coordinator', 'payroll_manager', 'admin')` |
| `PayrollWizard.tsx` | Step 3 bonus toggles/inputs | `can('payroll_manager', 'admin')` — coordinators see read-only |
| `PayrollWizard.tsx` | Step 5 "Confirm & Dispatch" button | `can('payroll_manager', 'admin')` |
| `PayrollWizard.tsx` | Exchange rate input | `can('payroll_manager', 'finance', 'admin')` |

### 6.3 Redacted Fields

For roles that can see a view but not sensitive columns:

```typescript
// In the rates table
const showRates = can('payroll_coordinator', 'payroll_manager', 'finance', 'admin');
// ...
<TableCell>{showRates ? formatPHP(rate.regularRate) : '***'}</TableCell>
```

Bank info and addresses are only visible to `payroll_manager`, `finance`, and `admin`.

---

## 7. Supabase RLS Policies (Data Layer)

Even though the API layer enforces permissions, RLS policies act as a safety net at the database level.

### 7.1 `global_master_list`

```sql
ALTER TABLE global_master_list ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read
CREATE POLICY "Authenticated users can read employees"
  ON global_master_list FOR SELECT
  USING (auth.role() = 'authenticated');

-- HR coordinators + admins can insert/update
CREATE POLICY "HR and admins can modify employees"
  ON global_master_list FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('hr_coordinator', 'admin'))
  );

CREATE POLICY "HR and admins can update employees"
  ON global_master_list FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('hr_coordinator', 'admin'))
  );

-- Only admins can delete
CREATE POLICY "Only admins can delete employees"
  ON global_master_list FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'admin')
  );
```

### 7.2 `employee_hourly_rates`

```sql
ALTER TABLE employee_hourly_rates ENABLE ROW LEVEL SECURITY;

-- Payroll coordinators+ can read
CREATE POLICY "Payroll roles can read rates"
  ON employee_hourly_rates FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND role IN ('payroll_coordinator', 'payroll_manager', 'finance', 'admin')
    )
  );

-- Only payroll managers and admins can modify
CREATE POLICY "Payroll managers can modify rates"
  ON employee_hourly_rates FOR ALL
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role IN ('payroll_manager', 'admin'))
  );
```

### 7.3 `hubstaff_hours`

```sql
ALTER TABLE hubstaff_hours ENABLE ROW LEVEL SECURITY;

-- Payroll roles can read
CREATE POLICY "Payroll roles can read hours"
  ON hubstaff_hours FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND role IN ('payroll_coordinator', 'payroll_manager', 'finance', 'admin')
    )
  );

-- Upload (insert/delete) requires payroll coordinator+
-- Note: CSV upload uses service role (bypasses RLS) — this is a fallback
CREATE POLICY "Payroll roles can modify hours"
  ON hubstaff_hours FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND role IN ('payroll_coordinator', 'payroll_manager', 'admin')
    )
  );
```

### 7.4 `app_settings`

```sql
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read settings
CREATE POLICY "Authenticated users can read settings"
  ON app_settings FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only payroll managers, finance, and admins can update
CREATE POLICY "Managers can update settings"
  ON app_settings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM user_profiles WHERE id = auth.uid()
        AND role IN ('payroll_manager', 'finance', 'admin')
    )
  );
```

---

## 8. New UI: User Management Page

Accessible only to **Admin** role. Replaces the current "System Settings" placeholder.

### Features

1. **User table**: Full Name, Email, Role (dropdown), Status (active/disabled), Last Login
2. **Invite user**: Email + Name + Role selection → Supabase `admin.createUser()` or invite link
3. **Change role**: Dropdown per row → updates `user_profiles.role`
4. **Disable user**: Toggles Supabase auth user `banned` flag (prevents login without deleting data)
5. **Audit log viewer**: Filterable table showing recent mutations (who, what, when)

### Component Structure

```
src/components/Settings.tsx
  ├── UserManagement        (user table + invite form)
  ├── AuditLogViewer        (filterable log table)
  └── SystemConfig          (exchange rate, table names — future)
```

---

## 9. Implementation Phases

### Phase 1 — Foundation (Auth + Session)

| # | Task | Files |
|---|---|---|
| 1.1 | Install `@supabase/ssr` package | `package.json` |
| 1.2 | Create `user_profiles` table + trigger in Supabase SQL editor | Supabase dashboard |
| 1.3 | Create `audit_log` table in Supabase SQL editor | Supabase dashboard |
| 1.4 | Create `src/lib/auth/get-user.ts` — server-side session reader | New file |
| 1.5 | Create `src/lib/auth/require-role.ts` — role guard for API routes | New file |
| 1.6 | Create `src/hooks/useCurrentUser.ts` — client-side auth hook | New file |
| 1.7 | Create `middleware.ts` — session refresh + redirect to login | New file |
| 1.8 | Create `app/login/page.tsx` — email/password login form | New file |
| 1.9 | Replace hardcoded "Fran M" in `Sidebar.tsx` with `useCurrentUser()` | Edit existing |
| 1.10 | Wire Sign Out button to `supabase.auth.signOut()` | Edit existing |
| 1.11 | Seed the first Admin user via Supabase dashboard | Supabase dashboard |

**Outcome**: Users must log in. The sidebar shows their real name and role. Sign out works.

### Phase 2 — API Protection

| # | Task | Files |
|---|---|---|
| 2.1 | Add `requireRole()` guard to `GET /api/employee-hourly-rates` | Edit route |
| 2.2 | Add `requireRole()` guard to `POST /api/add-employee` | Edit route |
| 2.3 | Add `requireRole()` guard to `DELETE /api/delete-employee` | Edit route |
| 2.4 | Add `requireRole()` guard to `POST /api/update-employee-rates` | Edit route |
| 2.5 | Add `requireRole()` guard to `POST /api/update-employee-profile` | Edit route |
| 2.6 | Add `requireRole()` guard to `POST /api/hubstaff-hours` | Edit route |
| 2.7 | Add `requireRole()` guard to `POST /api/app-settings` | Edit route |
| 2.8 | Add `requireRole()` guard to `POST /api/import-daily-report` | Edit route |
| 2.9 | Add audit logging to all mutation routes | Edit all POST/DELETE routes |
| 2.10 | Migrate API routes from service-role to user-session Supabase client where possible | Edit `server.ts` + routes |

**Outcome**: API routes reject unauthorized requests with 403. All mutations are logged.

### Phase 3 — UI Gating

| # | Task | Files |
|---|---|---|
| 3.1 | Gate nav items in `Sidebar.tsx` by role | Edit existing |
| 3.2 | Gate "Add Employee" / "Delete" buttons in `Rates.tsx` | Edit existing |
| 3.3 | Gate rate columns in `Rates.tsx` (show `***` for unauthorized roles) | Edit existing |
| 3.4 | Gate Quick Rate Editor in `Rates.tsx` profile modal | Edit existing |
| 3.5 | Gate "Total Payout" card in `Overview.tsx` | Edit existing |
| 3.6 | Gate PayrollWizard Step 1 upload button | Edit existing |
| 3.7 | Gate PayrollWizard Step 3 bonus inputs (read-only for coordinators) | Edit existing |
| 3.8 | Gate PayrollWizard Step 5 dispatch button | Edit existing |
| 3.9 | Gate exchange rate input in PayrollWizard Step 2 | Edit existing |
| 3.10 | Redact bank info / addresses in profile modal for unauthorized roles | Edit existing |

**Outcome**: UI elements are hidden or read-only based on the user's role.

### Phase 4 — RLS + User Management

| # | Task | Files |
|---|---|---|
| 4.1 | Enable RLS on `global_master_list` + create policies | Supabase SQL |
| 4.2 | Enable RLS on `employee_hourly_rates` + create policies | Supabase SQL |
| 4.3 | Enable RLS on `hubstaff_hours` + create policies | Supabase SQL |
| 4.4 | Enable RLS on `app_settings` + create policies | Supabase SQL |
| 4.5 | Build `Settings.tsx` — User Management tab (user table, invite, role change) | New component |
| 4.6 | Build `Settings.tsx` — Audit Log Viewer tab | New component |
| 4.7 | Wire "System Settings" nav item to the new Settings component | Edit `App.tsx` |

**Outcome**: Database-level safety net in place. Admins can manage users and review audit trails.

### Phase 5 — Hardening

| # | Task | Files |
|---|---|---|
| 5.1 | Remove `MOCK_USERS` from `constants.ts` | Edit existing |
| 5.2 | Remove service-role key from client-accessible paths | Audit `.env` usage |
| 5.3 | Add rate-limiting to login route (Supabase built-in or custom) | Middleware |
| 5.4 | Add session timeout (configurable idle timeout) | `useCurrentUser` hook |
| 5.5 | Add password complexity requirements via Supabase Auth config | Supabase dashboard |
| 5.6 | Test all role combinations against every route and UI element | Manual + automated tests |

**Outcome**: Production-ready RBAC with no remaining security gaps.

---

## 10. File Change Summary

### New Files

| File | Purpose |
|---|---|
| `middleware.ts` | Session refresh + auth redirect |
| `app/login/page.tsx` | Login page |
| `src/lib/auth/get-user.ts` | Server: read session → user + profile + role |
| `src/lib/auth/require-role.ts` | Server: role guard for API routes |
| `src/lib/auth/audit.ts` | Server: write to `public.audit_log` |
| `src/hooks/useCurrentUser.ts` | Client: auth context hook |
| `src/components/Settings.tsx` | User Management + Audit Log viewer |

### Modified Files

| File | Change |
|---|---|
| `src/components/Sidebar.tsx` | Replace hardcoded user with `useCurrentUser()`, wire sign out, gate nav items |
| `src/components/Overview.tsx` | Gate "Total Payout" card |
| `src/components/Rates.tsx` | Gate add/delete/edit buttons, redact rate columns and bank info |
| `src/components/PayrollWizard.tsx` | Gate upload, bonus edits, exchange rate, dispatch |
| `src/App.tsx` | Wrap in auth provider, render Settings component for `settings` tab |
| `app/api/*/route.ts` (all 10 mutation routes) | Add `requireRole()` + audit logging |
| `src/lib/supabase/server.ts` | Add session-aware Supabase client factory |
| `src/constants.ts` | Remove or gate `MOCK_USERS` |
| `package.json` | Add `@supabase/ssr` |

### Supabase SQL Migrations

| Migration | Tables Affected |
|---|---|
| `001_create_user_profiles.sql` | Creates `user_profiles` + trigger |
| `002_create_audit_log.sql` | Creates `audit_log` |
| `003_enable_rls_employees.sql` | RLS on `global_master_list` |
| `004_enable_rls_rates.sql` | RLS on `employee_hourly_rates` |
| `005_enable_rls_hours.sql` | RLS on `hubstaff_hours` |
| `006_enable_rls_settings.sql` | RLS on `app_settings` |

---

## 11. Testing Checklist

For each role, verify:

- [ ] Login works, session persists across page reload
- [ ] Sidebar shows correct name, role, and only permitted nav items
- [ ] Overview dashboard: Total Payout shows/hides based on role
- [ ] Rates: Add/Delete/Edit buttons show/hide based on role
- [ ] Rates: Rate columns show values or `***` based on role
- [ ] Rates: Bank info and address fields redacted for unauthorized roles
- [ ] PayrollWizard: Upload button enabled/disabled based on role
- [ ] PayrollWizard: Bonus toggles/inputs are editable or read-only based on role
- [ ] PayrollWizard: Dispatch button enabled/disabled based on role
- [ ] Exchange rate input: editable or read-only based on role
- [ ] API routes return 403 for unauthorized roles
- [ ] Audit log captures all mutations with correct user info
- [ ] Sign out clears session and redirects to login
- [ ] Direct URL access to `/` without session redirects to `/login`
- [ ] Direct API call without session returns 401
