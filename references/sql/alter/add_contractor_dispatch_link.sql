-- ============================================================
-- Contractors as first-class Payment Dispatch payees
--
-- Apply with:  node scripts/apply-contractor-dispatch-migration.mjs
-- (needs DATABASE_URL — the Supabase Postgres connection string — in .env.local)
--
-- Idempotent and safe to re-run. Four parts; PART 4 IS NOT OPTIONAL.
--
--   1. contractor_invoices  → dispatch link, so "already paid" is per-INVOICE.
--   2. payment_dispatches   → payee discriminator + the double-pay guard.
--   3. release trigger      → makes "send back to the pay processor" (Undo)
--                             self-reversing. Undo deletes dispatch rows blind
--                             by id (app/api/payment-dispatches/undo/route.ts),
--                             so without this an undone invoice would stay
--                             claimed forever: money owed, invoice unpayable.
--   4. clobber guard        → sync_disbursement_from_dispatch() currently fires
--                             on EVERY payment_dispatches insert and matches
--                             only on (cycle_source_file, recipient_email) with
--                             no payee awareness. Paying a contractor invoice
--                             for someone who ALSO has an employee disbursement
--                             record that week would silently overwrite that
--                             employee's status/paid_amount_usd/paid_at/
--                             bank_used/transaction_id — an unpaid employee
--                             would render as PAID.
-- ============================================================

BEGIN;

-- ── PART 1 — invoice → dispatch link ────────────────────────────────────────
-- dispatch_claimed_at is stamped BEFORE the dispatch row is written (the claim),
-- dispatch_id after it (the settlement). Both are cleared by the PART 3 trigger.
-- last_dispatched_at is never cleared — it is historical breadcrumb only.
ALTER TABLE public.contractor_invoices
  ADD COLUMN IF NOT EXISTS dispatch_id uuid REFERENCES public.payment_dispatches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_dispatched_at timestamptz;

COMMENT ON COLUMN public.contractor_invoices.dispatch_id IS
  'payment_dispatches row that settled this invoice. NULL = still payable. Cleared automatically when that dispatch row is deleted (Undo).';
COMMENT ON COLUMN public.contractor_invoices.dispatch_claimed_at IS
  'Set immediately before a paid dispatch row is written, so two concurrent Mark Paid clicks cannot both settle this invoice.';
COMMENT ON COLUMN public.contractor_invoices.last_dispatched_at IS
  'Informational: when this invoice was last dispatched, retained across an Undo.';

CREATE INDEX IF NOT EXISTS contractor_invoices_dispatch_id_idx
  ON public.contractor_invoices (dispatch_id);

-- Covers the dispatch-queue read: approved AND unclaimed.
CREATE INDEX IF NOT EXISTS contractor_invoices_payable_idx
  ON public.contractor_invoices (status)
  WHERE dispatch_id IS NULL AND dispatch_claimed_at IS NULL;


-- ── PART 2 — payee discriminator + double-pay guard ─────────────────────────
ALTER TABLE public.payment_dispatches
  ADD COLUMN IF NOT EXISTS payee_type text NOT NULL DEFAULT 'employee',
  ADD COLUMN IF NOT EXISTS contractor_invoice_id uuid REFERENCES public.contractor_invoices(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payment_dispatches.payee_type IS
  'employee (hourly payroll) or contractor (settles one approved contractor_invoices row). Drives the Contractor badge in Done/Reports/history and the payee_type guard in sync_disbursement_from_dispatch().';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payment_dispatches'::regclass
       AND conname  = 'payment_dispatches_payee_type_check'
  ) THEN
    ALTER TABLE public.payment_dispatches
      ADD CONSTRAINT payment_dispatches_payee_type_check
      CHECK (payee_type IN ('employee', 'contractor'));
  END IF;
END $$;

-- One PAID dispatch per invoice, enforced by the database.
-- The `status = 'paid'` predicate is load-bearing: a 'problem' / 'not_paid' /
-- 'threshold' attempt writes a row WITHOUT claiming the invoice, and the clerk
-- must be able to retry. Without the predicate that first failed attempt would
-- occupy the unique slot and the retry could never insert.
CREATE UNIQUE INDEX IF NOT EXISTS payment_dispatches_contractor_invoice_paid_uniq
  ON public.payment_dispatches (contractor_invoice_id)
  WHERE contractor_invoice_id IS NOT NULL AND status = 'paid';


-- ── PART 3 — make Undo self-reversing ──────────────────────────────────────
-- Mirrors the existing unsync_disbursement_from_dispatch() idiom in
-- seed_disbursement_records_sync.sql.
CREATE OR REPLACE FUNCTION public.release_contractor_invoice_on_dispatch_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Branch 1 (ci.dispatch_id = OLD.id) is the normal reversal: this row is the one
  -- that settled the invoice.
  --
  -- Branch 2 is a belt-and-braces fallback for a row that carries the invoice id
  -- without being the settling row, and it MUST NOT fire while some OTHER paid row
  -- still settles that invoice. Deleting a 'problem' retry marker would otherwise
  -- release an invoice that was genuinely paid afterwards: it would reappear in the
  -- queue as owed, and re-paying it would then die on the unique index — a standing
  -- phantom debt is exactly how a second, out-of-band payment gets made.
  UPDATE public.contractor_invoices ci
     SET dispatch_id         = NULL,
         dispatch_claimed_at = NULL
   WHERE ci.dispatch_id = OLD.id
      OR (
        OLD.status = 'paid'
        AND ci.id = OLD.contractor_invoice_id
        AND NOT EXISTS (
          SELECT 1
            FROM public.payment_dispatches pd
           WHERE pd.contractor_invoice_id = ci.id
             AND pd.status = 'paid'
             AND pd.id <> OLD.id
        )
      );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_dispatches_release_contractor_invoice ON public.payment_dispatches;
CREATE TRIGGER payment_dispatches_release_contractor_invoice
  AFTER DELETE ON public.payment_dispatches
  FOR EACH ROW
  EXECUTE FUNCTION public.release_contractor_invoice_on_dispatch_delete();


-- ── PART 4 — MANDATORY clobber guard ───────────────────────────────────────
-- Same body as seed_disbursement_records_sync.sql, plus one early return.
-- CREATE OR REPLACE is enough — the existing trigger picks up the new body, so
-- the trigger itself is deliberately NOT recreated here.
CREATE OR REPLACE FUNCTION public.sync_disbursement_from_dispatch()
RETURNS TRIGGER AS $$
BEGIN
  -- Contractor payments settle an invoice, not an hourly disbursement record.
  IF COALESCE(NEW.payee_type, 'employee') <> 'employee' THEN
    RETURN NEW;
  END IF;

  UPDATE public.disbursement_records dr
  SET
    status          = NEW.status,
    paid_amount_usd = CASE WHEN NEW.status = 'paid' THEN NEW.amount_usd ELSE NULL END,
    paid_at         = CASE WHEN NEW.status = 'paid' THEN NEW.sent_date ELSE NULL END,
    bank_used       = NEW.bank_used,
    transaction_id  = NEW.transaction_id,
    dispatch_id     = NEW.id,
    updated_at      = now()
  WHERE dr.source_file = NEW.cycle_source_file
    AND LOWER(dr.recipient_email) = LOWER(NEW.recipient_email);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The DELETE-side sibling (unsync_disbursement_from_dispatch) needs no guard:
-- it matches on dr.dispatch_id = OLD.id, and a contractor dispatch never
-- writes its id onto a disbursement_records row thanks to the guard above.

COMMIT;
