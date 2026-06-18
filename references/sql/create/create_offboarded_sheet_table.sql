-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: offboarded_sheet table
-- Date authored: 2026-05-08
-- Purpose: Backs the HR Offboarded tab with a snapshot of the "Offboarded" tab
--          of the master Google Sheet, decoupled from global_master_list. Each
--          sync wipes + repopulates this table.
--
-- The sync pipeline ALSO continues to stamp global_master_list.off_boarded_*
-- (so the active_employees view + payroll views still drop off-boarded people),
-- but the HR Offboarded tab reads only from this table.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS offboarded_sheet (
  id BIGSERIAL PRIMARY KEY,
  personal_email TEXT NOT NULL,
  work_email TEXT,
  name TEXT,
  department TEXT,
  start_date TEXT,
  off_boarded_at TIMESTAMPTZ,
  off_boarded_reason TEXT,
  off_boarded_note TEXT,
  off_boarded_by TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS offboarded_sheet_personal_email_idx
  ON offboarded_sheet (LOWER(personal_email));

CREATE INDEX IF NOT EXISTS offboarded_sheet_work_email_idx
  ON offboarded_sheet (LOWER(work_email));

CREATE INDEX IF NOT EXISTS offboarded_sheet_off_boarded_at_idx
  ON offboarded_sheet (off_boarded_at DESC);

-- Restore button (POST /api/hr/reonboard) deletes from this table by
-- LOWER(work_email). The personal_email index is for sync upserts / matching;
-- the work_email index is for the restore lookup.
