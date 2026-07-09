-- Migration: orphanage_vendors + orphanage_vendor_invoices  (#108)
-- Created: 2026-07-09
--
-- 3rd-party VENDORS the Orphanage pays for goods/services (a plumber's supply
-- shop, a printer, a caterer, etc.) + the INVOICES raised against them.
--
-- This is a SELF-CONTAINED payment surface that DELIBERATELY does NOT touch the
-- payroll-clerk Payment Dispatch machinery (orphanage_dispatches / payment_
-- dispatches). No n8n automation fires when an invoice is created — the Orphanage
-- Manager simply builds a SIMPLE-branded invoice from a saved vendor and, when
-- they've sent the money, marks it paid (a diagonal "PAID" watermark stamps the
-- rendered invoice). Lives entirely in the Orphanage dashboard's "3rd party
-- vendors" tab (see src/components/orphanage/ThirdPartyVendorsPanel.tsx).
--
-- Idempotent: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS).

BEGIN;

-- ── Vendor directory ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orphanage_vendors (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  business_name       TEXT          NOT NULL,                       -- e.g. "Cebu Hardware Supply Co."
  contact_name        TEXT,                                         -- the person to reach
  contact_email       TEXT,
  contact_phone       TEXT,

  -- Address (kept as a couple of free-text lines + city/country so it renders
  -- cleanly on the invoice without forcing a rigid schema on foreign vendors).
  address_line1       TEXT,
  address_line2       TEXT,
  city                TEXT,
  country             TEXT,

  products_services   TEXT,                                         -- what the vendor supplies (a few lines)
  payables            TEXT,                                         -- what Simple specifically needs to pay for

  -- Banking. A vendor is either SWIFT+account (intl wire) OR routing+account
  -- (domestic). Both stored; the invoice/UI shows whichever is filled.
  bank_name           TEXT          NOT NULL DEFAULT '',
  account_holder_name TEXT          NOT NULL DEFAULT '',
  account_number      TEXT          NOT NULL DEFAULT '',
  swift_code          TEXT          NOT NULL DEFAULT '',
  routing_number      TEXT          NOT NULL DEFAULT '',

  note                TEXT,

  created_by          TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orphanage_vendors_name_idx
  ON public.orphanage_vendors (lower(business_name));

-- ── Invoices raised against a vendor ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orphanage_vendor_invoices (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source vendor. ON DELETE SET NULL keeps historical/paid invoices intact if a
  -- vendor is later removed from the directory — the snapshot columns below carry
  -- everything the invoice document needs to still render.
  vendor_id           UUID          REFERENCES public.orphanage_vendors(id) ON DELETE SET NULL,

  invoice_number      TEXT          NOT NULL,                       -- human ref, e.g. "INV-20260709-4821"
  invoice_date        DATE          NOT NULL DEFAULT current_date,
  due_date            DATE,

  -- Vendor snapshot at create-time (survives vendor edits/deletes).
  vendor_name         TEXT          NOT NULL DEFAULT '',
  vendor_contact_name TEXT,
  vendor_email        TEXT,
  vendor_phone        TEXT,
  vendor_address      TEXT,                                         -- pre-joined multi-line address for the doc

  -- Banking snapshot (where the money goes).
  bank_name           TEXT          NOT NULL DEFAULT '',
  account_holder_name TEXT          NOT NULL DEFAULT '',
  account_number      TEXT          NOT NULL DEFAULT '',
  swift_code          TEXT          NOT NULL DEFAULT '',
  routing_number      TEXT          NOT NULL DEFAULT '',

  -- Line items: [{ description, quantity, unit_price, amount }]. JSONB so the
  -- builder can add/remove rows freely; total_amount is the authoritative sum.
  line_items          JSONB         NOT NULL DEFAULT '[]'::jsonb,
  total_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes               TEXT,

  status              TEXT          NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'paid')),

  -- Payment record, filled when the manager marks it paid (self-contained — no
  -- orphanage_dispatches / payment_dispatches row is ever created).
  paid_by             TEXT,
  paid_at             TIMESTAMPTZ,
  paid_transaction_id TEXT,
  paid_bank_used      TEXT,
  paid_sent_date      DATE,
  paid_note           TEXT,

  created_by          TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orphanage_vendor_invoices_status_idx
  ON public.orphanage_vendor_invoices (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orphanage_vendor_invoices_vendor_idx
  ON public.orphanage_vendor_invoices (vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS orphanage_vendor_invoices_number_uniq
  ON public.orphanage_vendor_invoices (invoice_number);

-- ── updated_at triggers ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_orphanage_vendors_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orphanage_vendors_updated_at ON public.orphanage_vendors;
CREATE TRIGGER trg_orphanage_vendors_updated_at
  BEFORE UPDATE ON public.orphanage_vendors
  FOR EACH ROW EXECUTE FUNCTION public.set_orphanage_vendors_updated_at();

CREATE OR REPLACE FUNCTION public.set_orphanage_vendor_invoices_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orphanage_vendor_invoices_updated_at ON public.orphanage_vendor_invoices;
CREATE TRIGGER trg_orphanage_vendor_invoices_updated_at
  BEFORE UPDATE ON public.orphanage_vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_orphanage_vendor_invoices_updated_at();

-- ── Realtime (best-effort) ───────────────────────────────────────────────────
-- The tab loads via fetch + manual Refresh today, so this only makes a future
-- live subscription POSSIBLE — it does not itself make the tab live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.orphanage_vendors;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.orphanage_vendor_invoices;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

COMMIT;

-- Verification:
-- select business_name, swift_code, routing_number from public.orphanage_vendors order by created_at desc;
-- select invoice_number, vendor_name, total_amount, status, paid_at from public.orphanage_vendor_invoices order by created_at desc;
