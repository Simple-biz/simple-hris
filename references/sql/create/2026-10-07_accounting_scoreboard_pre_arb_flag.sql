-- Accounting Scoreboard: a Chargeback Outcomes line can be flagged Pre-arb.
--
-- Carla, 2026-10-07 meeting (Open item 392): "a loss is a negative, but I can't put a dash right here to put
-- that. I want to show like it's actually we're in the hole." Kane: "Wins positive. PR losses have negative."
-- Carla: "Yes." And: "We consider prearb as a loss […] it's still considered a loss."
--
-- Governing doc: docs/features/accounting-scoreboard.md § Chargebacks
-- Applies after:  2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql (applied 2026-10-07)
--
-- The sign of a line's dollars comes from this flag, never from a typed minus: every box keeps its 0–100,000
-- rule, and a typed minus beside a "loss" flag would double-negate. Wins count plus; Losses and Pre-arb count
-- minus in the board's Net. What a line counts as is marked on the row, never read from its label.
--
-- The CHECK below is acct_sb_rows_outcome_valid as the 2026-10-07 outcomes migration declared it, copied
-- verbatim, with 'pre_arb' added to its value list and nothing else changed. sections.test.ts pins this list
-- to OUTCOMES in src/lib/accounting-scoreboard/sections.ts.
--
-- The data step (flag the one live "Pre-arb" Outcomes line) is NOT in this file: the apply script selects
-- that line by section + live + label, refuses unless exactly ONE row matches, writes a backup, and then
-- updates that one id.
--
-- NOTHING HERE PAYS ANYONE. No privilege change: the table stays service-role only.
-- Re-runnable: DROP CONSTRAINT IF EXISTS + ADD.

alter table public.accounting_scoreboard_rows drop constraint if exists acct_sb_rows_outcome_valid;
alter table public.accounting_scoreboard_rows add constraint acct_sb_rows_outcome_valid
  check (outcome is null or (section_key = 'chargeback_outcomes' and outcome in ('win', 'loss', 'pre_arb')));

comment on column public.accounting_scoreboard_rows.outcome is
  'Chargeback Outcomes only: win, loss or pre_arb. Net: wins plus, losses and pre_arb minus. Win ratio: pre_arb counts as a loss (Kane, 2026-10-07). Null = not counted.';
