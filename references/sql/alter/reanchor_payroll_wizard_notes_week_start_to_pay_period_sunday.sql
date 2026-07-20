-- Migration: payroll_wizard_notes — re-anchor week_start to the pay-period
--            Sunday (Sunday–Saturday, one week in arrears)
-- Created: 2026-07-20
--
-- The Notes board used to key each row on the Manila MONDAY of the calendar
-- week the note was WRITTEN, and the period selector showed that same week
-- (e.g. "Jul 20 – Jul 26"). Accounting works a week in arrears — while it's
-- the week of the 19th–25th they're processing the 12th–18th — so the board
-- now anchors on the SUNDAY of the pay period being paid and labels it
-- Sunday–Saturday (e.g. "Jul 12 – Jul 18"). See payrollNotesWeekStart() in
-- src/lib/payroll/manila-week.ts.
--
-- Re-map: every existing week_start is a Monday (date_trunc('week', …) and the
-- old manilaWeekStart() both yield Monday). The pay-period Sunday for a note
-- written in Monday-week M is the previous week's Sunday = M − 8 days:
--     M (this week's Monday) − 1 = this week's Sunday
--                               − 7 = the paid week's Sunday
-- so a single shift of 8 days converts every stored value correctly.
--
-- Idempotent + deploy-order-safe: only rows whose week_start is a Monday
-- (DOW = 1) are shifted. New code only ever writes Sundays (DOW = 0), so rows
-- inserted after the app deploys but before this runs are already correct and
-- are skipped; rerunning the migration also matches nothing. Blank seeds stay
-- NULL. (Backfill only — no schema change.)

BEGIN;

UPDATE public.payroll_wizard_notes
SET week_start = week_start - INTERVAL '8 days'
WHERE week_start IS NOT NULL
  AND EXTRACT(DOW FROM week_start) = 1; -- 1 = Monday; Sundays (0) already re-anchored

COMMIT;
