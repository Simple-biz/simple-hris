-- Reset Hubstaff timesheets table — removes ALL rows (uploaded weekly CSV data).
--
-- Default name is public.hubstaff_hours (same as NEXT_PUBLIC_SUPABASE_HUBSTAFF_HOURS_TABLE).
-- Rename the table below if your env uses a different table name.
--
-- Paste into Supabase → SQL Editor as postgres (or role with TRUNCATE on this table).

BEGIN;

TRUNCATE TABLE public.hubstaff_hours RESTART IDENTITY;

COMMIT;

-- Row count afterward should be 0. Re-import Hubstaff CSV from Payroll Wizard when ready.
--
-- If you get: ERROR: cannot truncate ... foreign key constraint:
-- Another table references hubstaff_hours. Either:
--   • Delete child rows first, then run TRUNCATE again, OR
--   • Use (destructive — only if you intend to wipe dependents):
--       TRUNCATE TABLE public.hubstaff_hours RESTART IDENTITY CASCADE;
