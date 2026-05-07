-- ============================================================
-- HSL Agents · upload-archive migration
-- ============================================================
-- Source sheet: HOGAN SMITH AGENT PAY PLAN
--   https://docs.google.com/spreadsheets/d/<id>/edit
--   Tab: "Hogan Agents Pay Plan"
--   Columns synced (left → right on the sheet):
--     A: Department/ Role     → role_raw
--     B: Full Name            → full_name
--     C: HSL Name             → hsl_name
--     D: Email                → email   (identity key, lowercased)
--     E: Hourly Rate          → hourly_rate
--     F: OT rate              → ot_rate
--     G: KPI/Bonus            → kpi_bonus  (NEW column added by this migration)
--   Columns IGNORED on sync:  Scoreboard, Notes  (transient editorial text)
--
-- Architecture mirrors hubstaff_uploads / master_list_uploads / rates_uploads:
--   - Each click of "Sync from Google Sheet" inserts ONE hsl_agent_uploads row.
--   - All sheet rows are upserted into hsl_team_members keyed on LOWER(email),
--     with their upload_id stamped to the new upload.
--   - The new upload is promoted to is_current = TRUE; all priors flipped to FALSE.
--   - A view `active_hsl_agents` filters hsl_team_members to rows whose
--     upload_id matches the current upload (= roster of the latest sync).
--
-- Run order: this whole file is idempotent. Safe to re-run.
-- Run as: a user with privileges to create tables/views in `public` (typically
-- the Supabase service role or an SQL editor session).
-- ============================================================

-- ─── 1. Archive table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hsl_agent_uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file  text,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  uploaded_by  text,
  row_count    integer,
  is_current   boolean NOT NULL DEFAULT false
);

-- Only one upload may be flagged is_current = TRUE at any time.
CREATE UNIQUE INDEX IF NOT EXISTS hsl_agent_uploads_one_current_idx
  ON public.hsl_agent_uploads (is_current)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS hsl_agent_uploads_uploaded_at_idx
  ON public.hsl_agent_uploads (uploaded_at DESC);

-- ─── 2. Extend hsl_team_members ───────────────────────────────
-- New columns: kpi_bonus (synced from the sheet), upload_id (which sync set it).
-- Both are nullable so this migration is non-breaking on existing rows.
ALTER TABLE public.hsl_team_members
  ADD COLUMN IF NOT EXISTS kpi_bonus  text,
  ADD COLUMN IF NOT EXISTS upload_id  uuid REFERENCES public.hsl_agent_uploads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS hsl_team_members_upload_id_idx
  ON public.hsl_team_members (upload_id);

-- ─── 3. Legacy backfill upload ────────────────────────────────
-- Stamp every existing hsl_team_members row with a synthetic "legacy_backfill"
-- upload that's flagged is_current=TRUE. This way the active_hsl_agents view
-- shows the existing roster immediately, before the first real sync runs.
DO $$
DECLARE
  legacy_id uuid;
  existing_rows int;
BEGIN
  -- If a legacy_backfill row already exists, reuse its id (re-runs are no-ops).
  SELECT id INTO legacy_id
  FROM public.hsl_agent_uploads
  WHERE source_file = 'legacy_backfill'
  LIMIT 1;

  IF legacy_id IS NULL THEN
    SELECT count(*) INTO existing_rows FROM public.hsl_team_members;

    INSERT INTO public.hsl_agent_uploads (source_file, uploaded_by, row_count, is_current)
    VALUES ('legacy_backfill', 'migration', existing_rows, true)
    RETURNING id INTO legacy_id;
  END IF;

  UPDATE public.hsl_team_members
  SET upload_id = legacy_id
  WHERE upload_id IS NULL;
END $$;

-- ─── 4. Active view ───────────────────────────────────────────
-- The roster used by HRIS is whatever's tagged with the current upload.
-- Drop+recreate so column-set changes propagate on re-runs.
DROP VIEW IF EXISTS public.active_hsl_agents;
CREATE VIEW public.active_hsl_agents AS
SELECT
  m.email,
  m.full_name,
  m.hsl_name,
  m.role_raw           AS "Department/Role",
  m.kpi_bonus          AS "KPI/Bonus",
  m.dept_key,
  m.is_manager,
  m.hourly_rate,
  m.ot_rate,
  m.upload_id,
  m.created_at,
  m.updated_at
FROM public.hsl_team_members m
WHERE m.upload_id = (
  SELECT id FROM public.hsl_agent_uploads WHERE is_current = true LIMIT 1
);

-- ─── 5. Grants ─────────────────────────────────────────────────
-- service_role bypasses RLS automatically, but we set explicit grants on the
-- view so authenticated readers (logged-in HRIS users) can see the active
-- roster through PostgREST without needing the service role key.
GRANT SELECT ON public.active_hsl_agents TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hsl_team_members  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hsl_agent_uploads TO service_role;

-- ─── 6. Verify ─────────────────────────────────────────────────
-- Quick sanity check: should print one row with row_count = number of HSL agents,
-- is_current = true, and source_file = 'legacy_backfill' (or the latest sync's filename).
SELECT id, source_file, uploaded_at, row_count, is_current
FROM public.hsl_agent_uploads
ORDER BY uploaded_at DESC
LIMIT 5;

-- And: count of rows visible through the active view should match the
-- "row_count" of the current upload.
SELECT
  (SELECT row_count FROM public.hsl_agent_uploads WHERE is_current = true LIMIT 1) AS current_upload_row_count,
  (SELECT count(*) FROM public.active_hsl_agents) AS active_view_count;
