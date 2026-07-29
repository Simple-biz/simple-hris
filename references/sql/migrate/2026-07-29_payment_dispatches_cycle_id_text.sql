-- payment_dispatches.cycle_id: UUID → TEXT.
--
-- WHY: the Urgent queue (MESA disbursements + one-off People-tab payments) has
-- always written sentinel cycle_id='urgent' (app/api/mesa-requests/[id]/dispatch,
-- app/api/urgent-payments/requests/[id]/dispatch), and the weekly urgent report
-- reader filters .eq('cycle_id','urgent') (src/lib/payroll/disbursement-reports.ts).
-- But the column was created as UUID REFERENCES hubstaff_uploads(id)
-- (references/sql/seed/seed_payment_dispatches.sql), so EVERY urgent Mark Paid
-- failed with: invalid input syntax for type uuid: "urgent" — no urgent dispatch
-- was ever recorded. Regular payroll dispatches (real upload UUIDs) still write
-- fine as text; PostgREST sends/compares them as strings either way.
--
-- The FK to hubstaff_uploads is dropped along with the type change (a text
-- column cannot reference a uuid PK). Nothing in code or SQL dereferences
-- cycle_id back to hubstaff_uploads, and the column's stated purpose is a
-- snapshot ("survives cycle deletion"); after this, deleting an upload simply
-- leaves the historical id string in place instead of nulling it.
--
-- Idempotent — a re-run is a no-op once the column is text.
-- Apply with: node scripts/apply-cycle-id-text.mjs

DO $$
DECLARE
  fk_name text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'payment_dispatches'
      AND column_name  = 'cycle_id'
      AND data_type    = 'uuid'
  ) THEN
    -- Drop the FK on cycle_id (name discovered dynamically — it was created
    -- inline by the seed migration, so the auto-generated name could vary).
    SELECT conname INTO fk_name
    FROM pg_constraint
    WHERE conrelid = 'public.payment_dispatches'::regclass
      AND contype  = 'f'
      AND conkey   = ARRAY[(
        SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.payment_dispatches'::regclass
          AND attname  = 'cycle_id'
      )];
    IF fk_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.payment_dispatches DROP CONSTRAINT %I', fk_name);
    END IF;

    -- Indexes on cycle_id (idx_payment_dispatches_cycle, _cycle_recipient)
    -- are rebuilt automatically by ALTER TYPE.
    ALTER TABLE public.payment_dispatches
      ALTER COLUMN cycle_id TYPE text USING cycle_id::text;
  END IF;
END $$;

COMMENT ON COLUMN public.payment_dispatches.cycle_id IS
  'Snapshot of the paying cycle: a hubstaff_uploads.id (regular payroll) or the sentinel ''urgent'' (MESA / one-off urgent payments). Text, not uuid — no FK by design.';
