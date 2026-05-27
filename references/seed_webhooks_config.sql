-- Migration: seed Admin -> Webhooks config (app_settings['webhooks.config'])
-- Created: 2026-05-27
--
-- The Admin -> Webhooks tab stores all outbound n8n/automation endpoints as a
-- JSON array under the `webhooks.config` app_settings key. Each entry is keyed
-- by a stable `slug` that the server-side code (src/lib/webhooks/resolve-webhook.ts)
-- looks up at runtime, so URLs can be rotated from the UI without a redeploy.
--
-- This migration ensures every canonical slug exists in the config, pre-filled
-- with the current production default URL. It is conservative and idempotent:
--   * It NEVER overwrites a slug an admin has already configured (URL/active/
--     label are left untouched if the slug is already present).
--   * Newly-seeded entries are inserted as ACTIVE = false. The default URL is
--     pre-filled so it shows in the UI, but the resolver still falls back to the
--     env var / hardcoded default until an admin toggles it on. This means
--     running the migration changes nothing about live behaviour.
--   * `onboarding_send` is pre-filled from the legacy `hr.onboarding_webhook_url`
--     key when present, else from the same hardcoded default the route uses, so
--     the onboarding email keeps working after the route moved to the slug system.
--
-- Canonical slugs (must match KNOWN_SLUGS in src/components/admin/AdminWebhooks.tsx):
--   paystub_dispatch          -> Payroll Wizard Step 5 paystub dispatch
--   create_workspace_account  -> HR "Save and stage hire"
--   hubstaff_invite_user      -> HR Pending-Hires "Promote"
--   onboarding_send           -> HR Onboarding "Send" (invite email)
--   offboarding               -> HR Offboarding "Confirm offboard"

DO $$
DECLARE
  existing   jsonb;
  legacy_url text;
  defaults   jsonb;
  def        jsonb;
  merged     jsonb;
  slug_set   text[];
BEGIN
  -- Current config (TEXT column holding a JSON string) -> jsonb array.
  SELECT value::jsonb INTO existing
  FROM public.app_settings
  WHERE key = 'webhooks.config';

  IF existing IS NULL OR jsonb_typeof(existing) <> 'array' THEN
    existing := '[]'::jsonb;
  END IF;

  -- Legacy bare-URL onboarding key, migrated into the `onboarding_send` slug.
  SELECT NULLIF(btrim(value), '') INTO legacy_url
  FROM public.app_settings
  WHERE key = 'hr.onboarding_webhook_url';

  -- Canonical defaults. active=false across the board so live resolution is
  -- unchanged until an admin opts in -- every slug now has a hardcoded default
  -- in code, so an inactive config entry just means "fall back to that default".
  defaults := jsonb_build_array(
    jsonb_build_object(
      'slug', 'paystub_dispatch',
      'label', 'Paystub Dispatch (n8n)',
      'url', 'https://simpledotbiz.app.n8n.cloud/webhook/confirm-dispatch',
      'active', false,
      'description', 'Used by Payroll Wizard Step 5 to dispatch paystubs.'
    ),
    jsonb_build_object(
      'slug', 'create_workspace_account',
      'label', 'Create Workspace Account (n8n)',
      'url', 'https://simpledotbiz.app.n8n.cloud/webhook/create-workspace-account',
      'active', false,
      'description', 'Used by HR Onboarding "Save and stage hire" to provision the Hubstaff workspace account.'
    ),
    jsonb_build_object(
      'slug', 'hubstaff_invite_user',
      'label', 'Hubstaff Invite User (n8n)',
      'url', 'https://simpledotbiz.app.n8n.cloud/webhook/hubstaff-invite-user',
      'active', false,
      'description', 'Fired by the HR Pending-Hires "Promote" button to invite the new hire to Hubstaff.'
    ),
    jsonb_build_object(
      'slug', 'onboarding_send',
      'label', 'Onboarding Email Send (n8n)',
      'url', COALESCE(legacy_url, 'https://simpledotbiz.app.n8n.cloud/webhook/7cb7afed-ef97-4cb9-92d5-31938695df18'),
      'active', false,
      'description', 'Sends the onboarding invite email. Used by HR Onboarding "Send" (falls back to the legacy hr.onboarding_webhook_url key).'
    ),
    jsonb_build_object(
      'slug', 'offboarding',
      'label', 'Offboarding (n8n)',
      'url', 'https://simpledotbiz.app.n8n.cloud/webhook/offboarding-endpoint',
      'active', false,
      'description', 'Fired by the HR Offboarding "Confirm offboard" button to deactivate the workspace account and send the termination notice.'
    )
  );

  -- Slugs already present in the stored config — never touched.
  SELECT COALESCE(array_agg(e->>'slug'), ARRAY[]::text[])
  INTO slug_set
  FROM jsonb_array_elements(existing) AS e;

  merged := existing;

  -- Append only the canonical entries whose slug is missing.
  FOR def IN SELECT * FROM jsonb_array_elements(defaults)
  LOOP
    IF NOT ((def->>'slug') = ANY (slug_set)) THEN
      merged := merged || jsonb_build_array(
        def || jsonb_build_object(
          'id', substr(md5(random()::text), 1, 8),
          'updated_at', now()
        )
      );
    END IF;
  END LOOP;

  -- Persist back as a JSON string (the column is TEXT).
  INSERT INTO public.app_settings (key, value)
  VALUES ('webhooks.config', merged::text)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;
