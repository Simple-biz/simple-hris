-- ============================================================
-- 2026-07-17 · HSL KPI Calculator department changes
--
-- Companion to the schema.ts edit that reshaped HSL_DEPTS. Run this ONCE in
-- Supabase after deploying the code. Idempotent — safe to re-run.
--
-- WHAT CHANGED IN CODE (src/lib/hsl-bonus/schema.ts):
--   REMOVED depts : case_manager, case_mgr_no_kpi, chelzy_asst,
--                   vicky_asst_tl, case_mgmt_asst_tl
--   ADDED   depts : callback_team (Medicare Sign Ups ₱250),
--                   simple_texting (Transferred Calls ₱50 + Sign Ups ₱250),
--                   medical_records (Patient Portal Log Ins ₱250 + RFC ₱250),
--                   hsl_managers  (Managers Weekly — bespoke per-manager checklist,
--                                  cohort hardcoded in HSL_MANAGERS, no roster needed)
--   RENAMED       : post_hearing_prep display → "Pre-Hearing / Post-Hearing Prep"
--
-- This migration does NOT delete any historical bonus rows. Once a dept key is
-- gone from HSL_DEPT_KEYS the PayrollWizard HSL step and the manager tabs stop
-- reading it, so old hsl_bonus_entries for removed depts are simply inert and are
-- preserved here for audit. Delete them only if you explicitly want to (see the
-- optional block at the bottom).
-- ============================================================

BEGIN;

-- 1) Un-strand roster members who were under a REMOVED dept_key.
--    Clearing dept_key removes them from every HSL KPI dept (the intended
--    "no bonus dept" outcome). They remain HSL employees (parent "Hogan Smith
--    Law") and still receive PAB / Technology bonuses. To instead MOVE any of
--    them into a NEW dept, replace NULL with the target key (see step 3).
UPDATE public.hsl_team_members
SET dept_key   = NULL,
    updated_at = now()
WHERE dept_key IN (
  'case_manager',
  'case_mgr_no_kpi',
  'chelzy_asst',
  'vicky_asst_tl',
  'case_mgmt_asst_tl'
);

-- 2) Soft-revoke the sub-dept access grants for the removed depts so they stop
--    showing as toggles / stranded grants in Admin → Roles.
UPDATE public.department_managers
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND department IN (
    'hsl:case_manager',
    'hsl:case_mgr_no_kpi',
    'hsl:chelzy_asst',
    'hsl:vicky_asst_tl',
    'hsl:case_mgmt_asst_tl'
  );

-- 3) (OPTIONAL) Populate the NEW teams' rosters.
--    callback_team / simple_texting / medical_records start EMPTY. Assign people
--    either here (set dept_key) or live via the calculator's "Add member" button.
--    hsl_managers needs NO roster rows — its cohort is hardcoded in HSL_MANAGERS.
--
--    Example (uncomment + edit):
--    UPDATE public.hsl_team_members
--    SET dept_key = 'callback_team', updated_at = now()
--    WHERE email IN ('someone@simple.biz');
--
--    UPDATE public.hsl_team_members
--    SET dept_key = 'simple_texting', updated_at = now()
--    WHERE email IN ('someone@simple.biz');
--
--    UPDATE public.hsl_team_members
--    SET dept_key = 'medical_records', updated_at = now()
--    WHERE email IN ('someone@simple.biz');

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Removed keys should return zero roster rows:
--   SELECT dept_key, count(*) FROM public.hsl_team_members
--   WHERE dept_key IN ('case_manager','case_mgr_no_kpi','chelzy_asst',
--                      'vicky_asst_tl','case_mgmt_asst_tl')
--   GROUP BY dept_key;   -- expect: (no rows)
--
-- No active grants for removed depts:
--   SELECT department, count(*) FROM public.department_managers
--   WHERE revoked_at IS NULL AND department LIKE 'hsl:%'
--   GROUP BY department ORDER BY 1;
--
-- Current roster spread by dept:
--   SELECT COALESCE(dept_key,'(none)') AS dept, count(*) FROM public.hsl_team_members
--   GROUP BY 1 ORDER BY 2 DESC;

-- ── OPTIONAL: hard-delete historical bonus rows for the removed depts ──────────
-- Only run if you do NOT want to keep the audit trail. These rows are otherwise
-- inert (no longer read by the app once the keys are removed from HSL_DEPT_KEYS).
--   DELETE FROM public.hsl_bonus_entries
--   WHERE department IN ('case_manager','case_mgr_no_kpi','chelzy_asst',
--                        'vicky_asst_tl','case_mgmt_asst_tl');
--   DELETE FROM public.hsl_bonus_period_status
--   WHERE department IN ('case_manager','case_mgr_no_kpi','chelzy_asst',
--                        'vicky_asst_tl','case_mgmt_asst_tl');
