-- ============================================================================
-- active_employees: drop the sheet-presence gate. ONE definition of "active".
--
-- Kane, 2026-09-21: "There will be no Sheet anymore we arent syncing on that
-- sheet anymore we have our own Global Master List", and "I only want the
-- active people not the offboarded in the Global Master List".
--
-- WHY
--   The HRIS held TWO definitions of "active" and nothing compared them:
--     active_employees              = off_boarded_at IS NULL
--                                     AND last_seen_upload_id = (current upload)
--     the external API / Integrations = off_boarded_at IS NULL
--   They differed by 508 rows on 2026-09-21 (1,723 vs 1,215). That gap IS the
--   "OMS pulled 1667 not 1143" report. After this migration they are the same
--   query and cannot diverge again.
--
--   `last_seen_upload_id` SURVIVES as sync provenance. It simply stops deciding
--   who is on the roster.
--
-- *** DO NOT RUN THIS BEFORE THE DATA RECONCILE ***
--   scripts/reconcile-gml-active-only.mts must have run with --apply first.
--   Until it has, 483 rows (298 transfer corpses + 185 unstamped leavers) are
--   unstamped, and this migration would put every one of them in front of the
--   ~40 readers of active_employees at once.
--
--   The pre-flight below REFUSES to apply while that is true. It is not advice;
--   it raises.
--
-- REVERT: 2026-09-21_active_employees_restore_upload_gate.sql (paired, in this
--   same directory). Kane asked for a documented flip-back and that is it.
-- ============================================================================

-- ── Pre-flight: refuse if the reconcile has not run ─────────────────────────
-- A difference between "unstamped" and "unstamped AND on the current upload"
-- means dead rows are still live. Applying now would publish them.
DO $$
DECLARE
  unstamped   bigint;
  on_current  bigint;
  gap         bigint;
BEGIN
  SELECT count(*) INTO unstamped
  FROM public.global_master_list
  WHERE off_boarded_at IS NULL;

  SELECT count(*) INTO on_current
  FROM public.global_master_list
  WHERE off_boarded_at IS NULL
    AND last_seen_upload_id = (
      SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
    );

  gap := unstamped - on_current;

  IF on_current = 0 THEN
    RAISE EXCEPTION
      'REFUSING: active_employees would be empty (no current upload, or no rows on it).';
  END IF;

  -- The residue the reconcile deliberately leaves for HR: people who are live
  -- but absent from the sheet, and rows evidence cannot classify. Measured at
  -- 51 rows on 2026-09-21. A gap larger than this means the reconcile has not
  -- run, or has not finished.
  IF gap > 60 THEN
    RAISE EXCEPTION
      'REFUSING: % unstamped rows are not on the current upload (expected <= 60 after the reconcile). Run scripts/reconcile-gml-active-only.mts --apply first.',
      gap;
  END IF;

  RAISE NOTICE 'pre-flight ok: % unstamped, % on current upload, gap %', unstamped, on_current, gap;
END $$;

-- ── The change ─────────────────────────────────────────────────────────────
-- Definition kept byte-identical to the previous one except for the removed
-- upload filter, so the column list still comes from `SELECT *` over the base
-- table and no column is dropped from PostgREST's view of it.
CREATE OR REPLACE VIEW public.active_employees AS
SELECT *
FROM public.global_master_list
WHERE off_boarded_at IS NULL;

-- Ownership/privilege semantics are UNCHANGED. The view stays SECURITY DEFINER
-- (security_invoker = false), restored deliberately on 2026-08-03 after
-- security_invoker = true made it return zero rows under the anon key and the
-- Payroll Wizard re-labelled 422 people "Unassigned".
-- See references/sql/alter/2026-08-03_restore_active_employees_definer.sql.
ALTER VIEW public.active_employees SET (security_invoker = false);

-- ── Verify ─────────────────────────────────────────────────────────────────
-- Expect: equal counts. They are now the same query.
SELECT
  (SELECT count(*) FROM public.active_employees)                                   AS active_employees,
  (SELECT count(*) FROM public.global_master_list WHERE off_boarded_at IS NULL)    AS unstamped_rows;
