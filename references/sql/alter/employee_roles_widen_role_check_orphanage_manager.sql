-- Allow `orphanage_manager` on employee_roles (ViewSwitcher + Orphanage queue RBAC).
-- Without this, POST /api/employee-roles with role=orphanage_manager fails with
-- check constraint violation (Supabase returns 500).
--
-- Keeps the same pattern as grant_manager_roles.sql.

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
    'manager',
    'orphanage_manager'
  ));
