-- NPD — New Payroll Dashboard (Accounting → NPD): the manual payroll sheet.
--
-- Kane, 2026-10-01: "inside it will be the Manual Version of Payroll Wizard - where
-- there are two tabs inside it one for All Departments and One for HSL only … this
-- is like a google sheet where Aliviah can paste in the data manually none of these
-- data will be automatically imported from HRIS … we will publish this in Supabase".
-- Governing doc: docs/features/npd-dashboard.md
--
-- One SHEET per (tab, pay week). The week is the Sunday that starts the Sun–Sat
-- pay week. A sheet's rows live in the row table for its tab, and each row table
-- has exactly the columns of that tab's header row, in the same order.
--
-- EVERY CELL IS TEXT, EXACTLY AS PASTED. "₱1,234.56", "#N/A", "Yes" and "" are all
-- legitimate cells in the sheet this replaces. Nothing in HRIS computes on these
-- cells, and nothing pays from them. A typed column would refuse or quietly coerce
-- what Accounting pasted. A later feature that needs numbers parses them with its
-- own tested parser; it does not retype these columns.
--
-- Saves replace the whole sheet ATOMICALLY through npd_save_sheet, under a
-- compare-and-swap on npd_sheets.version. Two editors on one sheet get a
-- conflict, never a silent overwrite.
--
-- Service-role only. These rows carry per-person pay figures and the last four
-- digits of bank accounts. RLS is on with NO policies, table privileges are
-- revoked from anon/authenticated, the tables are NOT in supabase_realtime, and the
-- function is revoked from PUBLIC/anon/authenticated (Postgres grants EXECUTE to
-- PUBLIC by default, which on Supabase means the public anon key).

-- ===========================================================================
-- Sheets (one per tab per pay week)
-- ===========================================================================

create table if not exists public.npd_sheets (
  id          uuid primary key default gen_random_uuid(),
  sheet       text not null,
  constraint npd_sheets_sheet_valid check (sheet in ('all_departments', 'hsl')),
  -- Sunday that starts the Sun–Sat pay week. isodow 7 = Sunday.
  week_start  date not null,
  constraint npd_sheets_week_is_sunday check (extract(isodow from week_start) = 7),

  -- Bumped by every save. The client sends the version it loaded; a mismatch is
  -- a conflict (someone else saved in between), never a silent overwrite.
  version     integer not null default 0,
  constraint npd_sheets_version_nonneg check (version >= 0),
  row_count   integer not null default 0,
  constraint npd_sheets_row_count_nonneg check (row_count >= 0),

  created_at  timestamptz not null default now(),
  created_by  text not null,
  constraint npd_sheets_created_by_present check (length(btrim(created_by)) > 0),
  updated_at  timestamptz not null default now(),
  updated_by  text not null,
  constraint npd_sheets_updated_by_present check (length(btrim(updated_by)) > 0),

  constraint npd_sheets_one_per_week unique (sheet, week_start),
  -- Target of the row tables' composite foreign keys.
  constraint npd_sheets_id_sheet unique (id, sheet)
);

comment on table public.npd_sheets is
  'NPD (Accounting → New Payroll Dashboard): one manual payroll sheet per tab (all_departments | hsl) per pay-week Sunday. version is the CAS token npd_save_sheet checks. Cells are TEXT exactly as pasted — nothing in HRIS computes or pays from them. Service-role only; NOT in supabase_realtime.';

alter table public.npd_sheets enable row level security;

-- ===========================================================================
-- All Departments rows — the 30 columns of the All Departments header
-- ===========================================================================

create table if not exists public.npd_all_departments_rows (
  id        uuid primary key,
  sheet_id  uuid not null,
  sheet     text not null default 'all_departments',
  constraint npd_all_departments_rows_sheet check (sheet = 'all_departments'),
  constraint npd_all_departments_rows_sheet_fk
    foreign key (sheet_id, sheet) references public.npd_sheets (id, sheet) on delete cascade,
  -- 1-based position in the sheet. Assigned by the server on every save.
  row_no    integer not null,
  constraint npd_all_departments_rows_row_no_positive check (row_no > 0),
  constraint npd_all_departments_rows_one_per_position unique (sheet_id, row_no),

  work_email                    text,
  name                          text,
  department                    text,
  mesa_participant              text,
  position                      text,
  week                          text,
  regular_total_hours           text,
  regular_rate                  text,
  ot_total_hours                text,
  ot_rate                       text,
  hours_until_ot                text,
  orphan_total_hours            text,
  orphan_hours_total_pay        text,
  midweek_new_rate_total_hours  text,
  midweek_new_hourly_rate       text,
  notes_hourly_rate_changes     text,
  total_hourly_pay              text,
  mesa_contribution             text,
  tech_bonus                    text,
  attendance_bonus              text,
  performance_bonus             text,
  additional_bonus              text,
  notes_bonuses                 text,
  total_pay_php                 text,
  php_usd_conversion            text,
  total_pay_us_workers          text,
  bank_preferred                text,
  last4_preferred_acct          text,
  sending_bank_used             text,
  hris                          text,

  created_at timestamptz not null default now()
);

comment on table public.npd_all_departments_rows is
  'NPD All Departments tab: one row per sheet row, cells TEXT exactly as pasted (NULL = empty cell). Written ONLY by npd_save_sheet. Service-role only.';

alter table public.npd_all_departments_rows enable row level security;

-- ===========================================================================
-- HSL rows — the 32 columns of the HSL header
-- ===========================================================================

create table if not exists public.npd_hsl_rows (
  id        uuid primary key,
  sheet_id  uuid not null,
  sheet     text not null default 'hsl',
  constraint npd_hsl_rows_sheet check (sheet = 'hsl'),
  constraint npd_hsl_rows_sheet_fk
    foreign key (sheet_id, sheet) references public.npd_sheets (id, sheet) on delete cascade,
  row_no    integer not null,
  constraint npd_hsl_rows_row_no_positive check (row_no > 0),
  constraint npd_hsl_rows_one_per_position unique (sheet_id, row_no),

  work_email                      text,
  name                            text,
  department                      text,
  mesa_participant                text,
  position                        text,
  week                            text,
  mf_total_hours                  text,
  mf_rate                         text,
  we_hours                        text,
  hogan_we_rate                   text,
  total_ot_hours                  text,
  ot_differential                 text,
  hours_until_ot                  text,
  orphan_total_hours              text,
  orphan_hours_total_pay          text,
  midweek_new_rate_total_hours    text,
  midweek_transition_hourly_rate  text,
  notes_hourly_rate_changes       text,
  total_hourly_pay                text,
  mesa_contribution               text,
  tech_bonus                      text,
  attendance_bonus                text,
  performance_bonus               text,
  additional_bonus                text,
  notes_bonuses                   text,
  total_pay_php                   text,
  php_usd_conversion              text,
  total_pay_us_workers            text,
  bank_preferred                  text,
  last4_preferred_acct            text,
  sending_bank_used               text,
  hris                            text,

  created_at timestamptz not null default now()
);

comment on table public.npd_hsl_rows is
  'NPD HSL tab: one row per sheet row, cells TEXT exactly as pasted (NULL = empty cell). Written ONLY by npd_save_sheet. Service-role only.';

alter table public.npd_hsl_rows enable row level security;

-- Belt and braces on top of RLS: Supabase's default privileges grant every new
-- public table to anon and authenticated. Nothing but the service role reads these.
revoke all on table public.npd_sheets from anon, authenticated;
revoke all on table public.npd_all_departments_rows from anon, authenticated;
revoke all on table public.npd_hsl_rows from anon, authenticated;

-- ===========================================================================
-- Save — atomic whole-sheet replace under a version check
-- ===========================================================================
--
-- p_rows is a JSON array of objects: { id, row_no, <column>: text|null, ... }.
-- Keys that are not columns of the tab's row table are ignored by
-- jsonb_populate_recordset; the route only ever sends the tab's own columns.
-- Raises (errcode P0001, message prefix is the contract the route maps):
--   npd_bad_sheet · npd_week_not_sunday · npd_saved_by_missing · npd_rows_not_array
--   npd_version_conflict:<current version>

create or replace function public.npd_save_sheet(
  p_sheet text,
  p_week_start date,
  p_expected_version integer,
  p_saved_by text,
  p_rows jsonb
) returns table (sheet_id uuid, version integer, row_count integer, updated_at timestamptz, updated_by text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_version integer;
  v_count integer;
begin
  if p_sheet is null or p_sheet not in ('all_departments', 'hsl') then
    raise exception 'npd_bad_sheet' using errcode = 'P0001';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 7 then
    raise exception 'npd_week_not_sunday' using errcode = 'P0001';
  end if;
  if p_saved_by is null or length(btrim(p_saved_by)) = 0 then
    raise exception 'npd_saved_by_missing' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'npd_rows_not_array' using errcode = 'P0001';
  end if;
  v_count := jsonb_array_length(p_rows);

  -- A sheet nobody has saved yet is version 0. Creating it here (and rolling it
  -- back with everything else if the version check fails) means the first save
  -- of a week and every later one go through the same lock.
  insert into public.npd_sheets (sheet, week_start, version, row_count, created_by, updated_by)
  values (p_sheet, p_week_start, 0, 0, p_saved_by, p_saved_by)
  on conflict on constraint npd_sheets_one_per_week do nothing;

  select s.id, s.version into v_id, v_version
    from public.npd_sheets s
   where s.sheet = p_sheet and s.week_start = p_week_start
   for update;

  if v_version is distinct from p_expected_version then
    raise exception 'npd_version_conflict:%', v_version using errcode = 'P0001';
  end if;

  if p_sheet = 'hsl' then
    delete from public.npd_hsl_rows r where r.sheet_id = v_id;
    insert into public.npd_hsl_rows (
      id, sheet_id, row_no,
      work_email, name, department, mesa_participant, position, week,
      mf_total_hours, mf_rate, we_hours, hogan_we_rate, total_ot_hours, ot_differential,
      hours_until_ot, orphan_total_hours, orphan_hours_total_pay,
      midweek_new_rate_total_hours, midweek_transition_hourly_rate, notes_hourly_rate_changes,
      total_hourly_pay, mesa_contribution, tech_bonus, attendance_bonus, performance_bonus,
      additional_bonus, notes_bonuses, total_pay_php, php_usd_conversion, total_pay_us_workers,
      bank_preferred, last4_preferred_acct, sending_bank_used, hris
    )
    select
      r.id, v_id, r.row_no,
      r.work_email, r.name, r.department, r.mesa_participant, r.position, r.week,
      r.mf_total_hours, r.mf_rate, r.we_hours, r.hogan_we_rate, r.total_ot_hours, r.ot_differential,
      r.hours_until_ot, r.orphan_total_hours, r.orphan_hours_total_pay,
      r.midweek_new_rate_total_hours, r.midweek_transition_hourly_rate, r.notes_hourly_rate_changes,
      r.total_hourly_pay, r.mesa_contribution, r.tech_bonus, r.attendance_bonus, r.performance_bonus,
      r.additional_bonus, r.notes_bonuses, r.total_pay_php, r.php_usd_conversion, r.total_pay_us_workers,
      r.bank_preferred, r.last4_preferred_acct, r.sending_bank_used, r.hris
    from jsonb_populate_recordset(null::public.npd_hsl_rows, p_rows) r;
  else
    delete from public.npd_all_departments_rows r where r.sheet_id = v_id;
    insert into public.npd_all_departments_rows (
      id, sheet_id, row_no,
      work_email, name, department, mesa_participant, position, week,
      regular_total_hours, regular_rate, ot_total_hours, ot_rate,
      hours_until_ot, orphan_total_hours, orphan_hours_total_pay,
      midweek_new_rate_total_hours, midweek_new_hourly_rate, notes_hourly_rate_changes,
      total_hourly_pay, mesa_contribution, tech_bonus, attendance_bonus, performance_bonus,
      additional_bonus, notes_bonuses, total_pay_php, php_usd_conversion, total_pay_us_workers,
      bank_preferred, last4_preferred_acct, sending_bank_used, hris
    )
    select
      r.id, v_id, r.row_no,
      r.work_email, r.name, r.department, r.mesa_participant, r.position, r.week,
      r.regular_total_hours, r.regular_rate, r.ot_total_hours, r.ot_rate,
      r.hours_until_ot, r.orphan_total_hours, r.orphan_hours_total_pay,
      r.midweek_new_rate_total_hours, r.midweek_new_hourly_rate, r.notes_hourly_rate_changes,
      r.total_hourly_pay, r.mesa_contribution, r.tech_bonus, r.attendance_bonus, r.performance_bonus,
      r.additional_bonus, r.notes_bonuses, r.total_pay_php, r.php_usd_conversion, r.total_pay_us_workers,
      r.bank_preferred, r.last4_preferred_acct, r.sending_bank_used, r.hris
    from jsonb_populate_recordset(null::public.npd_all_departments_rows, p_rows) r;
  end if;

  return query
  update public.npd_sheets s
     set version = v_version + 1,
         row_count = v_count,
         updated_at = now(),
         updated_by = p_saved_by
   where s.id = v_id
  returning s.id, s.version, s.row_count, s.updated_at, s.updated_by;
end;
$$;

comment on function public.npd_save_sheet(text, date, integer, text, jsonb) is
  'NPD: replace one sheet''s rows atomically under a version check. Raises npd_version_conflict:<v> on a stale version. Service-role only.';

revoke all on function public.npd_save_sheet(text, date, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.npd_save_sheet(text, date, integer, text, jsonb) to service_role;
