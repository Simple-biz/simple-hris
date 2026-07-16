-- ============================================================================
-- Tickets board — archive instead of delete + per-ticket edit history
-- (2026-07-16)
--
-- 1. Tickets are never hard-deleted anymore. "Delete" becomes ARCHIVE:
--    `archived_at` / `archived_by` mark the ticket as off the board; it stays
--    queryable in the board's new Archived view and can be restored by its
--    creator or an admin. Existing rows are untouched (archived_at NULL).
--
-- 2. `ticket_events` records the history trail shown in the ticket dialog:
--    who created / edited / moved / archived / restored a ticket, with a
--    field-level diff (`changes` jsonb: [{field, from, to}]) for edits. Rows
--    are written by the API on every write and are immutable.
--
-- ⚠️ RUN ORDER: run this BEFORE deploying the new code (the new API selects
--    archived_at/archived_by, which 500s until these columns exist; the old
--    code simply ignores them). Idempotent.
-- ============================================================================

BEGIN;

-- 1. Archive columns on tickets --------------------------------------------
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by text;

-- The board always filters on this; partial index keeps it cheap either way.
CREATE INDEX IF NOT EXISTS tickets_active_idx
  ON public.tickets (status, position)
  WHERE archived_at IS NULL;

-- 2. ticket_events — the per-ticket history trail ---------------------------
CREATE TABLE IF NOT EXISTS public.ticket_events (
  id            uuid          primary key default gen_random_uuid(),
  ticket_id     uuid          not null references public.tickets(id) on delete cascade,
  action        text          not null
                              check (action in ('created','updated','moved','archived','restored')),
  changes       jsonb,                            -- [{field, from, to}] for updated/moved
  actor_email   text          not null,           -- work email (lowercased by trigger)
  actor_name    text,
  created_at    timestamptz   not null default now()
);

CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx
  ON public.ticket_events (ticket_id, created_at);

-- Normalize the actor email on write (same defense the other ticket tables use).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS ticket_events_normalize_actor ON public.ticket_events;
    CREATE TRIGGER ticket_events_normalize_actor
      BEFORE INSERT OR UPDATE ON public.ticket_events
      FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column('actor_email');
  END IF;
END$$;

-- Expose to Realtime so an open ticket dialog's history refreshes live.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='ticket_events'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ticket_events;
  END IF;
END$$;

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='tickets' AND column_name IN ('archived_at','archived_by');
--   SELECT tablename FROM pg_publication_tables
--     WHERE pubname='supabase_realtime' AND tablename='ticket_events';
