-- ============================================================================
-- RECOVERY: re-stamp the 12 manually-seeded US employees onto whatever
--           master_list_uploads row is CURRENT, so they reappear in the
--           active_employees view after a master-sheet sync.
--
-- WHY THIS IS NEEDED
--   The US employees (seed_us_global_master_list.sql) are NOT in the Google
--   MASTERLIST sheet -- they were seeded directly and tagged with the upload
--   that was current at seed time. The master-sheet sync only ever touches rows
--   it finds in the sheet, then promotes a brand-new upload to is_current.
--   `active_employees` filters to last_seen_upload_id = (current upload), so the
--   moment a new upload is promoted the US rows (still pointing at the old
--   upload) drop out of the roster. Run this AFTER each successful sheet sync,
--   or add the US employees to the Google sheet so the sync maintains them.
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
