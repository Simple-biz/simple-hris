-- ============================================================
-- public.department_managers
--
-- Maps a manager (work_email) to one or more departments. Used by the
-- leave-request approval flow so any single department manager can clear
-- a request. Decoupled from `employee_roles` on purpose:
--   - holding the `manager` role doesn't imply oversight of any specific
--     department; an explicit row in this table grants that.
--   - a single manager can cover multiple departments.
--
-- Department values must match the `Department` column in
-- `global_master_list` (case-insensitive). The leave-request resolver
-- compares with LOWER(trim(...)) on both sides.
--
-- Idempotent: re-running this script is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.department_managers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_email   TEXT NOT NULL,
  department      TEXT NOT NULL,
  assigned_by     TEXT,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  CONSTRAINT department_managers_email_dept_unique UNIQUE (manager_email, department)
);

CREATE INDEX IF NOT EXISTS department_managers_email_idx
  ON public.department_managers (LOWER(manager_email))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS department_managers_department_idx
  ON public.department_managers (LOWER(department))
  WHERE revoked_at IS NULL;

-- Sanity: surface active rows.
SELECT manager_email, department, assigned_at
FROM public.department_managers
WHERE revoked_at IS NULL
ORDER BY manager_email, department;
