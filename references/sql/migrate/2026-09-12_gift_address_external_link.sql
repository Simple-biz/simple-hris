-- [GIFT-ADDRESS]
-- External tenure-gift address link — `gift_address_otps`
-- Created: 2026-09-12.
--
-- Powers a PUBLIC (no-login) page at /update-gift-address where someone on the
-- Global Master List types their SIMPLE.BIZ WORK EMAIL, receives a 6-digit code
-- in that work inbox, then sees every tenure gift they are owed since their
-- start date and gives one delivery address covering them.
--
-- WHY IT EXISTS: HRIS is not public yet, and the 592 owed gifts identified on
-- 2026-09-11 have no address-collection path at all — the in-app form only ever
-- asks for the CURRENT milestone and freezes earlier ones read-only
-- (docs/features/gift-tracker-receipts.md). This is that path.
--
-- Modelled exactly on references/sql/migrate/2026-06-29_bank_update_external_link.sql.
-- Same security model, enforced in APP CODE (service-role bypasses RLS):
--   * codes stored HASHED (sha256 + server pepper), never plaintext
--   * 10-minute code TTL, killed after 5 failed attempts
--   * 3 sends per email per 15 minutes, and the throttle FAILS CLOSED
--   * a successful verify mints a random session token (hashed at rest, 20-min
--     TTL); every later step derives the work email FROM THAT TOKEN and never
--     from a client-supplied value
--
-- WHAT THIS TABLE DOES NOT DO: it holds no addresses and no gift state. The form
-- writes `employee_gift_shipping_details` (which already exists) and NEVER
-- `employee_gift_receipts` — submitting an address is not receiving a gift.
--
-- NO `BEGIN` / `COMMIT` IN THIS FILE, DELIBERATELY. The apply script opens the
-- transaction and rolls it back on a dry run; a COMMIT here would end that
-- transaction from the inside, so the rehearsal would commit to production and
-- the script's own ROLLBACK would have nothing to undo. That happened on
-- 2026-09-11 with the gift-receipts migration. Every sibling under
-- references/sql/migrate/ omits them.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.gift_address_otps (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The canonical WORK EMAIL (lowercased). The code is mailed here and every
  -- later step is keyed to it — never to whatever the browser last sent.
  work_email          text        NOT NULL,

  -- sha256(code . work_email . pepper). The plaintext 6-digit code is never
  -- stored; compared in constant time at verify.
  code_hash           text        NOT NULL,
  attempts            int         NOT NULL DEFAULT 0,

  expires_at          timestamptz NOT NULL,
  -- Set on a successful verify, which also closes the code to reuse.
  consumed_at         timestamptz,

  -- sha256 of the token handed to the browser once. Storing the raw token would
  -- make a DB leak directly replayable as somebody's session.
  session_token       text,
  session_expires_at  timestamptz,

  -- Best-effort source IP (x-forwarded-for / x-real-ip) for the audit trail.
  request_ip          text,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gift_address_otps_work_email_normalized
    CHECK (work_email = lower(btrim(work_email)) AND work_email <> ''),
  CONSTRAINT gift_address_otps_work_email_shape
    CHECK (work_email LIKE '%_@_%'),
  CONSTRAINT gift_address_otps_attempts_sane
    CHECK (attempts >= 0 AND attempts <= 100),
  -- A session is only meaningful on a consumed code, and a token without an
  -- expiry would never age out.
  CONSTRAINT gift_address_otps_session_pair
    CHECK (session_token IS NULL OR session_expires_at IS NOT NULL)
);

COMMENT ON TABLE public.gift_address_otps IS
  '[GIFT-ADDRESS] Short-lived OTP codes + post-verification session tokens for the PUBLIC /update-gift-address page. Codes and session tokens are stored HASHED. Holds no addresses and no gift state. Doc: docs/features/gift-address-external-link.md';

-- Find the live code for an email (verify) and count recent sends (throttle).
CREATE INDEX IF NOT EXISTS gift_address_otps_email_idx
  ON public.gift_address_otps (lower(work_email), created_at DESC);

-- Resolve a post-verification session token.
CREATE INDEX IF NOT EXISTS gift_address_otps_session_idx
  ON public.gift_address_otps (session_token)
  WHERE session_token IS NOT NULL;

-- Lower-case the key on every write so one person cannot hold two spellings of
-- their own address, which would defeat the per-email send throttle.
CREATE OR REPLACE FUNCTION public.gift_address_otps_normalize()
RETURNS TRIGGER AS $$
BEGIN
  NEW.work_email := lower(btrim(NEW.work_email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gift_address_otps_normalize ON public.gift_address_otps;
CREATE TRIGGER trg_gift_address_otps_normalize
  BEFORE INSERT OR UPDATE ON public.gift_address_otps
  FOR EACH ROW EXECUTE FUNCTION public.gift_address_otps_normalize();

-- This table is reachable from a PUBLIC page and holds session tokens.
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle, so RLS is enabled
-- with NO policies: service-role only, exactly like bank_update_otps and the
-- house precedent for anything sensitive (references/sql/create/create_screening.sql).
ALTER TABLE public.gift_address_otps ENABLE ROW LEVEL SECURITY;
