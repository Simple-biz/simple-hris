-- Per-contractor invoicing currency (PHP or USD).
-- Admins set the contractor's currency in Admin -> Roles; each invoice
-- snapshots the currency in force when it was created.

ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'PHP';
ALTER TABLE contractor_invoices ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'PHP';

-- Backfill any pre-existing rows that predate the column.
UPDATE contractor_profiles SET currency = 'PHP' WHERE currency IS NULL;
UPDATE contractor_invoices SET currency = 'PHP' WHERE currency IS NULL;
