-- ============================================================
-- Assign Kane R — kaner@simple.biz — as department manager for
-- Client VA + AI/API Team only (matches global_master_list "Department" strings).
--
-- Idempotent; skips pairs that already exist as active (revoked_at IS NULL).
-- Run in Supabase SQL after department_managers table exists.
-- ============================================================

INSERT INTO public.department_managers (manager_email, department, assigned_by)
SELECT trim(lower(v.manager)), trim(v.dept), 'references/department_managers_seed_kane_client_va_ai_api.sql'
FROM (VALUES
  ('kaner@simple.biz', 'Client VA'),
  ('kaner@simple.biz', 'AI/API Team')
) AS v(manager, dept)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.department_managers dm
  WHERE lower(trim(dm.manager_email)) = lower(trim(v.manager))
    AND dm.department = trim(v.dept)
    AND dm.revoked_at IS NULL
);

SELECT dm.manager_email, dm.department, dm.assigned_at
FROM public.department_managers dm
WHERE lower(trim(dm.manager_email)) = 'kaner@simple.biz'
  AND dm.revoked_at IS NULL
ORDER BY dm.department;
