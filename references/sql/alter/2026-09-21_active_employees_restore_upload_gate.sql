-- ============================================================================
-- REVERT of 2026-09-21_active_employees_drop_upload_gate.sql
--
-- Kane, 2026-09-21: "just make sure to document this incase we need to flip the
-- switch." This is that switch for step 5.
--
-- Restores the sheet-presence gate: a person drops off the roster the moment
-- they are absent from the current master-sheet upload, whether or not anyone
-- ever offboarded them.
--
-- WHAT COMES BACK WITH IT
--   Anyone active but NOT on the current upload disappears from every surface
--   that reads active_employees (~40 of them: payroll, dispatch, gifts, leave,
--   notifications, team roster, contractor queue). On 2026-09-21 that was 508
--   rows; after the reconcile it is the ~51-row residue — the 7 live people
--   absent from the sheet and the 41 HR could not classify.
--
--   It does NOT un-stamp anybody. The corpses and leavers stamped by
--   scripts/reconcile-gml-active-only.mts stay stamped; to undo those, use
--   references/backups/2026-09-21-gml-reconcile/revert-plan.csv, which names
--   every id with the values it held before.
--
--   It does NOT restore the transfer-fork behaviour either — that lives in
--   src/lib/roster/sheet-assignment.ts and is reverted with its own commit.
--
-- This file is the exact definition that was live from
-- recreate_active_employees_expose_phone_location.sql until 2026-09-21.
-- ============================================================================

CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE last_seen_upload_id = (
    SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
  )
  AND off_boarded_at IS NULL;

ALTER VIEW public.active_employees SET (security_invoker = false);

-- Verify: the two should now DIFFER again by the un-synced residue.
SELECT
  (SELECT count(*) FROM public.active_employees)                                AS active_employees,
  (SELECT count(*) FROM public.global_master_list WHERE off_boarded_at IS NULL) AS unstamped_rows;
