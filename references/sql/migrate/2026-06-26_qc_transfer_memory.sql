-- ============================================================================
-- QC transfer memory + per-department scoring slots  (2026-06-26, migration #89)
--
-- The QC roster changes weekly and people get transferred between departments.
-- Two needs:
--   1. A person transferred mid-week (e.g. Leadgen → Callback) should be able to
--      be scored in BOTH departments for the transition week → up to 2 KPI
--      bonuses, each tagged to its source dept. That needs the per-week
--      uniqueness to be (period, member, DEPARTMENT) instead of (period, member).
--   2. Transferred / removed people must stay in the week's QC roster so their
--      Leadgen score & bonus stand (the Payroll Wizard already sums KPI by person
--      across departments, so the payout itself is never lost). `roster_status`
--      + `current_department` remember where they went.
--
-- Run AFTER 2026-06-26_qc_role_and_tables.sql (#88). Idempotent + guarded: a
-- no-op if #88 hasn't run yet, and safe to re-run.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.qc_score_assignments') IS NULL THEN
    RAISE NOTICE 'qc_score_assignments missing — run 2026-06-26_qc_role_and_tables.sql (#88) first, then re-run this.';
    RETURN;
  END IF;

  -- Roster lifecycle for the week + where the person is NOW (for display +
  -- "transferred to Callback" context). Existing rows default to 'active'.
  ALTER TABLE public.qc_score_assignments
    ADD COLUMN IF NOT EXISTS roster_status text NOT NULL DEFAULT 'active';
  ALTER TABLE public.qc_score_assignments
    ADD COLUMN IF NOT EXISTS current_department text;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qc_score_assignments_roster_status_check'
  ) THEN
    ALTER TABLE public.qc_score_assignments
      ADD CONSTRAINT qc_score_assignments_roster_status_check
      CHECK (roster_status IN ('active', 'transferred', 'removed'));
  END IF;

  -- Widen the per-week uniqueness: (period, member) → (period, member, department).
  -- Existing data satisfies the wider key (the old key was stricter), so this is
  -- a safe swap. The auto-named inline constraint from #88 is
  -- qc_score_assignments_period_start_member_email_key.
  ALTER TABLE public.qc_score_assignments
    DROP CONSTRAINT IF EXISTS qc_score_assignments_period_start_member_email_key;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'qc_score_assignments_period_member_dept_key'
  ) THEN
    ALTER TABLE public.qc_score_assignments
      ADD CONSTRAINT qc_score_assignments_period_member_dept_key
      UNIQUE (period_start, member_email, department);
  END IF;
END $$;

-- Verify:
--   SELECT period_start, department, roster_status, count(*)
--   FROM public.qc_score_assignments GROUP BY 1,2,3 ORDER BY 1 DESC, 2;
