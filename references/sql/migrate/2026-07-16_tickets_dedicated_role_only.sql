-- ============================================================================
-- Tickets board — dedicated `tickets` role only (2026-07-16)
--
-- The HRIS-updates Kanban board is now a DEDICATED-ROLE surface: only holders of
-- the standalone `tickets` role (or admins) can see the "Tickets" view-switcher
-- entry and open /tickets. It is no longer a per-dashboard tab.
--
-- Previously, the `tickets` feature lived in the Accounting / HR / Manager / CEO
-- catalogs, so assigning any of those dashboard roles AUTO-PROVISIONED an
-- `edit` grant on <view>.tickets (via provisionDashboardTabs). Those grants let
-- the holder pass the /api/tickets feature gate and surface in the assignable-
-- developer pool — i.e. people who were never explicitly assigned Tickets still
-- had board access.
--
-- This migration revokes every leaked `tickets` grant that sits under a NON-
-- tickets view. Only grants under the `tickets` view remain (those are minted
-- when the dedicated `tickets` role is assigned). After this runs, board access
-- requires the `tickets` role, full stop.
--
-- ⚠️ Anyone who was relying on ticket access via a dashboard role will lose it.
--    Re-grant them the "Tickets" role in Admin → Roles & Permissions if they
--    should keep the board.
--
-- ⚠️ RUN ORDER: safe to run before OR after deploying the new code (the new code
--    already ignores non-tickets `tickets` grants). Idempotent.
-- ============================================================================

BEGIN;

UPDATE public.employee_feature_permissions
   SET revoked_at = now()
 WHERE feature   = 'tickets'
   AND view_key <> 'tickets'
   AND revoked_at IS NULL;

COMMIT;

-- Verify (should return 0 rows):
--   SELECT work_email, view_key, access
--     FROM public.employee_feature_permissions
--    WHERE feature = 'tickets' AND view_key <> 'tickets' AND revoked_at IS NULL;
--
-- Who still has the board (should be exactly the `tickets`-role holders + admins):
--   SELECT work_email, access
--     FROM public.employee_feature_permissions
--    WHERE feature = 'tickets' AND view_key = 'tickets' AND revoked_at IS NULL;
