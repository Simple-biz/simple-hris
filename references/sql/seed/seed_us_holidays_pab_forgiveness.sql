-- ============================================================
-- Migration: seed US holidays for PAB forgiveness
-- Purpose:
--   Adds two app_settings rows that drive the new "US Holidays"
--   panel in System Settings:
--
--     us_holidays_enabled  -- master toggle ('true' / 'false')
--     us_holidays_list     -- JSON array of { date, name, enabled }
--
--   When enabled, any employee whose Hubstaff hours are below the
--   7h PAB threshold on a listed date is automatically forgiven for
--   that day -- no dispute row needed. This covers US announcements
--   (Memorial Day, Independence Day, etc.) where the team is told
--   not to work.
--
--   The seed below contains every US federal holiday for 2026 and
--   2027, using the observed-day rule (Sat -> Fri, Sun -> Mon).
--
--   Idempotent: re-runs upsert the JSON without duplicating rows.
--   Run in Supabase SQL editor (Dashboard -> SQL Editor).
-- ============================================================

INSERT INTO public.app_settings (key, value)
VALUES ('us_holidays_enabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO public.app_settings (key, value)
VALUES (
  'us_holidays_list',
  '[
    {"date":"2026-01-01","name":"New Year''s Day","enabled":true},
    {"date":"2026-01-19","name":"Martin Luther King Jr. Day","enabled":true},
    {"date":"2026-02-16","name":"Presidents'' Day","enabled":true},
    {"date":"2026-05-25","name":"Memorial Day","enabled":true},
    {"date":"2026-06-19","name":"Juneteenth","enabled":true},
    {"date":"2026-07-03","name":"Independence Day (observed)","enabled":true},
    {"date":"2026-09-07","name":"Labor Day","enabled":true},
    {"date":"2026-10-12","name":"Columbus Day","enabled":true},
    {"date":"2026-11-11","name":"Veterans Day","enabled":true},
    {"date":"2026-11-26","name":"Thanksgiving Day","enabled":true},
    {"date":"2026-12-25","name":"Christmas Day","enabled":true},
    {"date":"2027-01-01","name":"New Year''s Day","enabled":true},
    {"date":"2027-01-18","name":"Martin Luther King Jr. Day","enabled":true},
    {"date":"2027-02-15","name":"Presidents'' Day","enabled":true},
    {"date":"2027-05-31","name":"Memorial Day","enabled":true},
    {"date":"2027-06-18","name":"Juneteenth (observed)","enabled":true},
    {"date":"2027-07-05","name":"Independence Day (observed)","enabled":true},
    {"date":"2027-09-06","name":"Labor Day","enabled":true},
    {"date":"2027-10-11","name":"Columbus Day","enabled":true},
    {"date":"2027-11-11","name":"Veterans Day","enabled":true},
    {"date":"2027-11-25","name":"Thanksgiving Day","enabled":true},
    {"date":"2027-12-24","name":"Christmas Day (observed)","enabled":true}
  ]'
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================
-- Verify
-- ============================================================
-- SELECT key, value FROM public.app_settings
--  WHERE key IN ('us_holidays_enabled', 'us_holidays_list');
