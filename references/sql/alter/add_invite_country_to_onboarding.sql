-- Migration: invite_country on hr_onboarding_submissions
--
-- HR now picks a Country when generating an onboarding link (alongside the
-- existing invite_department). That pair (department + country) selects the
-- pay-plan PDF that rides the onboarding INVITE email (see onboarding_pay_plans
-- + create_onboarding_pay_plans.sql).
--
-- This is DISTINCT from the `country` column added by add_country_to_onboarding.sql:
--   * invite_country -> HR's choice at invite time (drives the emailed pay plan)
--   * country        -> what the HIRE selects on the paperwork (drives currency)
--
-- Run in the Supabase SQL editor.

ALTER TABLE hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS invite_country TEXT;
