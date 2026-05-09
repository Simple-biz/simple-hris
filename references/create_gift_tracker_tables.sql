-- Migration: gift_tracker tables (catalog + payments)
-- Created: 2026-05-09
--
-- Backs the Orphanage Dashboard's Gift Tracker tab with proper Supabase
-- tables instead of `app_settings` JSON blobs.
--
--   gift_catalog  — singleton row (id = 1) holding the catalog payload
--                    (items, anniversaries, suggestions) as JSONB.
--   gift_payments — one row per vendor batch payment. Vendor profile,
--                    bank list, and line items live in JSONB columns
--                    because their shape is freeform per record.
--
-- Idempotent: rerunning is safe.

BEGIN;

-- ─── gift_catalog (singleton) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gift_catalog (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  items         JSONB NOT NULL DEFAULT '[]'::jsonb,
  anniversaries JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggestions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the singleton row if it doesn't exist yet.
INSERT INTO public.gift_catalog (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.gift_catalog_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gift_catalog_updated_at ON public.gift_catalog;
CREATE TRIGGER trg_gift_catalog_updated_at
  BEFORE UPDATE ON public.gift_catalog
  FOR EACH ROW EXECUTE FUNCTION public.gift_catalog_touch_updated_at();

-- ─── gift_payments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gift_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_email TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  period_label    TEXT NOT NULL DEFAULT '',
  batch_label     TEXT NOT NULL DEFAULT '',

  -- Vendor profile + bank list. Shape:
  -- { name, phone, email, street, city, province, postal_code, full_address,
  --   banks: [{ label, bank_name, account_holder, account_number,
  --             routing_number, email }, ...] }
  vendor          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Line items array. Shape:
  -- [{ id, name, quantity, unit_price }, ...]
  items           JSONB NOT NULL DEFAULT '[]'::jsonb,

  shipping_fee    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ordered_by      TEXT NOT NULL DEFAULT '',
  total_usd       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  transaction_id  TEXT NOT NULL DEFAULT '',
  staff           TEXT NOT NULL DEFAULT '',
  date_sent       DATE,
  arrival_date    DATE,
  our_bank        TEXT NOT NULL DEFAULT '',

  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'paid', 'cancelled')),
  notes           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_gift_payments_created_by
  ON public.gift_payments (LOWER(created_by_email));
CREATE INDEX IF NOT EXISTS idx_gift_payments_created_at
  ON public.gift_payments (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gift_payments_status
  ON public.gift_payments (status);

CREATE OR REPLACE FUNCTION public.gift_payments_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.created_by_email IS NOT NULL THEN
    NEW.created_by_email := LOWER(TRIM(NEW.created_by_email));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gift_payments_updated_at ON public.gift_payments;
CREATE TRIGGER trg_gift_payments_updated_at
  BEFORE INSERT OR UPDATE ON public.gift_payments
  FOR EACH ROW EXECUTE FUNCTION public.gift_payments_touch_updated_at();

COMMIT;
