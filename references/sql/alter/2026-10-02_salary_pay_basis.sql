-- Payment Catalog: SALARIED pay basis (Kane, 2026-10-02).
--
-- "Lets add an option in here instead of the regular hourly and ot hourly - we can get a flat
--  rate per day, week, month - as a salary so its a flat rate everytime no matter their
--  hubstaff hours"
--
-- Governing ruling: docs/features/salaried-pay-basis.md §2 — a salary is a DATED FACT ABOUT A
-- PERSON, never a property of a department. So:
--
--   1. payment_catalog_pay_structures gains the salary columns the Pay Structure editor reads and
--      writes (pay_basis / salary_period / salary_amount). A salary is legal ONLY on an
--      EMPLOYEE-scope row — the CHECK below makes a department salary unrepresentable.
--   2. employee_salary_history is the dated, person-keyed spine the pay engines resolve the basis
--      from (mirrors employee_rate_history). One row per (person, effective date). A switch back
--      to hourly is a row too (pay_basis = 'hourly'), so a replayed week resolves the basis that
--      was in force then.
--
-- Additive and defaulted: every existing structure becomes pay_basis = 'hourly' with null salary
-- columns, which is exactly what it was. Nothing is backfilled into the history.
--
-- Period: the schema carries day / week / month. The app prices only 'week' today — how a daily
-- or monthly amount maps onto the weekly pay run is Kane's ruling (salaried-pay-basis.md, NEEDS).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, constraints dropped and re-added by name, CREATE ... IF
-- NOT EXISTS, guarded trigger. Applied by scripts/apply-salary-pay-basis-migration.mts.

-- ---------------------------------------------------------------------------
-- 1. Salary columns on the pay structure
-- ---------------------------------------------------------------------------
alter table public.payment_catalog_pay_structures
  add column if not exists pay_basis text not null default 'hourly';
alter table public.payment_catalog_pay_structures
  add column if not exists salary_period text;
alter table public.payment_catalog_pay_structures
  add column if not exists salary_amount numeric(14,2);

alter table public.payment_catalog_pay_structures
  drop constraint if exists pay_structures_pay_basis_valid;
alter table public.payment_catalog_pay_structures
  add constraint pay_structures_pay_basis_valid check (pay_basis in ('hourly','salary'));

alter table public.payment_catalog_pay_structures
  drop constraint if exists pay_structures_salary_period_valid;
alter table public.payment_catalog_pay_structures
  add constraint pay_structures_salary_period_valid
  check (salary_period is null or salary_period in ('day','week','month'));

-- The shape: an hourly row carries no salary figures; a salary row is EMPLOYEE scope with both a
-- period and a non-negative amount. A department-scope salary cannot be stored (ruling §2).
alter table public.payment_catalog_pay_structures
  drop constraint if exists pay_structures_salary_shape;
alter table public.payment_catalog_pay_structures
  add constraint pay_structures_salary_shape check (
    (pay_basis = 'hourly' and salary_period is null and salary_amount is null)
    or
    (pay_basis = 'salary' and scope = 'employee' and salary_period is not null
       and salary_amount is not null and salary_amount >= 0)
  );

comment on column public.payment_catalog_pay_structures.pay_basis is
  'hourly = regular_rate x Hubstaff hours (+ OT); salary = a flat salary_amount per salary_period, Hubstaff hours move no money. salary is legal on employee scope only.';

-- ---------------------------------------------------------------------------
-- 2. Dated, person-keyed salary history
-- ---------------------------------------------------------------------------
create table if not exists public.employee_salary_history (
  id              uuid          primary key default gen_random_uuid(),
  employee_email  text          not null,
  effective_from  date          not null,
  pay_basis       text          not null,
  salary_period   text,
  salary_amount   numeric(14,2),
  currency        text          not null default 'PHP',
  structure_id    text,
  note            text,
  created_by      text,
  created_at      timestamptz   not null default now(),
  constraint salary_history_email_present check (length(btrim(employee_email)) > 0),
  constraint salary_history_pay_basis_valid check (pay_basis in ('hourly','salary')),
  constraint salary_history_period_valid check (salary_period is null or salary_period in ('day','week','month')),
  constraint salary_history_currency_valid check (currency in ('PHP','USD','COP')),
  constraint salary_history_shape check (
    (pay_basis = 'hourly' and salary_period is null and salary_amount is null)
    or
    (pay_basis = 'salary' and salary_period is not null and salary_amount is not null and salary_amount >= 0)
  )
);

comment on table public.employee_salary_history is
  'Dated pay-basis timeline per person (salaried-pay-basis.md). The pay engines resolve hourly vs salary from the row in force on the pay-week start. Written by the pay-structures route only. Service-role only.';

-- One basis per person per effective date: a re-save on the same date replaces, never stacks
-- (the cheskac@ same-date duplicate class in employee_rate_history).
create unique index if not exists employee_salary_history_one_per_day
  on public.employee_salary_history (lower(employee_email), effective_from);
create index if not exists employee_salary_history_email_idx
  on public.employee_salary_history (lower(employee_email), effective_from desc);

-- Lower-case + trim the email on every write, like employee_rate_history.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists employee_salary_history_normalize_email on public.employee_salary_history;
    create trigger employee_salary_history_normalize_email
      before insert or update on public.employee_salary_history
      for each row execute function public.normalize_email_column('employee_email');
  end if;
end$$;

-- Lock-down: service role only. The routes read it with the service-role client; no browser
-- client ever touches it.
alter table public.employee_salary_history enable row level security;
revoke all on table public.employee_salary_history from anon, authenticated;

-- Verification:
-- select pay_basis, count(*) from public.payment_catalog_pay_structures group by pay_basis;
-- select count(*) from public.employee_salary_history;
