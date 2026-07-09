-- Backfill the per-tab feature permission for the NEW Accounting "Transfers"
-- tab (feature key 'transfers' under view_key 'accounting').
--
-- Why this is needed: accounting tab access is default-deny. Adding 'transfers'
-- to FEATURE_CATALOG.accounting (src/lib/rbac/feature-permissions.ts) makes it
-- (a) visible immediately to `admin` (who bypass the overlay) and (b)
-- auto-provisioned for any FUTURE `accounting` grant. But existing
-- accounting-role holders granted BEFORE this tab existed have no row for it, so
-- it stays hidden for them. This one-time, idempotent seed grants them `edit` so
-- the tab appears without a re-grant. (The tab itself is read-only; `edit` just
-- clears the default-deny gate — there are no mutations to authorize.)
--
-- Safe to run more than once: the NOT EXISTS guard skips anyone who already has
-- an active grant. The unique index employee_feature_permissions_active_uniq
-- also protects against duplicates.

insert into public.employee_feature_permissions (work_email, view_key, feature, access, granted_by)
select distinct lower(er.work_email), 'accounting', 'transfers', 'edit', 'accounting-transfers-backfill'
from public.employee_roles er
where er.role = 'accounting'
  and er.revoked_at is null
  and not exists (
    select 1
    from public.employee_feature_permissions fp
    where lower(fp.work_email) = lower(er.work_email)
      and fp.view_key = 'accounting'
      and fp.feature = 'transfers'
      and fp.revoked_at is null
  );
