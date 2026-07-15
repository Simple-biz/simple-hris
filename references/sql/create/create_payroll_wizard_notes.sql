-- Migration: payroll_wizard_notes
-- Created: 2026-07-15
--
-- The Payroll Wizard's floating "Notes" checklist — a running list of
-- carry-over items for the next payroll week (missed bonuses, rate changes,
-- deductions in progress). Mirrors the "Phase 5: Adjustments" block of the
-- old payroll spreadsheet: Date | Payroll Clerk | Done | Worker | Notes.
--
-- One flat list (no per-week partitioning): items are added as they come up
-- and ticked Done once applied in a following week. Access is enforced at the
-- API layer (app/api/payroll-wizard/notes) via the accounting/payroll_wizard
-- feature grant — no RLS, same as the other wizard tables.
--
-- Idempotent: rerunning is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_wizard_notes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_date     TEXT,                             -- free text, e.g. "7/10"
  payroll_clerk TEXT,                             -- who logged / owns the item
  done          BOOLEAN NOT NULL DEFAULT FALSE,   -- applied in a later week
  worker        TEXT,                             -- affected worker (email/name)
  notes         TEXT,                             -- what needs to happen
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.payroll_wizard_notes_touch()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pwn_touch ON public.payroll_wizard_notes;
CREATE TRIGGER trg_pwn_touch
  BEFORE UPDATE ON public.payroll_wizard_notes
  FOR EACH ROW EXECUTE FUNCTION public.payroll_wizard_notes_touch();

-- Realtime: the checklist is a shared board — every clerk with wizard access
-- sees adds/ticks/edits live (useLiveRefresh's poll covers it either way).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='payroll_wizard_notes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_wizard_notes;
    END IF;
  END IF;
END $$;

COMMIT;
