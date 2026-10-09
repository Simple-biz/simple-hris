-- [Accounting Scoreboard: Keys, the paid platforms each person holds a seat on]  2026-10-09, Open item 424
--
-- Carla, 2026-10-08 meeting: "QBO charges us per seat. Uh Stripe charges us per seat. So we lose money if we don't
-- offboard them from all these other platforms." "We can call them keys like I can create a key to QBO and you have a
-- key to access QBO." "if I ever needed to offboard [someone], I could click on his name. It would show me all the
-- tags and I would be able to action all of that before kicking him off the team." Admin only: "It's not for the team."
--
-- accounting_scoreboard_keys       one key = one paid platform (QBO, Stripe...). Archived, never deleted, and only
--                                  once nobody holds a seat on it, so a key cannot vanish while a seat is still paid
--                                  for. The label never changes in place.
-- accounting_scoreboard_key_seats  one seat: a person (a board person's work email) holds a key. The only UPDATE is
--                                  the removal stamp, once (the seat was removed on the platform); holding it again
--                                  inserts a new row. One live seat per key per person. Nothing is deleted, so who
--                                  held what, and who removed it when, stays readable (item 410).
--
-- Archiving a key and giving a seat on it take the same per-key advisory lock, so they cannot pass each other.
-- Not part of the board read (readBoard): only Setup → Keys reads these tables.
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-keys-migration.mts.
-- Governing doc: docs/features/accounting-scoreboard-keys.md.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  label        text        NOT NULL
    CONSTRAINT acct_sb_keys_label_valid CHECK (label = btrim(label) AND length(label) BETWEEN 1 AND 40),
  created_by   text        NOT NULL
    CONSTRAINT acct_sb_keys_created_by_set CHECK (btrim(created_by) <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  archived_by  text,
  archived_at  timestamptz,
  CONSTRAINT acct_sb_keys_archive_pair CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);

-- One live key per name, whatever the case ("QBO" and "qbo" are one platform).
CREATE UNIQUE INDEX IF NOT EXISTS acct_sb_keys_one_live_label
  ON public.accounting_scoreboard_keys (lower(label)) WHERE archived_at IS NULL;

COMMENT ON TABLE public.accounting_scoreboard_keys IS
  'Accounting Scoreboard Keys: the paid platforms a person can hold a seat on. Archived (only when no live seat), never deleted. Service-role only.';

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_key_seats (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      uuid        NOT NULL REFERENCES public.accounting_scoreboard_keys (id),
  email       text        NOT NULL
    CONSTRAINT acct_sb_key_seats_email_valid CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  given_by    text        NOT NULL
    CONSTRAINT acct_sb_key_seats_given_by_set CHECK (btrim(given_by) <> ''),
  given_at    timestamptz NOT NULL DEFAULT now(),
  removed_by  text,
  removed_at  timestamptz,
  CONSTRAINT acct_sb_key_seats_remove_pair CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);

-- One live seat per key per person. A removed seat stays as history.
CREATE UNIQUE INDEX IF NOT EXISTS acct_sb_key_seats_one_live
  ON public.accounting_scoreboard_key_seats (key_id, email) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS acct_sb_key_seats_email
  ON public.accounting_scoreboard_key_seats (email);

COMMENT ON TABLE public.accounting_scoreboard_key_seats IS
  'Accounting Scoreboard Keys: who holds a seat on which platform. Append-only apart from the one removal stamp. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_keys_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_keys: a key is archived, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_keys: a key is created live' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the archive stamp, once, and nothing else.
  IF OLD.archived_at IS NOT NULL OR NEW.archived_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_keys: only the archive stamp may change, once' USING ERRCODE = '23514';
  END IF;
  -- Serialise with seats given on this key, then look with a fresh snapshot: nobody may still hold a seat.
  PERFORM pg_advisory_xact_lock(hashtext('accounting_scoreboard_keys:' || OLD.id::text));
  IF EXISTS (
    SELECT 1 FROM public.accounting_scoreboard_key_seats s
     WHERE s.key_id = OLD.id AND s.removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'accounting_scoreboard_keys: someone still holds a seat on this key; remove every seat first'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_keys_guard ON public.accounting_scoreboard_keys;
CREATE TRIGGER acct_sb_keys_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_keys
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_keys_guard();

CREATE OR REPLACE FUNCTION public.acct_sb_key_seats_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_key_seats: a seat is removed, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL OR NEW.removed_by IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_key_seats: a seat is created live' USING ERRCODE = '23514';
    END IF;
    -- The same lock the archive takes, so a key cannot be archived while a seat on it is being given.
    PERFORM pg_advisory_xact_lock(hashtext('accounting_scoreboard_keys:' || NEW.key_id::text));
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_scoreboard_keys k WHERE k.id = NEW.key_id AND k.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'accounting_scoreboard_key_seats: that key is archived' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the removal stamp, once, and nothing else.
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.given_by IS DISTINCT FROM OLD.given_by
     OR NEW.given_at IS DISTINCT FROM OLD.given_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_key_seats: only the removal stamp may change, once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_key_seats_guard ON public.accounting_scoreboard_key_seats;
CREATE TRIGGER acct_sb_key_seats_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_key_seats
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_key_seats_guard();

ALTER TABLE public.accounting_scoreboard_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_scoreboard_key_seats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_keys, public.accounting_scoreboard_key_seats FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_keys_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_key_seats_guard() FROM PUBLIC, anon, authenticated;
