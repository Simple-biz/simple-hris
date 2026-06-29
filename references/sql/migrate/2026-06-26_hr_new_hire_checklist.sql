-- ============================================================================
-- HR New Hire Checklist  (2026-06-26, migration #90)
--
-- A standalone, spreadsheet-style tracking grid for the HR dashboard's new
-- "New Hire Checklist" tab. HR pastes columns of values straight from a
-- spreadsheet — one column at a time (Names, Personal Email, Location, Phone
-- Number, Date of Interview, Source, Hired By, Department, Country, Sources) — locks
-- them in with Save, and later drives a department-scoped "Bulk Invite" in the
-- onboarding Generate-link flow off these rows. (Start Date is intentionally
-- omitted — it's owned by the Onboarding section.)
--
-- This is a FREE-FORM intake sheet, deliberately decoupled from
-- hr_pending_employees / global_master_list. Every data column is plain TEXT so
-- a paste never fails on formatting (dates may arrive as "1/5/26", "Jan 5",
-- etc.). `position` preserves the grid's row order across save / reload.
--
-- Each row is scoped to a Sun–Sat pay week via `period_start` (the week's
-- Sunday). A header period selector switches weeks; the grid preloads that
-- week's rows. `hr_new_hire_checklist_periods` is a STANDALONE lock table (not
-- tied to any bonus/payroll lock): "Lock in" saves the week's rows + flips it
-- to 'locked'; "Reopen" flips it back to 'open' for editing.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.hr_new_hire_checklist (
  id                uuid        primary key default gen_random_uuid(),
  -- The Sun–Sat pay week this hire belongs to, anchored on its SUNDAY
  -- (YYYY-MM-DD). The grid is scoped to one period at a time and the period
  -- selector switches weeks. NULL only for legacy rows (backfilled below).
  period_start      date,
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
  sources           text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- `country` segregates hires into per-country boxes in the onboarding Bulk
-- Invite. Added via ALTER too so an already-created table picks it up on re-run.
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS country text;

-- `sources` — free-text "where did we get this hire from" (a separate column
-- from the existing `source`). Added via ALTER so an already-created table
-- picks it up on re-run.
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS sources text;

-- `period_start` scopes each row to a Sun–Sat week (added via ALTER too so an
-- already-created table picks it up on re-run).
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS period_start date;

-- Backfill legacy rows (created before periods existed) onto the CURRENT week's
-- Sunday so they stay visible. extract(dow) is 0 for Sunday, so this rewinds
-- today to the Sunday that starts its week.
UPDATE public.hr_new_hire_checklist
   SET period_start = (current_date - (extract(dow from current_date))::int)
 WHERE period_start IS NULL;

-- Start Date is owned by the Onboarding section, not this checklist. Drop it so
-- a table created by an earlier version of this migration converges (no-op on a
-- fresh create above, which never adds the column).
ALTER TABLE public.hr_new_hire_checklist
  DROP COLUMN IF EXISTS start_date;

-- Grid order is (period_start, position, created_at); department scoping powers
-- Bulk Invite.
CREATE INDEX IF NOT EXISTS hr_new_hire_checklist_period_idx
  ON public.hr_new_hire_checklist (period_start, position, created_at);
CREATE INDEX IF NOT EXISTS hr_new_hire_checklist_department_idx
  ON public.hr_new_hire_checklist (lower(department));

-- ── Per-period lock (its own table — NOT tied to any bonus/payroll lock) ──────
-- "Lock in" freezes a week's rows; "Reopen" flips it back to 'open' for edits.
CREATE TABLE IF NOT EXISTS public.hr_new_hire_checklist_periods (
  period_start date        primary key,
  period_end   date,
  status       text        not null default 'open' check (status in ('open','locked')),
  locked_at    timestamptz,
  locked_by    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

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

DROP TRIGGER IF EXISTS hr_new_hire_checklist_periods_touch ON public.hr_new_hire_checklist_periods;
CREATE TRIGGER hr_new_hire_checklist_periods_touch
  BEFORE UPDATE ON public.hr_new_hire_checklist_periods
  FOR EACH ROW EXECUTE FUNCTION public.hr_new_hire_checklist_touch_updated_at();

COMMIT;

-- Verify:
--   SELECT period_start, count(*) FROM public.hr_new_hire_checklist
--     GROUP BY 1 ORDER BY 1 DESC;
--   SELECT * FROM public.hr_new_hire_checklist_periods ORDER BY period_start DESC;
--   SELECT lower(department) AS dept, count(*) FROM public.hr_new_hire_checklist
--     GROUP BY 1 ORDER BY 1;
