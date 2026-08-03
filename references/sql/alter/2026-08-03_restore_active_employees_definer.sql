-- Fix: restore public.active_employees to OWNER-privilege (definer) semantics
-- ---------------------------------------------------------------------------
-- Reverses ONE of the three changes made by
-- references/sql/alter/2026-08-03_fix_security_definer_views.sql. The other two
-- were correct and MUST stay as they are — see the bottom of this file.
--
-- WHAT BROKE
-- ----------
-- active_employees is global_master_list filtered to the `is_current` row of
-- master_list_uploads. anon is RLS-blocked on master_list_uploads. Under
-- security_invoker = true that sub-select is evaluated as the CALLER, so for
-- anon it matched zero uploads and the view returned an EMPTY SET — with HTTP
-- 200 and no error. Measured live 2026-08-03:
--
--     active_employees      anon = 0      service_role = 1345
--     master_list_uploads   anon = 0      service_role = 191
--     global_master_list    anon = 2395   service_role = 2395
--
-- Because PostgREST reports that as a successful empty read, every anon caller
-- silently saw a roster of nobody. getEmployees() fed it to the Payroll Wizard,
-- whose department source of truth went blank: tier 1 resolved to null for all
-- 1045 rows, the weaker rates-sheet / Hubstaff "Job type" tiers back-filled 623,
-- and 422 people landed in "Unassigned". Those departments gate real money
-- (dept pay-pause, OT toggles, HSL grouping).
--
-- WHY DEFINER IS SAFE ON THIS VIEW SPECIFICALLY
-- ---------------------------------------------
-- It exposes nothing anon cannot already read directly: global_master_list is
-- fully anon-readable (2395 rows above; pre-existing issue, SECURITY_AUDIT.md
-- finding #44). The original migration said as much — "active_employees adds no
-- NEW exposure today" — and then flipped it anyway on the theory that the
-- anon read path was unaffected. It was not: anon's access to the BASE TABLE
-- does not carry through a security_invoker view whose own filter reads a table
-- anon cannot see.
--
-- If global_master_list is ever locked down against anon, revisit this view
-- together with that change — at that point the fix is to grant the reading
-- role SELECT on master_list_uploads (or inline the is_current predicate so the
-- view stops depending on a second table), NOT to flip invoker on alone.
--
-- Idempotent: ALTER VIEW ... SET, no DDL that fails on re-run. No row data
-- touched. Safe to re-run.

ALTER VIEW public.active_employees SET (security_invoker = false);

-- DO NOT revert these two. Their base tables ARE locked against anon, so under
-- definer semantics the views leaked the full pay-rate table and HSL roster to
-- anyone holding the public anon key (measured 2026-08-03: employee_hourly_rates
-- anon = 0 / service_role = 22174; hsl_team_members anon = 0 / service_role = 566).
-- They stay security_invoker = true:
--   public.employee_hourly_rates_current
--   public.active_hsl_agents
-- Both are read server-side via the service-role client, which bypasses
-- grants/RLS regardless of invoker/definer, so nothing in the app needs them.
-- scripts/verify-active-employees-roster.mjs asserts they remain closed.

-- Verify: active_employees should be readable again, and should NOT list
-- security_invoker=true in reloptions.
SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('active_employees', 'employee_hourly_rates_current', 'active_hsl_agents');
