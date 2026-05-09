-- Migration: gift_tracker_notes
-- Created: 2026-05-09
--
-- Per-employee free-text notes for the Orphanage dashboard's Gift Tracker
-- tab. Keyed by personal_email (lower-cased) — that's the stable identifier
-- across CSV reloads of global_master_list. One row per employee.
--
-- Idempotent: rerunning is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gift_tracker_notes (
  personal_email TEXT PRIMARY KEY,
  note           TEXT NOT NULL DEFAULT '',
  updated_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.gift_tracker_notes_normalize_email()
RETURNS TRIGGER AS $$
BEGIN
  NEW.personal_email := LOWER(TRIM(NEW.personal_email));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gtn_normalize_email ON public.gift_tracker_notes;
CREATE TRIGGER trg_gtn_normalize_email
  BEFORE INSERT OR UPDATE ON public.gift_tracker_notes
  FOR EACH ROW EXECUTE FUNCTION public.gift_tracker_notes_normalize_email();

COMMIT;
