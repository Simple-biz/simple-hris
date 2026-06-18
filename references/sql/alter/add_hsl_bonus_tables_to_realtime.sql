-- ─────────────────────────────────────────────────────────────────────────────
-- Add the HSL KPI Calculator's data tables to the `supabase_realtime`
-- publication so the manager's calculator updates LIVE as other scorers edit.
--
-- The KPI Calculator (HSL branch view, src/components/manager/HslBonusCalculator.tsx)
-- subscribes to `postgres_changes` on these tables via useLiveRefresh. Realtime
-- only fires if the table is a member of the publication. Without this the UI
-- still stays fresh via the 30s polling fallback + tab-focus refresh — this just
-- upgrades it to near-instant.
--
-- `bonus_catalog_applied` (the non-HSL Departments calculator) is already in the
-- publication via references/create_bonus_catalog_applied.sql, so it is not
-- repeated here.
--
-- Idempotent + guarded: safe to run repeatedly, and a no-op if the publication
-- doesn't exist (e.g. a local DB without Realtime).
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = 'hsl_bonus_entries'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.hsl_bonus_entries';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname    = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = 'hsl_bonus_period_status'
    ) THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.hsl_bonus_period_status';
    END IF;
  END IF;
END $$;

-- Verify both tables will be live (expect two rows after this migration):
--   SELECT tablename FROM pg_publication_tables
--   WHERE pubname='supabase_realtime' AND schemaname='public'
--     AND tablename IN ('hsl_bonus_entries','hsl_bonus_period_status');
