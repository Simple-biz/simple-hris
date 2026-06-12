-- Bonus Catalog -- APPLIED bonuses (per pay-week, per employee).
--
-- The Bonus Catalog (bonus_catalog_bonuses + bonus_catalog_assignments) is the
-- authoring layer: finance defines reusable bonuses and assigns them to a whole
-- department ("common") or a single employee. THIS table is the payout layer:
-- each row is one catalog bonus a manager has APPLIED to one employee for one
-- pay-week cycle. An employee can receive several bonuses in a week -> several
-- rows. The Payroll Wizard sums `amount` per employee for the week and pays it
-- (gated on hsl_bonus_period_status being 'ready'/'locked' for that dept+period).
--
-- Period identity = the Hubstaff CSV week. `period_start` is the Monday ISO date
-- the manager dashboard pins from the latest Hubstaff upload (same week key the
-- non-HSL KPI calculator already uses in hsl_bonus_period_status).
--
-- Status (draft/ready/locked) is NOT stored here -- it stays per
-- (department, period_start) in the generic hsl_bonus_period_status table.
--
-- Idempotent: safe to re-run.

create table if not exists public.bonus_catalog_applied (
  id             text        primary key,            -- client newId('app')
  period_start   date        not null,               -- Hubstaff-derived week (Mon ISO)
  period_end     date        not null,
  department     text        not null,               -- DEPARTMENTS key (pm_team, accounting, ...)
  employee_email text        not null,
  employee_name  text,
  bonus_id       text        not null references public.bonus_catalog_bonuses(id) on delete cascade,
  bonus_name     text        not null,               -- snapshot at apply time (survives later renames)
  kind           text        not null check (kind in ('flat','formula')),
  vars           jsonb,                               -- formula variable inputs, e.g. {"tickets": 12}
  amount         numeric(14,2) not null default 0,    -- computed payout (flat amount or evaluated formula)
  applied_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (period_start, department, employee_email, bonus_id)
);

create index if not exists bonus_catalog_applied_dept_period_idx
  on public.bonus_catalog_applied (department, period_start);
create index if not exists bonus_catalog_applied_email_idx
  on public.bonus_catalog_applied (lower(employee_email));
create index if not exists bonus_catalog_applied_bonus_idx
  on public.bonus_catalog_applied (bonus_id);

-- ── Touch trigger: bump updated_at; keep created_at immutable ─────────────────
create or replace function public.bonus_catalog_applied_touch() returns trigger as $$
begin
  new.updated_at = now();
  if (tg_op = 'UPDATE') then
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bonus_catalog_applied_touch on public.bonus_catalog_applied;
create trigger bonus_catalog_applied_touch
  before insert or update on public.bonus_catalog_applied
  for each row execute function public.bonus_catalog_applied_touch();

-- Lower-case the employee email on write so per-person lookups stay consistent.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists bonus_catalog_applied_normalize_email on public.bonus_catalog_applied;
    create trigger bonus_catalog_applied_normalize_email
      before insert or update on public.bonus_catalog_applied
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- ── Expose to Realtime so applied bonuses update live across users ────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.bonus_catalog_applied;
    exception when duplicate_object then null;
    end;
  end if;
end$$;

-- Verification:
-- select department, period_start, count(*), sum(amount)
-- from public.bonus_catalog_applied group by 1, 2 order by 2 desc, 1;
