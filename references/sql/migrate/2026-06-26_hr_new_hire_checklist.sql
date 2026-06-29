-- ============================================================================
-- HR New Hire Checklist  (2026-06-26, migration #90)
--
-- A standalone, spreadsheet-style tracking grid for the HR dashboard's new
-- "New Hire Checklist" tab. HR pastes columns of values straight from a
-- spreadsheet — one column at a time (Names, Personal Email, Location, Phone
-- Number, Date of Interview, Source, Hired By, Department, Country) — locks
-- them in with Save, and later drives a department-scoped "Bulk Invite" in the
-- onboarding Generate-link flow off these rows. (Start Date is intentionally
-- omitted — it's owned by the Onboarding section.)
--
-- This is a FREE-FORM intake sheet, deliberately decoupled from
-- hr_pending_employees / global_master_list. Every data column is plain TEXT so
-- a paste never fails on formatting (dates may arrive as "1/5/26", "Jan 5",
-- etc.). `position` preserves the grid's row order across save / reload.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.hr_new_hire_checklist (
  id                uuid        primary key default gen_random_uuid(),
  position          int         not null default 0,
  name              text,
  personal_email    text,
  location          text,
  phone_number      text,
  date_of_interview text,
  source            text,
  hired_by          text,
  department        text,
  country           text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- `country` segregates hires into per-country boxes in the onboarding Bulk
-- Invite. Added via ALTER too so an already-created table picks it up on re-run.
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS country text;

-- Start Date is owned by the Onboarding section, not this checklist. Drop it so
-- a table created by an earlier version of this migration converges (no-op on a
-- fresh create above, which never adds the column).
ALTER TABLE public.hr_new_hire_checklist
  DROP COLUMN IF EXISTS start_date;

-- Grid order is (position, created_at); department scoping powers Bulk Invite.
CREATE INDEX IF NOT EXISTS hr_new_hire_checklist_position_idx
  ON public.hr_new_hire_checklist (position, created_at);
CREATE INDEX IF NOT EXISTS hr_new_hire_checklist_department_idx
  ON public.hr_new_hire_checklist (lower(department));

-- Bump updated_at on every UPDATE (created_at stays immutable).
CREATE OR REPLACE FUNCTION public.hr_new_hire_checklist_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hr_new_hire_checklist_touch ON public.hr_new_hire_checklist;
CREATE TRIGGER hr_new_hire_checklist_touch
  BEFORE UPDATE ON public.hr_new_hire_checklist
  FOR EACH ROW EXECUTE FUNCTION public.hr_new_hire_checklist_touch_updated_at();

COMMIT;

-- Verify:
--   SELECT count(*) FROM public.hr_new_hire_checklist;
--   SELECT lower(department) AS dept, count(*) FROM public.hr_new_hire_checklist
--     GROUP BY 1 ORDER BY 1;
