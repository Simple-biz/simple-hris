-- ============================================================================
-- New Hire Checklist ← hiring-database sync  (2026-10-08, session 1e5dbda7)
--
-- Kane: "we will now be polling data that is available from that Database …
-- I want a new column for us where we can know the timestamp. Lets make sure
-- data being pulled from that database is saved in our own database as well."
--
-- 1. public.hr_new_hire_source_rows — the HRIS's OWN copy of every hire pulled
--    from the hiring database (HRIS_HIRES_SUPABASE_URL, a separate Supabase
--    project). One row per source hire, keyed by the source's id
--    (`source_key`). Only the ten mapped columns are stored, never `select *`.
--    `first_pulled_at` is the timestamp Kane asked for: when the HRIS first
--    received the hire.
--
--    Placement state (what the sync did with it on the checklist):
--      pending  not decided yet (fresh, or re-evaluated every sync)
--      placed   the sync INSERTED a checklist row for it (origin 'synced')
--      linked   it matched a hire HR had already typed in; no new row
--      held     not placed, with `hold_reason` (week_locked / past_week /
--               no_interview_date) — HR can place it by hand
--    A hire is placed AT MOST ONCE, ever: `placed_at` survives HR deleting the
--    checklist row (`checklist_row_id` goes NULL via ON DELETE SET NULL), and
--    the sync never re-places a row whose `placed_at` is set.
--
--    `applied_values` = the values the sync itself last wrote into the
--    checklist row. A later change at the source updates a cell ONLY while the
--    cell still equals that value — HR's own edits always win.
--
-- 2. public.hr_new_hire_checklist gains:
--      origin       'manual' (HR typed it) | 'synced' (the sync inserted it)
--      source_key   the source hire it came from; UNIQUE when set, so two HR
--                   tabs syncing at the same moment cannot list a hire twice
--      received_at  when the HRIS first received the hire (synced rows only;
--                   a manual row's time is its created_at)
--
-- NOT MONEY. Nothing here prices, dispatches or prints a paystub.
-- RLS on, no policies: rows name job applicants; reads and writes go through
-- the service-role route only (the anon key ships in the bundle).
--
-- Idempotent: safe to re-run. Touches no existing row data (the new checklist
-- columns default to 'manual' / NULL).
-- NO BEGIN/COMMIT in this file, on purpose: the apply script's dry run wraps it
-- in a transaction it rolls back, and a COMMIT in here would end that
-- transaction early and leave the "rehearsal" applied to production.
-- Apply: node --import tsx scripts/apply-hr-new-hire-source-sync-migration.mts --apply
-- Doc:   docs/features/new-hire-source-sync.md
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hr_new_hire_source_rows (
  id                   uuid        primary key default gen_random_uuid(),
  source_key           text        not null,
  name                 text,
  personal_email       text,
  location             text,
  phone_number         text,
  -- The interview's MANILA calendar date, YYYY-MM-DD (the checklist's format).
  date_of_interview    text,
  -- The source's raw interview timestamp, when it parsed as one.
  interview_at         timestamptz,
  source               text,
  referred_by          text,
  hired_by             text,
  department           text,
  country              text,
  source_created_at    timestamptz,
  source_updated_at    timestamptz,
  content_hash         text        not null,
  first_pulled_at      timestamptz not null default now(),
  last_changed_at      timestamptz not null default now(),
  target_period_start  date,
  placement            text        not null default 'pending',
  hold_reason          text,
  checklist_row_id     uuid        references public.hr_new_hire_checklist(id) on delete set null,
  placed_at            timestamptz,
  placed_by            text,
  applied_values       jsonb,
  constraint hr_new_hire_source_rows_source_key_present check (btrim(source_key) <> ''),
  constraint hr_new_hire_source_rows_hash_present check (btrim(content_hash) <> ''),
  constraint hr_new_hire_source_rows_placement_check
    check (placement in ('pending', 'placed', 'linked', 'held')),
  constraint hr_new_hire_source_rows_hold_shape
    check ((placement = 'held') = (hold_reason is not null)),
  constraint hr_new_hire_source_rows_hold_reason_check
    check (hold_reason is null or hold_reason in ('week_locked', 'past_week', 'no_interview_date')),
  constraint hr_new_hire_source_rows_placed_shape
    check ((placement in ('placed', 'linked')) = (placed_at is not null))
);

CREATE UNIQUE INDEX IF NOT EXISTS hr_new_hire_source_rows_source_key_uidx
  ON public.hr_new_hire_source_rows (source_key);
CREATE INDEX IF NOT EXISTS hr_new_hire_source_rows_open_idx
  ON public.hr_new_hire_source_rows (placement)
  WHERE placement in ('pending', 'held');
CREATE INDEX IF NOT EXISTS hr_new_hire_source_rows_checklist_row_idx
  ON public.hr_new_hire_source_rows (checklist_row_id);

ALTER TABLE public.hr_new_hire_source_rows ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.hr_new_hire_source_rows IS
  'HRIS copy of every hire pulled from the hiring database (New Hire Checklist sync). One row per source hire (source_key). first_pulled_at = when the HRIS first received it. A hire is placed on the checklist at most once (placed_at survives a delete). NOT MONEY. RLS on, no policies: service-role route only. Doc: docs/features/new-hire-source-sync.md';

-- ── the checklist side ──────────────────────────────────────────────────────
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS source_key text;
ALTER TABLE public.hr_new_hire_checklist
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_new_hire_checklist_origin_check') THEN
    ALTER TABLE public.hr_new_hire_checklist
      ADD CONSTRAINT hr_new_hire_checklist_origin_check CHECK (origin in ('manual', 'synced'));
  END IF;
  -- A synced row always names its source hire and when it arrived; a manual row never does.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_new_hire_checklist_synced_shape') THEN
    ALTER TABLE public.hr_new_hire_checklist
      ADD CONSTRAINT hr_new_hire_checklist_synced_shape CHECK (
        (origin = 'synced') = (source_key is not null)
        AND (origin = 'synced') = (received_at is not null)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hr_new_hire_checklist_source_key_uidx
  ON public.hr_new_hire_checklist (source_key)
  WHERE source_key IS NOT NULL;
