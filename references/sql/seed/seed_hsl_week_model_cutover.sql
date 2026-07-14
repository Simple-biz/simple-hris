-- ============================================================
-- Seed: HSL week-model cutover date
-- Purpose:
--   Sets the app_settings row that flips HSL's (Hogan) work/PAB
--   week from Mon->Sun to Sun->Sat on an effective date:
--
--     hsl.week_model_cutover  -- YYYY-MM-DD (effective date)
--
--   Weeks/PAB months anchored ON/AFTER this date compute Sun->Sat;
--   earlier ones stay Mon->Sun, so already-decided pay/PAB never
--   change. Only HSL employees are affected.
--
--   NOTE: the application already falls back to
--   HSL_WEEK_MODEL_DEFAULT_CUTOVER ('2026-05-31') in code when this
--   key is UNSET, so the cutover is live without running this seed.
--   Run this only to make the effective date explicit in data (and
--   to move/disable it later without a deploy: set a future date to
--   push the cutover out, or a far-past date to force Sun->Sat).
--
--   Idempotent: re-runs upsert the value without duplicating rows.
--   Run in Supabase SQL editor (Dashboard -> SQL Editor).
-- ============================================================

INSERT INTO public.app_settings (key, value)
VALUES ('hsl.week_model_cutover', '2026-05-31')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
