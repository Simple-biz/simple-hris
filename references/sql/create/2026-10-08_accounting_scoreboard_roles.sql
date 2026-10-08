-- [Accounting Scoreboard: board-local roles — Admin / Assistant / Team member]  2026-10-08, Open item 393
--
-- Carla, 2026-10-07 meeting: "I would love for this not to be available to anybody except Claire. I don't
-- want anybody to change anything." Three roles, not an edit / view / hidden matrix ("Nah."):
--   Admin       full write: Setup, deleting anyone's line, roles (and, in Task 5, the weekly lock)
--   Assistant   sees Setup without changing it, and (Task 7) everyone's tasks
--   Team member edits every cell and logs lines, never Setup
-- A Team member is anyone on the board's member list (a live person row, or accounting_scoreboard_members).
-- Admin and Assistant are GRANTS, kept here. An HRIS `admin` is always a board Admin (break glass) and is
-- NOT stored here. HRIS `accounting` alone no longer manages the board (Kane, 2026-10-07, item 393).
--
-- A grant is APPEND-ONLY: the one UPDATE allowed is the revoke stamp, once; DELETE is refused. Changing
-- someone's role is a revoke and a new grant. The board always keeps ONE live Admin grant: revoking the last
-- one is refused here, under an advisory lock so two Admins revoking each other at once cannot both pass.
--
-- Service role only: RLS on with zero policies, anon and authenticated revoked.
-- Applied by scripts/apply-accounting-scoreboard-roles-migration.mts, which also seeds the two Admins
-- (it takes both emails as --admin arguments and refuses --apply without them).
-- Governing doc: docs/features/accounting-scoreboard.md § Who may open it.

CREATE TABLE IF NOT EXISTS public.accounting_scoreboard_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text        NOT NULL
    CONSTRAINT acct_sb_roles_email_valid CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role        text        NOT NULL
    CONSTRAINT acct_sb_roles_role_valid CHECK (role IN ('admin', 'assistant')),
  granted_by  text        NOT NULL
    CONSTRAINT acct_sb_roles_granted_by_set CHECK (btrim(granted_by) <> ''),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  text,
  revoked_at  timestamptz,
  CONSTRAINT acct_sb_roles_revoke_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- One live grant per address. A revoked grant stays as history.
CREATE UNIQUE INDEX IF NOT EXISTS acct_sb_roles_one_live
  ON public.accounting_scoreboard_roles (email) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.accounting_scoreboard_roles IS
  'Accounting Scoreboard Admin / Assistant grants. Append-only apart from the one revoke stamp; the last live Admin grant cannot be revoked. Service-role only.';

CREATE OR REPLACE FUNCTION public.acct_sb_roles_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting_scoreboard_roles: a grant is revoked, never deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'accounting_scoreboard_roles: a grant is created live' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the revoke stamp, once, and nothing else.
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'accounting_scoreboard_roles: only the revoke stamp may change, once' USING ERRCODE = '23514';
  END IF;
  IF OLD.role = 'admin' THEN
    -- Serialise Admin revokes, then count with a fresh snapshot: the board keeps one live Admin grant.
    PERFORM pg_advisory_xact_lock(hashtext('accounting_scoreboard_roles:admins'));
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_scoreboard_roles
       WHERE role = 'admin' AND revoked_at IS NULL AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'accounting_scoreboard_roles: the board keeps at least one Admin; grant another Admin first'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acct_sb_roles_guard ON public.accounting_scoreboard_roles;
CREATE TRIGGER acct_sb_roles_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_scoreboard_roles
  FOR EACH ROW EXECUTE FUNCTION public.acct_sb_roles_guard();

ALTER TABLE public.accounting_scoreboard_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_scoreboard_roles FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.acct_sb_roles_guard() FROM PUBLIC, anon, authenticated;
