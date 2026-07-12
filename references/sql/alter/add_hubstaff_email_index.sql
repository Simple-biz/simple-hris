-- hubstaff_hours."Email" index — employee-portal load performance.
--
-- The employee portal (My Hours calendar + pay summary) and the manager
-- member-monthly-pay calculator all fetch ONE employee's rows across every
-- weekly upload with:
--     .from('hubstaff_hours').select('*').or('"Email".eq.<alias>,...')
-- With no index on "Email" this is a sequential scan of the whole table
-- (~22k+ rows measured 2026-05-20) on every load — and it runs on the pay
-- summary AND (after the 2026-07 fan-out fix) the calendar merge.
--
-- The filter is an exact-match `.eq` on the raw "Email" value (aliases are
-- already normalized to lower/trim before the query, mirroring the raw values
-- Hubstaff exports), so a plain btree index on the column matches the plan.
--
-- CREATE INDEX IF NOT EXISTS -> safe, idempotent, non-destructive. Run once in
-- the Supabase SQL editor. Use CONCURRENTLY in prod to avoid locking (cannot
-- run CONCURRENTLY inside a transaction block).

create index if not exists idx_hubstaff_hours_email
  on public.hubstaff_hours ("Email");
