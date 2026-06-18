-- Bonus Catalog: reusable custom bonuses (flat amount or Excel-style formula)
-- plus the assignments that attach each bonus to a whole department ("common")
-- or to a single employee ("specific").
--
-- Replaces the earlier single-blob storage in app_settings (key 'bonus.catalog')
-- so each bonus is its own row with a creator + timestamps. That gives author
-- attribution and live multi-user visibility (you can see when a teammate adds
-- a bonus) and avoids last-writer-wins clobbering of one shared JSON value.
--
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS, OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS / re-create, guarded publication add).

-- ── Bonus definitions ────────────────────────────────────────────────────────
create table if not exists public.bonus_catalog_bonuses (
  id          text        primary key,
  name        text        not null,
  description text,
  kind        text        not null check (kind in ('flat','formula')),
  amount      numeric(14,2),
  formula     text,
  -- Currency the flat amount / formula result is denominated in. USD bonuses are
  -- converted to PHP at the live FX rate when applied (the KPI Calculator), so
  -- the payout layer (bonus_catalog_applied + Payroll Wizard) stays PHP.
  currency    text        not null default 'PHP' check (currency in ('PHP','USD')),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- ── Assignments (department-wide "common" OR a single employee) ───────────────
create table if not exists public.bonus_catalog_assignments (
  id              text        primary key,
  bonus_id        text        not null references public.bonus_catalog_bonuses(id) on delete cascade,
  scope           text        not null check (scope in ('department','employee')),
  department_key  text        not null,
  employee_email  text,
  employee_name   text,
  created_by      text,
  created_at      timestamptz not null default now()
);

create index if not exists bonus_catalog_assignments_bonus_idx
  on public.bonus_catalog_assignments (bonus_id);
create index if not exists bonus_catalog_assignments_dept_idx
  on public.bonus_catalog_assignments (department_key);
create index if not exists bonus_catalog_assignments_email_idx
  on public.bonus_catalog_assignments (lower(employee_email))
  where employee_email is not null;

-- ── Touch trigger: bump updated_at; keep created_by/created_at immutable ──────
-- On UPDATE we restore the original creator/created_at regardless of what the
-- writer sends, so "who created this" can never be overwritten by an edit.
create or replace function public.bonus_catalog_touch() returns trigger as $$
begin
  new.updated_at = now();
  if (tg_op = 'UPDATE') then
    new.created_by = old.created_by;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bonus_catalog_bonuses_touch on public.bonus_catalog_bonuses;
create trigger bonus_catalog_bonuses_touch
  before insert or update on public.bonus_catalog_bonuses
  for each row execute function public.bonus_catalog_touch();

-- Lower-case the employee email on write so per-person lookups stay consistent.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists bonus_catalog_assignments_normalize_email on public.bonus_catalog_assignments;
    create trigger bonus_catalog_assignments_normalize_email
      before insert or update on public.bonus_catalog_assignments
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- ── Expose to Realtime so the Bonus Catalog tab updates live across users ─────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.bonus_catalog_bonuses;
    exception when duplicate_object then null;
    end;
    begin
      alter publication supabase_realtime add table public.bonus_catalog_assignments;
    exception when duplicate_object then null;
    end;
  end if;
end$$;

-- ── One-time backfill from the legacy app_settings JSON blob ──────────────────
-- Best-effort, idempotent (ON CONFLICT DO NOTHING). Separate DO blocks so a
-- failure migrating assignments cannot roll back the migrated bonuses.
do $$
declare v text;
begin
  select value into v from public.app_settings where key = 'bonus.catalog';
  if v is not null and v <> '' then
    insert into public.bonus_catalog_bonuses (id, name, description, kind, amount, formula, currency, created_by)
    select b->>'id',
           coalesce(b->>'name',''),
           b->>'description',
           coalesce(b->>'kind','flat'),
           nullif(b->>'amount','')::numeric,
           b->>'formula',
           case when b->>'currency' = 'USD' then 'USD' else 'PHP' end,
           'migrated'
    from jsonb_array_elements((v::jsonb)->'bonuses') as b
    where coalesce(b->>'id','') <> ''
    on conflict (id) do nothing;
  end if;
exception when others then null;
end$$;

do $$
declare v text;
begin
  select value into v from public.app_settings where key = 'bonus.catalog';
  if v is not null and v <> '' then
    insert into public.bonus_catalog_assignments
      (id, bonus_id, scope, department_key, employee_email, employee_name, created_by)
    select a->>'id',
           a->>'bonusId',
           a->>'scope',
           coalesce(a->>'departmentKey',''),
           a->>'employeeEmail',
           a->>'employeeName',
           'migrated'
    from jsonb_array_elements((v::jsonb)->'assignments') as a
    where coalesce(a->>'id','') <> ''
      and exists (select 1 from public.bonus_catalog_bonuses x where x.id = a->>'bonusId')
    on conflict (id) do nothing;
  end if;
exception when others then null;
end$$;

-- Verification:
-- select 'bonuses' as t, count(*) from public.bonus_catalog_bonuses
-- union all select 'assignments', count(*) from public.bonus_catalog_assignments;
