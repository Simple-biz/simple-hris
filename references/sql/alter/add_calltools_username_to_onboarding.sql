-- Migration: calltools_nickname + calltools_username on hr_onboarding_submissions
--
-- Lead Gen hires now type their own Nickname on the onboarding paperwork (how
-- they want to be called on the CallTools dialer) and the system mints their
-- CallTools username as "<Nickname> <first initial>. <surname slice>." —
-- e.g. James Thomas going by "Mikey" -> "Mikey J. T.". When that username is
-- already minted, the surname slice lengthens one letter at a time
-- ("Mikey J. TH.", "Mikey J. THO.", ...), mirroring the work-email rule.
-- See src/lib/hr/calltools-username.ts and
-- app/api/onboarding/[token]/calltools-username/route.ts.
--
-- Both columns stay NULL for every non-Lead-Gen department.
--
-- Until this runs, the live derivation on the form still works, but a Lead Gen
-- submit stores the paperwork WITHOUT these two fields (graceful retry in
-- submitHrOnboarding) and the uniqueness check can't see previously minted
-- usernames. Idempotent; run in the Supabase SQL editor.

ALTER TABLE hr_onboarding_submissions
  ADD COLUMN IF NOT EXISTS calltools_nickname TEXT,
  ADD COLUMN IF NOT EXISTS calltools_username TEXT;
