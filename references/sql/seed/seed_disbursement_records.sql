-- ============================================================
-- Migration + Seed: disbursement_records
--
-- Purpose
--   One row per (week, employee). The table is the analytic source
--   of truth for "how much was paid / pending / sent" per Hubstaff
--   pull. The Reports tab in Payment Dispatch queries it directly
--   instead of re-aggregating across hubstaff_hours +
--   employee_hourly_rates + payment_dispatches every render.
--
-- Steps
--   Step 1  Create table + indexes + triggers (idempotent).
--   Step 2  Seed / backfill from hubstaff_hours (idempotent upsert).
--   Step 3  Bulk-mark every row as paid (run once after backfill,
--           safe to re-run).
--
-- Sources joined at seed time
--   • public.hubstaff_hours            (one row per employee per week)
--   • public.employee_hourly_rates     (regular + OT rate per work email)
--   • public.payment_dispatches        (paid/threshold/problem outcomes)
--   • public.app_settings.usd_to_php_rate (FX rate at compute time)
--   • Cycle dates parsed from source_file filenames
--     (e.g. simple-biz_daily_report_2026-04-12_to_2026-04-18.csv)
--
-- Deduplication guards (added 2026-05-31)
--   • parsed_hours  — GROUP BY (source_file, email) + SUM hours, so
--     multiple hubstaff_hours rows per employee (re-imports, project
--     splits) are collapsed before the join.
--   • rates         — DISTINCT ON (work_email) ORDER BY id DESC, so
--     only the most-recently-inserted rate row is used per employee
--     (guards against rate-history duplicates).
--   • final SELECT  — wrapped in DISTINCT ON (source_file, email) as
--     a catch-all before the INSERT, preventing the
--     "ON CONFLICT DO UPDATE command cannot affect row a second time"
--     error even if an edge-case duplicate slips through upstream.
--
-- Re-run safety
--   • Step 2 is idempotent: UNIQUE(source_file, recipient_email) +
--     ON CONFLICT DO UPDATE means re-running refreshes rates/hours
--     without duplicating rows.
--   • Step 3 is idempotent: WHERE status <> 'paid' is a no-op when
--     all rows are already marked paid.
--
-- When to re-run
--   Re-run Step 2 (then optionally Step 3) whenever new Hubstaff
--   CSVs are uploaded and the Reports tab shows an "uploads without
--   payroll records" banner. Steps 1 and 2 must be run together
--   inside the BEGIN/COMMIT block; Step 3 is a standalone UPDATE.
--
-- Run in Supabase SQL Editor.
-- ============================================================

BEGIN;

-- ── Step 1 — table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.disbursement_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cycle (parsed from source_file)
  cycle_period_start   DATE NOT NULL,
  cycle_period_end     DATE NOT NULL,
  source_file          TEXT NOT NULL,
  upload_id            UUID REFERENCES public.hubstaff_uploads(id) ON DELETE SET NULL,

  -- Recipient
  recipient_email      TEXT NOT NULL,
  recipient_name       TEXT,

  -- Hours snapshot (decimal, e.g. 40.16 = 40h 9m 36s)
  total_hours          NUMERIC(7,2) NOT NULL DEFAULT 0,
  regular_hours        NUMERIC(7,2) NOT NULL DEFAULT 0,
  ot_hours             NUMERIC(7,2) NOT NULL DEFAULT 0,

  -- Rate snapshot (PHP per hour)
  regular_rate_php     NUMERIC(10,2),
  ot_rate_php          NUMERIC(10,2),

  -- Computed amounts
  amount_php           NUMERIC(12,2),
  amount_usd           NUMERIC(10,2),
  fx_rate              NUMERIC(10,4),

  -- Dispatch outcome
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'paid', 'not_paid', 'threshold', 'problem')),
  paid_amount_usd      NUMERIC(10,2),
  paid_at              DATE,
  bank_used            TEXT,
  transaction_id       TEXT,
  dispatch_id          UUID REFERENCES public.payment_dispatches(id) ON DELETE SET NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT disbursement_records_unique_per_cycle
    UNIQUE (source_file, recipient_email)
);

CREATE INDEX IF NOT EXISTS idx_disbursement_records_period
  ON public.disbursement_records (cycle_period_start, cycle_period_end);
CREATE INDEX IF NOT EXISTS idx_disbursement_records_recipient
  ON public.disbursement_records (lower(recipient_email));
CREATE INDEX IF NOT EXISTS idx_disbursement_records_status
  ON public.disbursement_records (status);
CREATE INDEX IF NOT EXISTS idx_disbursement_records_source_file
  ON public.disbursement_records (source_file);
CREATE INDEX IF NOT EXISTS idx_disbursement_records_upload
  ON public.disbursement_records (upload_id);

-- Reuse the project-wide email-normalization trigger (if migration #5 ran).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS disbursement_records_norm_email ON public.disbursement_records;
    CREATE TRIGGER disbursement_records_norm_email
      BEFORE INSERT OR UPDATE ON public.disbursement_records
      FOR EACH ROW
      EXECUTE FUNCTION normalize_email_column('recipient_email');
  END IF;
END $$;

-- updated_at touch trigger (so re-seeds bump the timestamp)
CREATE OR REPLACE FUNCTION public.disbursement_records_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS disbursement_records_set_updated_at ON public.disbursement_records;
CREATE TRIGGER disbursement_records_set_updated_at
  BEFORE UPDATE ON public.disbursement_records
  FOR EACH ROW
  EXECUTE FUNCTION public.disbursement_records_touch_updated_at();


-- ── Step 2 — seed/backfill ────────────────────────────────────
WITH
-- FX rate from app_settings (string "55.5" → numeric)
fx AS (
  SELECT COALESCE(NULLIF(value, '')::NUMERIC, 0) AS rate
  FROM public.app_settings
  WHERE key = 'usd_to_php_rate'
  LIMIT 1
),

-- Parse Hubstaff "Total worked" (HH:MM:SS) into decimal hours.
-- Handles HH:MM, HH:MM:SS, and blank/null gracefully.
-- GROUP BY deduplicates (source_file, email) — multiple rows per employee
-- (e.g. re-imports or multi-project splits) have their hours summed.
parsed_hours AS (
  SELECT
    hh.source_file,
    MAX(hh.upload_id::text)::uuid                               AS upload_id,
    LOWER(TRIM(hh."Email"))                                     AS recipient_email,
    MAX(NULLIF(TRIM(hh."Member"), ''))                          AS recipient_name,
    SUM(
      COALESCE(
        NULLIF(SPLIT_PART(hh."Total worked", ':', 1), '')::NUMERIC,
        0
      )
      + COALESCE(
          NULLIF(SPLIT_PART(hh."Total worked", ':', 2), '')::NUMERIC / 60.0,
          0
        )
      + COALESCE(
          NULLIF(SPLIT_PART(hh."Total worked", ':', 3), '')::NUMERIC / 3600.0,
          0
        )
    )                                                           AS total_hours
  FROM public.hubstaff_hours hh
  WHERE hh."Email" IS NOT NULL
    AND TRIM(hh."Email") <> ''
    AND hh.source_file IS NOT NULL
  GROUP BY hh.source_file, LOWER(TRIM(hh."Email"))
),

-- Look up each employee's PHP/hr rates.
-- DISTINCT ON work_email guards against multiple rate rows per employee
-- (rate history). Takes the row with the highest id (most recently inserted).
rates AS (
  SELECT DISTINCT ON (LOWER(TRIM("Work Email")))
    LOWER(TRIM("Work Email"))     AS work_email,
    LOWER(TRIM("Personal Email")) AS personal_email,
    "Regular Rate"::NUMERIC       AS regular_rate,
    "OT Rate"::NUMERIC            AS ot_rate
  FROM public.employee_hourly_rates
  ORDER BY LOWER(TRIM("Work Email")), id DESC
),

-- Combine + extract cycle dates from filename.
joined AS (
  SELECT
    ph.source_file,
    -- "..._YYYY-MM-DD_to_YYYY-MM-DD.csv" → start / end
    TO_DATE(SUBSTRING(ph.source_file FROM '(\d{4}-\d{2}-\d{2})_to_'),     'YYYY-MM-DD') AS cycle_period_start,
    TO_DATE(SUBSTRING(ph.source_file FROM '_to_(\d{4}-\d{2}-\d{2})'),     'YYYY-MM-DD') AS cycle_period_end,
    ph.upload_id,
    ph.recipient_email,
    ph.recipient_name,
    ROUND(ph.total_hours, 2)                                                AS total_hours,
    ROUND(LEAST(40, ph.total_hours), 2)                                     AS regular_hours,
    ROUND(GREATEST(0, ph.total_hours - 40), 2)                              AS ot_hours,
    COALESCE(r.regular_rate, 0)                                             AS regular_rate_php,
    COALESCE(r.ot_rate, 0)                                                  AS ot_rate_php
  FROM parsed_hours ph
  LEFT JOIN rates r ON r.work_email = ph.recipient_email
),

-- PHP/USD amounts using the active FX rate.
amounts AS (
  SELECT
    j.*,
    ROUND(j.regular_hours * j.regular_rate_php + j.ot_hours * j.ot_rate_php, 2) AS amount_php,
    fx.rate                                                                     AS fx_rate
  FROM joined j
  CROSS JOIN fx
),

-- Latest dispatch row per (source_file, recipient_email), if any.
latest_dispatch AS (
  SELECT DISTINCT ON (LOWER(pd.recipient_email), pd.cycle_source_file)
    pd.id,
    LOWER(pd.recipient_email) AS recipient_email,
    pd.cycle_source_file       AS source_file,
    pd.status,
    pd.amount_usd,
    pd.sent_date,
    pd.bank_used,
    pd.transaction_id
  FROM public.payment_dispatches pd
  WHERE pd.cycle_source_file IS NOT NULL
  ORDER BY LOWER(pd.recipient_email), pd.cycle_source_file, pd.created_at DESC
),

final AS (
  SELECT
    a.cycle_period_start,
    a.cycle_period_end,
    a.source_file,
    a.upload_id,
    a.recipient_email,
    a.recipient_name,
    a.total_hours,
    a.regular_hours,
    a.ot_hours,
    a.regular_rate_php,
    a.ot_rate_php,
    a.amount_php,
    CASE WHEN a.fx_rate > 0 THEN ROUND(a.amount_php / a.fx_rate, 2) ELSE NULL END AS amount_usd,
    a.fx_rate,
    COALESCE(d.status, 'pending')                              AS status,
    d.amount_usd                                               AS paid_amount_usd,
    d.sent_date                                                AS paid_at,
    d.bank_used,
    d.transaction_id,
    d.id                                                       AS dispatch_id
  FROM amounts a
  LEFT JOIN latest_dispatch d
    ON d.recipient_email = a.recipient_email
   AND d.source_file     = a.source_file
  WHERE a.cycle_period_start IS NOT NULL
    AND a.cycle_period_end   IS NOT NULL
)

INSERT INTO public.disbursement_records (
  cycle_period_start, cycle_period_end, source_file, upload_id,
  recipient_email, recipient_name,
  total_hours, regular_hours, ot_hours,
  regular_rate_php, ot_rate_php,
  amount_php, amount_usd, fx_rate,
  status, paid_amount_usd, paid_at,
  bank_used, transaction_id, dispatch_id
)
SELECT
  cycle_period_start, cycle_period_end, source_file, upload_id,
  recipient_email, recipient_name,
  total_hours, regular_hours, ot_hours,
  regular_rate_php, ot_rate_php,
  amount_php, amount_usd, fx_rate,
  status, paid_amount_usd, paid_at,
  bank_used, transaction_id, dispatch_id
FROM (
  SELECT DISTINCT ON (source_file, recipient_email) *
  FROM final
  ORDER BY source_file, recipient_email
) deduped
ON CONFLICT (source_file, recipient_email) DO UPDATE SET
  cycle_period_start = EXCLUDED.cycle_period_start,
  cycle_period_end   = EXCLUDED.cycle_period_end,
  upload_id          = EXCLUDED.upload_id,
  recipient_name     = EXCLUDED.recipient_name,
  total_hours        = EXCLUDED.total_hours,
  regular_hours      = EXCLUDED.regular_hours,
  ot_hours           = EXCLUDED.ot_hours,
  regular_rate_php   = EXCLUDED.regular_rate_php,
  ot_rate_php        = EXCLUDED.ot_rate_php,
  amount_php         = EXCLUDED.amount_php,
  amount_usd         = EXCLUDED.amount_usd,
  fx_rate            = EXCLUDED.fx_rate,
  status             = EXCLUDED.status,
  paid_amount_usd    = EXCLUDED.paid_amount_usd,
  paid_at            = EXCLUDED.paid_at,
  bank_used          = EXCLUDED.bank_used,
  transaction_id     = EXCLUDED.transaction_id,
  dispatch_id        = EXCLUDED.dispatch_id;

COMMIT;


-- ── Step 3 — mark all records as paid ────────────────────────
-- Run this separately after Step 2 to bulk-mark every seeded row as paid.
-- Safe to re-run (WHERE status <> 'paid' is a no-op if already done).

UPDATE public.disbursement_records
SET
  status      = 'paid',
  updated_at  = now()
WHERE status <> 'paid';


-- ============================================================
-- Sanity checks (run separately after the migration above)
-- ============================================================
--
-- Per-cycle rollup — paid / pending / total owed
--
-- SELECT
--   cycle_period_start,
--   cycle_period_end,
--   source_file,
--   COUNT(*)                                            AS recipients,
--   COUNT(*) FILTER (WHERE status = 'paid')             AS paid_count,
--   COUNT(*) FILTER (WHERE status <> 'paid')            AS pending_count,
--   ROUND(SUM(amount_usd)::numeric, 2)                  AS total_owed_usd,
--   ROUND(SUM(amount_usd) FILTER (WHERE status = 'paid')::numeric, 2)  AS paid_usd,
--   ROUND(SUM(amount_usd) FILTER (WHERE status <> 'paid')::numeric, 2) AS pending_usd
-- FROM public.disbursement_records
-- GROUP BY cycle_period_start, cycle_period_end, source_file
-- ORDER BY cycle_period_start DESC;
--
-- Top earners this cycle:
--
-- SELECT recipient_email, recipient_name, total_hours, amount_usd, status
-- FROM public.disbursement_records
-- WHERE cycle_period_start = '2026-04-12'
-- ORDER BY amount_usd DESC NULLS LAST
-- LIMIT 25;
