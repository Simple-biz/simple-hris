-- Accounting Scoreboard backfill — the archive for sheet tabs the board has no section for, and the
-- weekly collections totals the board reads instead of every log line.
--
-- Kane, 2026-10-01: "lets backfill the data - and use this Sheet please" · "add it into the system
-- for that domain".
-- Governing doc: docs/features/accounting-scoreboard-backfill.md
-- Base tables:   references/sql/create/2026-10-01_accounting_scoreboard.sql
--
-- Service-role only, like every scoreboard table: RLS on with NO policies, privileges revoked from
-- anon/authenticated, nothing in supabase_realtime. The view is security_invoker AND revoked, so it
-- can never read past the table's lock-down for anyone.

-- ===========================================================================
-- Archive: a sheet tab kept row for row, AS TYPED
-- ===========================================================================
-- "Totals - History" (Oct 2021 → Dec 2024) holds team totals no board section measures, typed as
-- "34/26", "Holiday" and "--" as often as plain numbers, and nobody has said what each column
-- counts. So nothing here is interpreted: each row keeps its cells as the sheet displayed them.
-- A wrong guess at a meaning would be worse than none.

create table if not exists public.accounting_scoreboard_archive (
  -- The sheet tab's title, e.g. 'Totals - History'.
  tab          text not null,
  constraint acct_sb_archive_tab_valid check (length(btrim(tab)) between 1 and 100 and tab = btrim(tab)),

  -- The 1-based row in the tab when it was imported, so a line here can be found in the sheet.
  sheet_row    integer not null,
  constraint acct_sb_archive_row_valid check (sheet_row >= 1),

  -- The row's cells as the sheet displayed them, column A first, as a JSON array of strings.
  cells        jsonb not null,
  constraint acct_sb_archive_cells_array check (jsonb_typeof(cells) = 'array'),

  -- Column A read as a date when it is one (MM/DD/YYYY). NULL for the header, weekly totals, notes.
  entry_date   date,

  imported_at  timestamptz not null default now(),
  imported_by  text not null,
  constraint acct_sb_archive_imported_by_present check (length(btrim(imported_by)) > 0),

  constraint acct_sb_archive_pk primary key (tab, sheet_row)
);

comment on table public.accounting_scoreboard_archive is
  'Accounting Scoreboard archive: sheet tabs with no board section, kept row for row AS TYPED. Read-only after import. Service-role only.';

alter table public.accounting_scoreboard_archive enable row level security;
revoke all on table public.accounting_scoreboard_archive from anon, authenticated;

-- ===========================================================================
-- Weekly collections totals, per rep row
-- ===========================================================================
-- The board's All Time column and its record week used to read EVERY live log line on each load
-- (paged). The sheet's log brings ~10,000 lines, which is ten or more round trips every 45 seconds
-- per open tab. One row per (rep row, Sunday week) is ~8 a week instead of ~150.
-- week_start is the Sunday on or before the day: the board's week key (week.ts).

create or replace view public.accounting_scoreboard_collection_weeks
with (security_invoker = true) as
select
  c.row_id,
  (c.entry_date - extract(dow from c.entry_date)::integer)::date as week_start,
  sum(c.points)  as points,
  count(*)       as lines,
  min(c.entry_date) as first_date
from public.accounting_scoreboard_collections c
where c.deleted_at is null
group by c.row_id, (c.entry_date - extract(dow from c.entry_date)::integer)::date;

comment on view public.accounting_scoreboard_collection_weeks is
  'Accounting Scoreboard: live collections points per rep row per Sunday week (All Time + record). security_invoker; service-role only.';

revoke all on table public.accounting_scoreboard_collection_weeks from anon, authenticated;
