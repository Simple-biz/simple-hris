-- ============================================================
-- Migration: paystub_dispatch_queue
-- Purpose:
--   The Payroll Wizard's "Lock in Values & Send to Payment Dispatch"
--   stages one row per (cycle, employee) here, carrying the AUTHORITATIVE
--   paystub payload the wizard computed (incl. Adj./Orphanage/MESA/dept &
--   KPI bonuses + manual overrides — none of which current-pay.ts can
--   reproduce). Paystub emails are NO LONGER sent in a batch from the wizard.
--   Instead, when Lenny marks a person Paid in Payment Dispatch, the server
--   looks up that one row and fires the n8n paystub webhook for just them.
--
--   `excluded = true` means accounting flagged them "do not pay" in the
--   wizard's Validation step → they surface in Payment Dispatch → Excluded
--   for later reconciliation (they can still be paid from there, which sends
--   their paystub because `payload` is staged regardless of the flag).
--
-- Run in Supabase SQL editor (Dashboard → SQL Editor). Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.paystub_dispatch_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cycle key — the Hubstaff CSV filename is the per-week key across the app.
  cycle_source_file TEXT NOT NULL,

  -- Recipient (snapshotted). recipient_email is the WORK email (the match key
  -- against payment_dispatches.recipient_email); personal_email is where the
  -- paystub is mailed.
  recipient_email   TEXT NOT NULL,
  personal_email    TEXT,
  recipient_name    TEXT,
  department_key    TEXT,

  -- Amounts for display in the Excluded tab even when no payload (USD/PHP).
  amount_php        NUMERIC(12,2),
  amount_usd        NUMERIC(12,2),

  -- pay_period block (top-level n8n shape) + the full per-employee payload
  -- (the exact DispatchEmployee object the old batch dispatch posted to n8n).
  pay_period        JSONB,
  payload           JSONB,

  -- Exclusion: true when accounting marked this person "do not pay" in the
  -- wizard's Validation step. Routes them to Payment Dispatch → Excluded.
  excluded          BOOLEAN NOT NULL DEFAULT false,
  exclude_reason    TEXT,            -- 'do_not_pay' | 'no_personal_email' | free text

  -- Paystub send tracking (stamped by the mark-paid send path).
  sent_at           TIMESTAMPTZ,
  sent_by           TEXT,
  send_count        INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,

  -- When the wizard locked + staged this cycle.
  locked_at         TIMESTAMPTZ,
  locked_by         TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One staged row per (cycle, employee) → enables idempotent re-stages via
  -- ON CONFLICT … DO UPDATE.
  UNIQUE (cycle_source_file, recipient_email)
);

-- Re-run safety: pick up columns added after an earlier CREATE.
ALTER TABLE public.paystub_dispatch_queue
  ADD COLUMN IF NOT EXISTS personal_email TEXT,
  ADD COLUMN IF NOT EXISTS recipient_name TEXT,
  ADD COLUMN IF NOT EXISTS department_key TEXT,
  ADD COLUMN IF NOT EXISTS amount_php     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS amount_usd     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS pay_period     JSONB,
  ADD COLUMN IF NOT EXISTS payload        JSONB,
  ADD COLUMN IF NOT EXISTS excluded       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exclude_reason TEXT,
  ADD COLUMN IF NOT EXISTS sent_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_by        TEXT,
  ADD COLUMN IF NOT EXISTS send_count     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error     TEXT,
  ADD COLUMN IF NOT EXISTS locked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by      TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT now();

-- Lookup indexes.
CREATE INDEX IF NOT EXISTS idx_paystub_queue_cycle
  ON public.paystub_dispatch_queue (cycle_source_file);

CREATE INDEX IF NOT EXISTS idx_paystub_queue_recipient
  ON public.paystub_dispatch_queue (lower(recipient_email));

CREATE INDEX IF NOT EXISTS idx_paystub_queue_cycle_recipient
  ON public.paystub_dispatch_queue (cycle_source_file, lower(recipient_email));

CREATE INDEX IF NOT EXISTS idx_paystub_queue_excluded
  ON public.paystub_dispatch_queue (cycle_source_file, excluded);

-- Reuse the project-wide email normalization trigger (migration #5) so the
-- work email always lands lowercased/trimmed regardless of caller.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS paystub_queue_norm_email ON public.paystub_dispatch_queue;
    CREATE TRIGGER paystub_queue_norm_email
      BEFORE INSERT OR UPDATE ON public.paystub_dispatch_queue
      FOR EACH ROW
      EXECUTE FUNCTION normalize_email_column('recipient_email');
  END IF;
END $$;

-- updated_at bump on every UPDATE (re-stages, send stamps, etc.). Reuse a
-- shared touch function if one exists; otherwise create a local one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'paystub_queue_touch_updated_at') THEN
    CREATE FUNCTION public.paystub_queue_touch_updated_at()
    RETURNS TRIGGER AS $fn$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS paystub_queue_set_updated_at ON public.paystub_dispatch_queue;
CREATE TRIGGER paystub_queue_set_updated_at
  BEFORE UPDATE ON public.paystub_dispatch_queue
  FOR EACH ROW
  EXECUTE FUNCTION public.paystub_queue_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Realtime: the per-cycle "values locked" flag lives in app_settings under
-- `payroll.dispatch_lock.<sourceFile>`. Payment Dispatch reacts to lock/unlock
-- LIVE via Supabase Realtime, which only fires if `app_settings` is a member of
-- the `supabase_realtime` publication. Migration #12 added it; this re-asserts
-- it idempotently so the lock is guaranteed live even if #12 was skipped.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = 'app_settings'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings';
    END IF;
  END IF;
END $$;

-- Verify the lock will be live (expect one row after this migration):
--   SELECT * FROM pg_publication_tables
--   WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='app_settings';
