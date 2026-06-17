-- Payment Catalog: System Bonuses (PAB + Technology Bonus).
--
-- Makes the two built-in payroll bonuses configurable instead of hardcoded:
--   * pab  -- Perfect Attendance Bonus (was a fixed PHP 5,000 constant)
--   * tech -- Technology Bonus           (was a fixed PHP 1,850 constant)
--
-- Each row carries the editable AMOUNT plus a department ALLOWLIST
-- (`department_keys`) -- a bonus is only paid to employees whose normalized
-- department key is in that list. The seed lists every DEPARTMENTS key EXCEPT
-- `us_manager_bonus`, so US managers (paid in USD) no longer pick up these
-- PHP bonuses while everyone else's behavior is unchanged.
--
-- The amount + allowlist drive every payroll surface (Payroll Wizard, Payment
-- Dispatch, Overview, Employee Dashboard / My Hours) via:
--   server math  -> src/lib/supabase/system-bonuses-db.ts (listSystemBonuses)
--   resolution   -> src/lib/payment-catalog/system-bonus.ts (resolveSystemBonuses)
--   editor UI    -> src/components/accounting/BonusCatalog.tsx (System Bonuses tab)
--
-- Timing is unchanged -- only the amount and dept-eligibility are configurable
-- (PAB still fires the final PAB week; Tech still fires the 3rd-week salary).
--
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS, OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS / re-create, guarded publication add, seed with
-- ON CONFLICT DO NOTHING so a re-run never clobbers later finance edits).

-- -----------------------------------------------------------------------------
-- System bonuses (a small fixed set keyed by a stable `code`)
-- -----------------------------------------------------------------------------
create table if not exists public.payment_catalog_system_bonuses (
  code             text          primary key,           -- 'pab' | 'tech'
  label            text          not null,
  amount           numeric(14,2) not null,
  currency         text          not null default 'PHP' check (currency in ('PHP','USD')),
  enabled          boolean       not null default true,
  department_keys  text[]        not null default '{}', -- canonical DEPARTMENTS[].key allowlist
  created_by       text,
  created_at       timestamptz   not null default now(),
  updated_by       text,
  updated_at       timestamptz   not null default now()
);

-- -----------------------------------------------------------------------------
-- Touch trigger: bump updated_at; keep created_by/created_at immutable
-- -----------------------------------------------------------------------------
create or replace function public.payment_catalog_system_bonuses_touch() returns trigger as $$
begin
  new.updated_at = now();
  if (tg_op = 'UPDATE') then
    new.created_by = old.created_by;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists payment_catalog_system_bonuses_touch on public.payment_catalog_system_bonuses;
create trigger payment_catalog_system_bonuses_touch
  before insert or update on public.payment_catalog_system_bonuses
  for each row execute function public.payment_catalog_system_bonuses_touch();

-- -----------------------------------------------------------------------------
-- Expose to Realtime so the Payment Catalog tab updates live across users
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.payment_catalog_system_bonuses;
    exception when duplicate_object then null;
    end;
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- Seed the two bonuses with their current amounts + the default allowlist
-- (every department EXCEPT us_manager_bonus). ON CONFLICT DO NOTHING so a
-- re-run preserves any edits finance has already made to the amounts/allowlist.
-- -----------------------------------------------------------------------------
insert into public.payment_catalog_system_bonuses
  (code, label, amount, currency, enabled, department_keys, created_by)
values
  ('pab', 'Perfect Attendance Bonus', 5000, 'PHP', true, array[
     'accounting','edit','devs','lead_gen','callback','qc','discovery','hr',
     'sales_assistant','smart_staff','hogan_smith_law','smm','pm_team',
     'client_va','site_building'
   ]::text[], 'seed'),
  ('tech', 'Technology Bonus', 1850, 'PHP', true, array[
     'accounting','edit','devs','lead_gen','callback','qc','discovery','hr',
     'sales_assistant','smart_staff','hogan_smith_law','smm','pm_team',
     'client_va','site_building'
   ]::text[], 'seed')
on conflict (code) do nothing;

-- Verification:
-- select code, amount, enabled, array_length(department_keys, 1) as depts
--   from public.payment_catalog_system_bonuses order by code;
