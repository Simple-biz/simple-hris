-- Migration: mesa_notes
-- Created: 2026-07-16
--
-- Ongoing, appendable internal notes on a MESA member — Accounting/HR log
-- context on a disbursement, a conversation, a follow-up, etc. Distinct from:
--   - mesa_ledger.notes / .additional_notes — frozen, per-EVENT text from the
--     one-time CSV backfill (read-only, see mesa_ledger_ddl.sql).
--   - mesa_requests.review_notes — tied to one specific request's review.
-- This is the general, many-rows-per-member annotation log, surfaced in the
-- Accounting -> MESA -> Member Balances -> View modal.
--
-- Append-only (no edit/delete in the UI, mirrors ticket_comments) — no
-- updated_at. Keyed by member_email (lowercased text), not a uuid FK: no
-- table in this repo FKs to the employee directory.
--
-- No RLS — enforced at the API layer only (same as every other MESA table).
-- Run once in the Supabase SQL Editor. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.mesa_notes (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  member_email TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  author_email TEXT        NOT NULL,
  author_name  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mesa_notes_member_email_idx
  ON public.mesa_notes (lower(member_email), created_at DESC);

COMMIT;
