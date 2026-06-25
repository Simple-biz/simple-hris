-- ============================================================================
-- HR Onboarding "Submitted" surname-first display name  (2026-06-25)  [migration #87]
--
-- REQUEST: in the HR Onboarding "Submitted" tab the hire names should read
-- SURNAME-FIRST, with the given names following and the name the person goes by
-- in quotes. The exact target format (from the user):
--
--     "Jan Kane Reroma"   ->   Reroma, Jan Kane "Kane"
--      ^first ^given ^last       ^surname  ^given names  ^go-by name
--
-- i.e.  <Surname[ Suffix]>, <all given names> "<go-by name>"
--
-- This is a DISPLAY string ONLY. It is stored in a NEW, separate column
-- `display_name` -- it is NEVER written back into `full_name`. `full_name` stays
-- the canonical legal name because the Payroll Wizard name-token matcher
-- (normalizeNameTokens) and the @simple.biz work-email / Gmail-surname
-- derivation all read it and expect natural "First [Middle] Last" order. (It
-- also means this transform is safely re-runnable -- reordering full_name in
-- place would NOT be idempotent: a second pass would re-rotate the tokens.)
--
-- DERIVATION RULE  (public.name_last_first_quoted):
--   1. Normalize via titlecase_name() -> fold_name() (NFKC + strip invisibles +
--      collapse whitespace + trim, then conservatively re-case a SHOUTED /
--      all-lowercase value). NULL stays NULL; '' -> NULL (so the UI's
--      `display_name ?? invite_name ?? full_name` fallback still fires); an
--      address parked in the name column (has '@') is returned verbatim.
--   2. Split into whitespace tokens. A single token (mononym) is returned as-is.
--   3. SUFFIX-AWARE: peel any trailing generational suffix (jr/sr/ii/iii/iv/v,
--      optional '.') off the end -- it travels WITH the surname, never becomes
--      one. Never peel so far that fewer than two real tokens remain.
--   4. SURNAME = the last remaining token. GIVEN NAMES = everything before it.
--      LIMITATION: a compound surname ("Dela Cruz", "De Leon", "San Jose")
--      cannot be detected from a single string, so only the LAST word is taken
--      as the surname -- this was accepted as the trade-off for this feature.
--   5. GO-BY name (the quoted part) = the LAST given-name token that is NOT a
--      bare initial ("S" / "S."); if every given token is an initial, the last
--      given token is used. This reproduces the user's example exactly
--      ("Jan Kane Reroma" -> go-by "Kane") and keeps "Kyle S. Engalan" -> "Kyle"
--      rather than the meaningless initial "S.".
--   6. Emit:  Surname[ Suffix], Given1 Given2 ... "GoBy"
--
-- ENFORCEMENT: a BEFORE INSERT/UPDATE trigger keeps `display_name` in sync from
-- `full_name` on every write (so new submissions get it automatically), plus a
-- one-time BACKFILL of the rows already stored. This mirrors the #83 fold trigger
-- and the #86 title-case backfill.
--
-- IDEMPOTENT: every function is CREATE OR REPLACE; the trigger is DROP IF EXISTS
-- + CREATE; the backfill only touches rows that actually differ; the column add
-- is ADD COLUMN IF NOT EXISTS. fold_name() and titlecase_name() are re-declared
-- here (identical to #83 / #86) so this migration is self-contained and
-- order-independent. Requires Postgres 13+ (normalize()) -- Supabase: ok.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- STEP 0 -- INSPECT (run FIRST, on its own, AFTER the BEGIN block below has
--           created the functions -- or just eyeball the BEFORE/AFTER once the
--           transaction has run). Lists what display_name each submitted hire
--           would get. Eyeball the go-by name + surname split before trusting it.
-- ----------------------------------------------------------------------------
-- SELECT id::text,
--        full_name                                   AS before_,
--        public.name_last_first_quoted(full_name)    AS after_
--   FROM public.hr_onboarding_submissions
--  WHERE full_name IS NOT NULL
--  ORDER BY submitted_at DESC NULLS LAST;


BEGIN;

-- ----------------------------------------------------------------------------
-- STEP 1 -- fold_name(text): the Unicode normalizer from migration #83. Included
--           here (CREATE OR REPLACE -- identical definition) so this migration
--           is self-contained. No-op if already present.
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
-- STEP 2 -- titlecase_name(text): the conservative re-caser from migration #86.
--           Included here (CREATE OR REPLACE -- identical definition) so the
--           display name is nicely cased even if the stored full_name is still
--           SHOUTED and #86 has not run yet. PRESERVES NULL; returns ''/email/
--           mixed-case/no-cased-letters verbatim. No-op if already present.
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
  IF s IS NULL THEN
    RETURN NULL;
  END IF;
  folded := public.fold_name(s);
  IF folded = '' THEN
    RETURN folded;
  END IF;
  IF position('@' in folded) > 0 THEN
    RETURN folded;
  END IF;
  IF (folded ~ '[[:lower:]]') = (folded ~ '[[:upper:]]') THEN
    RETURN folded;
  END IF;
  result := initcap(folded);
  result := regexp_replace(result, '(^|\s)Iii$', '\1III');
  result := regexp_replace(result, '(^|\s)Iv$',  '\1IV');
  result := regexp_replace(result, '(^|\s)Ii$',  '\1II');
  RETURN result;
END;
$$;

-- ----------------------------------------------------------------------------
-- STEP 3 -- name_last_first_quoted(text): the surname-first display formatter.
--           See the header for the full rule. Pure + IMMUTABLE. Returns NULL for
--           a NULL/blank name so the UI fallback chain stays intact.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.name_last_first_quoted(s text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  norm     text;
  toks     text[];
  n        int;
  core     text[];
  m        int;
  suffixes text[] := ARRAY[]::text[];
  surname  text;
  suffix   text := '';
  given    text[];
  goby     text;
  i        int;
BEGIN
  -- Normalize + conservatively re-case. titlecase_name() preserves NULL, folds
  -- Unicode, and returns '' / '@'-addresses / mixed-case verbatim.
  norm := public.titlecase_name(s);
  IF norm IS NULL OR norm = '' THEN
    RETURN NULL;                          -- no real name -> let the UI fall back
  END IF;
  IF position('@' in norm) > 0 THEN
    RETURN norm;                          -- an address parked in a name column
  END IF;

  toks := regexp_split_to_array(norm, '\s+');
  n := array_length(toks, 1);
  IF n IS NULL OR n <= 1 THEN
    RETURN norm;                          -- mononym -- nothing to reorder
  END IF;

  -- Peel trailing generational suffix tokens (jr/sr/ii/iii/iv/v, optional dot).
  -- Stop at the first non-suffix token, and never peel past surname + 1 given.
  core := toks;
  LOOP
    m := array_length(core, 1);
    EXIT WHEN m <= 2;                      -- keep at least surname + one given name
    IF lower(core[m]) ~ '^(jr|sr|ii|iii|iv|v)\.?$' THEN
      suffixes := array_prepend(core[m], suffixes);
      core := core[1:m - 1];
    ELSE
      EXIT;
    END IF;
  END LOOP;

  m := array_length(core, 1);
  IF m <= 1 THEN
    RETURN norm;                          -- only a surname (+ suffix) survived
  END IF;

  surname := core[m];
  given   := core[1:m - 1];

  IF array_length(suffixes, 1) IS NOT NULL THEN
    suffix := ' ' || array_to_string(suffixes, ' ');
  END IF;

  -- Go-by name = last given token that is NOT a bare initial; else last given.
  goby := given[array_length(given, 1)];
  i := array_length(given, 1);
  WHILE i >= 1 LOOP
    IF given[i] !~ '^[[:alpha:]]\.?$' THEN
      goby := given[i];
      EXIT;
    END IF;
    i := i - 1;
  END LOOP;

  RETURN surname || suffix || ', ' || array_to_string(given, ' ') || ' "' || goby || '"';
END;
$$;

-- ----------------------------------------------------------------------------
-- STEP 4 -- add the display column (no-op if it already exists).
-- ----------------------------------------------------------------------------
ALTER TABLE public.hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS display_name text;

COMMENT ON COLUMN public.hr_onboarding_submissions.display_name IS
  'DERIVED surname-first display name (Surname[ Suffix], Given... "GoBy"), '
  'computed from full_name by name_last_first_quoted() via a BEFORE trigger. '
  'Display only -- full_name stays the canonical legal name for payroll/work-email.';

-- ----------------------------------------------------------------------------
-- STEP 5 -- keep display_name in sync on every write. Runs AFTER the #83
--           normalize trigger (alphabetical: "normalize_name" < "set_display_name"),
--           so it reads an already-folded full_name -- though name_last_first_quoted
--           folds internally too, so the result is correct regardless of order.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_onboarding_display_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.display_name := public.name_last_first_quoted(NEW.full_name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS hr_onboarding_submissions_set_display_name ON public.hr_onboarding_submissions;
CREATE TRIGGER hr_onboarding_submissions_set_display_name
  BEFORE INSERT OR UPDATE ON public.hr_onboarding_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_onboarding_display_name();

-- ----------------------------------------------------------------------------
-- STEP 6 -- BACKFILL existing rows. Only rows whose computed value differs are
--           touched. Pending rows (full_name IS NULL) get display_name = NULL.
-- ----------------------------------------------------------------------------
UPDATE public.hr_onboarding_submissions
SET    display_name = public.name_last_first_quoted(full_name)
WHERE  display_name IS DISTINCT FROM public.name_last_first_quoted(full_name);

COMMIT;

-- ----------------------------------------------------------------------------
-- VERIFY -- after COMMIT this should return 0 rows (everything in sync):
--   SELECT id, full_name, display_name FROM public.hr_onboarding_submissions
--     WHERE display_name IS DISTINCT FROM public.name_last_first_quoted(full_name);
--
-- Spot-checks (expected output in the comment):
--   SELECT public.name_last_first_quoted('Jan Kane Reroma');     -- 'Reroma, Jan Kane "Kane"'
--   SELECT public.name_last_first_quoted('JAN KANE REROMA');     -- 'Reroma, Jan Kane "Kane"' (re-cased)
--   SELECT public.name_last_first_quoted('Maria Reyes');         -- 'Reyes, Maria "Maria"'
--   SELECT public.name_last_first_quoted('Kyle S. Engalan');     -- 'Engalan, Kyle S. "Kyle"'
--   SELECT public.name_last_first_quoted('Juan Cruz III');       -- 'Cruz III, Juan "Juan"'
--   SELECT public.name_last_first_quoted('Juan Dela Cruz Jr');   -- 'Cruz Jr, Juan Dela "Dela"' (compound surname caveat)
--   SELECT public.name_last_first_quoted('Madonna');             -- 'Madonna'  (mononym, unchanged)
--   SELECT public.name_last_first_quoted('jan@simple.biz');      -- 'jan@simple.biz' (verbatim)
--   SELECT public.name_last_first_quoted(NULL);                  -- NULL
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- UNDO -- remove the display column + helper trigger (the SHOUTING-fold and
--         title-case helpers are shared with #83 / #86 -- do NOT drop them here):
--   DROP TRIGGER IF EXISTS hr_onboarding_submissions_set_display_name ON public.hr_onboarding_submissions;
--   DROP FUNCTION IF EXISTS public.set_onboarding_display_name();
--   DROP FUNCTION IF EXISTS public.name_last_first_quoted(text);
--   ALTER TABLE public.hr_onboarding_submissions DROP COLUMN IF EXISTS display_name;
-- ----------------------------------------------------------------------------
