-- Accounting Scoreboard: a section can be left off the Overview.
--
-- Carla, 2026-10-07 meeting (Open item 391), on "Sales Projects Onboarded": "I don't want this on here
-- because this is kind of just again telling me how many products we added, but it doesn't really do
-- anything for my team", and on a second section: "I don't want this one on the overview, but I don't
-- have a hide option." Kane: "setup will have an option to hide it from the overview." Carla: "Under
-- sections."
--
-- Governing doc: docs/features/accounting-scoreboard.md § Hidden from the Overview
-- Applies after:  2026-10-07_accounting_scoreboard_custom_section_host.sql (applied 2026-10-07)
--
-- One column on each section table, NOT NULL DEFAULT true. Every existing section stays shown: a
-- built-in section with no row in accounting_scoreboard_sections is the code default (shown), and every
-- existing row reads the default. A hidden section keeps its tab and its numbers. It leaves the Overview
-- cards and the Team Score (CHOSEN, implementation plan Task 1).
--
-- No data step (no UPDATE), no new table, no privilege change: both tables stay service-role only
-- (RLS on, no policies, nothing granted to anon/authenticated).
-- Re-runnable: ADD COLUMN IF NOT EXISTS.

alter table public.accounting_scoreboard_sections
  add column if not exists show_on_overview boolean not null default true;

alter table public.accounting_scoreboard_custom_sections
  add column if not exists show_on_overview boolean not null default true;

comment on column public.accounting_scoreboard_sections.show_on_overview is
  'False = this built-in section has no Overview card and is left out of the Team Score. Its tab stays.';
comment on column public.accounting_scoreboard_custom_sections.show_on_overview is
  'False = this custom section has no Overview card and is left out of the Team Score. Its grid stays.';
