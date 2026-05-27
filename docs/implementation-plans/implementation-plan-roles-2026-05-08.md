# Implementation Plan: HR / Accounting Role Refactor (2026-05-08)

> **Goal:** Implement the 6-role HR/Accounting permission model defined in the
> stakeholder spec. Each role maps to a precise set of tabs, dashboard surfaces,
> and write capabilities. This plan extends the existing RBAC system in
> `src/lib/rbac/` rather than replacing it — most plumbing is already in place.

---

## 1. Source of truth

The roles and permissions in this plan come from the stakeholder doc dated
2026-05-08 ("Roles and Permissions for HR/Accounting System"). The mapping
below is canonical — UI gates and DB role inserts MUST match this table.

| # | Stakeholder Role | DB role key (proposed) | Sample owner | Primary surface |
|---|---|---|---|---|
| 1 | Accounting Manager | `accounting_manager` | Carla T, Claire | Full Accounting + Rates |
| 2 | Recruitment Manager | `recruitment_manager` | Teal | HR Dashboard (limited) |
| 3 | Accounting Specialist (Comms) | `comms_specialist` | TBD | Inbox / triage |
| 4 | Payroll Clerk | `payroll_clerk` | Lenny (current) | Payroll Wizard only |
| 5 | Credentials Clerk | `credentials_clerk` | TBD | Onboarding promotion + email automation |
| 6 | Disputes & Audit Clerk | `audit_clerk` | TBD | Reports tab in Payment Dispatch |

Three of these (`payroll_clerk` rough equivalent, `credentials_clerk`,
`recruitment_manager`) overlap conceptually with existing roles
(`payroll_coordinator`, `hr_coordinator`) but the scopes diverge enough that
**we should add new roles** rather than overload the old ones.

---

## 2. Current state (what's already built)

| Capability | Status | File |
|---|---|---|
| Role-aware view switching (`employee` / `accounting` / `hr` / etc.) | ✅ | `src/lib/rbac/views.ts` |
| Per-role accounting-tab allow-list | ✅ | `src/lib/rbac/accounting-tabs.ts` |
| HR view gate (admin + hr_coordinator only) | ✅ | `views.ts:57` |
| `employee_roles` DB table + CHECK constraint | ✅ | applied via `references/grant_manager_roles.sql` |
| Sidebar role filtering | ✅ partial | `src/components/Sidebar.tsx`, `HrSidebar.tsx` |
| Master List rate-redaction toggle | ❌ Not built | needed for Recruitment Manager |
| Pending-hires "promote" button gating | ❌ Not gated | currently any HR-view user can promote |
| Per-feature button-level gating inside Payroll Wizard | ❌ Not built | needed for Payroll Clerk vs Manager |
| "Reports section" of Payment Dispatch as standalone tab | ❌ Not built | needed for Audit Clerk |

Existing roles to keep: `admin`, `viewer`, `hr_coordinator`,
`payroll_coordinator`, `payroll_manager`, `finance`, `manager`,
`orphanage_manager`, `ceo`. The 6 new roles **add to** that list.

---

## 3. Permission matrix (target state)

Cells: **F** = full read+write, **R** = read-only, **L** = read-limited (no rates / redacted),
**P** = perform action, **—** = no access.

| Resource / Surface | Acct Mgr | Recruit Mgr | Comms Spec | Payroll Clerk | Credentials Clerk | Audit Clerk |
|---|---|---|---|---|---|---|
| **HR Overview** (active roster) | F | L (no rates) | — | — | F | — |
| **HR Onboarding** (pending hires) | F | F (add/edit only) | — | — | F (incl. promote) | — |
| **HR Offboarding** (active + history) | F | F (incl. restore) | — | — | F | — |
| **HR Leaves** | F | F | — | — | — | — |
| **Accounting Overview** | F | — | — | — | — | — |
| **Rates** tab | F | — | — | — | — | — |
| **Payroll Wizard** (steps 1–5) | F | — | — | F | — | — |
| **Payroll Wizard → Dispatch** (step 6) | F (Lenny-out backup) | — | — | F | — | — |
| **Payment Dispatch** | F | — | — | F | — | R (Reports only) |
| **Disputes / Bonuses queue** | F | — | — | — | — | F |
| **Announcements / S-Wall** | F | F | F | F | F | F |
| **System Settings** | F | — | — | — | — | — |
| **Comms inbox** (TBD) | R | — | F | — | — | — |
| **Email/credential automation** | R | — | — | — | F | — |

> The **Promote** privilege intentionally lives only with `credentials_clerk`
> (and `admin` / `accounting_manager` as fallback). Recruitment Manager can
> create the pending row but cannot promote it — matches the stakeholder spec's
> "Cannot promote potential employees to the Master List".

---

## 4. Phased plan

### Phase 0 — Schema (1 migration)

**File to create:** `references/expand_role_check_constraint_2026_05_08.sql`

```sql
-- Widen the employee_roles_role_check CHECK constraint to allow the 6 new roles.
ALTER TABLE public.employee_roles
  DROP CONSTRAINT IF EXISTS employee_roles_role_check;

ALTER TABLE public.employee_roles
  ADD  CONSTRAINT employee_roles_role_check
  CHECK (role IN (
    'viewer',
    'hr_coordinator',
    'payroll_coordinator',
    'payroll_manager',
    'finance',
    'admin',
    'manager',
    'orphanage_manager',
    'ceo',
    -- new 2026-05-08
    'accounting_manager',
    'recruitment_manager',
    'comms_specialist',
    'payroll_clerk',
    'credentials_clerk',
    'audit_clerk'
  ));
```

Idempotent: drops first, then re-adds with the full list. Re-run safe.

**Add to `pending_sql.md`** as migration #30 with the standard "PENDING /
CONFIRMED" pattern this project uses.

### Phase 1 — Type system

**File:** `src/lib/rbac/views.ts`

```ts
export type Role =
  | 'viewer' | 'hr_coordinator' | 'payroll_coordinator' | 'payroll_manager'
  | 'finance' | 'admin' | 'manager' | 'orphanage_manager' | 'ceo'
  // new 2026-05-08
  | 'accounting_manager'
  | 'recruitment_manager'
  | 'comms_specialist'
  | 'payroll_clerk'
  | 'credentials_clerk'
  | 'audit_clerk';
```

Add the new roles to `ACCOUNTING_ROLES` only where they grant accounting-view
access:

```ts
const ACCOUNTING_ROLES: Role[] = [
  'payroll_coordinator', 'payroll_manager', 'finance', 'hr_coordinator', 'viewer',
  'accounting_manager',  // NEW: full access
  'payroll_clerk',       // NEW: scoped to Wizard only
  'audit_clerk',         // NEW: scoped to Reports
];
```

Update `viewsForRoles`:

```ts
// HR view: existing admin/hr_coordinator + new recruitment_manager + credentials_clerk
if (
  roles.includes('admin') ||
  roles.includes('hr_coordinator') ||
  roles.includes('recruitment_manager') ||
  roles.includes('credentials_clerk') ||
  roles.includes('accounting_manager')
) set.add('hr');
```

**File:** `src/lib/rbac/accounting-tabs.ts`

Refactor `allowedAccountingTabsForRoles` from a single
"FULL_ACCOUNTING_ACCESS_ROLES" set into a per-role override map:

```ts
const ROLE_TAB_ALLOWLIST: Partial<Record<Role, AccountingTabId[]>> = {
  payroll_clerk: ['overview', 'payroll-wizard'],
  audit_clerk:   ['overview', 'payment-dispatch'],   // dispatch tab gates the Reports sub-section internally
  // existing payroll_manager scoped list unchanged
};
```

Then walk `roles` and union the resulting sets, falling back to
`[...ACCOUNTING_TAB_IDS]` for fully-privileged roles
(`admin`, `accounting_manager`, `finance`, `payroll_coordinator`,
`hr_coordinator`, `viewer`).

### Phase 2 — HR sidebar role filtering

**File:** `src/components/hr/HrSidebar.tsx`

`HrTab` currently is `'overview' | 'onboarding' | 'offboarding' | 'leaves' | 's-wall'`.
Add a `rolesByTab` map and filter `navBtn` rendering:

```ts
const HR_TAB_ROLES: Record<HrTab, Role[]> = {
  overview:   ['admin', 'accounting_manager', 'hr_coordinator', 'recruitment_manager', 'credentials_clerk'],
  onboarding: ['admin', 'accounting_manager', 'hr_coordinator', 'recruitment_manager', 'credentials_clerk'],
  offboarding:['admin', 'accounting_manager', 'hr_coordinator', 'recruitment_manager', 'credentials_clerk'],
  leaves:     ['admin', 'accounting_manager', 'hr_coordinator'],
  's-wall':   ['admin', 'accounting_manager', 'hr_coordinator', 'recruitment_manager', 'credentials_clerk', 'comms_specialist'],
};
```

The `recruitment_manager` will see Overview / Onboarding / Offboarding but
**not Leaves** — Leaves is HR-coordinator-and-above per the spec.

### Phase 3 — Master List rate redaction (Recruitment Manager view)

The HR Overview's active roster table currently shows columns: Name · Dept ·
Work email · Personal email · Location · Start date · Tenure. **No rate columns
exist there yet** — the rate-redaction concern in the spec is specifically for
the Master List view (`Rates` tab in Accounting), which Recruitment Manager
shouldn't see at all.

**Action:** Confirm that no HR-side surface ever renders rate data. Audit the
following call sites:

- `src/components/hr/HrApp.tsx` (OverviewBody) — currently renders no rate. ✓
- `src/components/hr/HrOffboarding.tsx` — renders no rate. ✓
- `src/components/hr/HrOnboarding.tsx` — pending-hires table shows
  `regular_rate / ot_rate` columns. **Hide these for `recruitment_manager`.**

**File:** `src/components/hr/HrOnboarding.tsx`

Pass a `viewerRoles: Role[]` prop (or pull from a hook) and conditionally
render the Rate column header + cells when `viewerRoles.includes('recruitment_manager')`
and **none** of the higher roles are present.

A small helper:

```ts
function viewerCanSeeRates(roles: Role[]): boolean {
  if (roles.includes('admin') || roles.includes('accounting_manager') || roles.includes('hr_coordinator')) return true;
  return !roles.includes('recruitment_manager');
}
```

### Phase 4 — Promotion privilege

**File:** `app/api/hr/pending-employees/[id]/promote/route.ts`

Currently allows any elevated session. Add role check:

```ts
const PROMOTE_ROLES: Role[] = ['admin', 'accounting_manager', 'credentials_clerk'];
if (!authz.roles.some((r) => PROMOTE_ROLES.includes(r as Role))) {
  return NextResponse.json({ error: 'Forbidden — promotion requires Credentials Clerk role' }, { status: 403 });
}
```

**File:** `src/components/hr/HrOnboarding.tsx`

Hide the "Promote" button when the viewer is `recruitment_manager`-only.
Replace with a tooltip: *"Awaiting credentials clerk to promote"*. The
Set-Work-Email and Cancel actions remain available.

### Phase 5 — Restore (re-onboard) gating

Per the spec, Recruitment Manager **can** restore off-boarded workers.
Currently `app/api/hr/reonboard/route.ts` allows any elevated session.

**Action:** Widen `RESTORE_ROLES` to include `recruitment_manager`:

```ts
const RESTORE_ROLES: Role[] = ['admin', 'accounting_manager', 'hr_coordinator', 'recruitment_manager', 'credentials_clerk'];
```

### Phase 6 — Payroll Clerk vs Accounting Manager scoping

`payroll_clerk` should see **only** Overview + Payroll Wizard tabs in the
Accounting sidebar. Already covered by `ROLE_TAB_ALLOWLIST` in Phase 1.

Inside the Payroll Wizard itself, no additional gating is needed —
`payroll_clerk` runs the wizard end-to-end (matches stakeholder spec: "Solely
responsible for running the Payroll Wizard").

### Phase 7 — Audit Clerk: Reports-only access

This requires the most surgery because **the Reports sub-section currently
lives inside Payment Dispatch as a tab toggle**, not a top-level tab.

**Option A — Surface as separate top-level tab (recommended):**

1. Add `'reports'` to `ACCOUNTING_TAB_IDS` in `accounting-tabs.ts`
2. Add a `Reports` nav entry to `Sidebar.tsx`
3. Extract the Reports panel from `PayrollDispatch.tsx` into its own
   component `src/components/payroll-clerk/PaymentReports.tsx`
4. Wire a new `case 'reports'` in `App.tsx` `renderContent`
5. Scope `audit_clerk` to `['overview', 'reports', 'disputes']`

**Option B — Keep nested but hard-gate Payment Dispatch entry mode:**

When the viewer is `audit_clerk`-only, force the Payment Dispatch component
to mount in "reports" mode and hide the dispatch action buttons.

Option A is cleaner, more discoverable, and matches the stakeholder mental
model ("a Report section under Payment Dispatch" → really wants its own
discoverable surface).

### Phase 8 — Disputes & Bonuses ownership

The existing **PAB Dispute Queue** (`disputes` tab → `PabDisputeQueue`) is
where pay-discrepancy research happens. Grant `audit_clerk` access:

```ts
ROLE_TAB_ALLOWLIST.audit_clerk = ['overview', 'reports', 'disputes'];
```

The Bonuses & Incentives view is the calculator panel inside
`PayrollWizard` step 3 ("Additions") — this is **not** accessible to
`audit_clerk` per the matrix above. The spec's "calculating bonuses"
responsibility means *researching* bonuses, not editing them. They view
results via Reports + Disputes.

### Phase 9 — Comms Specialist (deferred)

The "Comms Specialist" role handles a comms inbox that **does not yet exist
in the codebase**. Three options:

1. **Defer** — flag as future work, ship the role with view access only.
2. **Reuse Announcements** — grant access to compose announcements + reply
   to S-Wall comments. Closest fit to the existing surfaces.
3. **Build dedicated inbox** — separate scope, not part of this rollout.

Recommendation: ship with option 2 for v1. The role exists, it sees
Announcements + S-Wall, and we revisit option 3 once the comms-volume
problem is real.

### Phase 10 — Admin Roles & Permissions UI

**File:** `src/components/admin/AdminRoles.tsx`

The existing role assignment dropdown reads from a hardcoded `ROLES` array.
Extend with the 6 new entries + display labels:

```ts
const ROLES: { value: Role; label: string; description: string }[] = [
  // existing rows...
  { value: 'accounting_manager',  label: 'Accounting Manager',  description: 'Full Accounting + Rates + can run Payroll Wizard.' },
  { value: 'recruitment_manager', label: 'Recruitment Manager', description: 'HR Onboarding/Offboarding (no rates, no promote).' },
  { value: 'comms_specialist',    label: 'Comms Specialist',    description: 'Triages inbox / Announcements / S-Wall.' },
  { value: 'payroll_clerk',       label: 'Payroll Clerk',       description: 'Runs the Payroll Wizard.' },
  { value: 'credentials_clerk',   label: 'Credentials Clerk',   description: 'Promotes hires + email/password automation.' },
  { value: 'audit_clerk',         label: 'Disputes & Audit Clerk', description: 'Disputes queue + Reports section only.' },
];
```

### Phase 11 — Tests / verification matrix

For each new role, log in (or impersonate via `?email=` query param) and verify:

| Test | Expected |
|---|---|
| `accounting_manager` sees every Accounting + HR tab | ✅ all visible |
| `recruitment_manager` opens `/accounting` | redirect to `/hr` |
| `recruitment_manager` opens HR → Onboarding | sees rows, **no rate column**, no Promote button |
| `recruitment_manager` POSTs to `/api/hr/pending-employees/[id]/promote` | 403 |
| `payroll_clerk` opens `/accounting` | sees Overview + Payroll Wizard only |
| `audit_clerk` opens `/accounting` | sees Overview + Reports + Disputes |
| `audit_clerk` opens Payment Dispatch via direct URL | 403 or redirect |
| `credentials_clerk` clicks Promote | succeeds |
| `comms_specialist` opens HR → S-Wall | sees feed, can post |

---

## 5. File-by-file change summary

| File | Change | Phase |
|---|---|---|
| `references/expand_role_check_constraint_2026_05_08.sql` | NEW migration | 0 |
| `src/lib/rbac/views.ts` | Extend `Role` type + `viewsForRoles` | 1 |
| `src/lib/rbac/accounting-tabs.ts` | Per-role tab allowlist map | 1 |
| `src/components/hr/HrSidebar.tsx` | Role-filtered nav buttons | 2 |
| `src/components/hr/HrOnboarding.tsx` | Hide Rate column + Promote button when `recruitment_manager`-only | 3, 4 |
| `app/api/hr/pending-employees/[id]/promote/route.ts` | 403 unless `credentials_clerk`/`admin`/`accounting_manager` | 4 |
| `app/api/hr/reonboard/route.ts` | Widen role allow-list | 5 |
| `src/components/Sidebar.tsx` | Add Reports nav entry | 7 |
| `src/components/payroll-clerk/PaymentReports.tsx` | NEW (extract from `PayrollDispatch`) | 7 |
| `src/App.tsx` | New `case 'reports'` | 7 |
| `src/components/admin/AdminRoles.tsx` | Add 6 dropdown entries | 10 |
| `docs/llm-context.md` | Update role list | 10 |
| `pending_sql.md` (memory) | Add migration #30 entry | 0 |

Total: ~12 file changes + 1 SQL migration + 1 new component.

---

## 6. Rollout order

1. **Day 1** — Run Phase 0 migration; add new roles to `views.ts` and
   `accounting-tabs.ts`. No UI gating yet — system silently accepts the new
   role values without giving them anything yet.
2. **Day 2** — Phases 2–5 (HR-side gating: sidebar filter, rate redaction,
   promote/restore APIs).
3. **Day 3** — Phases 6–8 (Accounting-side: Payroll Clerk + Audit Clerk
   surfaces, Reports tab extraction).
4. **Day 4** — Phase 10 (Admin Roles UI), Phase 11 (verification).
5. **Day 5** — Assign actual humans to roles in `employee_roles`. Ship.

Phase 9 (Comms inbox) is parked unless v2 scope is approved.

---

## 7. Open questions for stakeholders

1. **Restore privilege for Recruitment Manager** — the spec says they can
   restore but not promote. Confirmed?  ➜ Phase 5 assumes yes.
2. **Accounting Manager vs Admin** — should `accounting_manager` literally
   equal `admin` minus System Settings? Plan currently says yes.
3. **Audit Clerk in Disputes** — spec says they "research pay discrepancies"
   — does that imply read+write on the dispute queue (approve/deny) or
   read-only? Plan currently grants full write.
4. **Comms Specialist** — accept v1 = Announcements + S-Wall, or block
   ship until a dedicated inbox is built?
5. **Backup-when-Lenny-is-out behavior** — should we add an explicit
   `dispatch_backup` flag in Settings, or is it OK that
   `accounting_manager` always retains dispatch privileges? Plan currently
   assumes the latter.

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| New roles assigned in DB before code ships → app silently grants whatever the highest matching legacy role gives | Apply Phase 0 migration **after** Phases 1–10 deploy. |
| `recruitment_manager` sees rates because of an overlooked surface | Phase 11 test grid + grep for `regular_rate \| ot_rate` in HR tree before merge. |
| Payroll Clerk can navigate to Reports via deep-link | Tab allow-list also gates `App.tsx` `canAccessAccountingTab` redirect, not just sidebar render. |
| Constraint widening fails because legacy rows have an unknown role | The constraint additions only ADD values to the allow list, never remove — DROP/ADD pattern is safe. |

---

## 9. Reference

- Stakeholder spec: "Roles and Permissions for HR/Accounting System"
  (2026-05-08, in conversation transcript).
- Existing RBAC plan: `docs/implementation-plan-rbac.md`.
- HR dashboard plan: `docs/implementation-plan-hr-dashboard.md`.
- Role check constraint precedent: `references/grant_manager_roles.sql`.

---

## 2026-05-15 Delta — Feature Permissions Overlay (implemented)

Coarse role grants like `finance` now layer a **per-tab access overlay** on top so admins can give someone "see the Accounting view but only Edit the Rates tab; everything else is hidden."

### Storage
- New table `employee_feature_permissions` (migration `references/create_employee_feature_permissions.sql`, pending #43).
- Three-state model: missing row = `hidden`, plus `'view'` and `'edit'` enum values.

### Catalog
`src/lib/rbac/feature-permissions.ts → FEATURE_CATALOG` enumerates the tabs per view:
- **accounting** — overview, rates, payroll_wizard, payment_dispatch, disputes, announcements, s_wall, settings
- **hr** — overview, onboarding, offboarding, leaves, gift_tracker, mesa, s_wall, notifications
- **manager** — overview, time_adjustments, leaves, team, announcements, s_wall, hsl_bonus, bonus_history, notifications
- **orphanage** — overview, queue, budget, budget_history, s_wall, notifications
- **ceo** — overview, announcements, s_wall, notifications
- **contractor** — overview, profile, invoices

`ROLE_TO_FEATURE_VIEW` maps each assignable role to its catalog view; `admin` deliberately has no entry (full-access bypass).

### JWT integration
- `auth-options.ts` jwt callback now fetches the user's perms on sign-in (`fetchFeaturePermissionsForEmail`) and stashes them on the token as `featurePerms`.
- Session exposes `session.user.featurePerms`.

### Enforcement
- `allowedAccountingTabsForUser(roles, perms)` and `canAccessAccountingTabForUser(tab, roles, perms)` in `src/lib/rbac/accounting-tabs.ts` filter the accounting sidebar nav.
- Wired into `App.tsx` (Accounting shell) — fetches roles + perms in parallel and feeds both into the gating functions.
- **Not yet wired** into HR/Manager/Orphanage/CEO/Contractor sidebars. Those apps still show all their tabs regardless of perms; the picker UI records the choices but the nav doesn't filter yet. Follow-up.

### Admin UI
- `AdminRoles.tsx` shows a Hidden / View / Edit radio grid below each granted role card whose dashboard has a feature catalog.
- Every click POSTs to `/api/employee-feature-permissions`, refreshes local state, and force-logs out the affected user so their next page load picks up the new perm set.
- **Self-edit skip**: when the admin is editing their own row, both the feature-permissions POST and the role-revoke force-logout endpoint skip the bump (`POST /api/auth/force-logout` returns `{ skipped: 'self' }`). Without this, the admin's own JWT got wiped on the first click and every subsequent click 403'd.

### Force-logout machinery
- `auth.force_logout_map` in `app_settings` — JSON map of `{ email: ISO-timestamp }`.
- `bumpForceLogoutFor(email)` in `src/lib/auth/force-logout.ts` writes the stamp (30-day TTL, auto-pruned).
- `getForceLogoutEpochFor(email)` reads the stamp, cached in-memory for 30s.
- `auth-options.ts` jwt callback returns `{}` (empty token) when the user's stamp ≥ token `iat`.
- `middleware.ts` rejects tokens with no `email` and no `sub`, redirecting to `/login`.
- Triggered on: role revoke (`AdminRoles → toggleRole`), every feature-permission write.
- Suppressed on: self-edits (both endpoints).

### Open follow-ups
- Wire the Hidden/View/Edit filter into the HR / Manager / Orphanage / CEO / Contractor sidebar nav items (mechanical work across each `*App.tsx` + `*Sidebar.tsx` pair).
- Build the `useFeatureAccess(view, feature)` client hook so individual components (Rates edit button, PayrollWizard run button, Payment Dispatch send button, etc.) can gate their mutation controls when access is `view`. Currently access defaults to `edit` for any visible tab.
