-- Remove the per-department "My Team" wallpaper banner feature.
-- The banner (Manager → My Team and the Employee → My Team dashboard) has been
-- removed from the app, so the backing table is no longer read or written.
-- CASCADE also drops the manager_team_wallpapers_dept_lower_idx index.
--
-- Safe to run once; idempotent via IF EXISTS.
drop table if exists public.manager_team_wallpapers cascade;
