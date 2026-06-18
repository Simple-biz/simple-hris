-- =============================================================================
-- Announcements table + CEO role
-- Run in Supabase SQL editor
-- =============================================================================

-- 1. Announcements table
create table if not exists announcements (
  id          uuid        primary key default gen_random_uuid(),
  author_email text       not null,
  author_name  text,
  scope        text       not null check (scope in ('general', 'department')),
  department   text,                              -- null when scope = 'general'
  title        text       not null,
  body         text       not null,
  pinned       bool       not null default false,
  created_at   timestamptz not null default now()
);

-- RLS: everyone authenticated can read; API enforces who can write
alter table announcements enable row level security;

drop policy if exists "announcements_select_all" on announcements;
create policy "announcements_select_all" on announcements
  for select using (true);

drop policy if exists "announcements_insert_service" on announcements;
create policy "announcements_insert_service" on announcements
  for insert with check (true);

drop policy if exists "announcements_delete_service" on announcements;
create policy "announcements_delete_service" on announcements
  for delete using (true);

-- 2. Enable Realtime on the table
alter publication supabase_realtime add table announcements;

-- 3. Widen the employee_roles role check to include 'ceo'
alter table employee_roles drop constraint if exists employee_roles_role_check;
alter table employee_roles add constraint employee_roles_role_check
  check (role in (
    'viewer',
    'hr_coordinator',
    'payroll_coordinator',
    'payroll_manager',
    'finance',
    'admin',
    'manager',
    'orphanage_manager',
    'ceo'
  ));
