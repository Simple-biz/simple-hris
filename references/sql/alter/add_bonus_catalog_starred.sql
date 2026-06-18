-- Bonus Catalog: highlight ("star") a bonus in the Bonus Library.
--
-- Adds a `starred` flag to bonus_catalog_bonuses. Starred bonuses are sorted to
-- the top of the Bonus Library tab and shown with an amber star so finance can
-- highlight the ones that matter. Display-only -- it does not change payout.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Run AFTER create_bonus_catalog.sql.

alter table public.bonus_catalog_bonuses
  add column if not exists starred boolean not null default false;

-- Verification:
-- select id, name, starred from public.bonus_catalog_bonuses order by starred desc, name;
