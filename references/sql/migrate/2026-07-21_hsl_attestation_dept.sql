-- ============================================================
-- 2026-07-21 · HSL "Attestation" sub-department roster seed
--
-- Companion to the schema.ts edit that ADDED the `attestation` HSL sub-dept
-- (weekly, one tiered "Attested Cases" rule; key appended to HSL_DEPT_KEYS +
-- config added to HSL_DEPTS). Run this ONCE in Supabase after deploying the code.
-- Idempotent — safe to re-run.
--
-- WHAT THIS DOES  (verified against the LIVE DB 2026-07-21, not the stale seed file)
--   Puts the 19 Attestation agents into dept_key = 'attestation'. They split into:
--     • 13 ALREADY in hsl_team_members (role_raw='Attestation', dept
--       filing_specialist) → part 1 UPDATE (keeps their upload_id → stay in the
--       active_hsl_agents roster the Payroll Wizard reads).
--     • 5 NOT yet in the HSL roster but present in the master list → part 2 INSERT,
--       stamped with the CURRENT hsl_agent_uploads id so they appear in the active
--       view. Per decision we do NOT touch their global_master_list Department.
--       (christiane/angelog/willianb/kyleb sit under "Lead Gen", trixieg under
--       "HSL" in the master list — left as-is; this only adds the KPI roster row.)
--   SKIPPED: marca@simple.biz — no row in hsl_team_members OR global_master_list
--     under that email (likely a typo / not onboarded). Add once its real email is
--     confirmed; see the commented block at the bottom.
--
-- WHY THE PAYROLL WIZARD NEEDS THIS
--   The HSL dept rail only shows a sub-dept pill when it has ≥1 member this cycle
--   OR a ready/locked KPI period. `attestation` starts empty, so it stays hidden
--   until these rows carry dept_key='attestation' AND the current upload_id.
--
-- Current upload at authoring time: 171db483-8f35-4334-9508-60dd5a892604. The
-- INSERT looks it up dynamically (not hardcoded) so it stays correct even if a
-- newer sync ran before you execute this.
-- ============================================================

BEGIN;

-- ── Part 1: move the 14 already-in-roster Attestation agents ───────────────────
--    UPDATE keeps each row's existing upload_id → stays in active_hsl_agents.
UPDATE public.hsl_team_members
SET dept_key   = 'attestation',
    updated_at = now()
WHERE lower(email) IN (
  'denylm@simple.biz',
  'rizalloydp@simple.biz',
  'nolianq@simple.biz',
  'marylouc@simple.biz',
  'nikkaj@simple.biz',
  'carrenm@simple.biz',
  'canetho@simple.biz',
  'maee@simple.biz',
  'kevincc@simple.biz',
  'joeg@simple.biz',
  'joeyf@simple.biz',
  'wynd@simple.biz',
  'marionb@simple.biz'
);
-- Reconciliation: 13 UPDATE (this list) + 5 INSERT (part 2) + 1 skipped (marca) = 19.

-- ── Part 2: seed the 5 not-yet-in-roster agents, stamped with the CURRENT upload ─
--    Names taken from the live global_master_list. Rates match the Attestation
--    cohort (235.00 / 352.50). is_manager=false. ON CONFLICT keeps them idempotent
--    and (re)stamps dept + current upload on re-run.
INSERT INTO public.hsl_team_members
  (email, full_name, hsl_name, role_raw, dept_key, is_manager, hourly_rate, ot_rate, upload_id)
SELECT v.email, v.full_name, v.hsl_name, 'Attestation', 'attestation', false, 235.00, 352.50,
       (SELECT id FROM public.hsl_agent_uploads WHERE is_current = true LIMIT 1)
FROM (VALUES
  ('christiane@simple.biz', 'Entong, Christian Jade "Christian"', 'Christian'),
  ('angelog@simple.biz',    'Ogerio, Angel "Angel"',             'Angel'),
  ('willianb@simple.biz',   'Bautista, Willian Nicole "Willian"','Willian'),
  ('kyleb@simple.biz',      'Bautista, Kyle Andrew "Kyle"',      'Kyle'),
  ('trixieg@simple.biz',    'De Guzman, Trixie "Trixie"',        'Trixie')
) AS v(email, full_name, hsl_name)
ON CONFLICT (email) DO UPDATE SET
  dept_key   = 'attestation',
  role_raw   = 'Attestation',
  upload_id  = (SELECT id FROM public.hsl_agent_uploads WHERE is_current = true LIMIT 1),
  updated_at = now();

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- §A. Full Attestation roster — expect 18 rows (19 requested − marca skipped),
--     every row in_active_view = true:
--   SELECT email, full_name, hsl_name,
--          (upload_id = (SELECT id FROM public.hsl_agent_uploads WHERE is_current=true LIMIT 1)) AS in_active_view
--   FROM public.hsl_team_members
--   WHERE dept_key = 'attestation'
--   ORDER BY full_name;
--
-- §B. Count in the ACTIVE view the Payroll Wizard reads (expect 18):
--   SELECT count(*) AS attestation_in_active_roster
--   FROM public.active_hsl_agents WHERE dept_key = 'attestation';
--
-- §C. Overall dept spread after the move:
--   SELECT COALESCE(dept_key,'(none)') AS dept, count(*)
--   FROM public.hsl_team_members GROUP BY 1 ORDER BY 2 DESC;

-- ── SKIPPED: marca@simple.biz ──────────────────────────────────────────────────
-- Not found in hsl_team_members or global_master_list under this email. Confirm
-- the correct address, then add (replace CORRECT_EMAIL / NAME):
--   INSERT INTO public.hsl_team_members
--     (email, full_name, hsl_name, role_raw, dept_key, is_manager, hourly_rate, ot_rate, upload_id)
--   VALUES ('CORRECT_EMAIL@simple.biz', 'LASTNAME, FIRST', 'Nick', 'Attestation',
--           'attestation', false, 235.00, 352.50,
--           (SELECT id FROM public.hsl_agent_uploads WHERE is_current = true LIMIT 1))
--   ON CONFLICT (email) DO UPDATE SET dept_key='attestation', role_raw='Attestation',
--     upload_id=(SELECT id FROM public.hsl_agent_uploads WHERE is_current=true LIMIT 1), updated_at=now();

-- ── OPTIONAL: grant a manager access to the Attestation sub-dept ───────────────
-- Lets a manager see/edit Attestation in the KPI Calculator + Admin → Roles.
-- Repeat per manager. (Admins/elevated need no grant.)
--   INSERT INTO public.department_managers (manager_email, department, assigned_by)
--   VALUES ('MANAGER_EMAIL@simple.biz', 'hsl:attestation', 'migration')
--   ON CONFLICT (manager_email, department) DO UPDATE SET revoked_at = NULL;
