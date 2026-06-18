-- ============================================================================
-- Roles = dashboard access only  (2026-06-18)
--
-- Model: assign a DASHBOARD (role); each dashboard's tabs are provisioned
-- per-user as view/edit/hidden (default-deny). Assigning a dashboard role
-- auto-provisions its tabs to `edit` in code (employee-roles grant route); this
-- migration BACKFILLS that for everyone who already holds a dashboard role so
-- they aren't stuck on Overview.
--
-- Also renames `finance` -> `accounting` and retires the legacy non-dashboard
-- roles viewer / payroll_coordinator / payroll_manager (their powers — dispute
-- approve/delete, dispatch lock, leave delete — were folded into `accounting`).
--
-- ⚠️ RUN ORDER: DEPLOY THE NEW CODE FIRST, THEN RUN THIS.
--    The old deployed code only recognizes 'finance'; renaming rows to
--    'accounting' before the new code is live locks Accounting users out.
--    After running, affected users self-heal within ~60s (JWT role refresh),
--    or sign out/in for an instant refresh.
-- ============================================================================

BEGIN;

-- 0. Widen the role CHECK constraint to allow `accounting`. Keep the legacy
--    values too so soft-deleted history rows (revoked_at set) stay valid — the
--    app's VALID_ROLES is what actually blocks new assignment of legacy roles.
ALTER TABLE public.employee_roles
  DROP CONSTRAINT IF EXISTS employee_roles_role_check;

ALTER TABLE public.employee_roles
  ADD CONSTRAINT employee_roles_role_check
  CHECK (role IN (
    'admin', 'ceo', 'hr_coordinator', 'accounting',
    'manager', 'orphanage_manager', 'contractor',
    -- legacy (history only; not assignable in the app anymore):
    'finance', 'payroll_coordinator', 'payroll_manager', 'viewer'
  ));

-- 1. Rename finance -> accounting on ACTIVE rows (preserves Accounting access).
UPDATE employee_roles
SET    role = 'accounting'
WHERE  role = 'finance'
  AND  revoked_at IS NULL;

-- 2. Preserve Accounting access for the one real person who had it ONLY via a
--    retired role: ellyt@ had read-only 'viewer'. (No read-only tier now, so
--    this grants full `accounting`. Delete this block if ellyt shouldn't have it.)
INSERT INTO employee_roles (work_email, role, assigned_by)
SELECT 'ellyt@simple.biz', 'accounting', 'roles-dashboard-only-migration'
WHERE NOT EXISTS (
  SELECT 1 FROM employee_roles
  WHERE work_email ILIKE 'ellyt@simple.biz' AND role = 'accounting' AND revoked_at IS NULL
);

-- 3. Retire the legacy non-dashboard roles (soft-delete).
UPDATE employee_roles
SET    revoked_at = now()
WHERE  role IN ('viewer', 'payroll_coordinator', 'payroll_manager')
  AND  revoked_at IS NULL;

-- 4. Backfill per-tab permissions for every dashboard-role holder who has NONE
--    yet for that dashboard (the "stuck on Overview" cases). All tabs = edit;
--    admins can dial back afterward. Users who already have ANY perm for the
--    dashboard are left untouched (their customization is preserved).
INSERT INTO employee_feature_permissions (work_email, view_key, feature, access, granted_by)
SELECT lower(er.work_email), v.view_key, f.feature, 'edit', 'roles-backfill'
FROM employee_roles er
JOIN (VALUES
  ('manager','manager'),
  ('hr_coordinator','hr'),
  ('accounting','accounting'),
  ('orphanage_manager','orphanage'),
  ('ceo','ceo'),
  ('contractor','contractor')
) AS v(role, view_key) ON v.role = er.role
JOIN LATERAL (
  SELECT feature FROM (VALUES
    -- manager
    ('manager','overview'),('manager','time_adjustments'),('manager','leaves'),
    ('manager','team'),('manager','announcements'),('manager','s_wall'),
    ('manager','hsl_bonus'),('manager','bonus_history'),('manager','notifications'),
    -- hr
    ('hr','overview'),('hr','onboarding'),('hr','offboarding'),('hr','leaves'),
    ('hr','transfers'),('hr','gift_tracker'),('hr','mesa'),('hr','announcements'),
    ('hr','s_wall'),('hr','notifications'),
    -- accounting
    ('accounting','overview'),('accounting','rates'),('accounting','payroll_wizard'),
    ('accounting','bonus_catalog'),('accounting','payment_dispatch'),('accounting','disputes'),
    ('accounting','mesa'),('accounting','announcements'),('accounting','notifications'),
    ('accounting','s_wall'),('accounting','settings'),
    -- orphanage
    ('orphanage','overview'),('orphanage','queue'),('orphanage','budget'),
    ('orphanage','budget_history'),('orphanage','s_wall'),('orphanage','notifications'),
    -- ceo
    ('ceo','overview'),('ceo','announcements'),('ceo','s_wall'),('ceo','notifications'),
    -- contractor
    ('contractor','overview'),('contractor','profile'),('contractor','invoices')
  ) AS cat(view_key, feature)
  WHERE cat.view_key = v.view_key
) AS f ON true
WHERE er.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM employee_feature_permissions p
    WHERE lower(p.work_email) = lower(er.work_email)
      AND p.view_key = v.view_key
      AND p.revoked_at IS NULL
  );

COMMIT;

-- ----------------------------------------------------------------------------
-- ⚑ MANUAL FOLLOW-UP (NOT done by this script):
--   alivia@simple.biz and alissa@simple.biz held ONLY the retired roles and
--   look like stale DUPLICATES of the admin accounts aliviah@ / alissar@.
--   After this migration they have no elevated roles. Confirm: DELETE the
--   duplicates, or grant them a dashboard role if they're real people.
--
-- Verify:
--   SELECT role, count(*) FROM employee_roles WHERE revoked_at IS NULL
--   GROUP BY role ORDER BY role;
--   -- expect only: accounting, admin, ceo, contractor, hr_coordinator,
--   --              manager, orphanage_manager
-- ----------------------------------------------------------------------------
