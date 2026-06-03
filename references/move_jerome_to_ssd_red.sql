-- #50 Move Jerome Aguirre into SSD Medical Records, RED sub-team.
-- PENDING. Idempotent — safe to re-run.
--
-- Why: Carla — "the only person on red team should be Jerome, but currently no one
-- is on the red team. He's under Vicky's Asst TL but should be under Medical Records."
-- His sub_team was already 'RED' (seed_hsl_sub_team_assignments.sql / migration #26),
-- but his dept_key was 'vicky_asst_tl'. The KPI calculator filters
-- dept_key = 'ssd_medical_records', so the RED tag sat on an invisible row and RED
-- showed empty. Moving his dept_key surfaces him on the SSD RED team.
--
-- is_manager flipped false: he is a RED team member, not the SSD manager (that's Vicky).
-- SSD's only rule is team_split, which ignores is_manager, so this is purely cosmetic
-- (un-ticks the "Mgr" box on his roster row).

UPDATE public.hsl_team_members
SET dept_key   = 'ssd_medical_records',
    sub_team   = 'RED',
    is_manager = false,
    updated_at = now()
WHERE email = 'jeromea@simple.biz';

-- Verify:
--   SELECT email, dept_key, sub_team, is_manager
--   FROM public.hsl_team_members WHERE email = 'jeromea@simple.biz';
--   -- expect: ssd_medical_records | RED | f
--
--   SELECT sub_team, count(*) FROM public.hsl_team_members
--   WHERE dept_key = 'ssd_medical_records' GROUP BY sub_team ORDER BY 1 NULLS LAST;
--   -- expect RED = 1
