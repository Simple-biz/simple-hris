-- [Accounting Scoreboard: a pay cycle's close set by hand, for Payroll Timing]  2026-10-09, Open item 437
--
-- Kane, 2026-10-09: "Run me a migration on this week sep 27 - oct 3 where it closed today at 11:55AM this is for the
-- accounting scoreboard" · "I just want todays cycle to be closed at 11:55" · "override" · "Approve it" (item 437 (b)).
-- The record (audit_log) says Carla's Close Pay Cycle was at 12:00:32 PM ET and she reopened it at 12:01:03 PM.
--
-- accounting_scoreboard_cycle_closes  one row = the close time Payroll Timing shows for one pay cycle, set by hand.
--                                     The newest row per cycle wins. closed_at NULL clears it: the board reads the
--                                     record (payment_cycle.closed / reopened) again. Append-only: a change is a new
--                                     row, nothing is updated or deleted, so every hand-set time and who set it stays
--                                     readable (item 410).
--
-- It never writes or replaces audit_log, the close-out record (app_settings) or Payment Dispatch: the cycle's own
-- record stays what happened. The panel shows a hand-set close like any other (Kane: "remove set by hand in there");
-- this table, its reason and who set it are where it is recorded.
-- Part of the board read (readBoard) AND the History read: apply this BEFORE the code is pushed, or every board read
-- answers 503 "not set up yet".
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-cycle-closes-migration.mts.
-- Governing doc: docs/features/accounting-scoreboard.md § Payroll Timing fills itself.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_cycle_closes (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Sunday the pay cycle starts (the work week it pays), the key Payroll Timing matches every event on.
  cycle_start  date        NOT NULL
    CONSTRAINT acct_sb_cycle_closes_sunday CHECK (extract(isodow FROM cycle_start) = 7),
  closed_at    timestamptz,
  reason       text        NOT NULL
    CONSTRAINT acct_sb_cycle_closes_reason_valid CHECK (reason = btrim(reason) AND length(reason) BETWEEN 1 AND 500),
  set_by       text        NOT NULL
    CONSTRAINT acct_sb_cycle_closes_set_by_valid CHECK (set_by = lower(btrim(set_by)) AND set_by ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  set_at       timestamptz NOT NULL DEFAULT now(),
  -- A cycle closes after the week it pays has ended (midnight Eastern after its Saturday), and never in the future.
  CONSTRAINT acct_sb_cycle_closes_after_period CHECK (
    closed_at IS NULL OR closed_at >= ((cycle_start + 7)::timestamp AT TIME ZONE 'America/New_York')
  ),
  CONSTRAINT acct_sb_cycle_closes_not_future CHECK (closed_at IS NULL OR closed_at <= set_at)
);

CREATE INDEX IF NOT EXISTS acct_sb_cycle_closes_cycle
  ON public.accounting_scoreboard_cycle_closes (cycle_start, set_at DESC, id DESC);

COMMENT ON TABLE public.accounting_scoreboard_cycle_closes IS
  'Accounting Scoreboard Payroll Timing: a pay cycle''s close time set by hand (newest per cycle wins, NULL clears). Append-only. Never touches audit_log. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_cycle_closes_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'accounting_scoreboard_cycle_closes: append-only; set a new time (or clear it) with a new row'
    USING ERRCODE = '23514';
END $$;

DROP TRIGGER IF EXISTS acct_sb_cycle_closes_guard ON public.accounting_scoreboard_cycle_closes;
CREATE TRIGGER acct_sb_cycle_closes_guard
  BEFORE UPDATE OR DELETE ON public.accounting_scoreboard_cycle_closes
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_cycle_closes_guard();

ALTER TABLE public.accounting_scoreboard_cycle_closes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_cycle_closes FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_cycle_closes_guard() FROM PUBLIC, anon, authenticated;

-- The ruled close (item 437): pay cycle Sep 27 – Oct 3, 2026, closed at 11:55 AM Eastern on Fri Oct 9.
-- Inserted once: re-running this file never adds a second row for the cycle.
INSERT INTO public.accounting_scoreboard_cycle_closes (cycle_start, closed_at, reason, set_by)
SELECT DATE '2026-09-27',
       TIMESTAMP '2026-10-09 11:55:00' AT TIME ZONE 'America/New_York',
       'Kane, 2026-10-09 (Open item 437): "I just want todays cycle to be closed at 11:55". Payment Dispatch''s record: closed 12:00:32 PM ET, reopened 12:01:03 PM.',
       'kaner@simple.biz'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.accounting_scoreboard_cycle_closes WHERE cycle_start = DATE '2026-09-27'
 );
