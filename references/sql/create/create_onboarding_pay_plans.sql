-- Migration: onboarding pay plans (department + country -> one PDF)
--
-- HR uploads a "Pay Plan" PDF per (Department, Country). The PDF itself lives in
-- the existing private `hr-onboarding-files` Supabase Storage bucket under
-- `pay-plans/<id>.pdf`; this table only holds the metadata + storage path.
--
-- When a new hire submits the LIVE onboarding paperwork, the server matches the
-- HR-assigned `invite_department` + the hire-selected `country` against this
-- table and forwards the matching PDF (as a short-lived signed URL) to the
-- `onboarding_pay_plan` n8n webhook. Department/country matching is normalized
-- in code (normalizeDeptToKey + resolveOnboardingCountry), so the values stored
-- here are the human-facing names HR picks from /api/departments and the
-- canonical country names from src/lib/onboarding/countries.ts.
--
-- Run in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.onboarding_pay_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department    text NOT NULL,
  country       text NOT NULL,
  file_path     text NOT NULL,
  file_name     text NOT NULL,
  content_type  text,
  file_size     bigint,
  uploaded_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One pay plan per (department, country), case/whitespace-insensitive. The
-- application also de-dupes via normalized match keys before writing, so this is
-- a backstop against obvious duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS onboarding_pay_plans_dept_country_uniq
  ON public.onboarding_pay_plans (lower(btrim(department)), lower(btrim(country)));
