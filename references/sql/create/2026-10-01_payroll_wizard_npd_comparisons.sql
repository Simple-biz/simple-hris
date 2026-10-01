-- Payroll Wizard → Validation step → HRIS vs NPD: SAVE OUTPUT.
--
-- Kane, 2026-10-01: "Payroll Wizard - Validation Step - HRIS vs NPD - Give me an SQL
-- Migration for this one so I can save the output for the current week".
-- Governing doc: docs/features/payroll-wizard-hris-vs-npd.md § Saving the output
--
-- One row in payroll_wizard_npd_comparisons per SAVE. A week (the wizard's week key,
-- `source_file`, the same key Manual Validation and the final-pay snapshot use) gets
-- version 1, 2, 3 … in save order, and the newest version is "the saved output".
-- Nothing is ever overwritten: a save APPENDS. Saving an output identical to the
-- newest version (same content_sha256, computed by the route over the validated
-- snapshot) returns that version instead of adding a copy.
--
-- What is stored is the output exactly as the operator saw it: every row with its
-- verdict, HRIS's and NPD's dollar figures in cents, the difference, HRIS's pesos
-- and the paste lines behind NPD's figure; the people left out (configured not to be
-- paid) and the refused paste lines as JSON arrays; the "off by" tolerance and the
-- cycle FX rate the verdicts were given with; the counts and totals; and the NPD
-- paste text VERBATIM. The route re-parses that paste and refuses a snapshot whose
-- NPD side is not exactly it. HRIS's figures are the browser's (the server cannot
-- recompute the wizard), so the record is what the operator saw, not a server rerun.
--
-- A saved output NEVER CHANGES: a trigger refuses every UPDATE on both tables. Rows
-- are only ever written by payroll_wizard_save_npd_comparison, which checks, before
-- it returns, that the counts and totals add up and that every verdict agrees with
-- the tolerance it was given with. DELETE is left to the service role (cleanup is
-- Kane's call); the rows cascade with their save.
--
-- Service-role only. These rows carry every person's pay for the week. RLS is on with
-- NO policies, table privileges are revoked from anon/authenticated, the tables are
-- NOT in supabase_realtime, and both functions are revoked from PUBLIC/anon/
-- authenticated (Postgres grants EXECUTE to PUBLIC by default, which on Supabase
-- means the public anon key). NOT app_settings: the payroll.wizard.* family is
-- readable by every signed-in user (Sep 16 session log item 161).

-- ===========================================================================
-- Saves (one row per Save output click that changed something)
-- ===========================================================================

create table if not exists public.payroll_wizard_npd_comparisons (
  id               uuid primary key default gen_random_uuid(),

  -- The wizard's week key: the Hubstaff source file the wizard is on
  -- (e.g. simple-biz_daily_report_2026-09-27_to_2026-10-03.csv).
  source_file      text not null,
  constraint pw_npd_cmp_source_file_valid
    check (length(btrim(source_file)) between 1 and 300 and source_file = btrim(source_file)),

  -- 1, 2, 3 … per week, in save order. The newest is the saved output.
  version          integer not null,
  constraint pw_npd_cmp_version_positive check (version > 0),
  constraint pw_npd_cmp_one_per_version unique (source_file, version),

  saved_at         timestamptz not null default now(),
  -- The SESSION email, stamped by the route. Never the request body.
  saved_by         text not null,
  constraint pw_npd_cmp_saved_by_present check (length(btrim(saved_by)) > 0),

  -- The "off by at most N¢" setting the verdicts were given with (0–99).
  tolerance_cents  integer not null,
  constraint pw_npd_cmp_tolerance_range check (tolerance_cents between 0 and 99),
  -- This cycle's USD→PHP rate (PHP per $1): HRIS's dollars = staged final ÷ this.
  fx_rate          numeric not null,
  constraint pw_npd_cmp_fx_positive check (fx_rate > 0),

  match_count        integer not null,
  mismatch_count     integer not null,
  not_in_hris_count  integer not null,
  not_in_npd_count   integer not null,
  row_count          integer not null,
  constraint pw_npd_cmp_counts_nonneg check (
    match_count >= 0 and mismatch_count >= 0 and not_in_hris_count >= 0 and not_in_npd_count >= 0
  ),
  constraint pw_npd_cmp_row_count_is_sum check (
    row_count = match_count + mismatch_count + not_in_hris_count + not_in_npd_count
  ),
  -- There is no output of nothing: Save needs at least one readable NPD line.
  constraint pw_npd_cmp_has_rows check (row_count > 0),

  -- People configured not to be paid this week, left out of the comparison.
  left_out_count   integer not null,
  constraint pw_npd_cmp_left_out_nonneg check (left_out_count >= 0),
  -- Paste lines read, and paste lines refused (listed in `refusals`).
  npd_lines_read   integer not null,
  constraint pw_npd_cmp_lines_read_positive check (npd_lines_read > 0),
  refusal_count    integer not null,
  constraint pw_npd_cmp_refusals_nonneg check (refusal_count >= 0),

  -- Whole-comparison totals over the rows, in cents (never a filtered view).
  hris_total_cents bigint not null,
  npd_total_cents  bigint not null,

  -- The NPD paste, VERBATIM. Never trimmed or reformatted.
  paste_text       text not null,
  constraint pw_npd_cmp_paste_present check (length(paste_text) between 1 and 2000000),
  -- [{ line, raw, reason }] — the lines step 1 listed as refused.
  refusals         jsonb not null,
  constraint pw_npd_cmp_refusals_array check (
    jsonb_typeof(refusals) = 'array' and jsonb_array_length(refusals) = refusal_count
  ),
  -- [{ work_email, name, reason: excluded|paused, npd_cents, npd_lines }]
  left_out         jsonb not null,
  constraint pw_npd_cmp_left_out_array check (
    jsonb_typeof(left_out) = 'array' and jsonb_array_length(left_out) = left_out_count
  ),

  -- sha256 (hex) of the validated snapshot, computed by the route. Equal to the newest
  -- version's ⇒ the save returns that version (unchanged) instead of a copy.
  content_sha256   text not null,
  constraint pw_npd_cmp_sha256_hex check (content_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.payroll_wizard_npd_comparisons is
  'Payroll Wizard → Validation → HRIS vs NPD: one row per SAVE of the output, versioned per week (source_file). APPEND-ONLY — UPDATE is refused by trigger; the newest version is the saved output. Written ONLY by payroll_wizard_save_npd_comparison. Service-role only; NOT in supabase_realtime.';

create index if not exists pw_npd_cmp_source_file_newest
  on public.payroll_wizard_npd_comparisons (source_file, version desc);

alter table public.payroll_wizard_npd_comparisons enable row level security;

-- ===========================================================================
-- Rows (one per row of the output table, in its order)
-- ===========================================================================

create table if not exists public.payroll_wizard_npd_comparison_rows (
  comparison_id       uuid not null
    references public.payroll_wizard_npd_comparisons (id) on delete cascade,
  -- 1-based position in the output (sorted by work email), contiguous.
  row_no              integer not null,
  constraint pw_npd_cmp_rows_row_no_positive check (row_no > 0),
  constraint pw_npd_cmp_rows_pk primary key (comparison_id, row_no),

  -- HRIS's address when the person is in HRIS; otherwise NPD's address as pasted.
  work_email          text not null,
  constraint pw_npd_cmp_rows_email_present check (length(btrim(work_email)) > 0),
  -- HRIS's display name. Null for an NPD-only row.
  name                text,

  -- A saved row ALWAYS has a verdict: an output whose verdicts are held is not saved.
  status              text not null,
  constraint pw_npd_cmp_rows_status_valid
    check (status in ('match', 'mismatch', 'not_in_hris', 'not_in_npd')),

  -- HRIS's dollars (staged final ÷ fx, rounded as dispatch stages it), summed per email.
  hris_cents          bigint,
  -- NPD's dollars, every pasted line on this email, added.
  npd_cents           bigint,
  -- NPD − HRIS. Kept on a match too: a within-tolerance gap is shown, never erased.
  delta_cents         bigint,
  -- HRIS's pesos (the pivot behind NPD's implied rate).
  hris_php            numeric(14, 2),
  hris_row_count      integer not null,
  excluded_row_count  integer not null,
  no_payout_row_count integer not null,
  -- The paste lines (1-based, blank lines counted) that landed on this row.
  npd_lines           integer[] not null,
  -- PHP per $1 that NPD's figure implies against HRIS's pesos. Mismatches only.
  implied_npd_rate    numeric,

  constraint pw_npd_cmp_rows_counts_nonneg
    check (hris_row_count >= 0 and excluded_row_count >= 0 and no_payout_row_count >= 0),
  -- The nulls follow the verdict, so a row can never claim a side it has no figure for.
  constraint pw_npd_cmp_rows_hris_side check (
    (status = 'not_in_hris') = (hris_cents is null)
    and (status = 'not_in_hris') = (hris_php is null)
    and (status = 'not_in_hris') = (hris_row_count = 0)
  ),
  constraint pw_npd_cmp_rows_npd_side check (
    (status = 'not_in_npd') = (npd_cents is null)
    and (status = 'not_in_npd') = (cardinality(npd_lines) = 0)
  ),
  constraint pw_npd_cmp_rows_delta check (
    (status in ('match', 'mismatch')) = (delta_cents is not null)
    and (delta_cents is null or delta_cents = npd_cents - hris_cents)
  ),
  constraint pw_npd_cmp_rows_implied_rate check (
    implied_npd_rate is null or (status = 'mismatch' and implied_npd_rate > 0)
  )
);

comment on table public.payroll_wizard_npd_comparison_rows is
  'HRIS vs NPD saved output: one row per output row of a save, with its verdict. APPEND-ONLY — UPDATE is refused by trigger. Written ONLY by payroll_wizard_save_npd_comparison. Service-role only.';

alter table public.payroll_wizard_npd_comparison_rows enable row level security;

-- Belt and braces on top of RLS: Supabase's default privileges grant every new
-- public table to anon and authenticated. Nothing but the service role reads these.
revoke all on table public.payroll_wizard_npd_comparisons from anon, authenticated;
revoke all on table public.payroll_wizard_npd_comparison_rows from anon, authenticated;

-- ===========================================================================
-- A saved output never changes
-- ===========================================================================

create or replace function public.payroll_wizard_npd_comparisons_refuse_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'pw_npd_cmp_saved_output_is_immutable' using errcode = 'P0001';
end;
$$;

revoke all on function public.payroll_wizard_npd_comparisons_refuse_update() from public, anon, authenticated;

drop trigger if exists pw_npd_cmp_refuse_update on public.payroll_wizard_npd_comparisons;
create trigger pw_npd_cmp_refuse_update
  before update on public.payroll_wizard_npd_comparisons
  for each row execute function public.payroll_wizard_npd_comparisons_refuse_update();

drop trigger if exists pw_npd_cmp_rows_refuse_update on public.payroll_wizard_npd_comparison_rows;
create trigger pw_npd_cmp_rows_refuse_update
  before update on public.payroll_wizard_npd_comparison_rows
  for each row execute function public.payroll_wizard_npd_comparisons_refuse_update();

-- ===========================================================================
-- Save — one transaction: header + every row, then the sums are proven
-- ===========================================================================
--
-- p_snapshot = { header: { tolerance_cents, fx_rate, match_count, mismatch_count,
--   not_in_hris_count, not_in_npd_count, row_count, left_out_count, npd_lines_read,
--   refusal_count, hris_total_cents, npd_total_cents, paste_text, refusals, left_out },
--   rows: [{ row_no, work_email, name, status, hris_cents, npd_cents, delta_cents,
--   hris_php, hris_row_count, excluded_row_count, no_payout_row_count, npd_lines,
--   implied_npd_rate }] }
-- Keys that are not columns are ignored by jsonb_populate_record(set); a missing
-- required key is NULL and fails its NOT NULL.
-- Raises (errcode P0001; the message prefix is the contract the route maps):
--   pw_npd_cmp_bad_source_file · pw_npd_cmp_saved_by_missing · pw_npd_cmp_bad_sha256
--   pw_npd_cmp_bad_snapshot · pw_npd_cmp_no_rows · pw_npd_cmp_too_many_rows
--   pw_npd_cmp_row_order · pw_npd_cmp_counts_disagree · pw_npd_cmp_totals_disagree
--   pw_npd_cmp_verdict_disagrees

create or replace function public.payroll_wizard_save_npd_comparison(
  p_source_file text,
  p_saved_by text,
  p_content_sha256 text,
  p_snapshot jsonb
) returns table (
  comparison_id uuid,
  version integer,
  saved_at timestamptz,
  saved_by text,
  row_count integer,
  unchanged boolean
)
language plpgsql
set search_path = ''
as $$
declare
  v_header jsonb;
  v_rows jsonb;
  v_n integer;
  v_latest_id uuid;
  v_latest_version integer;
  v_latest_at timestamptz;
  v_latest_by text;
  v_latest_count integer;
  v_latest_sha text;
  v_id uuid;
  v_version integer;
  v_at timestamptz;
  v_tol integer;
  v_bad integer;
begin
  if p_source_file is null or length(btrim(p_source_file)) not between 1 and 300
     or p_source_file <> btrim(p_source_file) then
    raise exception 'pw_npd_cmp_bad_source_file' using errcode = 'P0001';
  end if;
  if p_saved_by is null or length(btrim(p_saved_by)) = 0 then
    raise exception 'pw_npd_cmp_saved_by_missing' using errcode = 'P0001';
  end if;
  if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'pw_npd_cmp_bad_sha256' using errcode = 'P0001';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object'
     or jsonb_typeof(p_snapshot -> 'header') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'rows') is distinct from 'array' then
    raise exception 'pw_npd_cmp_bad_snapshot' using errcode = 'P0001';
  end if;
  v_header := p_snapshot -> 'header';
  v_rows := p_snapshot -> 'rows';
  v_n := jsonb_array_length(v_rows);
  if v_n = 0 then
    raise exception 'pw_npd_cmp_no_rows' using errcode = 'P0001';
  end if;
  if v_n > 5000 then
    raise exception 'pw_npd_cmp_too_many_rows' using errcode = 'P0001';
  end if;

  -- One save per week at a time, so two clerks clicking together get v1 and v2,
  -- never a unique-violation, and the unchanged check reads a settled "newest".
  perform pg_advisory_xact_lock(hashtextextended('payroll_wizard_npd_comparisons:' || p_source_file, 0));

  select c.id, c.version, c.saved_at, c.saved_by, c.row_count, c.content_sha256
    into v_latest_id, v_latest_version, v_latest_at, v_latest_by, v_latest_count, v_latest_sha
    from public.payroll_wizard_npd_comparisons c
   where c.source_file = p_source_file
   order by c.version desc
   limit 1;

  if v_latest_id is not null and v_latest_sha = p_content_sha256 then
    return query select v_latest_id, v_latest_version, v_latest_at, v_latest_by, v_latest_count, true;
    return;
  end if;

  v_version := coalesce(v_latest_version, 0) + 1;

  insert into public.payroll_wizard_npd_comparisons (
    source_file, version, saved_by, content_sha256,
    tolerance_cents, fx_rate,
    match_count, mismatch_count, not_in_hris_count, not_in_npd_count, row_count,
    left_out_count, npd_lines_read, refusal_count,
    hris_total_cents, npd_total_cents,
    paste_text, refusals, left_out
  )
  select
    p_source_file, v_version, p_saved_by, p_content_sha256,
    h.tolerance_cents, h.fx_rate,
    h.match_count, h.mismatch_count, h.not_in_hris_count, h.not_in_npd_count, h.row_count,
    h.left_out_count, h.npd_lines_read, h.refusal_count,
    h.hris_total_cents, h.npd_total_cents,
    h.paste_text, h.refusals, h.left_out
  from jsonb_populate_record(null::public.payroll_wizard_npd_comparisons, v_header) h
  returning id, payroll_wizard_npd_comparisons.saved_at, tolerance_cents
    into v_id, v_at, v_tol;

  insert into public.payroll_wizard_npd_comparison_rows (
    comparison_id, row_no, work_email, name, status,
    hris_cents, npd_cents, delta_cents, hris_php,
    hris_row_count, excluded_row_count, no_payout_row_count,
    npd_lines, implied_npd_rate
  )
  select
    v_id, r.row_no, r.work_email, r.name, r.status,
    r.hris_cents, r.npd_cents, r.delta_cents, r.hris_php,
    r.hris_row_count, r.excluded_row_count, r.no_payout_row_count,
    r.npd_lines, r.implied_npd_rate
  from jsonb_populate_recordset(null::public.payroll_wizard_npd_comparison_rows, v_rows) r;

  -- The rows are 1..n in order: nothing missing, nothing repeated (the PK refuses repeats).
  if (select max(r.row_no) from public.payroll_wizard_npd_comparison_rows r where r.comparison_id = v_id) <> v_n then
    raise exception 'pw_npd_cmp_row_order' using errcode = 'P0001';
  end if;

  -- The header's counts are the rows' verdicts, not the browser's word for them.
  if exists (
    select 1
      from public.payroll_wizard_npd_comparisons c,
           lateral (
             select count(*) filter (where r.status = 'match')        as m,
                    count(*) filter (where r.status = 'mismatch')     as mm,
                    count(*) filter (where r.status = 'not_in_hris')  as nh,
                    count(*) filter (where r.status = 'not_in_npd')   as nn,
                    count(*)                                          as total
               from public.payroll_wizard_npd_comparison_rows r
              where r.comparison_id = c.id
           ) s
     where c.id = v_id
       and (s.m <> c.match_count or s.mm <> c.mismatch_count or s.nh <> c.not_in_hris_count
            or s.nn <> c.not_in_npd_count or s.total <> c.row_count)
  ) then
    raise exception 'pw_npd_cmp_counts_disagree' using errcode = 'P0001';
  end if;

  -- The totals are the rows' sums.
  if exists (
    select 1
      from public.payroll_wizard_npd_comparisons c,
           lateral (
             select coalesce(sum(r.hris_cents), 0) as h, coalesce(sum(r.npd_cents), 0) as n
               from public.payroll_wizard_npd_comparison_rows r
              where r.comparison_id = c.id
           ) s
     where c.id = v_id
       and (s.h <> c.hris_total_cents or s.n <> c.npd_total_cents)
  ) then
    raise exception 'pw_npd_cmp_totals_disagree' using errcode = 'P0001';
  end if;

  -- Every verdict agrees with the tolerance it was given with: a match is within N
  -- cents (inclusive), a mismatch is not.
  select count(*) into v_bad
    from public.payroll_wizard_npd_comparison_rows r
   where r.comparison_id = v_id
     and ((r.status = 'match' and abs(r.delta_cents) > v_tol)
          or (r.status = 'mismatch' and abs(r.delta_cents) <= v_tol));
  if v_bad > 0 then
    raise exception 'pw_npd_cmp_verdict_disagrees:%', v_bad using errcode = 'P0001';
  end if;

  return query select v_id, v_version, v_at, p_saved_by, v_n, false;
end;
$$;

comment on function public.payroll_wizard_save_npd_comparison(text, text, text, jsonb) is
  'HRIS vs NPD: append one saved output (header + rows) as the week''s next version, or return the newest version when its content_sha256 is identical. Proves counts, totals and every verdict before returning. Service-role only.';

revoke all on function public.payroll_wizard_save_npd_comparison(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_wizard_save_npd_comparison(text, text, text, jsonb) to service_role;
