-- NPD — formulas (Accounting → New Payroll Dashboard).
--
-- Kane, 2026-10-01: "Copy the formulas in respective of the Columns please this is to
-- ensure we have the values calculated", then "when we right click on the cell it
-- should show the formula beneath that cell please and should be editable".
-- Governing doc: docs/features/npd-dashboard.md § Formulas. Engine: src/lib/npd/formulas.ts.
--
-- Applies AFTER references/sql/alter/2026-10-01_npd_sheets_lock.sql (the new save
-- function keeps its lock check). Re-runnable: IF NOT EXISTS, guarded constraints,
-- CREATE OR REPLACE.
--
-- What is stored (the server recalculates every formula cell on every save, so a
-- stored formula cell always holds what its formula gives):
--   npd_sheets.usd_per_php       the sheet's PHP→USD rate, dollars per peso (0.0162575);
--                                the Google Sheet typed it into each week's formula.
--                                Exact numeric, never a float; > 0 and < 1 (a value ≥ 1
--                                is pesos per dollar typed the wrong way round).
--   npd_sheets.column_formulas   this sheet's column formulas where they differ from
--                                the defaults: { "<column>": "=<formula>" | "" (none) }.
--   <rows>.formula_overrides     formula cells holding a TYPED value instead.
--   <rows>.formula_cells         a row's own formulas: { "<column>": "=<formula>" }.
-- Formulas reference columns by key, e.g. "={regular_rate}*1.5".
--
-- npd_save_sheet (the original) is kept for the deploy window: code that has not
-- been redeployed still saves through it, with no overrides and no rate.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'npd_sheets' and column_name = 'locked_at'
  ) then
    raise exception 'Apply references/sql/alter/2026-10-01_npd_sheets_lock.sql first (npd_sheets.locked_at is missing).';
  end if;
end;
$$;

-- ===========================================================================
-- Sheet-level: rate + column formulas
-- ===========================================================================

alter table public.npd_sheets add column if not exists usd_per_php numeric;
alter table public.npd_sheets add column if not exists column_formulas jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'npd_sheets_usd_per_php_range') then
    alter table public.npd_sheets
      add constraint npd_sheets_usd_per_php_range check (usd_per_php is null or (usd_per_php > 0 and usd_per_php < 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'npd_sheets_column_formulas_object') then
    alter table public.npd_sheets
      add constraint npd_sheets_column_formulas_object check (jsonb_typeof(column_formulas) = 'object');
  end if;
end;
$$;

comment on column public.npd_sheets.usd_per_php is
  'NPD: dollars per peso for this sheet (the Google Sheet typed it into each week''s USD formula). Never carried forward from another week.';
comment on column public.npd_sheets.column_formulas is
  'NPD: this sheet''s column formulas where they differ from the defaults in src/lib/npd/formulas.ts. "" = no formula in that column.';

-- ===========================================================================
-- Row-level: typed-over cells + a row's own formulas
-- ===========================================================================

alter table public.npd_all_departments_rows add column if not exists formula_overrides text[] not null default '{}';
alter table public.npd_all_departments_rows add column if not exists formula_cells jsonb not null default '{}'::jsonb;
alter table public.npd_hsl_rows add column if not exists formula_overrides text[] not null default '{}';
alter table public.npd_hsl_rows add column if not exists formula_cells jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'npd_all_departments_rows_formula_cells_object') then
    alter table public.npd_all_departments_rows
      add constraint npd_all_departments_rows_formula_cells_object check (jsonb_typeof(formula_cells) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'npd_hsl_rows_formula_cells_object') then
    alter table public.npd_hsl_rows
      add constraint npd_hsl_rows_formula_cells_object check (jsonb_typeof(formula_cells) = 'object');
  end if;
end;
$$;

comment on column public.npd_all_departments_rows.formula_overrides is
  'NPD: formula cells in this row holding a TYPED value instead of their formula (column keys).';
comment on column public.npd_hsl_rows.formula_overrides is
  'NPD: formula cells in this row holding a TYPED value instead of their formula (column keys).';

-- ===========================================================================
-- Save v2 — rows + overrides + own formulas + rate + column formulas, atomically
-- ===========================================================================
--
-- Raises (errcode P0001, message prefix is the contract the route maps):
--   npd_bad_sheet · npd_week_not_sunday · npd_saved_by_missing · npd_rows_not_array
--   npd_column_formulas_not_object · npd_sheet_locked · npd_version_conflict:<current>

create or replace function public.npd_save_sheet_v2(
  p_sheet text,
  p_week_start date,
  p_expected_version integer,
  p_saved_by text,
  p_rows jsonb,
  p_usd_per_php numeric,
  p_column_formulas jsonb
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
  if p_column_formulas is null or jsonb_typeof(p_column_formulas) <> 'object' then
    raise exception 'npd_column_formulas_not_object' using errcode = 'P0001';
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
      id, sheet_id, row_no, formula_overrides, formula_cells,
      work_email, name, department, mesa_participant, position, week,
      mf_total_hours, mf_rate, we_hours, hogan_we_rate, total_ot_hours, ot_differential,
      hours_until_ot, orphan_total_hours, orphan_hours_total_pay,
      midweek_new_rate_total_hours, midweek_transition_hourly_rate, notes_hourly_rate_changes,
      total_hourly_pay, mesa_contribution, tech_bonus, attendance_bonus, performance_bonus,
      additional_bonus, notes_bonuses, total_pay_php, php_usd_conversion, total_pay_us_workers,
      bank_preferred, last4_preferred_acct, sending_bank_used, hris
    )
    select
      r.id, v_id, r.row_no, coalesce(r.formula_overrides, '{}'), coalesce(r.formula_cells, '{}'::jsonb),
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
      id, sheet_id, row_no, formula_overrides, formula_cells,
      work_email, name, department, mesa_participant, position, week,
      regular_total_hours, regular_rate, ot_total_hours, ot_rate,
      hours_until_ot, orphan_total_hours, orphan_hours_total_pay,
      midweek_new_rate_total_hours, midweek_new_hourly_rate, notes_hourly_rate_changes,
      total_hourly_pay, mesa_contribution, tech_bonus, attendance_bonus, performance_bonus,
      additional_bonus, notes_bonuses, total_pay_php, php_usd_conversion, total_pay_us_workers,
      bank_preferred, last4_preferred_acct, sending_bank_used, hris
    )
    select
      r.id, v_id, r.row_no, coalesce(r.formula_overrides, '{}'), coalesce(r.formula_cells, '{}'::jsonb),
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
         usd_per_php = p_usd_per_php,
         column_formulas = p_column_formulas,
         updated_at = now(),
         updated_by = p_saved_by
   where s.id = v_id
  returning s.id, s.version, s.row_count, s.updated_at, s.updated_by;
end;
$$;

comment on function public.npd_save_sheet_v2(text, date, integer, text, jsonb, numeric, jsonb) is
  'NPD: replace one sheet''s rows, typed-over cells, own formulas, rate and column formulas atomically under a lock + version check. Service-role only.';

revoke all on function public.npd_save_sheet_v2(text, date, integer, text, jsonb, numeric, jsonb) from public, anon, authenticated;
grant execute on function public.npd_save_sheet_v2(text, date, integer, text, jsonb, numeric, jsonb) to service_role;
