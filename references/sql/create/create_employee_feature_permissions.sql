-- Per-user, per-view, per-feature access overlay on top of the coarse
-- `employee_roles` grants. Granting a role gives access to a *view* (the
-- whole `/accounting` shell, for example). This table then says which tabs
-- inside that view the user can see (`view`) and which they can fully use
-- (`edit`). A missing row means the tab is hidden — default deny.
create table if not exists public.employee_feature_permissions (
  id           uuid         primary key default gen_random_uuid(),
  work_email   text         not null,
  view_key     text         not null,                              -- 'accounting', 'manager', 'hr', 'orphanage', …
  feature      text         not null,                              -- 'rates', 'payroll_wizard', 'payment_dispatch', …
  access       text         not null check (access in ('view', 'edit')),
  granted_by   text,
  granted_at   timestamptz  not null default now(),
  revoked_at   timestamptz
);

-- One active grant per (email, view, feature).
create unique index if not exists employee_feature_permissions_active_uniq
  on public.employee_feature_permissions (lower(work_email), view_key, feature)
  where revoked_at is null;

create index if not exists employee_feature_permissions_email_active_idx
  on public.employee_feature_permissions (lower(work_email))
  where revoked_at is null;

-- Lower-case the email on every write so lookups stay case-insensitive.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'normalize_email_column') then
    drop trigger if exists employee_feature_permissions_normalize_email on public.employee_feature_permissions;
    create trigger employee_feature_permissions_normalize_email
      before insert or update on public.employee_feature_permissions
      for each row execute function public.normalize_email_column('work_email');
  end if;
end$$;
