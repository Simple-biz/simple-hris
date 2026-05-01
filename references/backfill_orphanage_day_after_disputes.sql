-- Backfill: materialize the former "day-after auto-forgiveness" rule as real dispute rows.
--
-- Background: through 2026-04-30, an approved orphanage_visit dispute on day D also
-- implicitly forgave day D+1 in the calendar (synthetic map entry; no DB row).
-- That implicit rule has been removed in code so the Orphanage Manager (Alyson) and
-- Accounting (Carla) explicitly choose every forgiven date going forward.
--
-- This migration is a ONE-TIME backfill so PAB months that previously relied on
-- implicit D+1 forgiveness do not silently regress. For each existing accounting-approved
-- orphanage_visit row at date D, we insert (or skip) a sibling row at D+1 with status
-- accounting_approved and a clear audit-trail explanation.
--
-- Idempotent: re-running is safe — the unique index on (work_email, dispute_date)
-- enforces ON CONFLICT DO NOTHING semantics. A real D+1 dispute already on file wins.
--
-- Run order: deploy code first (so future writes skip D+1), then run this script.

BEGIN;

INSERT INTO public.pab_day_disputes (
  work_email,
  dispute_date,
  reason,
  explanation,
  status,
  decided_by,
  decided_at,
  decision_note,
  override_hours,
  created_by,
  created_at,
  updated_at
)
SELECT
  d.work_email,
  (d.dispute_date::date + INTERVAL '1 day')::date AS dispute_date,
  'orphanage_visit'                               AS reason,
  'Auto-migrated from former day-after rule (visit was on '
    || to_char(d.dispute_date::date, 'YYYY-MM-DD')
    || ').'                                       AS explanation,
  'accounting_approved'                           AS status,
  COALESCE(d.decided_by, 'system_backfill')       AS decided_by,
  NOW()                                           AS decided_at,
  'Auto-migrated from former day-after rule.'     AS decision_note,
  NULL                                            AS override_hours,
  'system_backfill'                               AS created_by,
  NOW()                                           AS created_at,
  NOW()                                           AS updated_at
FROM public.pab_day_disputes d
WHERE d.reason = 'orphanage_visit'
  AND d.status IN ('accounting_approved', 'approved')
ON CONFLICT (work_email, dispute_date) DO NOTHING;

-- Optional sanity check (not enforced — comment out if you don't want a row count):
-- SELECT COUNT(*) AS d_plus_one_rows
-- FROM public.pab_day_disputes
-- WHERE created_by = 'system_backfill'
--   AND decision_note = 'Auto-migrated from former day-after rule.';

COMMIT;
