-- Accounting Scoreboard, 2026-10-07: two changes asked for the same day (Carla, forwarded by Kane; and Kane).
--
-- Governing doc: docs/features/accounting-scoreboard.md (§ Chargebacks, § Payroll Problems)
-- Applies after:  2026-10-06_accounting_scoreboard_round3.sql (applied 2026-10-06)
--
--   1. Chargeback Outcomes: the win ratio. Carla: "I need to get a win ratio of 50% or higher each week."
--      Win ratio = wins ÷ (wins + losses), by count. A line counts as a win or a loss by its row flag
--      (rows.outcome), never by its label, the same as bucket_day and due_soon, so a rename keeps it.
--      Pre-arb is neither: it is not decided. The live "Wins" and "Losses" lines are flagged here.
--   2. Payroll Problems: a log line may record 0 problems. Kane: "lets not limit it to 1 to 1000 lets start
--      from 0 because 0 can count as 0 problems". The count CHECK was 1–1000; it is 0–1000. Nothing logged
--      is still "—" on the board, never 0: a 0 is only ever a number somebody typed.
--
-- The outcome values are pinned to OUTCOMES in src/lib/accounting-scoreboard/sections.ts by sections.test.ts.
-- NOTHING HERE PAYS ANYONE. No privilege change: both tables stay service-role only.
-- Re-runnable: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD, and each UPDATE touches only an
-- unflagged line, so a second run changes nothing.

-- ===========================================================================
-- 1. rows.outcome: what a Chargeback Outcomes line counts as in the win ratio
-- ===========================================================================

alter table public.accounting_scoreboard_rows add column if not exists outcome text;
alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_outcome_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_outcome_valid
  check (outcome is null or (section_key = 'chargeback_outcomes' and outcome in ('win', 'loss')));

comment on column public.accounting_scoreboard_rows.outcome is
  'Chargeback Outcomes only: win or loss in the win ratio (wins ÷ (wins + losses), by count). Null = neither (Pre-arb).';

-- The lines the round-3 migration seeded (2026-10-06): "Wins" and "Losses". Pre-arb stays null.
update public.accounting_scoreboard_rows
set outcome = 'win'
where section_key = 'chargeback_outcomes' and archived_at is null and label = 'Wins' and outcome is null;

update public.accounting_scoreboard_rows
set outcome = 'loss'
where section_key = 'chargeback_outcomes' and archived_at is null and label = 'Losses' and outcome is null;

-- ===========================================================================
-- 2. Payroll Problems: 0–1000 problems on one log line (was 1–1000)
-- ===========================================================================

alter table public.accounting_scoreboard_problems drop constraint if exists acct_sb_prob_count_range;
alter table public.accounting_scoreboard_problems add constraint acct_sb_prob_count_range
  check (problem_count between 0 and 1000);
