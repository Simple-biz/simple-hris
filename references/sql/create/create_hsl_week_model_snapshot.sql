-- HSL "Sunday-to-Sunday" (Mon→Sun) pre-change snapshot
-- =====================================================
-- Freezes the CURRENT Mon→Sun computed payroll/PAB output for every HSL
-- employee, for every historical Hubstaff upload, BEFORE the HSL week boundary
-- is switched to Sun→Sat (week of 2026-06-30 cutover).
--
-- Why this exists: almost every HSL surface (calendars, PAB verdicts, dispatch
-- estimates, the wizard when a past period is re-opened LIVE) recomputes from
-- raw Hubstaff data at request time — nothing is frozen except already-paid
-- disbursement_records + payroll.wizard.final_pay.* snapshots. Flipping the
-- week rule would therefore retroactively change what past HSL periods DISPLAY.
-- This table is the immutable baseline of the pre-change truth, and doubles as
-- the regression oracle: after the cutover ships, re-run the same compute for
-- pre-cutover periods and assert it still matches these rows.
--
-- Populated by POST /api/admin/hsl-week-snapshot (reuses computeCurrentPay, so
-- the numbers are byte-identical to Payment Dispatch / the Wizard).
--
-- Idempotent: UNIQUE (source_file, work_email, week_model) → re-running upserts.

CREATE TABLE IF NOT EXISTS public.hsl_week_model_snapshot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which week convention this row captures. Always 'mon_sun' for the
  -- pre-change baseline; the column exists so a later 'sun_sat' re-capture can
  -- coexist for side-by-side diffing.
  week_model         text NOT NULL DEFAULT 'mon_sun',

  -- The Hubstaff upload this row was computed from.
  source_file        text NOT NULL,
  upload_id          uuid,

  -- Normalized (lowercased) work email — the canonical pay join key.
  work_email         text NOT NULL,

  -- The HSL pay week the Mon→Sun rule assigned this upload to.
  pay_week_start     date,   -- Monday
  pay_week_end       date,   -- Sunday

  -- The raw filename date range (Sun→Sun, 8-day), for traceability.
  file_period_start  date,
  file_period_end    date,

  -- PAB context for this week.
  pab_month          text,      -- 'YYYY-MM' (Monday-owned month)
  week_is_final_pab  boolean,
  week_is_tech_bonus boolean,

  -- Computed Mon→Sun outputs (mirror CurrentPayEntry).
  total_hours        numeric(12,2),
  regular_hours      numeric(12,2),
  ot_hours           numeric(12,2),
  regular_pay_php    numeric(14,2),
  ot_pay_php         numeric(14,2),
  initial_pay_php    numeric(14,2),
  pab_bonus_php      numeric(14,2),
  tech_bonus_php     numeric(14,2),
  bonus_total_php    numeric(14,2),
  total_pay_php      numeric(14,2),
  pay_currency       text,
  fx_rate            numeric(14,6),

  -- Full CurrentPayEntry as computed, so nothing is lost even if a column above
  -- is later added/removed.
  entry              jsonb,

  captured_at        timestamptz NOT NULL DEFAULT now(),
  captured_by        text,

  CONSTRAINT hsl_week_model_snapshot_uniq UNIQUE (source_file, work_email, week_model)
);

CREATE INDEX IF NOT EXISTS hsl_week_model_snapshot_email_idx
  ON public.hsl_week_model_snapshot (work_email);
CREATE INDEX IF NOT EXISTS hsl_week_model_snapshot_pabmonth_idx
  ON public.hsl_week_model_snapshot (pab_month);
CREATE INDEX IF NOT EXISTS hsl_week_model_snapshot_source_idx
  ON public.hsl_week_model_snapshot (source_file);

COMMENT ON TABLE public.hsl_week_model_snapshot IS
  'Pre-change Mon→Sun (Sunday-to-Sunday) baseline of HSL payroll/PAB output, frozen before the 2026-06-30 Sun→Sat cutover. Regression oracle for the week-boundary change.';
