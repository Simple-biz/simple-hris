-- ============================================================================
-- QC (Quality Control) role + data tables  (2026-06-26)
--
-- Adds the `qc` dashboard role and the staging/handoff tables that power the
-- QC view: QC officers do a FIRST-PASS KPI scoring of Leadgen / Callback /
-- Discovery, lock it in, and the department's real manager reviews + finalizes
-- before anything reaches payroll.
--
-- The QC scores live in `qc_kpi_submissions` — a SEPARATE staging table the
-- Payroll Wizard never reads (it only reads `bonus_catalog_applied`). The
-- manager promotes reviewed values into `bonus_catalog_applied` through the
-- existing calculator flow, so there is no double-count.
--
-- ⚠️ RUN ORDER: deploy the new code first, then run this (mirrors the role
--    migrations before it). Idempotent: safe to re-run.
-- ============================================================================

BEGIN;

-- 0. Widen the role CHECK constraint to allow `qc`. Keep the full current set
--    plus the legacy values so soft-deleted history rows stay valid (the app's
--    VALID_ROLES is what blocks new assignment of legacy roles).
ALTER TABLE public.employee_roles
  DROP CONSTRAINT IF EXISTS employee_roles_role_check;

ALTER TABLE public.employee_roles
  ADD CONSTRAINT employee_roles_role_check
  CHECK (role IN (
    'admin', 'ceo', 'hr_coordinator', 'accounting',
    'manager', 'orphanage_manager', 'contractor', 'qc',
    -- legacy (history only; not assignable in the app anymore):
    'finance', 'payroll_coordinator', 'payroll_manager', 'viewer'
  ));

-- 1. qc_score_assignments — who scores whom, per pay-week. The auto equal-split
--    writes one row per (period_start, member_email): a member belongs to
--    exactly one QC officer in a week. `department` is the member's dept key
--    (lead_gen | callback | discovery). Powers each officer's calculator scope
--    AND the manager's "QC Officer N responsibility" view.
CREATE TABLE IF NOT EXISTS public.qc_score_assignments (
  id               uuid        primary key default gen_random_uuid(),
  period_start     date        not null,
  qc_officer_email text        not null,
  member_email     text        not null,
  member_name      text,
  department       text        not null,
  generated        boolean     not null default true,   -- auto-split vs manual override
  assigned_by      text,
  assigned_at      timestamptz not null default now(),
  unique (period_start, member_email)
);
CREATE INDEX IF NOT EXISTS qc_score_assignments_period_officer_idx
  ON public.qc_score_assignments (period_start, lower(qc_officer_email));

-- 2. qc_kpi_submissions — STAGED scores (never read by payroll). Mirrors
--    bonus_catalog_applied's shape so the same calculator engine can write it,
--    plus `scored_by` (the QC officer) for attribution.
CREATE TABLE IF NOT EXISTS public.qc_kpi_submissions (
  id             text          primary key,             -- deterministic: 'qc:app:{period}:{dept}:{email}:{bonus_id}'
  period_start   date          not null,
  period_end     date          not null,
  department     text          not null,
  employee_email text          not null,
  employee_name  text,
  bonus_id       text          not null,
  bonus_name     text          not null,
  kind           text          not null check (kind in ('flat','formula')),
  vars           jsonb,
  amount         numeric(14,2) not null default 0,      -- PHP, informational for the manager
  scored_by      text,                                  -- QC officer email
  created_at     timestamptz   not null default now(),
  updated_at     timestamptz   not null default now(),
  unique (period_start, department, employee_email, bonus_id)
);
CREATE INDEX IF NOT EXISTS qc_kpi_submissions_dept_period_idx
  ON public.qc_kpi_submissions (department, period_start);
CREATE INDEX IF NOT EXISTS qc_kpi_submissions_scored_by_idx
  ON public.qc_kpi_submissions (lower(scored_by), period_start);

-- 3. qc_officer_locks — per-officer "locked their batch" log. This is the
--    manager's who/when record for the week.
CREATE TABLE IF NOT EXISTS public.qc_officer_locks (
  id               uuid        primary key default gen_random_uuid(),
  period_start     date        not null,
  qc_officer_email text        not null,
  status           text        not null default 'draft' check (status in ('draft','locked')),
  member_count     int         not null default 0,
  locked_at        timestamptz,
  locked_by        text,
  updated_at       timestamptz not null default now(),
  unique (period_start, qc_officer_email)
);

-- 4. qc_review_status — the manager's per-(dept, period) decision. Drives the
--    review banner + round-trip back to QC.
CREATE TABLE IF NOT EXISTS public.qc_review_status (
  id            uuid        primary key default gen_random_uuid(),
  period_start  date        not null,
  department    text        not null,
  status        text        not null default 'pending' check (status in ('pending','accepted','returned')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  note          text,
  updated_at    timestamptz not null default now(),
  unique (period_start, department)
);

-- ── Touch triggers (bump updated_at; keep created_at immutable where present) ──
CREATE OR REPLACE FUNCTION public.qc_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS qc_kpi_submissions_touch ON public.qc_kpi_submissions;
CREATE TRIGGER qc_kpi_submissions_touch
  BEFORE INSERT OR UPDATE ON public.qc_kpi_submissions
  FOR EACH ROW EXECUTE FUNCTION public.qc_touch_updated_at();

DROP TRIGGER IF EXISTS qc_officer_locks_touch ON public.qc_officer_locks;
CREATE TRIGGER qc_officer_locks_touch
  BEFORE INSERT OR UPDATE ON public.qc_officer_locks
  FOR EACH ROW EXECUTE FUNCTION public.qc_touch_updated_at();

DROP TRIGGER IF EXISTS qc_review_status_touch ON public.qc_review_status;
CREATE TRIGGER qc_review_status_touch
  BEFORE INSERT OR UPDATE ON public.qc_review_status
  FOR EACH ROW EXECUTE FUNCTION public.qc_touch_updated_at();

-- ── Normalize the unique-key email columns on write (defense; app also lowers) ─
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'normalize_email_column') THEN
    DROP TRIGGER IF EXISTS qc_score_assignments_normalize_member ON public.qc_score_assignments;
    CREATE TRIGGER qc_score_assignments_normalize_member
      BEFORE INSERT OR UPDATE ON public.qc_score_assignments
      FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column('member_email');

    DROP TRIGGER IF EXISTS qc_kpi_submissions_normalize_email ON public.qc_kpi_submissions;
    CREATE TRIGGER qc_kpi_submissions_normalize_email
      BEFORE INSERT OR UPDATE ON public.qc_kpi_submissions
      FOR EACH ROW EXECUTE FUNCTION public.normalize_email_column('employee_email');
  END IF;
END$$;

-- ── Expose all four tables to Realtime so QC ↔ manager update live ────────────
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY[
      'qc_score_assignments','qc_kpi_submissions','qc_officer_locks','qc_review_status'
    ] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename=t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      END IF;
    END LOOP;
  END IF;
END$$;

COMMIT;

-- Verify:
--   SELECT role, count(*) FROM employee_roles WHERE revoked_at IS NULL GROUP BY 1;
--   SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'
--     AND tablename LIKE 'qc\_%';
