-- Migration: employee_skill_sets
-- Created: 2026-05-28
--
-- Per-employee profile fields shown on the Employee Profile (editable by
-- self) and on the My Team tab (read-only for teammates). One row per work
-- email, lower-cased and trimmed by the normalize trigger.
--
-- Fields:
--   role_title           - curated role/title shown on My Team
--   currently_working_on - short status of what the employee is focused on now
--   skills               - free-form list / paragraph of technical skills
--   strengths            - free-form list / paragraph of strengths
--   member_notes         - free-form notes the employee wants to share
--
-- Idempotent: rerunning is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_skill_sets (
  work_email           TEXT PRIMARY KEY,
  role_title           TEXT NOT NULL DEFAULT '',
  currently_working_on TEXT NOT NULL DEFAULT '',
  skills               TEXT NOT NULL DEFAULT '',
  strengths            TEXT NOT NULL DEFAULT '',
  member_notes         TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lowercase the email and bump updated_at on every write.
CREATE OR REPLACE FUNCTION public.employee_skill_sets_normalize()
RETURNS TRIGGER AS $$
BEGIN
  NEW.work_email := LOWER(TRIM(NEW.work_email));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ess_normalize ON public.employee_skill_sets;
CREATE TRIGGER trg_ess_normalize
  BEFORE INSERT OR UPDATE ON public.employee_skill_sets
  FOR EACH ROW EXECUTE FUNCTION public.employee_skill_sets_normalize();

COMMIT;
