-- ============================================================================
-- Title-case SHOUTED / all-lowercase NAME columns  (2026-06-25)  [migration #86]
--
-- REQUEST: HR Onboarding "Submitted" column showed hire names in ALL CAPS
-- ("ANGEL OCAMPO", "WILMAR LOUIE SORIANO LAGUYO", "KYLE S. ENGALAN", ...). They
-- should read naturally -- "Angel Ocampo" -- everywhere, and the onboarding form
-- should capture them that way going forward.
--
-- A live scan (2026-06-25) found the SHOUTING confined to the onboarding
-- pipeline: hr_onboarding_submissions (~10 full_name + a few ip_agreement_name),
-- hr_pending_employees (8 names, the same promoted people) and a handful in
-- employee_ids. global_master_list was already clean (0 rows). gmail_surname is
-- deliberately a short ALL-CAPS initial form (it feeds Google-account
-- provisioning, not display) and is intentionally LEFT ALONE.
--
-- FIX = two guardrails, mirroring the Unicode fold in migration #83:
--   1. APP-LAYER  -- src/lib/text/sanitize-name.ts toTitleCaseName(), applied in
--      the onboarding write paths (createHrOnboardingLink.invite_name,
--      submitHrOnboarding.full_name + ip_agreement_name) and on-blur in the
--      public onboarding form. Catches names as they are entered. This is the
--      enforcement going forward -- ALL onboarding name writes flow through it,
--      so no DB trigger is added here (unlike the Unicode-fold trigger in #83).
--   2. DB-LAYER (this file) -- titlecase_name() + a one-time BACKFILL that
--      re-cases the rows already stored.
--
-- titlecase_name() is DELIBERATELY CONSERVATIVE -- it only re-cases a value it is
-- confident was mis-cased, and never a value a human cased on purpose:
--   * email-like strings (some legacy `name` columns hold an address such as
--     "jan@simple.biz") are returned VERBATIM;
--   * MIXED-case values are returned VERBATIM ("McDonald", "de la Cruz",
--     "DeShawn", "O'Brien", "van der Berg" -- cased intentionally);
--   * only a value that is ENTIRELY one case (all-caps OR all-lowercase) is
--     title-cased.
-- It mirrors the TypeScript toTitleCaseName() one-to-one EXCEPT the "Mc" prefix
-- refinement (Postgres regexp_replace cannot upper-case a back-reference, and the
-- scanned data contains no "Mc" names) -- the app layer covers that case for
-- future writes.
--
-- IDEMPOTENT: titlecase_name() is a no-op on already-Title-Cased names; the
-- backfill only touches rows that actually differ. Requires the fold_name()
-- helper from migration #83 (re-declared below so this migration is
-- self-contained and order-independent).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 -- INSPECT (run FIRST, on its own). Lists every onboarding-pipeline
--           name that titlecase_name() would CHANGE. Eyeball it before running
--           the transaction below. (Safe to run before STEP 1 only after the
--           BEGIN block's STEP 1 has created the function; to preview without
--           creating anything, just look for ALL-CAPS / all-lowercase values.)
-- ----------------------------------------------------------------------------
-- SELECT 'hr_onboarding_submissions.full_name' AS where_, id::text, full_name AS before_, public.titlecase_name(full_name) AS after_
--   FROM public.hr_onboarding_submissions WHERE full_name IS DISTINCT FROM public.titlecase_name(full_name)
-- UNION ALL
-- SELECT 'hr_onboarding_submissions.ip_agreement_name', id::text, ip_agreement_name, public.titlecase_name(ip_agreement_name)
--   FROM public.hr_onboarding_submissions WHERE ip_agreement_name IS DISTINCT FROM public.titlecase_name(ip_agreement_name)
-- UNION ALL
-- SELECT 'hr_pending_employees.name', id::text, name, public.titlecase_name(name)
--   FROM public.hr_pending_employees WHERE name IS DISTINCT FROM public.titlecase_name(name)
-- UNION ALL
-- SELECT 'employee_ids.name', id::text, name, public.titlecase_name(name)
--   FROM public.employee_ids WHERE name IS DISTINCT FROM public.titlecase_name(name);


BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 -- fold_name(text): the Unicode normalizer from migration #83. Included
--           here (CREATE OR REPLACE -- identical definition) so titlecase_name()
--           can rely on it whether or not #83 has run yet. No-op if already
--           present.
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
             '\s+', ' ', 'g'
           )
         )
$$;

-- ----------------------------------------------------------------------------
-- STEP 2 -- titlecase_name(text): the canonical re-caser. Conservative; see the
--           header. Always Unicode-folds first (so it composes with #83), then:
--             - returns NULL for NULL input and '' for empty input -- i.e. it
--               PRESERVES NULL (it must not turn a null name column into '',
--               because the UI renders `invite_name ?? full_name` and '' is not
--               nullish, so a '' would blank the cell instead of falling back);
--             - returns the value verbatim if it contains '@' (email in a name
--               column), is MIXED-case, or has no cased letters;
--             - otherwise initcap()s it (capitalize first letter of every
--               word-part: start or after any non-alphanumeric -- space, hyphen,
--               apostrophe, period) and upper-cases a trailing generational
--               suffix ii/iii/iv. v/vi/ix/x are deliberately NOT touched so real
--               names like "Vi"/"Ix" are never clobbered.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.titlecase_name(s text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  folded text;
  result text;
BEGIN
  -- PRESERVE NULL. fold_name() COALESCEs NULL to '' (so it never returns NULL);
  -- without this guard the backfill below would rewrite every null name column
  -- to '' and blank the UI's `invite_name ?? full_name` fallback.
  IF s IS NULL THEN
    RETURN NULL;
  END IF;
  folded := public.fold_name(s);              -- NFKC + strip invisibles + collapse ws + trim
  IF folded = '' THEN
    RETURN folded;
  END IF;
  -- An address parked in a name column -- never re-case it.
  IF position('@' in folded) > 0 THEN
    RETURN folded;
  END IF;
  -- Mixed case is intentional; no cased letters means nothing to do. Both branches
  -- collapse to: re-case ONLY when exactly one of (has-lower, has-upper) is true.
  IF (folded ~ '[[:lower:]]') = (folded ~ '[[:upper:]]') THEN
    RETURN folded;
  END IF;
  -- Single-case -> title-case every word-part. initcap() lower-cases the rest,
  -- so it handles ALL-CAPS and all-lowercase input alike.
  result := initcap(folded);
  -- Trailing generational suffix -> upper-case. Explicit per-value replaces
  -- because regexp_replace cannot upper-case a back-reference. Anchored to the
  -- last whitespace-delimited token only.
  result := regexp_replace(result, '(^|\s)Iii$', '\1III');
  result := regexp_replace(result, '(^|\s)Iv$',  '\1IV');
  result := regexp_replace(result, '(^|\s)Ii$',  '\1II');
  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- STEP 3 -- BACKFILL the onboarding pipeline. Only rows that actually change are
--           updated. gmail_surname is intentionally excluded (see header).
--           These UPDATEs pass through the #83 fold_name BEFORE-trigger, which
--           is a no-op on the already-clean ASCII output of titlecase_name().
-- ----------------------------------------------------------------------------
UPDATE public.hr_onboarding_submissions
SET    full_name         = public.titlecase_name(full_name),
       invite_name       = public.titlecase_name(invite_name),
       ip_agreement_name = public.titlecase_name(ip_agreement_name)
WHERE  full_name         IS DISTINCT FROM public.titlecase_name(full_name)
   OR  invite_name       IS DISTINCT FROM public.titlecase_name(invite_name)
   OR  ip_agreement_name IS DISTINCT FROM public.titlecase_name(ip_agreement_name);

UPDATE public.hr_pending_employees
SET    name = public.titlecase_name(name)
WHERE  name IS DISTINCT FROM public.titlecase_name(name);

-- employee_ids holds promoted-hire names AND a number of rows whose `name` is an
-- email address; titlecase_name() returns the latter verbatim (the '@' guard),
-- so only the genuine SHOUTED names are fixed.
UPDATE public.employee_ids
SET    name = public.titlecase_name(name)
WHERE  name IS DISTINCT FROM public.titlecase_name(name);

-- ----------------------------------------------------------------------------
-- STEP 3b -- SELF-HEAL. An earlier (pre-hardening) revision of titlecase_name()
--            returned '' for NULL input, so its backfill rewrote every null name
--            column to '' -- which blanks the UI's `invite_name ?? full_name`
--            fallback (an empty name is semantically NULL, never ''). The NULL
--            guard above prevents this going forward; this restores any rows an
--            earlier run already turned into ''. No-op on a fresh run.
-- ----------------------------------------------------------------------------
UPDATE public.hr_onboarding_submissions SET full_name         = NULL WHERE full_name         = '';
UPDATE public.hr_onboarding_submissions SET invite_name       = NULL WHERE invite_name       = '';
UPDATE public.hr_onboarding_submissions SET ip_agreement_name = NULL WHERE ip_agreement_name = '';
UPDATE public.hr_pending_employees      SET name              = NULL WHERE name              = '';
UPDATE public.employee_ids              SET name              = NULL WHERE name              = '';

COMMIT;

-- ----------------------------------------------------------------------------
-- VERIFY -- after COMMIT these should return 0 rows (everything already cased):
--   SELECT id, full_name FROM public.hr_onboarding_submissions
--     WHERE full_name IS DISTINCT FROM public.titlecase_name(full_name);
--   SELECT id, name FROM public.employee_ids
--     WHERE name IS DISTINCT FROM public.titlecase_name(name);
--
-- Spot-checks (expected output in the comment):
--   SELECT public.titlecase_name('ANGEL OCAMPO');           -- 'Angel Ocampo'
--   SELECT public.titlecase_name('KYLE S. ENGALAN');        -- 'Kyle S. Engalan'
--   SELECT public.titlecase_name('JUAN DELA CRUZ III');     -- 'Juan Dela Cruz III'
--   SELECT public.titlecase_name('McDonald');               -- 'McDonald'  (verbatim)
--   SELECT public.titlecase_name('de la Cruz');             -- 'de la Cruz' (verbatim)
--   SELECT public.titlecase_name('jan@simple.biz');         -- 'jan@simple.biz' (verbatim)
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- UNDO -- removes the helper (does NOT un-title-case already-fixed data; the
--         SHOUTING was never wanted):
--   DROP FUNCTION IF EXISTS public.titlecase_name(text);
--   (fold_name() is shared with migration #83 -- do NOT drop it here.)
-- ----------------------------------------------------------------------------
