-- ============================================================================
-- global_master_list: correct Sheen Gobalani's canonical Work Email.
-- Generated: 2026-06-15
--
-- WHO
--   Kyle Sheen "Sheen" Gobalani  -- Accounting Team, Start Date 2026-03-30,
--   employee_id 2603-0042, row id 0e5a77da-456c-4e31-9009-5eb58fa824f3.
--
-- WHY
--   Her master row carries a vestigial primary Work Email `shannong@simple.biz`,
--   while every operational system keys her on `sheeng@simple.biz`:
--     * Hubstaff reports her hours under sheeng@simple.biz (every weekly upload),
--     * employee_hourly_rates stores her rate (PHP 260 / OT 390) under sheeng,
--     * sheeng@simple.biz currently sits in her *Alternate* Work Email slot.
--   The Tech Bonus 30-day-service gate resolves `start_date` by the master's
--   primary Work Email / Personal Email, so her start date never matched the
--   email her hours + rates use. Result: she was wrongly excluded from the
--   PHP 1,850 Technology Bonus despite >30 days of service (eligible 2026-04-29).
--
-- SAFETY
--   `shannong@simple.biz` is referenced NOWHERE else -- no other master row,
--   no employee_ids, no employee_hourly_rates, no hubstaff_hours, no onboarding
--   row. `sheeng@simple.biz` is used by no other employee as a primary Work
--   Email, so the active (lower(Work Email), lower(Department)) unique index
--   (global_master_list_work_email_dept_uniq) will not collide.
--   The swap is non-lossy (old value preserved as the alternate) and reversible.
--   active_employees is a plain view over global_master_list, so it reflects
--   this automatically -- no refresh needed.
--
-- NOTE
--   If the source MASTERLIST Google Sheet still lists shannong@simple.biz as her
--   work email, a future sheet sync could re-introduce it. Update the Sheet too
--   so this correction is durable.
--
-- IDEMPOTENT: re-running is a no-op once applied (the WHERE no longer matches).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) PRE-CHECK -- expect exactly one row, Work Email = shannong@simple.biz.
-- ----------------------------------------------------------------------------
SELECT id, "Name", "Department", "Work Email", "Alternate Work Email",
       "Personal Email", "Start Date"
FROM   public.global_master_list
WHERE  "Personal Email" = 'gobalanik@gmail.com';

-- ----------------------------------------------------------------------------
-- 1) Promote her real address to primary; keep the old one as alternate.
-- ----------------------------------------------------------------------------
UPDATE public.global_master_list
SET    "Work Email"           = 'sheeng@simple.biz',
       "Alternate Work Email" = 'shannong@simple.biz'
WHERE  "Work Email"     = 'shannong@simple.biz'
  AND  "Personal Email" = 'gobalanik@gmail.com'
  AND  "Department"     = 'Accounting Team';

-- ----------------------------------------------------------------------------
-- VERIFY -- expect Work Email = sheeng@simple.biz, Alternate = shannong@simple.biz.
-- ----------------------------------------------------------------------------
SELECT "Name", "Work Email", "Alternate Work Email", "Personal Email", "Start Date"
FROM   public.global_master_list
WHERE  "Personal Email" = 'gobalanik@gmail.com';

-- ----------------------------------------------------------------------------
-- ROLLBACK -- restore the original (wrong) primary if needed.
-- ----------------------------------------------------------------------------
-- UPDATE public.global_master_list
-- SET    "Work Email"           = 'shannong@simple.biz',
--        "Alternate Work Email" = 'sheeng@simple.biz'
-- WHERE  "Work Email"     = 'sheeng@simple.biz'
--   AND  "Personal Email" = 'gobalanik@gmail.com'
--   AND  "Department"     = 'Accounting Team';
