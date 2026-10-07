-- Accounting Scoreboard: a custom section can be shown inside a built-in section's tab.
--
-- Carla, 2026-10-07 (forwarded by Kane): "Sales - Projects Onboarded" belongs on the Sales Onboarding
-- tab, under the built-in section (now titled "Sales — Payments"), the way Outcomes sits under Open
-- Disputes on the Chargebacks tab. She asked whether naming it "Sales Onboarding - …" would put it
-- there. It would not: where a section is shown is this column, picked in Setup, never its name.
--
-- Governing doc: docs/features/accounting-scoreboard.md § Custom sections
-- Applies after:  2026-10-06_accounting_scoreboard_round3.sql (applied 2026-10-06)
--
-- One nullable column. null = a tab of its own, which is every section created before this.
-- The list is every built-in section that has a tab of its own. It leaves out chargeback_outcomes,
-- which is itself shown inside Chargebacks. sections.test.ts pins this list to HOST_SECTION_KEYS in
-- src/lib/accounting-scoreboard/sections.ts, and the apply script checks the live CHECK against it.
--
-- No data changes, no new table, no privilege change: the table stays service-role only (RLS on, no
-- policies, nothing granted to anon/authenticated).
-- Re-runnable: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD.

alter table public.accounting_scoreboard_custom_sections
  add column if not exists host_section_key text;

alter table public.accounting_scoreboard_custom_sections drop constraint if exists acct_sb_custom_host_valid;
alter table public.accounting_scoreboard_custom_sections add constraint acct_sb_custom_host_valid
  check (host_section_key is null or host_section_key in (
    'buckets', 'collections', 'pm_buckets', 'onboarding', 'inbox', 'chargebacks', 'compliance',
    'cancellations', 'payroll_timing', 'payroll_problems'
  ));

comment on column public.accounting_scoreboard_custom_sections.host_section_key is
  'The built-in section whose tab this custom section is shown inside, under that section. Null = a tab of its own.';
