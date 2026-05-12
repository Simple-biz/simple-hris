-- Adds the manager-side orientation-attendance gate on hr_pending_employees.
-- HR can no longer promote a hire to global_master_list until the assigned
-- department's manager has marked orientation_attended_at via the Manager
-- Dashboard → My Team → Newly Hired tab.
--
-- Idempotent: safe to re-run.

alter table public.hr_pending_employees
  add column if not exists orientation_attended_at timestamptz,
  add column if not exists orientation_attended_by text,
  add column if not exists orientation_note        text;

comment on column public.hr_pending_employees.orientation_attended_at is
  'Set by the assigned department manager via /api/manager/pending-hires/[id]/orientation. Null = orientation not yet confirmed; HR promote API refuses to run while null.';
comment on column public.hr_pending_employees.orientation_attended_by is
  'Email of the manager who marked orientation. Sourced from department_managers; the API verifies the caller manages the hire''s department.';
comment on column public.hr_pending_employees.orientation_note is
  'Optional free-text from the manager (e.g. "showed up day 2 only"). Visible in the HR onboarding row.';

-- Speeds up the manager dashboard query: "show every pending hire in any of
-- my departments that has not been promoted/cancelled."
create index if not exists hr_pending_employees_dept_status_idx
  on public.hr_pending_employees (department, status);
