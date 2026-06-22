-- ============================================================
-- Backfill: mark the May 24 – June 21, 2026 Hubstaff cycles as PAID
--
-- Goal
--   Record the four weekly cycles in that window as paid in the system
--   (Payment Dispatch "Done" tab + Reports tab) WITHOUT sending any
--   paystub emails. SQL never calls the n8n webhook, so this is
--   email-free by construction — emails only fire through the
--   POST /api/payment-dispatches route, never from a DB write.
--
-- How it works
--   1. Source the who/how-much from disbursement_records (already
--      seeded per (week, employee) from hubstaff_hours x rates).
--   2. INSERT one payment_dispatches row per in-range (cycle, employee)
--      with status='paid' — this is what the Done tab lists.
--   3. The existing payment_dispatches_sync_disbursement trigger then
--      UPDATEs the matching disbursement_records row in place
--      (status / paid_amount_usd / paid_at / bank_used / transaction_id
--      / dispatch_id) — so the Reports tab stays accurate too.
--
-- Window
--   Weekly cycles fully contained in 2026-05-24 .. 2026-06-21 (both are
--   Sundays). With Sun->Sun weeks that is exactly four cycles:
--     2026-05-24 -> 2026-05-31
--     2026-05-31 -> 2026-06-07
--     2026-06-07 -> 2026-06-14
--     2026-06-14 -> 2026-06-21
--   The filter keys off the cycle dates parsed into disbursement_records,
--   so no source-file names are hardcoded.
--
-- Idempotent
--   Re-running is safe: it skips any (cycle, employee) that already has a
--   paid payment_dispatches row, so it will not create duplicate dispatches.
--
-- Prereq
--   disbursement_records must be seeded for these weeks. If the Reports
--   tab shows an "uploads without payroll records" banner for this window,
--   run seed_disbursement_records.sql Step 2 first, then this script.
--
-- Run in Supabase SQL Editor.
-- ============================================================

-- ── STEP 0 — PREVIEW (run this first, on its own, and eyeball it) ──
-- Confirms which cycles/employees/totals will be marked paid. Read-only.
--
-- SELECT
--   dr.source_file,
--   dr.cycle_period_start,
--   dr.cycle_period_end,
--   COUNT(*)                                  AS employees,
--   ROUND(SUM(dr.amount_php)::numeric, 2)     AS total_php,
--   ROUND(SUM(dr.amount_usd)::numeric, 2)     AS total_usd
-- FROM public.disbursement_records dr
-- WHERE dr.cycle_period_start >= DATE '2026-05-24'
--   AND dr.cycle_period_end   <= DATE '2026-06-21'
--   AND NOT EXISTS (
--     SELECT 1 FROM public.payment_dispatches pd
--     WHERE pd.cycle_source_file = dr.source_file
--       AND LOWER(pd.recipient_email) = LOWER(dr.recipient_email)
--       AND pd.status = 'paid'
--   )
-- GROUP BY dr.source_file, dr.cycle_period_start, dr.cycle_period_end
-- ORDER BY dr.cycle_period_start;


-- ── STEP 1 — backfill the paid dispatches ─────────────────────────
BEGIN;

INSERT INTO public.payment_dispatches (
  cycle_id,
  cycle_period_start,
  cycle_period_end,
  cycle_source_file,
  recipient_email,
  recipient_name,
  processor,
  amount_usd,
  amount_php,
  transaction_id,
  bank_used,
  sent_date,
  status,
  note,
  created_by
)
SELECT
  dr.upload_id                                   AS cycle_id,
  dr.cycle_period_start,
  dr.cycle_period_end,
  dr.source_file                                 AS cycle_source_file,
  dr.recipient_email,
  dr.recipient_name,
  'backfill'                                     AS processor,
  dr.amount_usd,
  dr.amount_php,
  'BACKFILL'                                     AS transaction_id,
  'backfill'                                     AS bank_used,
  dr.cycle_period_end                            AS sent_date,
  'paid'                                         AS status,
  'Backfill: marked paid via SQL (May 24 - Jun 21, 2026 reconciliation). No paystub email sent.' AS note,
  'kaner@simple.biz (backfill)'                  AS created_by
FROM public.disbursement_records dr
WHERE dr.cycle_period_start >= DATE '2026-05-24'
  AND dr.cycle_period_end   <= DATE '2026-06-21'
  -- Idempotency guard: skip anyone already marked paid for this cycle.
  AND NOT EXISTS (
    SELECT 1 FROM public.payment_dispatches pd
    WHERE pd.cycle_source_file = dr.source_file
      AND LOWER(pd.recipient_email) = LOWER(dr.recipient_email)
      AND pd.status = 'paid'
  );

-- The payment_dispatches_sync_disbursement trigger fired per inserted row,
-- so disbursement_records for this window is now status='paid' with
-- paid_amount_usd / paid_at / dispatch_id populated. No extra UPDATE needed.

COMMIT;


-- ── STEP 2 — verify (run after the COMMIT) ────────────────────────
-- SELECT
--   dr.cycle_period_start,
--   dr.cycle_period_end,
--   dr.source_file,
--   COUNT(*)                                   AS recipients,
--   COUNT(*) FILTER (WHERE dr.status = 'paid') AS paid_count,
--   COUNT(*) FILTER (WHERE dr.status <> 'paid') AS not_paid_count
-- FROM public.disbursement_records dr
-- WHERE dr.cycle_period_start >= DATE '2026-05-24'
--   AND dr.cycle_period_end   <= DATE '2026-06-21'
-- GROUP BY dr.cycle_period_start, dr.cycle_period_end, dr.source_file
-- ORDER BY dr.cycle_period_start;
