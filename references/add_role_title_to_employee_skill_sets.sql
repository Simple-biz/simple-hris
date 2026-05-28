-- Migration: add role_title to employee_skill_sets
-- Adds a curated Role / Title field so teammates can pick a title from a
-- dropdown on their Employee Profile and have it surface on the My Team
-- card (under their name) + the full-profile modal. List of options lives
-- in src/lib/skill-set-titles.ts. Stored as a free TEXT column so the list
-- can evolve in code without further migrations.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.employee_skill_sets
  ADD COLUMN IF NOT EXISTS role_title TEXT NOT NULL DEFAULT '';
