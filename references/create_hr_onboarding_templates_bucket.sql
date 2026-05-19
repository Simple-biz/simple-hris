-- ============================================================================
-- HR Onboarding shared templates bucket — `hr-onboarding-templates`
-- Generated: 2026-05-19
--
-- Purpose
--   Public Supabase storage bucket for HR-managed templates that get linked
--   from outgoing onboarding emails — most importantly the blank IRS W-8BEN
--   PDF that contractors outside the US fill in and re-upload via step 4 of
--   the form.
--
--   This is *separate* from `hr-onboarding-files` (created in migration #48,
--   which is PRIVATE and holds the *filled* W-8BEN each new hire uploads).
--
-- Why a separate, public bucket?
--   • Email links must be openable for weeks/months without re-signing URLs.
--     Signed URLs expire; a public bucket gives a stable, deterministic URL.
--   • HR can swap in an updated form (the IRS revises W-8BEN every few years)
--     without a code deploy — just upload a new file with the same name.
--   • The W-8BEN is a public IRS form anyway — there's nothing sensitive in
--     the blank template, so public-read is fine.
--
-- After running this migration:
--   1. Open Supabase Studio → Storage → hr-onboarding-templates
--   2. Drag-drop `FW8BEN.pdf` into the bucket (root level — not in a folder).
--      The runtime URL becomes:
--        https://<project-ref>.supabase.co/storage/v1/object/public/hr-onboarding-templates/FW8BEN.pdf
--   3. The send route (app/api/hr/onboarding-submissions/[id]/send/route.ts)
--      constructs that URL from NEXT_PUBLIC_SUPABASE_URL and the bucket name
--      automatically — no further config needed.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('hr-onboarding-templates', 'hr-onboarding-templates', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Verify ─────────────────────────────────────────────────────────────────
SELECT id, name, public, created_at
FROM storage.buckets
WHERE id = 'hr-onboarding-templates';
