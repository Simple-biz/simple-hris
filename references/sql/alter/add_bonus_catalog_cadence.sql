-- Per-bonus payout cadence (weekly or monthly) for the Bonus Catalog.
--
-- The Bonus Library lets finance choose whether a bonus pays every payroll week
-- (default) or once per month. Payroll runs weekly, so a MONTHLY bonus pays on
-- the LAST payroll week of its month -- mirroring how PAB already attaches to the
-- final weekly paystub of its period. Enforcement:
--   * the manager KPI Calculator only lets a monthly bonus be APPLIED in that
--     final week (so bonus_catalog_applied never holds a monthly row for a
--     non-final week), and
--   * the Payroll Wizard only sums a monthly applied row into the final week's
--     "KPI Sub." column (a backstop).
--
-- `cadence` is snapshotted onto bonus_catalog_applied at apply time (like
-- bonus_name / kind) so the Wizard can gate payout without joining back to the
-- definition.
--
-- Run AFTER create_bonus_catalog.sql + create_bonus_catalog_applied.sql.
-- Idempotent (add column if not exists + backfill), safe to re-run.

-- ── Definition table ─────────────────────────────────────────────────────────
alter table public.bonus_catalog_bonuses
  add column if not exists cadence text;
update public.bonus_catalog_bonuses set cadence = 'weekly' where cadence is null;
alter table public.bonus_catalog_bonuses alter column cadence set default 'weekly';
alter table public.bonus_catalog_bonuses alter column cadence set not null;
do $$
begin
  alter table public.bonus_catalog_bonuses
    add constraint bonus_catalog_bonuses_cadence_check check (cadence in ('weekly','monthly'));
exception when duplicate_object then null;
end$$;

-- ── Applied (payout) table — snapshot of the definition's cadence at apply time ─
alter table public.bonus_catalog_applied
  add column if not exists cadence text;
update public.bonus_catalog_applied set cadence = 'weekly' where cadence is null;
alter table public.bonus_catalog_applied alter column cadence set default 'weekly';
alter table public.bonus_catalog_applied alter column cadence set not null;
do $$
begin
  alter table public.bonus_catalog_applied
    add constraint bonus_catalog_applied_cadence_check check (cadence in ('weekly','monthly'));
exception when duplicate_object then null;
end$$;

-- Verification:
-- select cadence, count(*) from public.bonus_catalog_bonuses group by 1;
-- select cadence, count(*) from public.bonus_catalog_applied group by 1;
