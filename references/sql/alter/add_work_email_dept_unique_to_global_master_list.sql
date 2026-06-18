-- ============================================================================
-- global_master_list: switch the identity uniqueness key from
--   (LOWER "Personal Email", LOWER "Department")   <- WRONG
-- to
--   (LOWER "Work Email",     LOWER "Department")   <- canonical
-- Generated: 2026-06-06
--
-- WHY
--   A personal email is NOT a unique identifier. The same personal address can
--   legitimately belong to multiple distinct work accounts:
--     * a person re-onboarded later under a brand-new @simple.biz address,
--     * a shared/family personal inbox,
--     * an admin testing with a second account (kaner@ + kanerero@).
--   The old unique index treated (Personal Email, Department) as one identity,
--   so promoting a second hire that reused a personal email REATTACHED that hire
--   to the first person's master row and overwrote its Work Email -- hijacking
--   the whole identity (name, dept, start date, profile photo, commendations and
--   the hours join all resolve through this single row). See the matching fix in
--   src/lib/supabase/hr-pending-employees.ts (promoteHrPendingEmployee).
--
--   The Work Email (@simple.biz, minted by Payroll) IS the canonical, unique
--   join key for every other system. Department disambiguates the one case where
--   a person holds more than one master row: one per department they belong to.
--
-- SCOPE / IMPACT
--   * Promote (hr-pending-employees.ts) now matches on (Work Email, Department).
--   * The master-list CSV / Google-Sheet sync (global-master-list-db.ts) still
--     PRIMARY-matches existing rows by (Personal Email, Department) in app code,
--     with a (Work Email, Department) fallback. That matching is SELECT-based, it
--     does not use this index, so dropping the personal-email index does not break
--     it -- the index was only a DB-level backstop. The sync already dedupes
--     within a CSV by (personal_email, department) in memory (last-wins), so it
--     will not try to insert intra-CSV duplicates.
--   * The new index is PARTIAL on active rows (off_boarded_at IS NULL). Off-boarded
--     rows keep their old Work Email, so a recycled @simple.biz address handed to a
--     new hire does not collide with the departed employee's archived row.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) PRE-CHECK -- run this FIRST. The CREATE UNIQUE INDEX in step 2 will FAIL
--    if any active (Work Email, Department) pair is already duplicated. If this
--    returns rows, resolve them (merge / off-board / correct the Work Email)
--    before running step 2. Two active rows sharing a (work email, dept) is the
--    exact corruption this migration prevents going forward.
-- ----------------------------------------------------------------------------
SELECT lower(trim("Work Email"))  AS work_email,
       lower(trim("Department"))  AS department,
       count(*)                   AS active_rows,
       array_agg(id)              AS row_ids
FROM   public.global_master_list
WHERE  "Work Email" IS NOT NULL
  AND  trim("Work Email") <> ''
  AND  off_boarded_at IS NULL
GROUP  BY 1, 2
HAVING count(*) > 1
ORDER  BY active_rows DESC;

-- ----------------------------------------------------------------------------
-- 1) Drop the old personal-email-based unique index(es). Self-discovering,
--    because the exact name varies by environment. Only UNIQUE indexes whose
--    definition references BOTH "Personal Email" and "Department" are dropped;
--    plain (non-unique) lookup indexes are left intact.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  idx record;
BEGIN
  FOR idx IN
    SELECT indexname, indexdef
    FROM   pg_indexes
    WHERE  schemaname = 'public'
      AND  tablename  = 'global_master_list'
      AND  indexdef ILIKE '%unique%'
      AND  indexdef ILIKE '%personal email%'
      AND  indexdef ILIKE '%department%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', idx.indexname);
    RAISE NOTICE 'Dropped personal-email identity index: % (%).', idx.indexname, idx.indexdef;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 1.5) RESOLVE PRE-EXISTING DUPLICATES (only needed when step 0 returned rows,
--      i.e. step 2 fails with "could not create unique index ... is duplicated").
--      The table already holds >1 ACTIVE row for some (Work Email, Department)
--      -- pre-existing identity duplication, typically a master CSV/Sheet sync
--      re-inserting the same person. The unique index cannot build until each
--      such group has exactly one active row. (These dupes also already break
--      single-row lookups -- profile-photo / commendations use .maybeSingle(),
--      which errors when two rows match -- so resolving them is worthwhile on
--      its own.)
--
--      Strategy: per group KEEP one row -- preferring the row on the current
--      master upload (so it stays in active_employees), then the row with the
--      most data (photo / employee_id / start date), newest id last. Losers are
--      RETIRED via off_boarded_at -- REVERSIBLE, not deleted. Undo SQL is at the
--      bottom of this file.
-- ----------------------------------------------------------------------------

-- 1.5a INSPECT -- review BEFORE retiring. keep=1 is the surviving row; keep>1 are
--       the rows that will be retired. Confirm every keep=1 row is the right
--       identity (same person, holds the data you want to keep).
WITH ranked AS (
  SELECT g.id, g."Name", g."Work Email", g."Personal Email", g."Department",
         g."Start Date", g."Profile Photo URL", g.employee_id, g.last_seen_upload_id,
         row_number() OVER w AS keep,
         count(*)     OVER w AS grp_size
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email")), lower(trim(g."Department"))
    ORDER BY (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) DESC NULLS LAST,
             (g."Profile Photo URL" IS NOT NULL) DESC,
             (g.employee_id IS NOT NULL) DESC,
             (g."Start Date" IS NOT NULL AND trim(g."Start Date") <> '') DESC,
             g.id DESC
  )
)
SELECT * FROM ranked WHERE grp_size > 1
ORDER  BY "Work Email", "Department", keep;

-- 1.5b RESCUE (optional, recommended) -- before retiring, copy photo / employee_id
--       / start date from any sibling into the keeper where the keeper is missing
--       it, so nothing is lost. Safe: only fills NULL/empty keeper fields.
WITH ranked AS (
  SELECT g.*, row_number() OVER w AS keep
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email")), lower(trim(g."Department"))
    ORDER BY (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) DESC NULLS LAST,
             (g."Profile Photo URL" IS NOT NULL) DESC,
             (g.employee_id IS NOT NULL) DESC,
             (g."Start Date" IS NOT NULL AND trim(g."Start Date") <> '') DESC,
             g.id DESC
  )
),
best AS (
  SELECT lower(trim("Work Email")) AS we, lower(trim("Department")) AS dep,
         (array_agg("Profile Photo URL") FILTER (WHERE "Profile Photo URL" IS NOT NULL))[1] AS photo,
         (array_agg(employee_id)         FILTER (WHERE employee_id IS NOT NULL))[1]         AS emp_id,
         (array_agg("Start Date")        FILTER (WHERE "Start Date" IS NOT NULL AND trim("Start Date") <> ''))[1] AS start_date
  FROM   ranked GROUP BY 1, 2
)
UPDATE public.global_master_list t
SET    "Profile Photo URL" = COALESCE(t."Profile Photo URL", b.photo),
       employee_id         = COALESCE(t.employee_id, b.emp_id),
       "Start Date"        = COALESCE(NULLIF(trim(t."Start Date"), ''), b.start_date)
FROM   ranked r
JOIN   best b ON b.we = lower(trim(r."Work Email")) AND b.dep = lower(trim(r."Department"))
WHERE  t.id = r.id AND r.keep = 1;

-- 1.5c RETIRE the duplicates (REVERSIBLE -- sets off_boarded_at, does NOT delete;
--       does NOT set scheduled_deletion_at, so the deletion cron never touches
--       them). Run only AFTER 1.5a looks correct.
WITH ranked AS (
  SELECT g.id, row_number() OVER w AS keep
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email")), lower(trim(g."Department"))
    ORDER BY (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) DESC NULLS LAST,
             (g."Profile Photo URL" IS NOT NULL) DESC,
             (g.employee_id IS NOT NULL) DESC,
             (g."Start Date" IS NOT NULL AND trim(g."Start Date") <> '') DESC,
             g.id DESC
  )
)
UPDATE public.global_master_list t
SET    off_boarded_at     = now(),
       off_boarded_reason = 'duplicate_cleanup',
       off_boarded_note   = 'Duplicate (Work Email, Department) row retired for identity-key migration #65. Reversible.'
FROM   ranked r
WHERE  t.id = r.id AND r.keep > 1;

-- ----------------------------------------------------------------------------
-- 2) Create the canonical (Work Email, Department) unique index, active rows
--    only. lower(trim(...)) matches how the app normalizes emails everywhere
--    (normalizeEmail / normEmail = lower + trim).
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS global_master_list_work_email_dept_uniq
  ON public.global_master_list (lower(trim("Work Email")), lower(trim("Department")))
  WHERE "Work Email" IS NOT NULL
    AND trim("Work Email") <> ''
    AND off_boarded_at IS NULL;

COMMENT ON INDEX public.global_master_list_work_email_dept_uniq IS
  'Canonical identity key: one active master row per (work email, department). '
  'Replaces the old (personal email, department) unique index -- personal emails '
  'are reused across distinct accounts and must NOT key identity.';

-- ----------------------------------------------------------------------------
-- VERIFY: the new index exists and the old personal-email one is gone.
-- ----------------------------------------------------------------------------
SELECT indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public'
  AND  tablename  = 'global_master_list'
  AND  (indexdef ILIKE '%work email%' OR indexdef ILIKE '%personal email%')
ORDER  BY indexname;

-- ----------------------------------------------------------------------------
-- UNDO for 1.5c -- if you retired the wrong rows, this re-activates everything
-- that this migration retired (only rows it stamped, so it won't disturb real
-- off-boards):
-- ----------------------------------------------------------------------------
-- UPDATE public.global_master_list
-- SET    off_boarded_at = NULL, off_boarded_reason = NULL, off_boarded_note = NULL
-- WHERE  off_boarded_reason = 'duplicate_cleanup'
--   AND  off_boarded_note LIKE 'Duplicate (Work Email, Department) row retired for identity-key migration #65%';
