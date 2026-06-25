-- ============================================================
-- Migration: add payment_dispatches to the Realtime publication
-- Purpose:
--   The CEO Overview "Payments to send" card counts DOWN live as each
--   employee is paid. A payment is recorded by INSERTing a row into
--   public.payment_dispatches (status='paid'); an Undo DELETEs it. To let
--   the CEO dashboard react the instant that happens — rather than polling —
--   the table must emit Realtime change events, which requires membership in
--   the standard `supabase_realtime` publication (same mechanism used for
--   app_settings, employee_notifications, the HSL bonus tables, etc.).
--
--   We don't need the OLD row on DELETE (the client just refetches the
--   server-computed count for the current cycle on any change), so the
--   default REPLICA IDENTITY is sufficient — no need for REPLICA IDENTITY FULL.
--
-- Run in Supabase SQL editor (Dashboard → SQL Editor). Idempotent.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = 'payment_dispatches'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_dispatches';
    END IF;
  END IF;
END $$;

-- Verify (optional):
--   SELECT * FROM pg_publication_tables
--   WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='payment_dispatches';
