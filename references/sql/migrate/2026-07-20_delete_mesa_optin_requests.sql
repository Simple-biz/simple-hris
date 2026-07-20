-- ============================================================================
-- MESA: delete opt-in request rows — use the opt-in date as the record  (2026-07-20)
--
-- Opt-in through the HRIS creates a row in `mesa_requests` (request_type =
-- 'opt_in'). A member can submit opt-in more than once (re-joining, or
-- correcting details), so these rows duplicate — e.g. kaner@simple.biz has two.
-- The authoritative record of "when someone joined MESA" is the enrollment date
-- on their rates row (employee_hourly_rates.mesa_member_since), NOT these
-- request rows. The Employee → MESA → Past requests table now derives a single
-- "Opt-in" line from that date (see src/components/employee/EmployeeMesa.tsx),
-- so the raw opt_in rows are redundant.
--
-- This one-time cleanup removes them. Run once in the Supabase SQL editor.
--
-- NOTE: the DELETE below removes ALL opt_in rows, including any *pending* opt-in
-- from someone not yet enrolled (an in-flight join HR hasn't processed). If you
-- want to keep those and only clear opt-ins for people who have already joined,
-- use the "enrolled-only" variant at the bottom instead.
-- ============================================================================

-- Preview BEFORE running (how many opt_in rows, and for whom):
--   SELECT work_email, count(*) AS opt_in_rows
--     FROM public.mesa_requests
--    WHERE request_type = 'opt_in'
--    GROUP BY work_email
--    ORDER BY opt_in_rows DESC, work_email;

BEGIN;

DELETE FROM public.mesa_requests
 WHERE request_type = 'opt_in';

COMMIT;

-- Verify AFTER running (expect 0):
--   SELECT count(*) FROM public.mesa_requests WHERE request_type = 'opt_in';

-- ── Enrolled-only variant (safer — keeps pending joins) ─────────────────────
-- Deletes opt_in rows ONLY for members who are already enrolled, leaving
-- pending opt-ins for HR to still act on. Use INSTEAD OF the DELETE above.
--
--   BEGIN;
--   DELETE FROM public.mesa_requests mr
--    WHERE mr.request_type = 'opt_in'
--      AND EXISTS (
--            SELECT 1
--              FROM public.employee_hourly_rates ehr
--             WHERE lower(trim(ehr."Work Email")) = lower(trim(mr.work_email))
--               AND ehr.mesa_member = true
--          );
--   COMMIT;
