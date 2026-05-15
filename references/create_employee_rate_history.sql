-- Per-employee rate history with effective dates. Powers mid-cycle rate
-- prorating: when a rate change is dated 2026-05-21 (a Wednesday), days
-- Mon-Tue in that week use the OLD rate row, Wed-Sat use the NEW one.
--
-- `employee_hourly_rates."Regular Rate"` / `"OT Rate"` continue to live as
-- a denormalized cache of "what's the rate as of today" (so existing
-- read paths don't have to change). The history table is authoritative.
create table if not exists public.employee_rate_history (
  id              uuid         primary key default gen_random_uuid(),
  employee_email  text         not null,
  regular_rate    text,
  ot_rate         text,
  effective_from  date         not null,
  note            text,
  created_by      text,
  created_at      timestamptz  not null default now()
);

create index if not exists employee_rate_history_email_idx
  on public.employee_rate_history (lower(employee_email), effective_from desc);
create index if not exists employee_rate_history_effective_idx
  on public.employee_rate_history (effective_from);

-- Lower-case + trim the email on every write.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists employee_rate_history_normalize_email on public.employee_rate_history;
    create trigger employee_rate_history_normalize_email
      before insert or update on public.employee_rate_history
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- Backfill: every current `employee_hourly_rates` row gets a baseline history
-- entry effective 1970-01-01 so `resolveRateAsOf(any-date)` always finds a
-- match. Re-runs are no-ops thanks to the NOT EXISTS guard.
insert into public.employee_rate_history (employee_email, regular_rate, ot_rate, effective_from, note, created_by)
select
  lower(coalesce("Work Email", "Personal Email")),
  "Regular Rate",
  "OT Rate",
  date '1970-01-01',
  'baseline backfill from employee_hourly_rates',
  'system'
from public.employee_hourly_rates ehr
where coalesce("Work Email", "Personal Email") is not null
  and not exists (
    select 1 from public.employee_rate_history h
    where h.employee_email = lower(coalesce(ehr."Work Email", ehr."Personal Email"))
      and h.effective_from = date '1970-01-01'
  );

-- Expose to Realtime (optional — used by dashboards if they want to react to
-- scheduled rate changes landing).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.employee_rate_history;
    exception when duplicate_object then
      null;
    end;
  end if;
end$$;
