-- ============================================================================
-- New Hire Checklist: collapse the OnlineJobs.ph "Source" variants  (2026-07-20)
--
-- The Hiring Source dropdown historically offered "Online Jobs", and HR also
-- typed free-text variants ("OnlineJobsPH", "Onlinejobs.ph", …) for the same
-- website. This rewrites every such row's `source` to the single canonical
-- label "OnlineJobs.ph" so the Overview pie/table and the dropdown show ONE
-- option instead of several.
--
-- Match is punctuation/space/case-insensitive: any value whose alphanumeric-
-- only, lowercased form starts with "onlinejobs" is folded in. That covers
-- "Online Jobs", "OnlineJobsPH", "Onlinejobs.ph", "onlinejobs", "Online Jobs
-- PH", etc. — mirroring `normalizeSource()` in src/lib/hr/referral-source.ts.
--
-- Pairs with the app change renaming the base dropdown option to
-- "OnlineJobs.ph" (BASE_SOURCE_OPTIONS). The `cell_edits` history is left as-is
-- on purpose — this is a data cleanup, not a user edit, so we don't attribute
-- it to anyone or churn the log. Run once in the Supabase SQL editor.
-- Idempotent + safe to re-run (rows already at the target are skipped).
-- ============================================================================

BEGIN;

UPDATE public.hr_new_hire_checklist
   SET source = 'OnlineJobs.ph'
 WHERE source IS NOT NULL
   AND source <> 'OnlineJobs.ph'
   AND lower(regexp_replace(source, '[^a-zA-Z0-9]', '', 'g')) LIKE 'onlinejobs%';

COMMIT;

-- Preview BEFORE running (what would be folded in):
--   SELECT source, count(*)
--     FROM public.hr_new_hire_checklist
--    WHERE source IS NOT NULL
--      AND lower(regexp_replace(source, '[^a-zA-Z0-9]', '', 'g')) LIKE 'onlinejobs%'
--    GROUP BY source
--    ORDER BY count(*) DESC;
--
-- Verify AFTER running (should be exactly one "OnlineJobs.ph" bucket):
--   SELECT source, count(*)
--     FROM public.hr_new_hire_checklist
--    WHERE lower(regexp_replace(source, '[^a-zA-Z0-9]', '', 'g')) LIKE 'onlinejobs%'
--    GROUP BY source;
