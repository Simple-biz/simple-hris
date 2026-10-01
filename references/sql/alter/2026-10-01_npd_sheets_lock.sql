-- NPD — Lock in (Accounting → New Payroll Dashboard).
--
-- Kane, 2026-10-01: "Lets add a lock in button on this where we can lock in the values
-- on here for the current week".
-- Governing doc: docs/features/npd-dashboard.md § Lock in.
-- Applies on top of references/sql/create/2026-10-01_npd_sheets.sql (applied in
-- production 2026-10-01 with 0 rows). Re-runnable: every step is IF NOT EXISTS,
-- guarded, or CREATE OR REPLACE.
--
-- A sheet (one tab × one pay week) can be LOCKED. While locked_at is set,
-- npd_save_sheet REFUSES every save at any version, so the cells cannot change by
-- any path, not just from the UI. The check runs under the same row lock
-- npd_lock_sheet takes, so a save and a lock racing each other cannot both win.
-- npd_lock_sheet locks only the version the editor is looking at, and only a sheet
-- with rows. npd_unlock_sheet clears the lock; the route records who and why BEFORE
-- calling it. Locking and unlocking change no cell and no version.
--
-- Service-role only, like everything NPD: both new functions are revoked from
-- PUBLIC/anon/authenticated (Postgres grants EXECUTE to PUBLIC by default, which on
-- Supabase means the public anon key) and pin search_path.

-- ===========================================================================
-- Lock columns
-- ===========================================================================

alter table public.npd_sheets add column if not exists locked_at timestamptz;
alter table public.npd_sheets add column if not exists locked_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'npd_sheets_lock_both_or_neither') then
    alter table public.npd_sheets
      add constraint npd_sheets_lock_both_or_neither check ((locked_at is null) = (locked_by is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'npd_sheets_locked_by_present') then
    alter table public.npd_sheets
      add constraint npd_sheets_locked_by_present check (locked_by is null or length(btrim(locked_by)) > 0);
  end if;
end;
$$;

comment on column public.npd_sheets.locked_at is
  'NPD Lock in: set = locked; npd_save_sheet refuses every save. Both locked_at and locked_by, or neither.';
comment on column public.npd_sheets.locked_by is
  'NPD Lock in: the session email that locked the sheet (stamped by the server, never the request body).';

-- ===========================================================================
-- Save — now refuses a locked sheet (same signature; replaces the original)
-- ===========================================================================
--
-- Raises (errcode P0001, message prefix is the contract the route maps):
--   npd_bad_sheet · npd_week_not_sunday · npd_saved_by_missing · npd_rows_not_array
--   npd_sheet_locked · npd_version_conflict:<current version>

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
  v_locked timestamptz;
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

  insert into public.npd_sheets (sheet, week_start, version, row_count, created_by, updated_by)
  values (p_sheet, p_week_start, 0, 0, p_saved_by, p_saved_by)
  on conflict on constraint npd_sheets_one_per_week do nothing;

  select s.id, s.version, s.locked_at into v_id, v_version, v_locked
    from public.npd_sheets s
   where s.sheet = p_sheet and s.week_start = p_week_start
   for update;

  -- A locked sheet takes no save at all, whatever version the caller holds.
  if v_locked is not null then
    raise exception 'npd_sheet_locked' using errcode = 'P0001';
  end if;

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
  'NPD: replace one sheet''s rows atomically under a version check. Raises npd_sheet_locked on a locked sheet and npd_version_conflict:<v> on a stale version. Service-role only.';

-- ===========================================================================
-- Lock in
-- ===========================================================================
--
-- Raises: npd_bad_sheet · npd_week_not_sunday · npd_locked_by_missing
--   · npd_sheet_empty (no sheet for that tab and week, or no rows)
--   · npd_sheet_locked (already locked)
--   · npd_version_conflict:<current version> (the editor is not looking at the latest save)

create or replace function public.npd_lock_sheet(
  p_sheet text,
  p_week_start date,
  p_expected_version integer,
  p_locked_by text
) returns table (sheet_id uuid, version integer, row_count integer, locked_at timestamptz, locked_by text)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_version integer;
  v_rows integer;
  v_locked timestamptz;
begin
  if p_sheet is null or p_sheet not in ('all_departments', 'hsl') then
    raise exception 'npd_bad_sheet' using errcode = 'P0001';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 7 then
    raise exception 'npd_week_not_sunday' using errcode = 'P0001';
  end if;
  if p_locked_by is null or length(btrim(p_locked_by)) = 0 then
    raise exception 'npd_locked_by_missing' using errcode = 'P0001';
  end if;

  select s.id, s.version, s.row_count, s.locked_at into v_id, v_version, v_rows, v_locked
    from public.npd_sheets s
   where s.sheet = p_sheet and s.week_start = p_week_start
   for update;

  if v_id is null then
    raise exception 'npd_sheet_empty' using errcode = 'P0001';
  end if;
  if v_locked is not null then
    raise exception 'npd_sheet_locked' using errcode = 'P0001';
  end if;
  if v_version is distinct from p_expected_version then
    raise exception 'npd_version_conflict:%', v_version using errcode = 'P0001';
  end if;
  -- row_count is saved after trailing blank rows are trimmed, so > 0 means at
  -- least one filled row.
  if v_rows = 0 then
    raise exception 'npd_sheet_empty' using errcode = 'P0001';
  end if;

  return query
  update public.npd_sheets s
     set locked_at = now(),
         locked_by = p_locked_by
   where s.id = v_id
  returning s.id, s.version, s.row_count, s.locked_at, s.locked_by;
end;
$$;

comment on function public.npd_lock_sheet(text, date, integer, text) is
  'NPD: lock one sheet at the version the editor saw. While locked, npd_save_sheet refuses every save. Service-role only.';

-- ===========================================================================
-- Unlock
-- ===========================================================================
--
-- Raises: npd_bad_sheet · npd_week_not_sunday · npd_unlocked_by_missing · npd_sheet_not_locked

create or replace function public.npd_unlock_sheet(
  p_sheet text,
  p_week_start date,
  p_unlocked_by text
) returns table (sheet_id uuid, version integer)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
  v_locked timestamptz;
begin
  if p_sheet is null or p_sheet not in ('all_departments', 'hsl') then
    raise exception 'npd_bad_sheet' using errcode = 'P0001';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 7 then
    raise exception 'npd_week_not_sunday' using errcode = 'P0001';
  end if;
  if p_unlocked_by is null or length(btrim(p_unlocked_by)) = 0 then
    raise exception 'npd_unlocked_by_missing' using errcode = 'P0001';
  end if;

  select s.id, s.locked_at into v_id, v_locked
    from public.npd_sheets s
   where s.sheet = p_sheet and s.week_start = p_week_start
   for update;

  if v_id is null or v_locked is null then
    raise exception 'npd_sheet_not_locked' using errcode = 'P0001';
  end if;

  return query
  update public.npd_sheets s
     set locked_at = null,
         locked_by = null
   where s.id = v_id
  returning s.id, s.version;
end;
$$;

comment on function public.npd_unlock_sheet(text, date, text) is
  'NPD: clear a sheet''s lock. The route audits who and why BEFORE calling this. Service-role only.';

-- ===========================================================================
-- Privileges — service role only (re-issued for the replaced save function too)
-- ===========================================================================

revoke all on function public.npd_save_sheet(text, date, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.npd_lock_sheet(text, date, integer, text) from public, anon, authenticated;
revoke all on function public.npd_unlock_sheet(text, date, text) from public, anon, authenticated;
grant execute on function public.npd_save_sheet(text, date, integer, text, jsonb) to service_role;
grant execute on function public.npd_lock_sheet(text, date, integer, text) to service_role;
grant execute on function public.npd_unlock_sheet(text, date, text) to service_role;
