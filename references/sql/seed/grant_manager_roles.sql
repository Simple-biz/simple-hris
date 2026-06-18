-- ============================================================
-- Grant the new `manager` role to Carla and Kane.
--
-- The DB has a CHECK constraint (`employee_roles_role_check`)
-- that limits role values to the original 6. We widen it to
-- include 'manager' first, then INSERT.
--
-- - carla@simple.biz — Carla T (HSL/payroll lead, per the
--   2026-04-29 meeting notes)
-- - kaner@simple.biz — Kane R (developer building the system)
--
-- 'manager' is NOT in ELEVATED_ROLES, so this grant does NOT
-- give org-wide read access — it just exposes the /manager
-- view in the sidebar's view switcher and lets them reach
-- /manager directly.
--
-- Idempotent: skips if an active assignment already exists.
-- ============================================================

-- ── 1. Widen the CHECK constraint to allow 'manager' ──
ALTER TABLE public.employee_roles
  DROP CONSTRAINT IF EXISTS employee_roles_role_check;

ALTER TABLE public.employee_roles
  ADD CONSTRAINT employee_roles_role_check
  CHECK (role IN (
    'viewer',
    'hr_coordinator',
    'payroll_coordinator',
    'payroll_manager',
    'finance',
    'admin',
    'manager'
  ));

-- ── 2. Grant the role ──
INSERT INTO public.employee_roles (work_email, role, assigned_by)
SELECT v.email, 'manager', 'system (manager dashboard rollout)'
FROM (VALUES
  ('carla@simple.biz'),
  ('kaner@simple.biz')
) AS v(email)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.employee_roles r
  WHERE LOWER(r.work_email) = LOWER(v.email)
    AND r.role = 'manager'
    AND r.revoked_at IS NULL
);

-- ── 3. Verify ──
SELECT work_email, role, assigned_by, assigned_at, revoked_at
FROM public.employee_roles
WHERE LOWER(work_email) IN ('carla@simple.biz', 'kaner@simple.biz')
  AND role = 'manager'
ORDER BY work_email;
