-- Backfill the per-tab feature permission for the NEW HR "Screening" tab
-- (feature key 'screening' under view_key 'hr').
--
-- Why this is needed: tab access is default-deny. Adding 'screening' to
-- FEATURE_CATALOG.hr (src/lib/rbac/feature-permissions.ts) makes it (a) visible
-- immediately to `admin` (who bypass the overlay) and (b) auto-provisioned for
-- any FUTURE `hr_coordinator` grant. But existing hr_coordinator holders granted
-- BEFORE this tab existed have no row for it, so it stays hidden for them. This
-- one-time, idempotent seed grants them `edit` so the tab appears without a
-- re-grant.
--
-- Safe to run more than once: the NOT EXISTS guard skips anyone who already has
-- an active grant. The unique index employee_feature_permissions_active_uniq
-- also protects against duplicates.

insert into public.employee_feature_permissions (work_email, view_key, feature, access, granted_by)
select distinct lower(er.work_email), 'hr', 'screening', 'edit', 'screening-backfill'
from public.employee_roles er
where er.role = 'hr_coordinator'
  and er.revoked_at is null
  and not exists (
    select 1
    from public.employee_feature_permissions fp
    where lower(fp.work_email) = lower(er.work_email)
      and fp.view_key = 'hr'
      and fp.feature = 'screening'
      and fp.revoked_at is null
  );
