-- ============================================================================
-- DEDUPE the US people on the Global Master List (2026-07-07).
--
-- SUPERSEDES `retire_us_manager_bonus_dept.sql` (which RE-LABELED the manual
-- rows to 'US Employees' — that turned out to be wrong: it created a competing
-- label alongside the Sheet's own "USEE", making the duplicates visible).
--
-- THE REAL SITUATION
--   Each of the 12 US staff has TWO rows in global_master_list:
--     (a) an OLD manually-seeded row  — source_file = 'manual_us_seed_2026-04-30'
--         (originally 'US Manager Bonus', then renamed 'US Employees' by the
--          superseded script above), and
--     (b) a CURRENT Google-Sheet-synced row — source_file LIKE 'google-sheet:%'
--         which the MASTERLIST already carries under department "USEE".
--   The Sheet (b) is authoritative for identity, so the manual rows (a) are pure
--   duplicates. This is why the roster shows e.g. TWO "Zapata, Jaquelin Jackie".
--
-- WHAT THIS DOES
--   1. DELETES the 12 manual-seed rows from global_master_list. Every one has a
--      same-work-email Sheet row, so no person is removed from the roster; only
--      the duplicate copy goes. Going forward everyone shows once, as "USEE".
--   2. Reverts the 3 employee_hourly_rates rows the superseded script mislabeled
--      'US Employees' back to NULL (matches their ~200 sibling rows; these US
--      people are record-only and not scoped by rate department).
--
-- SAFETY / REVERSIBILITY
--   * Record-only in HRIS (no PHP dispatch/paystubs), so removing the dup rows
--     has no payout effect. Banking/identity lives in employee_ids (US-… ids),
--     keyed by work email, and is NOT touched.
--   * Recreatable: `references/sql/seed/seed_us_global_master_list.sql` re-inserts
--     these exact rows (WHERE NOT EXISTS on Work Email) if ever needed.
--   * Idempotent: the DELETE targets only source_file='manual_us_seed_2026-04-30';
--     re-running after they're gone is a no-op.
--   * NOTE (Seungyong): the Sheet itself has BOTH seungyong@ (dept "Manager") and
--     seungyongl@ (dept "USEE") — a separate duplicate to fix IN THE SHEET; this
--     script does not touch it beyond removing his manual-seed row.
-- ============================================================================

-- 1) Show exactly what will be deleted (run first to eyeball the 12 rows) ─────
SELECT id, "Name", "Work Email", "Department", off_boarded_at, employee_id
FROM   public.global_master_list
WHERE  source_file = 'manual_us_seed_2026-04-30'
ORDER  BY "Work Email";

-- 2) Delete the duplicate manual-seed rows ───────────────────────────────────
DELETE FROM public.global_master_list
WHERE  source_file = 'manual_us_seed_2026-04-30';

-- 3) Revert the 3 mislabeled rate rows back to NULL department ────────────────
UPDATE public.employee_hourly_rates
SET    "Department" = NULL
WHERE  "Department" = 'US Employees';

-- ── Verify ───────────────────────────────────────────────────────────────────
-- (a) No manual-seed rows remain.
SELECT COUNT(*) AS manual_seed_rows_left
FROM   public.global_master_list
WHERE  source_file = 'manual_us_seed_2026-04-30';

-- (b) No 'US Employees' label remains anywhere; each US work email now appears
--     once (the Sheet "USEE" row). Expect one row per email, department 'USEE'
--     (except seungyong@ = 'Manager' + seungyongl@ = 'USEE', the sheet quirk).
SELECT "Work Email", "Department", source_file, off_boarded_at
FROM   public.global_master_list
WHERE  LOWER(TRIM("Work Email")) IN (
         'thomas@simple.biz','jeff@simple.biz','teal@simple.biz','carla@simple.biz',
         'emma@simple.biz','jackie@simple.biz','courtney@simple.biz','seungyong@simple.biz',
         'seungyongl@simple.biz','nicholas@simple.biz','sterling@simple.biz',
         'adrian@simple.biz','brandonb@simple.biz'
       )
ORDER  BY "Work Email";

-- (c) Confirm 'US Employees' is fully gone from both tables.
SELECT 'global_master_list' AS tbl, COUNT(*) AS us_employees_left
FROM   public.global_master_list WHERE "Department" = 'US Employees'
UNION ALL
SELECT 'employee_hourly_rates', COUNT(*)
FROM   public.employee_hourly_rates WHERE "Department" = 'US Employees';
