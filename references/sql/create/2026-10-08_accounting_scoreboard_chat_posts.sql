-- [Accounting Scoreboard: scheduled progress posts to Google Chat]  2026-10-08
--
-- Carla, relayed by Kane 2026-10-08: "Daily: Every day around 3:00 PM · Weekly: Twice a week, ideally Wednesday and
-- Friday mornings · Monthly: On the 1st and 30th of each month · The other task don't need to be posted".
--
-- accounting_scoreboard_chat_posts   one SCHEDULED post: its slot (US Eastern date + hour), the frequencies it
--                                    carries, and what happened. The row is inserted as the CLAIM before anything is
--                                    sent: the unique (slot_date, slot_hour) is what stops a duplicate cron delivery,
--                                    or the second UTC entry of a DST pair, from posting twice. Its outcome is stamped
--                                    ONCE ('sending' -> a final status) and never changes after. Never deleted.
--
-- The Admin's Post to Chat click is NOT recorded here (it is not scheduled); both write the audit row.
-- A row left at 'sending' means the function died between the claim and the stamp: the post may or may not have
-- gone out, and the schedule never retries it.
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-chat-posts-migration.mts.
-- Governing doc: docs/features/accounting-scoreboard-tasks.md § Scheduled posts.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_chat_posts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_date    date        NOT NULL,
  slot_hour    smallint    NOT NULL
    CONSTRAINT acct_sb_chat_posts_hour_valid CHECK (slot_hour BETWEEN 0 AND 23),
  frequencies  text[]      NOT NULL
    CONSTRAINT acct_sb_chat_posts_frequencies_valid CHECK (
      cardinality(frequencies) BETWEEN 1 AND 3
      AND frequencies <@ ARRAY['daily', 'weekly', 'monthly']::text[]
    ),
  status       text        NOT NULL DEFAULT 'sending'
    CONSTRAINT acct_sb_chat_posts_status_valid CHECK (status IN
      ('sending', 'posted', 'skipped', 'refused', 'unreachable', 'timed_out', 'failed')),
  message      text,
  progress     jsonb,
  detail       text
    CONSTRAINT acct_sb_chat_posts_detail_short CHECK (detail IS NULL OR length(detail) <= 300),
  schedule     text
    CONSTRAINT acct_sb_chat_posts_schedule_short CHECK (schedule IS NULL OR length(schedule) <= 100),
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CONSTRAINT acct_sb_chat_posts_finish_pair CHECK ((status = 'sending') = (finished_at IS NULL)),
  CONSTRAINT acct_sb_chat_posts_one_per_slot UNIQUE (slot_date, slot_hour)
);

COMMENT ON TABLE public.accounting_scoreboard_chat_posts IS
  'Accounting Scoreboard scheduled Google Chat posts: one claim per Eastern slot, outcome stamped once, never deleted. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_chat_posts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_posts: a post is history, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'sending' OR NEW.finished_at IS NOT NULL OR NEW.message IS NOT NULL OR NEW.progress IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_chat_posts: a post is claimed as sending, before anything is sent'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the outcome, once. The slot, its frequencies and the claim never change.
  IF OLD.status <> 'sending' OR NEW.status = 'sending'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.slot_date IS DISTINCT FROM OLD.slot_date
     OR NEW.slot_hour IS DISTINCT FROM OLD.slot_hour
     OR NEW.frequencies IS DISTINCT FROM OLD.frequencies
     OR NEW.schedule IS DISTINCT FROM OLD.schedule
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_posts: only the outcome of a sending post may be stamped, once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_chat_posts_guard ON public.accounting_scoreboard_chat_posts;
CREATE TRIGGER acct_sb_chat_posts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_chat_posts
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_chat_posts_guard();

ALTER TABLE public.accounting_scoreboard_chat_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_chat_posts FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_chat_posts_guard() FROM PUBLIC, anon, authenticated;
