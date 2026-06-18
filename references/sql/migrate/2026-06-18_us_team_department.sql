-- ============================================================================
-- US Team department consolidation  (2026-06-18)
--
-- Folds EVERY US-based employee into ONE department, "US Team", replacing the
-- old split across "US Manager Bonus" / "Hogan Smith Law" / "HR".
--
-- The US cohort is the authoritative set keyed by employee_ids.employee_id
-- LIKE 'US-%' (Arndt/Thomas, Thomas/Carla, Thibodeau/Jeff, Lepley/Teal,
-- Andresen/Courtney, Charland/Nicholas, Fierro/Adrian, Foote/Sterling,
-- Kitson/Emma, Zapata/Jackie, Lee/Seungyong, Biggs/Brandon).
--
-- WHY: these are all US employees — some individual contributors, some team
-- leads — but they belong in a single group for the manager KPI Calculator.
-- Before this:
--   • only the 4 tagged "US Manager Bonus" surfaced in the calculator;
--   • the "Hogan Smith Law"-tagged US folks (incl. Thomas Arndt) were dropped
--     entirely, because hogan_smith_law is NOT in MANAGER_BONUS_DEPT_KEYS;
--   • Teal (HR) sat alone under HR.
-- After: all of them normalize to the existing `us_manager_bonus` key (now
-- labelled "US Team") and appear together.
--
-- The internal department KEY stays `us_manager_bonus` on purpose — it carries
-- the USD currency forcing, the Payment-Catalog assignments, and the saved
-- `bonus_catalog_applied` history. Only the user-facing LABEL becomes "US Team"
-- (done in code). normalizeDeptToKey('US Team') -> us_manager_bonus is added in
-- the same deploy.
--
-- ⚠ DUPLICATE ROWS: a US employee can hold MORE THAN ONE active
-- global_master_list row — one per department they were ever tagged with (e.g.
-- seungyong@ under both "US Manager Bonus" and another dept, from master-sheet
-- re-syncs). Naively setting them all to "US Team" violates the partial unique
-- index `global_master_list_work_email_dept_uniq` (one ACTIVE row per
-- work-email+dept). So we first COLLAPSE each US person to a single keeper row
-- (partitioned by Work Email, NOT by dept) and RETIRE the siblings via
-- off_boarded_at — REVERSIBLE, not deleted, same mechanism as migration #65.
-- Undo SQL is at the bottom.
--
-- NOT touched: the HSL KPI / SSD Medical Records bonus system. That runs off the
-- separate `hsl_team_members` table (all PH staff) — these US master rows were
-- never part of it. employee_hourly_rates has no (work email, dept) unique
-- index, so its update tolerates dupes and needs no collapse.
--
-- ⚠ RUN ORDER: DEPLOY THE NEW CODE FIRST, THEN RUN THIS.
--    The new code adds the 'US Team' -> us_manager_bonus mapping and relabels
--    the department. Running this before the code is live would make
--    normalizeDeptToKey('US Team') return null and temporarily drop these
--    people out of the KPI Calculator / Payroll Wizard until deploy.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 — INSPECT (run this FIRST, on its own, and eyeball it before running
--          the transaction below). Lists every active master row for the US
--          cohort. `keep = 1` is the row that SURVIVES and becomes "US Team";
--          `keep > 1` rows (only appear for people with duplicates) are the
--          siblings that get RETIRED (reversibly). Confirm each keep=1 is the
--          right identity before proceeding.
-- ----------------------------------------------------------------------------
WITH us_emails AS (
  SELECT lower(work_email)     AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND work_email     IS NOT NULL AND work_email     <> ''
  UNION
  SELECT lower(personal_email) AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND personal_email IS NOT NULL AND personal_email <> ''
),
ranked AS (
  SELECT g.id, g."Name", g."Work Email", g."Personal Email", g."Department",
         g."Start Date", g.employee_id, g.last_seen_upload_id,
         row_number() OVER w AS keep,
         count(*)     OVER w AS grp_size
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
    AND  ( lower(g."Work Email")     IN (SELECT email FROM us_emails)
        OR lower(g."Personal Email") IN (SELECT email FROM us_emails) )
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email"))
    ORDER BY (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) DESC NULLS LAST,
             (g."Profile Photo URL" IS NOT NULL) DESC,
             (g.employee_id IS NOT NULL) DESC,
             (g."Start Date" IS NOT NULL AND trim(g."Start Date") <> '') DESC,
             g.id DESC
  )
)
SELECT * FROM ranked ORDER BY "Work Email", keep;


BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 — RESCUE: before retiring the siblings, copy photo / employee_id /
--          start date from any of a person's rows into the keeper where the
--          keeper is missing it. Safe: only fills NULL/empty keeper fields.
-- ----------------------------------------------------------------------------
WITH us_emails AS (
  SELECT lower(work_email)     AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND work_email     IS NOT NULL AND work_email     <> ''
  UNION
  SELECT lower(personal_email) AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND personal_email IS NOT NULL AND personal_email <> ''
),
ranked AS (
  SELECT g.*, row_number() OVER w AS keep
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
    AND  ( lower(g."Work Email")     IN (SELECT email FROM us_emails)
        OR lower(g."Personal Email") IN (SELECT email FROM us_emails) )
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email"))
    ORDER BY (g.last_seen_upload_id = (SELECT id FROM public.master_list_uploads WHERE is_current = TRUE LIMIT 1)) DESC NULLS LAST,
             (g."Profile Photo URL" IS NOT NULL) DESC,
             (g.employee_id IS NOT NULL) DESC,
             (g."Start Date" IS NOT NULL AND trim(g."Start Date") <> '') DESC,
             g.id DESC
  )
),
best AS (
  SELECT lower(trim("Work Email")) AS we,
         (array_agg("Profile Photo URL") FILTER (WHERE "Profile Photo URL" IS NOT NULL))[1] AS photo,
         (array_agg(employee_id)         FILTER (WHERE employee_id IS NOT NULL))[1]         AS emp_id,
         (array_agg("Start Date")        FILTER (WHERE "Start Date" IS NOT NULL AND trim("Start Date") <> ''))[1] AS start_date
  FROM   ranked GROUP BY 1
)
UPDATE public.global_master_list t
SET    "Profile Photo URL" = COALESCE(t."Profile Photo URL", b.photo),
       employee_id         = COALESCE(t.employee_id, b.emp_id),
       "Start Date"        = COALESCE(NULLIF(trim(t."Start Date"), ''), b.start_date)
FROM   ranked r
JOIN   best b ON b.we = lower(trim(r."Work Email"))
WHERE  t.id = r.id AND r.keep = 1;

-- ----------------------------------------------------------------------------
-- STEP 2 — RETIRE the duplicate siblings (REVERSIBLE: sets off_boarded_at, does
--          NOT delete and does NOT set scheduled_deletion_at). Keeps exactly one
--          active row per US Work Email so the relabel in step 3 cannot collide.
-- ----------------------------------------------------------------------------
WITH us_emails AS (
  SELECT lower(work_email)     AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND work_email     IS NOT NULL AND work_email     <> ''
  UNION
  SELECT lower(personal_email) AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND personal_email IS NOT NULL AND personal_email <> ''
),
ranked AS (
  SELECT g.id, row_number() OVER w AS keep
  FROM   public.global_master_list g
  WHERE  g.off_boarded_at IS NULL
    AND  g."Work Email" IS NOT NULL AND trim(g."Work Email") <> ''
    AND  ( lower(g."Work Email")     IN (SELECT email FROM us_emails)
        OR lower(g."Personal Email") IN (SELECT email FROM us_emails) )
  WINDOW w AS (
    PARTITION BY lower(trim(g."Work Email"))
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
       off_boarded_note   = 'US Team consolidation (2026-06-18): collapsed multiple department rows for one US employee into a single US Team row. Reversible.'
FROM   ranked r
WHERE  t.id = r.id AND r.keep > 1;

-- ----------------------------------------------------------------------------
-- STEP 3 — RELABEL the surviving rows. After step 2 there is exactly one active
--          row per US Work Email, so this sets one row per person -> no unique
--          collision. Also removes them from "Hogan Smith Law" / "HR".
-- ----------------------------------------------------------------------------
WITH us_emails AS (
  SELECT lower(work_email)     AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND work_email     IS NOT NULL AND work_email     <> ''
  UNION
  SELECT lower(personal_email) AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND personal_email IS NOT NULL AND personal_email <> ''
)
UPDATE public.global_master_list g
SET    "Department" = 'US Team'
WHERE  g.off_boarded_at IS NULL
  AND  ( lower(g."Work Email")     IN (SELECT email FROM us_emails)
      OR lower(g."Personal Email") IN (SELECT email FROM us_emails) )
  AND  g."Department" IS DISTINCT FROM 'US Team';

-- ----------------------------------------------------------------------------
-- STEP 4 — employee_hourly_rates: the rates cache (feeds Payroll Wizard tab
--          grouping + rates roster fallback). No unique index here, so dupes
--          are fine; just align every US-cohort row to "US Team".
-- ----------------------------------------------------------------------------
WITH us_emails AS (
  SELECT lower(work_email)     AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND work_email     IS NOT NULL AND work_email     <> ''
  UNION
  SELECT lower(personal_email) AS email FROM public.employee_ids
    WHERE employee_id LIKE 'US-%' AND personal_email IS NOT NULL AND personal_email <> ''
)
UPDATE public.employee_hourly_rates r
SET    "Department" = 'US Team'
WHERE  ( lower(r."Work Email")     IN (SELECT email FROM us_emails)
      OR lower(r."Personal Email") IN (SELECT email FROM us_emails) )
  AND  r."Department" IS DISTINCT FROM 'US Team';

COMMIT;

-- ----------------------------------------------------------------------------
-- VERIFY — every active US-cohort master row should read "US Team", exactly one
-- per person, and no active "Hogan Smith Law" / "US Manager Bonus" US rows left:
--
--   SELECT g."Name", g."Work Email", g."Department"
--   FROM public.global_master_list g
--   JOIN public.employee_ids e
--     ON  e.employee_id LIKE 'US-%'
--     AND ( lower(e.work_email) = lower(g."Work Email")
--        OR lower(e.personal_email) = lower(g."Personal Email") )
--   WHERE g.off_boarded_at IS NULL
--   ORDER BY g."Name";
--   -- expect: one row per person, Department = 'US Team'
--
--   SELECT "Work Email", count(*) FROM public.global_master_list
--   WHERE off_boarded_at IS NULL AND "Department" = 'US Team'
--   GROUP BY 1 HAVING count(*) > 1;   -- expect: 0 rows (no dupes survived)
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- UNDO for STEP 2 — re-activate every row this migration retired (only the rows
-- it stamped, so real off-boards are untouched). Note: this restores the
-- duplicate rows, so re-run the collapse afterward if you still want one row.
-- ----------------------------------------------------------------------------
-- UPDATE public.global_master_list
-- SET    off_boarded_at = NULL, off_boarded_reason = NULL, off_boarded_note = NULL
-- WHERE  off_boarded_reason = 'duplicate_cleanup'
--   AND  off_boarded_note LIKE 'US Team consolidation (2026-06-18)%';
