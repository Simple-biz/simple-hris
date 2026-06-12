-- Payment Catalog: Pay Structures.
--
-- Authoritative starting compensation (Regular Rate + OT Rate) defined per
-- department ("common") or per individual employee ("specific"). This is the
-- SOURCE OF TRUTH consumed by HR onboarding: when a department has a catalog
-- pay structure it overrides the observed mode-of-existing-rates heuristic that
-- previously prefilled the onboarding form (see src/lib/supabase/department-rates.ts).
--
-- Each entry carries its own currency (PHP default, switchable to USD per row)
-- because the org pays a mix of PHP staff and USD contractors / US managers.
--
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS, OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS / re-create, guarded publication add).

-- -----------------------------------------------------------------------------
-- Pay structures (department-wide OR a single employee)
-- -----------------------------------------------------------------------------
create table if not exists public.payment_catalog_pay_structures (
  id              text        primary key,
  scope           text        not null check (scope in ('department','employee')),
  department_key  text        not null,
  employee_email  text,
  employee_name   text,
  regular_rate    numeric(14,2) not null,
  ot_rate         numeric(14,2),
  currency        text        not null default 'PHP' check (currency in ('PHP','USD')),
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now()
);

create index if not exists payment_catalog_pay_structures_dept_idx
  on public.payment_catalog_pay_structures (department_key);
create index if not exists payment_catalog_pay_structures_email_idx
  on public.payment_catalog_pay_structures (lower(employee_email))
  where employee_email is not null;

-- One department-scoped structure per department; one per (department, employee).
create unique index if not exists payment_catalog_pay_structures_dept_uniq
  on public.payment_catalog_pay_structures (department_key)
  where scope = 'department';
create unique index if not exists payment_catalog_pay_structures_emp_uniq
  on public.payment_catalog_pay_structures (department_key, lower(employee_email))
  where scope = 'employee' and employee_email is not null;

-- -----------------------------------------------------------------------------
-- Touch trigger: bump updated_at; keep created_by/created_at immutable
-- -----------------------------------------------------------------------------
create or replace function public.payment_catalog_pay_structures_touch() returns trigger as $$
begin
  new.updated_at = now();
  if (tg_op = 'UPDATE') then
    new.created_by = old.created_by;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists payment_catalog_pay_structures_touch on public.payment_catalog_pay_structures;
create trigger payment_catalog_pay_structures_touch
  before insert or update on public.payment_catalog_pay_structures
  for each row execute function public.payment_catalog_pay_structures_touch();

-- Lower-case the employee email on write so per-person lookups stay consistent.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists payment_catalog_pay_structures_normalize_email on public.payment_catalog_pay_structures;
    create trigger payment_catalog_pay_structures_normalize_email
      before insert or update on public.payment_catalog_pay_structures
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- Expose to Realtime so the Payment Catalog tab updates live across users
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.payment_catalog_pay_structures;
    exception when duplicate_object then null;
    end;
  end if;
end$$;

-- Verification:
-- select scope, count(*) from public.payment_catalog_pay_structures group by scope;
