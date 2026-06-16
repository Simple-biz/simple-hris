-- Per-bonus currency (PHP or USD) for the Bonus Catalog (Payment Catalog tab).
--
-- The Bonus Library lets finance denominate a bonus in PHP (default) or USD --
-- mirroring the per-row currency Pay Structures already carry. A USD bonus is
-- converted to PHP at the live USD->PHP rate (app_settings.usd_to_php_rate) when
-- a manager APPLIES it in the KPI Calculator, so the payout layer
-- (bonus_catalog_applied.amount + the Payroll Wizard "KPI Sub." sum) stays PHP
-- with no downstream changes.
--
-- Run AFTER create_bonus_catalog.sql. Idempotent (add column if not exists +
-- backfill), so it's safe to re-run.

-- Add nullable first so the backfill UPDATE below is load-bearing even if a
-- prior hand-add created the column without a default; then enforce default +
-- NOT NULL. (If create_bonus_catalog.sql already made it NOT NULL DEFAULT, each
-- statement is simply a no-op.)
alter table public.bonus_catalog_bonuses
  add column if not exists currency text;

-- Backfill any pre-existing rows that predate the column.
update public.bonus_catalog_bonuses set currency = 'PHP' where currency is null;

alter table public.bonus_catalog_bonuses alter column currency set default 'PHP';
alter table public.bonus_catalog_bonuses alter column currency set not null;

-- Constrain to the supported currencies (matches the PayCurrency union + the
-- kind/scope check-constraint style already used in this schema). Guarded so a
-- re-run doesn't error on the existing constraint.
do $$
begin
  alter table public.bonus_catalog_bonuses
    add constraint bonus_catalog_bonuses_currency_check check (currency in ('PHP','USD'));
exception when duplicate_object then null;
end$$;

-- Verification:
-- select currency, count(*) from public.bonus_catalog_bonuses group by 1;
