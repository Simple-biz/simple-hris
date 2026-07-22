-- ============================================================
-- 2026-07-22 · HSL "Case Managers" sub-department roster seed
--
-- Companion to the schema.ts edit that ADDED the `case_managers` HSL sub-dept
-- (weekly, six per_unit rules; key appended to HSL_DEPT_KEYS + config added to
-- HSL_DEPTS). Run this ONCE in Supabase after deploying the code. Idempotent —
-- safe to re-run.
--
--   KPI formula (per_unit, all summed):
--     =(Reviews*250)+(RFC*250)+(PPL*100)+(DME*250)+(Task*250)+(Referral Leads*250)
--
-- WHAT THIS DOES
--   Puts every HSL "Case Manager" agent into dept_key = 'case_managers' by
--   matching their role_raw (the "Department/ Role" cell synced from the Hogan
--   sheet), NOT a hardcoded email list. On the 2026-07 import the cohort is:
--       74× "HSL - Case Manager"  +  5× "HSL Case Manager"  = 79 people.
--   The `%case manager%` match catches both spellings (dash / no-dash) and stays
--   correct as people join/leave, because the Hogan Payplan Sync keeps role_raw
--   fresh on every run.
--
--   EXCLUDED on purpose: "Case Management Assistant TL" (note: "Management", not
--   "Manager") — that TL/assistant role is not part of the per-unit KPI branch,
--   mirroring how it lived under its own retired dept previously. The match term
--   'case manager' does not hit 'case management', so it's excluded naturally;
--   the extra AND guard below makes that explicit and future-proof.
--
-- WHY role_raw INSTEAD OF the Attestation-style email list
--   The `case_manager` (singular) dept was REMOVED on 2026-07-17, which set these
--   people's dept_key back to NULL (see 2026-07-17_hsl_bonus_dept_changes.sql).
--   They still exist in hsl_team_members with role_raw = "…Case Manager", they
--   just have no bonus dept. A single role-based UPDATE re-homes all of them into
--   the new `case_managers` (plural) key. We use a NEW plural key so no stale
--   'hsl:case_manager' grants or historical 'case_manager' bonus rows get
--   resurrected.
--
-- ORDERING vs. the Payroll Wizard "Hogan Payplan Sync"
--   Works in EITHER order:
--     • Run this migration, THEN click Sync — the sync re-stamps upload_id for
--       every sheet row (so Case Managers stay in active_hsl_agents) and leaves
--       dept_key UNTOUCHED (replaceHslAgentsFromRows never writes dept_key on
--       UPDATE/INSERT), so 'case_managers' survives.
--     • Click Sync first, THEN run this migration — the rows are already stamped
--       with the current upload; this just sets dept_key on them.
--   In both cases the dept pill appears once ≥1 member carries
--   dept_key='case_managers' AND the current upload_id (which the sync guarantees
--   for everyone on the Hogan sheet).
-- ============================================================

BEGIN;

-- ── Re-home every "Case Manager" agent into dept_key = 'case_managers' ─────────
--    UPDATE keeps each row's existing upload_id → stays in active_hsl_agents.
--    role_raw is preserved (the sync owns it); only dept_key changes.
UPDATE public.hsl_team_members
SET dept_key   = 'case_managers',
    updated_at = now()
WHERE role_raw ILIKE '%case manager%'
  AND role_raw NOT ILIKE '%assistant%'   -- exclude "Case Management Assistant TL" & any asst/TL variants
  AND role_raw NOT ILIKE '%management%'; -- belt-and-suspenders: never match "Case Management …"

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- §A. Full Case Managers roster — expect ~79 rows (78 unique people; some have a
--     duplicate work-email row). Every row in_active_view = true once the sync has
--     stamped the current upload:
--   SELECT email, full_name, hsl_name, role_raw,
--          (upload_id = (SELECT id FROM public.hsl_agent_uploads WHERE is_current=true LIMIT 1)) AS in_active_view
--   FROM public.hsl_team_members
--   WHERE dept_key = 'case_managers'
--   ORDER BY full_name;
--
-- §B. Count in the ACTIVE view the Payroll Wizard reads:
--   SELECT count(*) AS case_managers_in_active_roster
--   FROM public.active_hsl_agents WHERE dept_key = 'case_managers';
--
-- §C. Sanity — did we accidentally sweep in any non-CM role? Expect only
--     "HSL - Case Manager" / "HSL Case Manager" spellings:
--   SELECT role_raw, count(*) FROM public.hsl_team_members
--   WHERE dept_key = 'case_managers' GROUP BY 1 ORDER BY 2 DESC;
--
-- §D. Overall dept spread after the move:
--   SELECT COALESCE(dept_key,'(none)') AS dept, count(*)
--   FROM public.hsl_team_members GROUP BY 1 ORDER BY 2 DESC;

-- ── OPTIONAL: grant a manager access to the Case Managers sub-dept ─────────────
-- Lets a manager see/edit Case Managers in the KPI Calculator + Admin → Roles.
-- Repeat per manager. (Admins/elevated need no grant.)
--   INSERT INTO public.department_managers (manager_email, department, assigned_by)
--   VALUES ('MANAGER_EMAIL@simple.biz', 'hsl:case_managers', 'migration')
--   ON CONFLICT (manager_email, department) DO UPDATE SET revoked_at = NULL;
