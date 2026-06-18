-- Adds a free-typed "Projects" capability to employee_skill_sets (2026-05-29).
--
-- `projects`         — the full list of project names an employee has added
--                      (their personal list, no fixed catalog).
-- `current_projects` — the 1–2 they are currently working on, in display order.
--                      Rendered joined with " and " (e.g. "Gridline Billing
--                      System and Simple HRIS") on the employee + manager
--                      My Team views.
--
-- The legacy free-text `currently_working_on` column is kept as a display
-- fallback for rows that have not picked projects yet.
ALTER TABLE public.employee_skill_sets
  ADD COLUMN IF NOT EXISTS projects JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS current_projects JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.employee_skill_sets.projects IS
  'Free-typed list of project names the employee has added (no fixed catalog).';
COMMENT ON COLUMN public.employee_skill_sets.current_projects IS
  'The 1-2 projects the employee is currently on, in display order; joined with " and ".';
