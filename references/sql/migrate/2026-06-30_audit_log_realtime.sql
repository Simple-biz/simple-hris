-- ============================================================
-- Migration: add audit_log to the Realtime publication
-- Purpose:
--   The People-tab "Bank changes" feed (Accounting + CEO) lists recent
--   self-service payout changes, sourced from the append-only public.audit_log
--   (action = 'bank_update.saved'). To let the feed react the instant a change
--   lands — rather than only on the 30s poll — audit_log must emit Realtime
--   change events, which requires membership in the standard `supabase_realtime`
--   publication (same mechanism used for app_settings, payment_dispatches, etc.).
--
--   NOTE: this is the BONUS/direct channel. The feed's RELIABLE trigger is the
--   `people.bank_changes.pulse` key in app_settings (already in the publication
--   and readable by the anon client). If audit_log is RLS-gated from the anon
--   realtime client, the direct channel stays quiet and the pulse + poll carry
--   it — so this migration is a nice-to-have, not a hard dependency.
--
--   Only the NEW row matters on INSERT (the client refetches the server-computed
--   feed on any change), so the default REPLICA IDENTITY is sufficient.
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
        AND tablename  = 'audit_log'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.audit_log';
    END IF;
  END IF;
END $$;

-- Verify (optional):
--   SELECT * FROM pg_publication_tables
--   WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='audit_log';
