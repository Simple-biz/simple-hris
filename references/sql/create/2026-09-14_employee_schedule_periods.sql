-- Manager -> My Team -> HSL -> Scheduling: what each person is EXPECTED to work,
-- as a dated period rather than a flag.
--
-- ONE table, not the two named in manager-scheduling.md.
-- ---------------------------------------------------------------------------
-- That doc refers to "the proposed employee_rest_day_patterns and
-- employee_shift_windows tables", but no DDL for them was ever written and the
-- shipped model contradicts the split: SchedulePeriod carries ONE id, ONE
-- effective_from/to, and rest days and shift window TOGETHER. Two independently
-- effective-dated tables would allow a rest-day period of Jan-Mar to overlap a
-- shift-window period of Feb-Apr, and SchedulePeriod has no answer for what
-- February then is. The same doc also specifies a single unique index on
-- "(lower(work_email), effective_from)" — singular, one table. The two-table
-- naming is vestigial from an earlier sketch the model superseded.
--
-- A schedule describes EXPECTATION. Nothing here feeds pay: HSL prices days off
-- the calendar (+P15/h weekend, PAB coverage, orphanage OT) and must keep doing
-- so. Letting a pay rule read this table converts a descriptive surface into a
-- money path and is its own decision under the hardening rules.

create table if not exists public.employee_schedule_periods (
  id            uuid primary key default gen_random_uuid(),

  -- Identity. Lower-cased on the way in by the trigger below so the unique index
  -- and every lookup agree without callers having to remember.
  work_email    text        not null,
  member_name   text,
  -- Master-list Department cell as written, e.g. 'hsl:intake_specialist'. Stored
  -- RAW: this is a key, not a label (dept-label-display-sweep).
  department    text        not null,

  -- Days NOT expected to be worked. 0 = Sunday .. 6 = Saturday, matching
  -- `Weekday` in src/lib/manager/scheduling.ts. Everything not listed is a
  -- scheduled day. An empty array is a legitimate "works every day".
  rest_days     smallint[]  not null default '{}',

  -- Expected window, minutes from local midnight. BOTH NULL is a legitimate and
  -- common state — "we know their days but not their hours" — and must never be
  -- rendered or stored as midnight. end < start means the window crosses midnight.
  shift_start_minute smallint,
  shift_end_minute   smallint,
  -- The workforce is on EST/EDT and every Hubstaff row measured carries this.
  timezone      text        not null default 'America/New_York',

  -- Inclusive both ends. NULL end = still current.
  effective_from date       not null,
  effective_to   date,

  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),

  -- "Hours not set" is a STATE, not a zero: both blank saves, exactly one blank
  -- is refused. This is the same discipline parseShiftWindow applies to text.
  constraint employee_schedule_periods_window_both_or_neither
    check ((shift_start_minute is null) = (shift_end_minute is null)),
  constraint employee_schedule_periods_window_in_day
    check (
      (shift_start_minute is null or shift_start_minute between 0 and 1439) and
      (shift_end_minute   is null or shift_end_minute   between 0 and 1439)
    ),
  -- A zero-length window is the shape a half-filled form produces, so it is
  -- refused here exactly as parseShiftWindow refuses it.
  constraint employee_schedule_periods_window_not_zero_length
    check (shift_start_minute is null or shift_start_minute <> shift_end_minute),
  constraint employee_schedule_periods_dates_ordered
    check (effective_to is null or effective_to >= effective_from),
  constraint employee_schedule_periods_rest_days_valid
    check (rest_days <@ array[0,1,2,3,4,5,6]::smallint[]),
  constraint employee_schedule_periods_email_present
    check (length(btrim(work_email)) > 0),
  constraint employee_schedule_periods_department_present
    check (length(btrim(department)) > 0)
);

comment on table public.employee_schedule_periods is
  'Expected working days/hours per person, effective-dated. Manager -> My Team -> HSL -> Scheduling. Describes expectation only; never a pay input.';

-- Stops an exact duplicate period. It CANNOT stop a straddle (Jan-Mar vs Feb-Apr),
-- which is why findOverlaps treats an overlap as a hard error in code too — an
-- overlapping date has two answers.
create unique index if not exists employee_schedule_periods_email_from_uniq
  on public.employee_schedule_periods (lower(work_email), effective_from);

create index if not exists employee_schedule_periods_department_idx
  on public.employee_schedule_periods (department);

-- Open periods are what every "who is scheduled now" read wants.
create index if not exists employee_schedule_periods_current_idx
  on public.employee_schedule_periods (lower(work_email))
  where effective_to is null;

create or replace function public.employee_schedule_periods_normalize()
returns trigger
language plpgsql
as $$
begin
  new.work_email := lower(btrim(new.work_email));
  new.department := btrim(new.department);
  -- Sorted + de-duplicated so two equivalent rest-day sets compare equal and a
  -- diff-only write does not churn on ordering alone.
  new.rest_days := (
    select coalesce(array_agg(distinct d order by d), '{}')::smallint[]
    from unnest(new.rest_days) as d
  );
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists employee_schedule_periods_normalize_trg
  on public.employee_schedule_periods;
create trigger employee_schedule_periods_normalize_trg
  before insert or update on public.employee_schedule_periods
  for each row execute function public.employee_schedule_periods_normalize();

-- Service-role only, like every other manager-facing table here: the app reaches
-- it through gated routes, never from the browser.
alter table public.employee_schedule_periods enable row level security;
