-- [Accounting Scoreboard: Setup → Scheduled Posts]  2026-10-09
--
-- Kane, 2026-10-09: "Add a new tab under - Setup - label it "Scheduled Posts" where I can see all the scheduled posts
-- and that I can edit that template and add a new one as well".
--
-- accounting_scoreboard_chat_schedules   one scheduled Google Chat post: when it goes out (US Eastern: every day, some
--                                        weekdays, or some days of the month, at a whole hour), which task
--                                        frequencies it counts, and its words (a template with {progress}). Until
--                                        today these were three constants in chat-schedule.ts (item 412). Edited in
--                                        place, every change audited; REMOVED by an archive stamp, never deleted, and
--                                        an archived post is final.
--
-- timing_changed_at is set BY THE TRIGGER (clock_timestamp, the real moment), never by the app: on insert, and whenever
-- the hour, the days or the pause switch change. The schedule skips any slot whose hour had already begun by then, so
-- a post created, retimed or resumed at 9:15 never goes out late at 10:00 for 9:00 (the cron's second call inside the
-- slot's window).
--
-- accounting_scoreboard_chat_posts (2026-10-08) is widened: a post may now count any counted frequency, and each claim
-- names the schedules it carries (schedule_ids). The claim stays one per (Eastern date, hour): schedules due at the
-- same hour go out as ONE message, the 10-08 rule for a weekly + monthly morning, generalised. Old rows keep
-- schedule_ids NULL. The code from before this migration still writes valid claims, so applying it before the push
-- changes nothing that is live.
--
-- Seeds the three posts Carla asked for (2026-10-08) with the words posted today, only into an empty table.
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-chat-schedules-migration.mts.
-- Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_chat_schedules (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label              text        NOT NULL
    CONSTRAINT acct_sb_chat_sched_label_valid CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 60),
  repeat             text        NOT NULL
    CONSTRAINT acct_sb_chat_sched_repeat_valid CHECK (repeat IN ('every_day', 'weekdays', 'month_days')),
  weekdays           text[]      NOT NULL DEFAULT '{}'
    CONSTRAINT acct_sb_chat_sched_weekdays_valid CHECK (weekdays <@ ARRAY['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']::text[]),
  month_days         smallint[]  NOT NULL DEFAULT '{}'
    CONSTRAINT acct_sb_chat_sched_month_days_valid CHECK (
      month_days <@ '{1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31}'::smallint[]
    ),
  post_hour          smallint    NOT NULL
    CONSTRAINT acct_sb_chat_sched_hour_valid CHECK (post_hour BETWEEN 0 AND 23),
  frequencies        text[]      NOT NULL
    CONSTRAINT acct_sb_chat_sched_frequencies_valid CHECK (
      cardinality(frequencies) BETWEEN 1 AND 7
      AND frequencies <@ ARRAY['daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually']::text[]
    ),
  template           text        NOT NULL
    CONSTRAINT acct_sb_chat_sched_template_valid CHECK (length(btrim(template)) >= 1 AND length(template) <= 1000),
  paused             boolean     NOT NULL DEFAULT false,
  timing_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_by         text        NOT NULL
    CONSTRAINT acct_sb_chat_sched_created_by_valid CHECK (length(btrim(created_by)) > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         text,
  updated_at         timestamptz,
  archived_by        text,
  archived_at        timestamptz,
  CONSTRAINT acct_sb_chat_sched_days_match CHECK (
    (repeat = 'every_day' AND cardinality(weekdays) = 0 AND cardinality(month_days) = 0)
    OR (repeat = 'weekdays' AND cardinality(weekdays) >= 1 AND cardinality(month_days) = 0)
    OR (repeat = 'month_days' AND cardinality(month_days) >= 1 AND cardinality(weekdays) = 0)
  ),
  CONSTRAINT acct_sb_chat_sched_update_pair CHECK ((updated_at IS NULL) = (updated_by IS NULL)),
  CONSTRAINT acct_sb_chat_sched_archive_pair CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);

-- One live post per name, whatever the case ("Daily" and "daily" are one post).
CREATE UNIQUE INDEX IF NOT EXISTS acct_sb_chat_sched_live_label
  ON public.accounting_scoreboard_chat_schedules (lower(label)) WHERE archived_at IS NULL;

COMMENT ON TABLE public.accounting_scoreboard_chat_schedules IS
  'Accounting Scoreboard scheduled Google Chat posts (Setup → Scheduled Posts): when, what it counts, the words. Archived, never deleted. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_chat_sched_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: a scheduled post is archived, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: a new post is created live and unedited' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.timing_changed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: an archived post is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: who created a post, and when, never change' USING ERRCODE = '23514';
  END IF;
  IF NEW.archived_at IS NOT NULL THEN
    -- The archive is a stamp on its own: nothing else changes in the same write.
    IF NEW.label IS DISTINCT FROM OLD.label OR NEW.repeat IS DISTINCT FROM OLD.repeat
       OR NEW.weekdays IS DISTINCT FROM OLD.weekdays OR NEW.month_days IS DISTINCT FROM OLD.month_days
       OR NEW.post_hour IS DISTINCT FROM OLD.post_hour OR NEW.frequencies IS DISTINCT FROM OLD.frequencies
       OR NEW.template IS DISTINCT FROM OLD.template OR NEW.paused IS DISTINCT FROM OLD.paused
       OR NEW.updated_by IS DISTINCT FROM OLD.updated_by OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
      RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: archiving changes nothing else' USING ERRCODE = '23514';
    END IF;
    NEW.timing_changed_at := OLD.timing_changed_at;
    RETURN NEW;
  END IF;
  IF NEW.updated_at IS NULL OR NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_schedules: an edit is stamped with who and when' USING ERRCODE = '23514';
  END IF;
  IF NEW.post_hour IS DISTINCT FROM OLD.post_hour OR NEW.repeat IS DISTINCT FROM OLD.repeat
     OR NEW.weekdays IS DISTINCT FROM OLD.weekdays OR NEW.month_days IS DISTINCT FROM OLD.month_days
     OR NEW.paused IS DISTINCT FROM OLD.paused THEN
    NEW.timing_changed_at := clock_timestamp();
  ELSE
    NEW.timing_changed_at := OLD.timing_changed_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_chat_sched_guard ON public.accounting_scoreboard_chat_schedules;
CREATE TRIGGER acct_sb_chat_sched_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_chat_schedules
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_chat_sched_guard();

ALTER TABLE public.accounting_scoreboard_chat_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_chat_schedules FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_chat_sched_guard() FROM PUBLIC, anon, authenticated;

-- The three posts as they ran on 2026-10-08 / 09, with the words they posted. Only into an empty table, so a re-run
-- never re-adds a post an Admin removed.
INSERT INTO public.accounting_scoreboard_chat_schedules (label, repeat, weekdays, month_days, post_hour, frequencies, template, created_by)
SELECT v.label, v.repeat, v.weekdays, v.month_days, v.post_hour, v.frequencies, v.template, 'migration'
FROM (VALUES
  ('Daily', 'every_day', '{}'::text[], '{}'::smallint[], 15::smallint, ARRAY['daily']::text[],
   'Current progress: {progress} have been completed. As you complete your tasks, remember to check them off.'),
  ('Weekly', 'weekdays', ARRAY['wed', 'fri']::text[], '{}'::smallint[], 9::smallint, ARRAY['weekly']::text[],
   'Current progress: {progress} have been completed. As you complete your tasks, remember to check them off.'),
  ('Monthly', 'month_days', '{}'::text[], ARRAY[1, 30]::smallint[], 9::smallint, ARRAY['monthly']::text[],
   'Current progress: {progress} have been completed. As you complete your tasks, remember to check them off.')
) AS v(label, repeat, weekdays, month_days, post_hour, frequencies, template)
WHERE NOT EXISTS (SELECT 1 FROM public.accounting_scoreboard_chat_schedules);

-- The posts table: any counted frequency, and the schedules each claim carries.
ALTER TABLE public.accounting_scoreboard_chat_posts ADD COLUMN IF NOT EXISTS schedule_ids uuid[];
ALTER TABLE public.accounting_scoreboard_chat_posts DROP CONSTRAINT IF EXISTS acct_sb_chat_posts_frequencies_valid;
ALTER TABLE public.accounting_scoreboard_chat_posts ADD CONSTRAINT acct_sb_chat_posts_frequencies_valid CHECK (
  cardinality(frequencies) BETWEEN 1 AND 7
  AND frequencies <@ ARRAY['daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually']::text[]
);
ALTER TABLE public.accounting_scoreboard_chat_posts DROP CONSTRAINT IF EXISTS acct_sb_chat_posts_schedule_ids_valid;
ALTER TABLE public.accounting_scoreboard_chat_posts ADD CONSTRAINT acct_sb_chat_posts_schedule_ids_valid CHECK (
  schedule_ids IS NULL OR (cardinality(schedule_ids) >= 1 AND array_position(schedule_ids, NULL) IS NULL)
);
CREATE INDEX IF NOT EXISTS acct_sb_chat_posts_slot_date ON public.accounting_scoreboard_chat_posts (slot_date);

-- The 2026-10-08 guard, plus: the schedules a claim carries never change either.
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
  -- UPDATE: the outcome, once. The slot, its frequencies, its schedules and the claim never change.
  IF OLD.status <> 'sending' OR NEW.status = 'sending'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.slot_date IS DISTINCT FROM OLD.slot_date
     OR NEW.slot_hour IS DISTINCT FROM OLD.slot_hour
     OR NEW.frequencies IS DISTINCT FROM OLD.frequencies
     OR NEW.schedule_ids IS DISTINCT FROM OLD.schedule_ids
     OR NEW.schedule IS DISTINCT FROM OLD.schedule
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_chat_posts: only the outcome of a sending post may be stamped, once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.acct_sb_chat_posts_guard() FROM PUBLIC, anon, authenticated;
