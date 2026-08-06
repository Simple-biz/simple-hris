-- ============================================================
-- Snapshot the Payment Catalog system bonus (PAB / Technology Bonus) onto
-- payment_dispatches at Mark Paid, so the Paid tab can show the same
-- "incl. ₱X bonus" chip the Pending queue shows.
--
-- Apply with:  node scripts/apply-system-bonus-dispatch-column.mjs
-- (needs DATABASE_URL in .env.local — see that script's header comment)
--
-- Idempotent and safe to re-run. Adds two nullable columns only — no
-- backfill, no triggers, no constraints. Rows paid before this migration
-- simply have NULL here and render no chip on the Paid tab.
-- ============================================================

BEGIN;

ALTER TABLE public.payment_dispatches
  ADD COLUMN IF NOT EXISTS system_bonus_php numeric,
  ADD COLUMN IF NOT EXISTS system_bonus_label text;

COMMENT ON COLUMN public.payment_dispatches.system_bonus_php IS
  'PHP amount of Payment Catalog system bonus (PAB / Technology Bonus, or a custom variant) already included in amount_php, snapshotted at Mark Paid. NULL when this dispatch carried no system bonus.';
COMMENT ON COLUMN public.payment_dispatches.system_bonus_label IS
  'Human-readable breakdown of the system bonus(es) included, e.g. "PAB ₱5,000" or "PAB ₱5,000 + Tech ₱1,850". NULL when system_bonus_php is NULL.';

COMMIT;
