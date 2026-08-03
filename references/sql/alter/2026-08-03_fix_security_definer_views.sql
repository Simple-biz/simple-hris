-- Fix: Supabase Advisor "Security Definer View" (CRITICAL x3)
-- ---------------------------------------------------------------------------
-- public.active_employees, public.employee_hourly_rates_current, and
-- public.active_hsl_agents were all created as plain views, which in Postgres
-- run with the OWNER's privileges rather than the querying user's — the same
-- effect as SECURITY DEFINER on a function.
--
-- This is not theoretical here: employee_hourly_rates and hsl_team_members
-- are locked down against the anon key (confirmed live: anon reads 0 rows
-- directly), but employee_hourly_rates_current and active_hsl_agents bypass
-- that lockdown entirely and leak the full pay-rate table (2272 rows) and HSL
-- roster (565 rows) to anyone holding the public anon key. active_employees
-- adds no NEW exposure today (global_master_list is already open to anon —
-- see SECURITY_AUDIT.md finding #44) but carries the same silent-bypass trap
-- if that table is ever locked down later without revisiting the view.
--
-- Fix: security_invoker = true makes each view enforce the CALLER's grants
-- instead of the owner's. Same pattern already used for public.active_screening
-- (references/sql/create/create_screening.sql).
--
-- Safe for app functionality: employee_hourly_rates_current and
-- active_hsl_agents are read server-side via the service-role client (see
-- src/lib/supabase/employee-hourly-rates.ts, src/lib/supabase/hsl-agents.ts),
-- which bypasses grants/RLS regardless of invoker/definer.
--
-- !! CORRECTION (2026-08-03, after this ran) !!
-- The claim below was WRONG and caused a payroll incident. Reverted for
-- active_employees by
-- references/sql/alter/2026-08-03_restore_active_employees_definer.sql.
--
--   > active_employees' anon-key read path (getEmployees() in
--   > src/lib/supabase/employees.ts) is unaffected because anon already has
--   > full direct access to global_master_list.
--
-- anon's access to the BASE TABLE does not carry through a security_invoker
-- view whose own filter reads a table anon cannot see. active_employees filters
-- on the is_current row of master_list_uploads, and anon is RLS-blocked there
-- (anon = 0 rows, service_role = 191). Under invoker semantics the sub-select
-- matched nothing, so the view returned an EMPTY SET to anon with HTTP 200 and
-- no error — indistinguishable from "nobody is active". The Payroll Wizard's
-- department source of truth went blank and 422 of 1045 people were re-labelled
-- "Unassigned".
--
-- Rule of thumb: before setting security_invoker on a view, check every table
-- its definition touches — including tables referenced only inside a filter
-- sub-select — and confirm the reading role can see all of them. A silent
-- empty set is the failure mode, not a permission error.
--
-- Idempotent: ALTER VIEW ... SET, no DDL that fails on re-run. Safe to re-run.

-- SUPERSEDED for this view — see 2026-08-03_restore_active_employees_definer.sql.
-- Left in place (not deleted) so the history of the change is legible.
-- ALTER VIEW public.active_employees             SET (security_invoker = true);
ALTER VIEW public.employee_hourly_rates_current    SET (security_invoker = true);
ALTER VIEW public.active_hsl_agents                SET (security_invoker = true);

-- Verify: reloptions should now include security_invoker=true for all three.
SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('active_employees', 'employee_hourly_rates_current', 'active_hsl_agents');
