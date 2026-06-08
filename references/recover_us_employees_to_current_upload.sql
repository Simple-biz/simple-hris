-- ============================================================================
-- RECOVERY (one-time only): re-stamp the 12 manually-seeded US employees onto
--           whatever master_list_uploads row is CURRENT.
--
-- AS OF 2026-06-08 THIS IS NO LONGER NEEDED FOR ONGOING SYNCS.
--   The sync route (/api/cron/sync-master-from-sheet) now calls
--   `restampActiveNonSheetRows()` automatically at the end of every successful
--   sync. That function re-stamps ALL non-offboarded rows — including the US
--   employees — onto the new current upload before the active_employees count is
--   read. You only need this SQL if you are recovering from a sync that ran
--   BEFORE the fix was deployed (i.e. if active_employees is currently missing
--   the US employees after a past sync).
--
-- WHY THE ISSUE EXISTED
--   The US employees (seed_us_global_master_list.sql) are NOT in the Google
--   MASTERLIST sheet -- they were seeded directly and tagged with the upload
--   that was current at seed time. The master-sheet sync promotes a brand-new
--   upload to is_current; `active_employees` filters to last_seen_upload_id =
--   (current upload), so the US rows (still on the old upload) dropped out of
--   the roster after every sync.
--
-- IDEMPOTENT: re-stamping to the already-current upload is a no-op.
-- Only active (non-off-boarded) rows are touched.
-- ============================================================================

WITH curr AS (
  SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1
)
UPDATE public.global_master_list g
SET    last_seen_upload_id = (SELECT id FROM curr)
WHERE  g.off_boarded_at IS NULL
  AND  LOWER(TRIM(g."Work Email")) IN (
    'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
    'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
    'nicholas@simple.biz','sterling@simple.biz','adrian@simple.biz','brandonb@simple.biz'
  );

-- ── Verify: every US row should now report visible_in_active = true ──
SELECT g."Department", g."Name", g."Work Email",
       (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) AS visible_in_active
FROM   public.global_master_list g
WHERE  g.off_boarded_at IS NULL
  AND  LOWER(TRIM(g."Work Email")) IN (
    'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
    'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
    'nicholas@simple.biz','sterling@simple.biz','adrian@simple.biz','brandonb@simple.biz'
  )
ORDER  BY g."Work Email";
