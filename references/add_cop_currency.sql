-- Add COP (Colombian Peso) as a third currency across the Payment Catalog +
-- Payment Dispatch, USD-anchored.
--
-- Context: the app supported only PHP + USD (PayCurrency = 'PHP' | 'USD'), with
-- USD<->PHP via app_settings.usd_to_php_rate. COP is added as a USD-anchored
-- currency: a NEW app_settings.usd_to_cop_rate (COP per $1) drives it, and the
-- PHP<->COP cross-rate is derived through USD (never stored). COP-paid people
-- are settled natively in COP via a dedicated Payment Dispatch tab + a new
-- payment_dispatches.amount_cop column.
--
-- This migration:
--   1. Widens the `currency` CHECK constraints to allow 'COP'.
--   2. Adds payment_dispatches.amount_cop (whole pesos -- COP has no minor unit).
--   3. Seeds a default usd_to_cop_rate.
--
-- Idempotent: re-runnable. Run AFTER create_bonus_catalog.sql,
-- add_bonus_catalog_currency.sql, create_payment_catalog_pay_structures.sql,
-- create_payment_catalog_system_bonuses.sql, and the payment_dispatches table.

-- 1a. bonus_catalog_bonuses.currency  -> ('PHP','USD','COP')
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'bonus_catalog_bonuses'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%currency%'
  loop
    execute format('alter table public.bonus_catalog_bonuses drop constraint %I', c.conname);
  end loop;
  alter table public.bonus_catalog_bonuses
    add constraint bonus_catalog_bonuses_currency_check check (currency in ('PHP','USD','COP'));
end$$;

-- 1b. payment_catalog_pay_structures.currency  -> ('PHP','USD','COP')
do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'payment_catalog_pay_structures'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%currency%'
  loop
    execute format('alter table public.payment_catalog_pay_structures drop constraint %I', c.conname);
  end loop;
  alter table public.payment_catalog_pay_structures
    add constraint payment_catalog_pay_structures_currency_check check (currency in ('PHP','USD','COP'));
end$$;

-- 1c. payment_catalog_system_bonuses.currency  -> ('PHP','USD','COP')
do $$
declare c record;
begin
  if to_regclass('public.payment_catalog_system_bonuses') is null then
    return;
  end if;
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'payment_catalog_system_bonuses'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%currency%'
  loop
    execute format('alter table public.payment_catalog_system_bonuses drop constraint %I', c.conname);
  end loop;
  alter table public.payment_catalog_system_bonuses
    add constraint payment_catalog_system_bonuses_currency_check check (currency in ('PHP','USD','COP'));
end$$;

-- 2. Native COP payout amount on dispatch records. NUMERIC(14,0): COP has no
--    commonly-used minor unit, so the app rounds to whole pesos.
alter table public.payment_dispatches
  add column if not exists amount_cop numeric(14,0);

-- 3. Seed the default USD -> COP rate (COP per $1). Stored as a plain numeric
--    string, like usd_to_php_rate. Leaves an existing value untouched.
insert into public.app_settings (key, value)
values ('usd_to_cop_rate', '4000')
on conflict (key) do nothing;

-- Verification:
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname like '%currency_check%';
-- select column_name, data_type from information_schema.columns
--   where table_name = 'payment_dispatches' and column_name = 'amount_cop';
-- select key, value from public.app_settings where key = 'usd_to_cop_rate';
