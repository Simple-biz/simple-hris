-- Migration: orphanages
-- Created: 2026-06-04
--
-- Master directory of partner orphanages, manager-maintained from the
-- "Orphanage Budget > Orphanages" tab. Replaces the former hardcoded
-- 14-entry seed in OrphanagesPanel.tsx -- the table now starts empty and
-- managers add rows via the "Add orphanage" button (name, location, number
-- of children, phone, email, leftover budget, and an optional photo).
--
-- `leftover_budget` drives the "Leftover from prev month" defaults on the
-- orphanage budget request form. Photos live in the `orphanage-photos`
-- Storage bucket (public read); `image_url` holds the resolved public URL.
--
-- Idempotent: rerunning is safe (uses IF NOT EXISTS / OR REPLACE /
-- DROP TRIGGER IF EXISTS / ON CONFLICT DO NOTHING).

BEGIN;

CREATE TABLE IF NOT EXISTS public.orphanages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name            TEXT NOT NULL,
  location        TEXT,
  children        INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  phone           TEXT,
  email           TEXT,

  -- Currency: PHP. Carried over month-to-month as the budget-form default.
  leftover_budget NUMERIC(12, 2) NOT NULL DEFAULT 0,

  -- Public URL of the orphanage photo in the `orphanage-photos` bucket.
  image_url       TEXT,

  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orphanages_name
  ON public.orphanages (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_orphanages_created_at
  ON public.orphanages (created_at DESC);

-- Touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION public.orphanages_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orphanages_set_updated_at ON public.orphanages;
CREATE TRIGGER trg_orphanages_set_updated_at
  BEFORE UPDATE ON public.orphanages
  FOR EACH ROW EXECUTE FUNCTION public.orphanages_set_updated_at();

-- ---------------------------------------------------------------------------
-- Storage bucket for orphanage photos (public read). The upload route writes
-- with the service-role key, so no INSERT policy is required; we only add a
-- public SELECT policy so the returned public URLs render in the cards.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('orphanage-photos', 'orphanage-photos', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

DROP POLICY IF EXISTS "Public read orphanage photos" ON storage.objects;
CREATE POLICY "Public read orphanage photos"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'orphanage-photos');

COMMIT;
