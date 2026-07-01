-- ============================================================================
-- Bank/payout change history — dedicated, non-clearable table  (2026-07-01, migration #93)
--
-- Until now, the People-tab "Recent bank changes" feed sourced everything from
-- `audit_log` (`bank_update.saved` rows). Two problems that fixes:
--   1. `audit_log` is global — there was no way to see one employee's payout
--      change history on its own (only the shared, paginated feed).
--   2. `DELETE /api/audit-log` (any admin, see app/api/audit-log/route.ts)
--      truncates the ENTIRE audit_log table. A payout-change trail is exactly
--      the kind of record Accounting needs to still have after someone clears
--      the general audit log for housekeeping — it shouldn't live only there.
--
-- This migration adds `bank_update_history`, written to going forward by
-- app/api/bank-update/save/route.ts ALONGSIDE the existing audit_log insert
-- (that one is untouched — still feeds the general Audit Log admin viewer).
-- The People-tab global feed and a new per-employee "Bank change history"
-- section both read from this table instead.
--
-- Security model matches audit_log/employee_rate_history: no RLS, service-role
-- only, enforced in app code. No Realtime publication either — the People
-- feed's live-update signal is a separate non-PII app_settings pulse key
-- (see src/lib/supabase/app-settings.ts), untouched by this change.
--
-- Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.bank_update_history (
  id            uuid        primary key default gen_random_uuid(),
  -- The employee's canonical WORK EMAIL (lowercased by the trigger below).
  work_email    text        not null,
  -- Display name at save time (falls back to work_email in the feed if null).
  employee_name text,
  -- Snake_case payout field names submitted this save (may include fields
  -- re-submitted unchanged — see `changes` for which actually changed).
  fields        jsonb       not null default '[]'::jsonb,
  -- Masked before->after per submitted field, with a `changed` boolean computed
  -- on the raw values before masking (see maskFieldValue in
  -- src/lib/bank-update/mask-field.ts). Empty for legacy pre-migration rows.
  changes       jsonb       not null default '[]'::jsonb,
  processor     text,
  created_new   boolean     not null default false,
  via           text,
  ip_address    text,
  created_at    timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS bank_update_history_email_idx
  ON public.bank_update_history (lower(work_email), created_at DESC);
CREATE INDEX IF NOT EXISTS bank_update_history_created_idx
  ON public.bank_update_history (created_at DESC);

-- Lower-case + trim the email on every write (same helper as employee_rate_history).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS bank_update_history_normalize_email ON public.bank_update_history;
    CREATE TRIGGER bank_update_history_normalize_email
      BEFORE INSERT OR UPDATE ON public.bank_update_history
      FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column('work_email');
  END IF;
END$$;

-- One-time backfill from the existing audit_log rows, reusing the audit_log
-- row's own id (ON CONFLICT DO NOTHING) so the People-tab feed's ids stay
-- stable across the cutover — no duplicate "New" flashes on existing entries.
INSERT INTO public.bank_update_history
  (id, work_email, employee_name, fields, changes, processor, created_new, via, ip_address, created_at)
SELECT
  id,
  resource_id,
  user_name,
  COALESCE(details->'fields', '[]'::jsonb),
  COALESCE(details->'changes', '[]'::jsonb),
  details->>'processor',
  COALESCE((details->>'created')::boolean, false),
  details->>'via',
  ip_address,
  created_at
FROM public.audit_log
WHERE action = 'bank_update.saved'
  AND resource_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Verify:
--   SELECT count(*) FROM public.bank_update_history;
--   SELECT count(*) FROM public.audit_log WHERE action = 'bank_update.saved';
--   -- (the two counts should match right after this migration runs)
