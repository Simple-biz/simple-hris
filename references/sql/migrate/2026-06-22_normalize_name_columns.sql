-- ============================================================================
-- Normalize "fancy" Unicode in NAME columns  (2026-06-22)   [migration #83]
--
-- INCIDENT: a hire ("Katherine Santiago") submitted the onboarding form with
-- her name typed in Unicode MATHEMATICAL ITALIC letters
-- (U+1D43E, U+1D44E, U+210E, ...) instead of ASCII. Those code points only
-- LOOK like Latin letters; lower()/ILIKE/.includes() never fold them to
-- "katherine", so she was invisible to:
--   * the Payroll Wizard name-token matcher (normalizeNameTokens) -- email
--     match failed, then the name fallback failed too, so she dropped out of
--     the payroll run;
--   * every dashboard search box (HR roster, MESA, SWall, Bonus Catalog, ...).
--
-- FIX = two guardrails (this migration is the DB half; the app half ships in
-- the same deploy):
--   1. APP-LAYER  -- src/lib/text/sanitize-name.ts (NFKC + strip invisibles +
--      collapse ws + trim), applied in the onboarding write paths. Catches
--      names at the form. PayrollWizard.normalizeNameTokens NFKC-folds now too.
--   2. DB-LAYER (this file) -- a BEFORE INSERT/UPDATE trigger that folds the
--      name columns no matter HOW the row was written (CSV sync, master-sheet
--      sync, promote, manual SQL). This is the real "can't happen again"
--      guarantee, mirroring the project's existing normalize_email_column().
--
-- NFKC fold is the key step. It maps math-italic/bold, full-width, ligatures,
-- circled/superscript glyphs -> plain ASCII, while LEAVING real accents intact
-- (e.g. an accented "Jose" keeps its accent -- we are NOT stripping diacritics).
--
-- IDEMPOTENT: fold_name() is a no-op on already-clean names; the backfill only
-- touches rows that actually differ; triggers use DROP IF EXISTS + CREATE.
-- Requires Postgres 13+ (normalize()) and UTF8 server encoding -- Supabase: ok.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 -- INSPECT (run FIRST, on its own). Lists every name containing a
--          non-ASCII code point across all name tables. Eyeball it before
--          running the transaction below.
-- ----------------------------------------------------------------------------
SELECT 'hr_onboarding_submissions.full_name'    AS where_, full_name        AS current_value FROM public.hr_onboarding_submissions WHERE full_name         ~ '[^[:ascii:]]'
UNION ALL
SELECT 'hr_onboarding_submissions.invite_name',          invite_name             FROM public.hr_onboarding_submissions WHERE invite_name       ~ '[^[:ascii:]]'
UNION ALL
SELECT 'hr_onboarding_submissions.gmail_surname',        gmail_surname           FROM public.hr_onboarding_submissions WHERE gmail_surname     ~ '[^[:ascii:]]'
UNION ALL
SELECT 'hr_onboarding_submissions.ip_agreement_name',    ip_agreement_name       FROM public.hr_onboarding_submissions WHERE ip_agreement_name ~ '[^[:ascii:]]'
UNION ALL
SELECT 'hr_pending_employees.name',                      name                    FROM public.hr_pending_employees      WHERE name              ~ '[^[:ascii:]]'
UNION ALL
SELECT 'global_master_list."Name"',                      "Name"                  FROM public.global_master_list        WHERE "Name"            ~ '[^[:ascii:]]'
UNION ALL
SELECT 'employee_ids.name',                              name                    FROM public.employee_ids              WHERE name              ~ '[^[:ascii:]]';


BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 -- fold_name(text): the canonical name normalizer. Reusable anywhere
--          (triggers, backfills, ad-hoc queries). NFKC + strip invisible
--          zero-width / bidi controls + collapse whitespace + trim. Never
--          returns NULL for non-null input (so it can't break a NOT NULL col);
--          returns '' for input that was all-invisible/whitespace.
--
--          The strip pattern is written as a Postgres U&'...' Unicode string
--          literal (pure-ASCII \XXXX escapes) so this source file contains no
--          invisible code points. It expands to the character class:
--            U+200B-200F zero-width spaces/joiners + LRM/RLM
--            U+202A-202E bidi embeddings/overrides
--            U+2060-206F word-joiner / bidi isolates / deprecated format
--            U+FEFF      BOM / zero-width no-break space
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fold_name(s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(
           regexp_replace(
             regexp_replace(
               normalize(COALESCE(s, ''), NFKC),
               U&'[\200B-\200F\202A-\202E\2060-\206F\FEFF]', '', 'g'
             ),
             '\s+', ' ', 'g'          -- collapse internal whitespace runs
           )
         )
$$;

-- ----------------------------------------------------------------------------
-- STEP 2 -- normalize_name_column(): generic BEFORE-trigger function. Takes the
--          target column name(s) via TG_ARGV (exactly like the project's
--          normalize_email_column). Only the named columns are folded; every
--          other column is taken straight from NEW (jsonb_populate_record
--          overlays just the patched keys), so unrelated column types are never
--          round-tripped.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_name_column()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  col   text;
  val   text;
  cur   jsonb := to_jsonb(NEW);
  patch jsonb := '{}'::jsonb;
BEGIN
  FOREACH col IN ARRAY TG_ARGV
  LOOP
    val := cur ->> col;                       -- NULL if column absent or NULL
    IF val IS NOT NULL THEN
      patch := patch || jsonb_build_object(col, public.fold_name(val));
    END IF;
  END LOOP;
  IF patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, patch);
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- STEP 3 -- attach the trigger to every table that stores a human name. Quoted
--          "Name" for global_master_list (mixed-case CSV identifier).
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS hr_onboarding_submissions_normalize_name ON public.hr_onboarding_submissions;
CREATE TRIGGER hr_onboarding_submissions_normalize_name
  BEFORE INSERT OR UPDATE ON public.hr_onboarding_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_name_column('full_name', 'invite_name', 'gmail_surname', 'ip_agreement_name');

DROP TRIGGER IF EXISTS hr_pending_employees_normalize_name ON public.hr_pending_employees;
CREATE TRIGGER hr_pending_employees_normalize_name
  BEFORE INSERT OR UPDATE ON public.hr_pending_employees
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_name_column('name');

DROP TRIGGER IF EXISTS global_master_list_normalize_name ON public.global_master_list;
CREATE TRIGGER global_master_list_normalize_name
  BEFORE INSERT OR UPDATE ON public.global_master_list
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_name_column('Name');

DROP TRIGGER IF EXISTS employee_ids_normalize_name ON public.employee_ids;
CREATE TRIGGER employee_ids_normalize_name
  BEFORE INSERT OR UPDATE ON public.employee_ids
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_name_column('name');

-- ----------------------------------------------------------------------------
-- STEP 4 -- BACKFILL existing rows (fixes Katherine + anyone else already
--          stored with styled glyphs). Only updates rows that actually change.
-- ----------------------------------------------------------------------------
UPDATE public.hr_onboarding_submissions
SET    full_name         = public.fold_name(full_name),
       invite_name       = public.fold_name(invite_name),
       gmail_surname     = public.fold_name(gmail_surname),
       ip_agreement_name = public.fold_name(ip_agreement_name)
WHERE  full_name         IS DISTINCT FROM public.fold_name(full_name)
   OR  invite_name       IS DISTINCT FROM public.fold_name(invite_name)
   OR  gmail_surname     IS DISTINCT FROM public.fold_name(gmail_surname)
   OR  ip_agreement_name IS DISTINCT FROM public.fold_name(ip_agreement_name);

UPDATE public.hr_pending_employees
SET    name = public.fold_name(name)
WHERE  name IS DISTINCT FROM public.fold_name(name);

UPDATE public.global_master_list
SET    "Name" = public.fold_name("Name")
WHERE  "Name" IS DISTINCT FROM public.fold_name("Name");

UPDATE public.employee_ids
SET    name = public.fold_name(name)
WHERE  name IS DISTINCT FROM public.fold_name(name);

COMMIT;

-- ----------------------------------------------------------------------------
-- VERIFY -- these should return only LEGITIMATE accented names (or 0 rows):
--   SELECT full_name FROM public.hr_onboarding_submissions WHERE full_name ~ '[^[:ascii:]]';
--   SELECT "Name"    FROM public.global_master_list        WHERE "Name"     ~ '[^[:ascii:]]';
--
-- Sanity-check the function on the math-italic "Kat":
--   SELECT public.fold_name(U&'\+01D43E\+01D44E\+01D461');   -- expect 'Kat'
--
-- Spot-check Katherine specifically (now matches plain ASCII):
--   SELECT id, full_name FROM public.hr_onboarding_submissions
--   WHERE full_name ILIKE '%katherine%santiago%';
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- UNDO -- removes the guardrail (does NOT un-fold already-cleaned data; the
--         original styled glyphs were never wanted):
--   DROP TRIGGER IF EXISTS hr_onboarding_submissions_normalize_name ON public.hr_onboarding_submissions;
--   DROP TRIGGER IF EXISTS hr_pending_employees_normalize_name      ON public.hr_pending_employees;
--   DROP TRIGGER IF EXISTS global_master_list_normalize_name        ON public.global_master_list;
--   DROP TRIGGER IF EXISTS employee_ids_normalize_name              ON public.employee_ids;
--   DROP FUNCTION IF EXISTS public.normalize_name_column();
--   DROP FUNCTION IF EXISTS public.fold_name(text);
-- ----------------------------------------------------------------------------
