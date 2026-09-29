-- Fix: Supabase Advisor "Security Definer View" on public.active_employees, 2026-09-29
-- ---------------------------------------------------------------------------
-- Kane, 2026-09-29, choosing (b) over the definer rule in
-- 2026-09-21_active_employees_drop_upload_gate.sql:82-87 ("The view stays
-- SECURITY DEFINER"). That rule came from the 2026-08-03 incident, and the
-- cause of that incident no longer exists in this view:
--
--   2026-08-03  the view sub-selected master_list_uploads, which anon is
--               RLS-blocked on. Under security_invoker = true that sub-select
--               ran as anon, matched nothing, and the view returned an EMPTY
--               SET with HTTP 200 (422 people "Unassigned" in the wizard).
--               Restored to definer: 2026-08-03_restore_active_employees_definer.sql.
--   2026-09-21  the upload gate was dropped. The view is now
--               `SELECT * FROM global_master_list WHERE off_boarded_at IS NULL`
--               and reads no second table.
--
-- Rehearsed in a rolled-back transaction on 2026-09-29 before this ran: with
-- security_invoker = true, anon, authenticated and service_role each read
-- 1,270 rows, which equals global_master_list WHERE off_boarded_at IS NULL
-- for that same role, with all columns readable.
--
-- WHY INVOKER IS THE RIGHT END STATE. Under definer the view runs as its owner
-- (postgres), so it shows every caller the whole active roster whatever
-- global_master_list's own policies say. Today that exposes nothing new, because
-- the `anon can read global master list` policy already opens the base table
-- (memory gml-anon-readable-undercuts-column-grants). But the day that policy is
-- narrowed (item 221), a definer view would keep leaking the roster to the
-- public key. Under invoker the view obeys the caller's access to the base table,
-- so narrowing the policy narrows the view with it. Every production reader of
-- active_employees uses the service role, which has BYPASSRLS.
--
-- THE RULE THAT STILL HOLDS (memory security-invoker-view-silent-empty): an
-- invoker view is only safe while every table it reads is visible to every role
-- that reads it. The pre-flight below enforces the half that can be checked here:
-- it REFUSES if the view reads any table other than global_master_list. So
-- re-adding a second table (for example by running
-- 2026-09-21_active_employees_restore_upload_gate.sql, which also sets definer
-- back, correctly) cannot be combined with this file.
--
-- Idempotent: ALTER VIEW ... SET. No row data touched. No BEGIN/COMMIT, because
-- the apply script wraps it:
--
--   node --import tsx scripts/apply-active-employees-invoker.mts           # rehearse, then ROLL BACK
--   node --import tsx scripts/apply-active-employees-invoker.mts --apply   # COMMIT
--   node --import tsx scripts/apply-active-employees-invoker.mts --verify  # re-check only
--
-- REVERT (brings the Advisor error back; only if a reader goes empty):
--   ALTER VIEW public.active_employees SET (security_invoker = false);

-- ── Pre-flight: the view must read exactly one table ─────────────────────────
DO $$
DECLARE
  others text;
BEGIN
  SELECT string_agg(DISTINCT d.refobjid::regclass::text, ', ')
    INTO others
  FROM pg_rewrite r
  JOIN pg_depend d
    ON d.classid = 'pg_rewrite'::regclass
   AND d.objid = r.oid
   AND d.refclassid = 'pg_class'::regclass
  WHERE r.ev_class = 'public.active_employees'::regclass
    AND d.refobjid <> r.ev_class
    AND d.refobjid <> 'public.global_master_list'::regclass;

  IF others IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUSING: active_employees also reads % — under security_invoker a role that cannot see it gets a SILENT EMPTY roster (the 2026-08-03 incident).',
      others;
  END IF;
END $$;

ALTER VIEW public.active_employees SET (security_invoker = true);
