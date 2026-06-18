-- Migration: orphanage_budget_requests
-- Created: 2026-05-09
--
-- Stores orphanage Budget Request submissions with one-stage Accounting
-- approval (pending → approved | rejected). State changes append to the
-- existing public.audit_log table; no custom audit table.
--
-- Idempotent: rerunning is safe (uses IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.orphanage_budget_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_email TEXT NOT NULL,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  visit_type   TEXT NOT NULL CHECK (visit_type IN ('monthly', 'frequent', 'special')),
  mission_trip BOOLEAN NOT NULL DEFAULT FALSE,
  notes        TEXT,

  -- Snapshotted totals so the history list doesn't have to re-derive them
  -- from `payload`. Currency: PHP.
  subtotal     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  leftover     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,

  -- Visit-specific fields. JSONB blob — the application reads back whichever
  -- keys match `visit_type`:
  --   monthly:  { dateOfVisit, children, celebrants, gift, lootbag, cake,
  --              grocery, food, travel, misc, miscExplain, collaborators,
  --              directGiving, giftEfficiency }
  --   frequent: { travelers }
  --   special:  { description }
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Bank account snapshotted at submit so later profile edits don't silently
  -- change historical records.
  bank_account_name   TEXT NOT NULL,
  bank_account_number TEXT NOT NULL,
  bank_name           TEXT NOT NULL,
  swift_code          TEXT NOT NULL,

  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obr_submitter_email
  ON public.orphanage_budget_requests (LOWER(submitter_email));
CREATE INDEX IF NOT EXISTS idx_obr_status
  ON public.orphanage_budget_requests (status);
CREATE INDEX IF NOT EXISTS idx_obr_submitted_at
  ON public.orphanage_budget_requests (submitted_at DESC);

-- Lower-case the submitter email on every write so application-side
-- normEmail matches the persisted value.
CREATE OR REPLACE FUNCTION public.orphanage_budget_normalize_email()
RETURNS TRIGGER AS $$
BEGIN
  NEW.submitter_email := LOWER(TRIM(NEW.submitter_email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_obr_normalize_email ON public.orphanage_budget_requests;
CREATE TRIGGER trg_obr_normalize_email
  BEFORE INSERT OR UPDATE ON public.orphanage_budget_requests
  FOR EACH ROW EXECUTE FUNCTION public.orphanage_budget_normalize_email();

-- Touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION public.orphanage_budget_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_obr_set_updated_at ON public.orphanage_budget_requests;
CREATE TRIGGER trg_obr_set_updated_at
  BEFORE UPDATE ON public.orphanage_budget_requests
  FOR EACH ROW EXECUTE FUNCTION public.orphanage_budget_set_updated_at();

COMMIT;
