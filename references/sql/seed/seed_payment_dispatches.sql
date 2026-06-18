-- ============================================================
-- Migration: payment_dispatches table + dispatch lock setting
-- Purpose:
--   1. Persist a per-cycle log of who Lenny paid (table)
--   2. Add a global "payroll being processed" lock employees can
--      see live via Supabase Realtime (app_settings row +
--      publication membership)
-- Run in Supabase SQL editor (Dashboard → SQL Editor).
-- ============================================================

-- Step 1 — payment_dispatches
CREATE TABLE IF NOT EXISTS public.payment_dispatches (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cycle context (snapshotted so old logs survive cycle deletion)
  cycle_id                 UUID REFERENCES public.hubstaff_uploads(id) ON DELETE SET NULL,
  cycle_period_start       DATE,
  cycle_period_end         DATE,
  cycle_source_file        TEXT,

  -- Recipient (snapshotted)
  recipient_email          TEXT NOT NULL,
  recipient_name           TEXT,

  -- Processor + bank (raw is the snapshot of "Bank Preferred" cell)
  processor                TEXT NOT NULL,
  bank_preferred_raw       TEXT,

  -- Recipient banking details snapshotted at dispatch time. These describe
  -- where the money went TO — distinct from `bank_used` (where it came FROM).
  -- All nullable since not every processor needs every field (Hurupay/Wepay
  -- only need an email; wires need account + SWIFT + address).
  recipient_preferred_bank TEXT,
  recipient_account_number TEXT,
  recipient_account_holder TEXT,
  recipient_swift_code     TEXT,

  -- Amounts (both currencies — UI shows both)
  amount_usd               NUMERIC(10,2),
  amount_php               NUMERIC(12,2),

  -- Manual confirmation fields Lenny enters
  transaction_id           TEXT NOT NULL,
  bank_used                TEXT NOT NULL,
  sent_date                DATE NOT NULL,
  arrival_date             DATE,

  -- Outcome of this dispatch attempt. 'paid' is the happy path; the others
  -- let Lenny log a row even when payment didn't go through cleanly so the
  -- person stays visible for retry.
  status                   TEXT NOT NULL DEFAULT 'paid'
                           CHECK (status IN ('paid', 'not_paid', 'threshold', 'problem')),
  note                     TEXT,

  -- Audit
  created_by               TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Re-run safety: if the table already exists from an earlier migration run,
-- add any new columns introduced after the original CREATE.
ALTER TABLE public.payment_dispatches
  ADD COLUMN IF NOT EXISTS recipient_preferred_bank TEXT,
  ADD COLUMN IF NOT EXISTS recipient_account_number TEXT,
  ADD COLUMN IF NOT EXISTS recipient_account_holder TEXT,
  ADD COLUMN IF NOT EXISTS recipient_swift_code     TEXT,
  ADD COLUMN IF NOT EXISTS status                   TEXT NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS note                     TEXT;

-- The CHECK constraint is added separately so re-running this migration is
-- safe even if status was added by an earlier run without the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.payment_dispatches'::regclass
      AND conname  = 'payment_dispatches_status_check'
  ) THEN
    ALTER TABLE public.payment_dispatches
      ADD CONSTRAINT payment_dispatches_status_check
      CHECK (status IN ('paid', 'not_paid', 'threshold', 'problem'));
  END IF;
END $$;

-- Index on status so `paid` rows can be filtered out of pending queues fast.
CREATE INDEX IF NOT EXISTS idx_payment_dispatches_status
  ON public.payment_dispatches (status);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_payment_dispatches_cycle
  ON public.payment_dispatches (cycle_id);

CREATE INDEX IF NOT EXISTS idx_payment_dispatches_recipient
  ON public.payment_dispatches (lower(recipient_email));

CREATE INDEX IF NOT EXISTS idx_payment_dispatches_cycle_recipient
  ON public.payment_dispatches (cycle_id, lower(recipient_email));

-- Reuse the project-wide email normalization trigger (created by migration #5)
-- so `recipient_email` always lands lowercased/trimmed regardless of caller.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS payment_dispatches_norm_email ON public.payment_dispatches;
    CREATE TRIGGER payment_dispatches_norm_email
      BEFORE INSERT OR UPDATE ON public.payment_dispatches
      FOR EACH ROW
      EXECUTE FUNCTION normalize_email_column('recipient_email');
  END IF;
END $$;


-- Step 2 — dispatch lock seed in app_settings
-- Three keys: the boolean flag + audit metadata for who/when last toggled it.
INSERT INTO public.app_settings (key, value)
VALUES
  ('payroll.dispatch_locked',     'false'),
  ('payroll.dispatch_locked_at',  ''),
  ('payroll.dispatch_locked_by',  '')
ON CONFLICT (key) DO NOTHING;


-- Step 3 — make app_settings emit Realtime change events
-- The standard Supabase publication is `supabase_realtime`. We add
-- app_settings to it so the employee dashboard can subscribe to lock-flag
-- flips without polling. Idempotent: skips if already a member.
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
