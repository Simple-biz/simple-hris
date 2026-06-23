-- ============================================================
-- Fix: compute the MISSING PHP/USD amounts for May 24 – Jun 21, 2026
--
-- Why
--   The four weekly cycles in this window were marked PAID via
--   backfill_mark_paid_may24_jun21_2026.sql, but their disbursement_records
--   rows were never COSTED — amount_php / amount_usd / rate snapshots are NULL.
--   (Hubstaff hours were uploaded, but pay was never computed for these weeks;
--   the mark-paid backfill just copied the NULL amounts through.) So the
--   Reports tab + Penny AI correctly show "-" for those weeks.
--
-- What this does — same math as seed_disbursement_records.sql Step 2, but
--   SCOPED to the un-costed rows so it never disturbs already-costed weeks:
--     regular_rate_php / ot_rate_php  <- employee_hourly_rates
--                                        (newest rate row per Work Email)
--     amount_php      = regular_hours*reg + ot_hours*ot
--     fx_rate         = app_settings.usd_to_php_rate
--     amount_usd      = amount_php / fx_rate
--     paid_amount_usd = amount_usd   (only for rows already status='paid', so
--                                     the Reports "paid total" reflects them)
--
--   Rows WITHOUT a work-email rate are LEFT UNTOUCHED (NULL) so they surface for
--   manual review instead of being silently costed at 0. (Matching rates by
--   personal email is deliberately avoided — personal email is not unique.)
--
-- Safety
--   • Only touches rows where amount_php IS NULL inside the window → idempotent
--     and cannot change historical, already-costed weeks.
--   • Read STEP 0 first; it is read-only.
--
-- Preview at authoring time (2026-06-23): 593 rows fillable (~₱4,126,926.78 /
--   ~$68,451 at FX 60.29); 40 rows have no work-email rate and stay NULL.
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- ── STEP 0 — PREVIEW (read-only): what will be filled, and what will be skipped
-- WITH rates AS (
--   SELECT DISTINCT ON (LOWER(TRIM("Work Email")))
--     LOWER(TRIM("Work Email")) AS work_email,
--     "Regular Rate"::numeric   AS regular_rate,
--     "OT Rate"::numeric        AS ot_rate
--   FROM public.employee_hourly_rates
--   WHERE "Work Email" IS NOT NULL AND TRIM("Work Email") <> ''
--   ORDER BY LOWER(TRIM("Work Email")), id DESC
-- )
-- SELECT
--   (r.work_email IS NOT NULL) AS has_rate,
--   COUNT(*)                                                          AS rows,
--   ROUND(SUM(dr.regular_hours*COALESCE(r.regular_rate,0)
--           + dr.ot_hours*COALESCE(r.ot_rate,0))::numeric, 2)         AS total_php
-- FROM public.disbursement_records dr
-- LEFT JOIN rates r ON r.work_email = LOWER(TRIM(dr.recipient_email))
-- WHERE dr.cycle_period_start >= DATE '2026-05-24'
--   AND dr.cycle_period_end   <= DATE '2026-06-21'
--   AND dr.amount_php IS NULL
-- GROUP BY (r.work_email IS NOT NULL);


-- ── STEP 1 — fill the amounts ──────────────────────────────────────
BEGIN;

WITH fx AS (
  SELECT COALESCE(NULLIF(value, '')::numeric, 0) AS rate
  FROM public.app_settings
  WHERE key = 'usd_to_php_rate'
  LIMIT 1
),
rates AS (
  SELECT DISTINCT ON (LOWER(TRIM("Work Email")))
    LOWER(TRIM("Work Email")) AS work_email,
    "Regular Rate"::numeric   AS regular_rate,
    "OT Rate"::numeric        AS ot_rate
  FROM public.employee_hourly_rates
  WHERE "Work Email" IS NOT NULL AND TRIM("Work Email") <> ''
  ORDER BY LOWER(TRIM("Work Email")), id DESC
)
UPDATE public.disbursement_records dr
SET
  regular_rate_php = r.regular_rate,
  ot_rate_php      = r.ot_rate,
  amount_php       = ROUND(dr.regular_hours * r.regular_rate + dr.ot_hours * r.ot_rate, 2),
  fx_rate          = f.rate,
  amount_usd       = CASE WHEN f.rate > 0
                       THEN ROUND((dr.regular_hours * r.regular_rate + dr.ot_hours * r.ot_rate) / f.rate, 2)
                       ELSE NULL END,
  paid_amount_usd  = CASE WHEN dr.status = 'paid' AND f.rate > 0
                       THEN ROUND((dr.regular_hours * r.regular_rate + dr.ot_hours * r.ot_rate) / f.rate, 2)
                       ELSE dr.paid_amount_usd END,
  updated_at       = now()
FROM rates r, fx f
WHERE r.work_email = LOWER(TRIM(dr.recipient_email))
  AND dr.cycle_period_start >= DATE '2026-05-24'
  AND dr.cycle_period_end   <= DATE '2026-06-21'
  AND dr.amount_php IS NULL;

COMMIT;


-- ── STEP 2 — verify, and list any rows still NULL (no work-email rate) ──
-- SELECT dr.cycle_period_start, dr.cycle_period_end,
--        COUNT(*)                                        AS rows,
--        COUNT(*) FILTER (WHERE dr.amount_php IS NULL)   AS still_null,
--        ROUND(SUM(dr.amount_php)::numeric, 2)           AS total_php
-- FROM public.disbursement_records dr
-- WHERE dr.cycle_period_start >= DATE '2026-05-24'
--   AND dr.cycle_period_end   <= DATE '2026-06-21'
-- GROUP BY dr.cycle_period_start, dr.cycle_period_end
-- ORDER BY dr.cycle_period_start;
--
-- -- The leftover no-rate rows to chase down a rate for (then re-run STEP 1):
-- SELECT dr.recipient_email, dr.recipient_name, dr.cycle_period_start, dr.total_hours
-- FROM public.disbursement_records dr
-- WHERE dr.cycle_period_start >= DATE '2026-05-24'
--   AND dr.cycle_period_end   <= DATE '2026-06-21'
--   AND dr.amount_php IS NULL
-- ORDER BY dr.recipient_email;
