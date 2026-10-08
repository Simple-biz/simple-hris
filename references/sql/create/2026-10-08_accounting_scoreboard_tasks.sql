-- [Accounting Scoreboard: per-person task boards]  2026-10-08, Open item 393 (plan Task 7)
--
-- Carla, 2026-10-07 meeting: "every person has a task board ... daily task, weekly task, bi-weekly, monthly,
-- bimonthly, quarterly, annually. And then there's tasks that just come up on our desk and we do them as they are
-- needed." The person tabs of her scoreboard sheet move onto the board, behind a Scoreboard | Tasks switch.
--
-- accounting_scoreboard_tasks        one task: its owner (a board person's work email), title and frequency.
--                                    Only an Admin adds, renames, reorders or ARCHIVES one (never deleted). The owner
--                                    and the frequency never change in place: a new frequency is a new task, so an
--                                    old tick never changes meaning.
-- accounting_scoreboard_task_checks  one tick, for one task in one PERIOD (period_key = the day, the Sunday week, the
--                                    two-week block, the month... the server computes it, never the client). The only
--                                    UPDATE is the uncheck stamp, once; ticking again inserts a new row. One live tick
--                                    per task per period. The Payment Verified pattern.
--
-- Tasks are NOT week results, so the weekly lock (plan Task 5) never applies to them.
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-tasks-migration.mts.
-- Governing doc: docs/features/accounting-scoreboard-tasks.md.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email  text        NOT NULL
    CONSTRAINT acct_sb_tasks_owner_valid CHECK (owner_email = lower(btrim(owner_email)) AND owner_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  title        text        NOT NULL
    CONSTRAINT acct_sb_tasks_title_valid CHECK (title = btrim(title) AND length(title) BETWEEN 1 AND 300),
  frequency    text        NOT NULL
    CONSTRAINT acct_sb_tasks_frequency_valid CHECK (frequency IN
      ('daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually', 'as_needed')),
  sort_order   integer     NOT NULL DEFAULT 0,
  created_by   text        NOT NULL
    CONSTRAINT acct_sb_tasks_created_by_set CHECK (btrim(created_by) <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_by  text,
  archived_at  timestamptz,
  CONSTRAINT acct_sb_tasks_archive_pair CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);

CREATE INDEX IF NOT EXISTS acct_sb_tasks_live_owner
  ON public.accounting_scoreboard_tasks (owner_email) WHERE archived_at IS NULL;

COMMENT ON TABLE public.accounting_scoreboard_tasks IS
  'Accounting Scoreboard task boards. Archived, never deleted; owner and frequency never change in place. Service-role only.';

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_task_checks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid        NOT NULL REFERENCES public.accounting_scoreboard_tasks (id),
  period_key    date        NOT NULL,
  checked_by    text        NOT NULL
    CONSTRAINT acct_sb_task_checks_by_set CHECK (btrim(checked_by) <> ''),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  unchecked_by  text,
  unchecked_at  timestamptz,
  CONSTRAINT acct_sb_task_checks_uncheck_pair CHECK ((unchecked_at IS NULL) = (unchecked_by IS NULL))
);

-- One live tick per task per period. An unchecked tick stays as history.
CREATE UNIQUE INDEX IF NOT EXISTS acct_sb_task_checks_one_live
  ON public.accounting_scoreboard_task_checks (task_id, period_key) WHERE unchecked_at IS NULL;
CREATE INDEX IF NOT EXISTS acct_sb_task_checks_period
  ON public.accounting_scoreboard_task_checks (period_key) WHERE unchecked_at IS NULL;

COMMENT ON TABLE public.accounting_scoreboard_task_checks IS
  'Accounting Scoreboard task ticks, one live per task per period. Append-only apart from the one uncheck stamp. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_tasks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_tasks: a task is archived, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_tasks: a task is created live' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: an archived task is final; owner, frequency and authorship never change; title and order may change on a
  -- live task, and the archive stamp is set once.
  IF OLD.archived_at IS NOT NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.owner_email IS DISTINCT FROM OLD.owner_email
     OR NEW.frequency IS DISTINCT FROM OLD.frequency
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_tasks: only the title, the order or the archive stamp of a live task may change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_tasks_guard ON public.accounting_scoreboard_tasks;
CREATE TRIGGER acct_sb_tasks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_tasks
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_tasks_guard();

CREATE OR REPLACE FUNCTION public.acct_sb_task_checks_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_task_checks: a tick is unchecked, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.unchecked_at IS NOT NULL OR NEW.unchecked_by IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_task_checks: a tick is created live' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_scoreboard_tasks t
       WHERE t.id = NEW.task_id AND t.archived_at IS NULL AND t.frequency <> 'as_needed'
    ) THEN
      RAISE EXCEPTION 'accounting_scoreboard_task_checks: only a live, counted task (not as-needed) can be ticked'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the uncheck stamp, once, and nothing else.
  IF OLD.unchecked_at IS NOT NULL OR NEW.unchecked_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.period_key IS DISTINCT FROM OLD.period_key
     OR NEW.checked_by IS DISTINCT FROM OLD.checked_by
     OR NEW.checked_at IS DISTINCT FROM OLD.checked_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_task_checks: only the uncheck stamp may change, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_task_checks_guard ON public.accounting_scoreboard_task_checks;
CREATE TRIGGER acct_sb_task_checks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_task_checks
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_task_checks_guard();

ALTER TABLE public.accounting_scoreboard_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_scoreboard_task_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_tasks, public.accounting_scoreboard_task_checks FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_tasks_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_task_checks_guard() FROM PUBLIC, anon, authenticated;
